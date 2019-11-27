/**
 * Template and template argument handling, first cut.
 *
 * AsyncTokenTransformManager objects provide preprocessor-frame-like
 * functionality once template args etc are fully expanded, and isolate
 * individual transforms from concurrency issues. Template expansion is
 * controlled using a tplExpandData structure created independently for each
 * handled template tag.
 * @module
 */

'use strict';

const { AttributeExpander } = require('./AttributeExpander.js');
const { ContentUtils } = require('../../utils/ContentUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../utils/DOMUtils.js');
const { Params } = require('../Params.js');
const { ParserFunctions } = require('./ParserFunctions.js');
const { PipelineUtils } = require('../../utils/PipelineUtils.js');
const Promise = require('../../utils/promise.js');
const { TemplateRequest } = require('../../mw/ApiRequest.js');
const TokenTransformManager = require('../TokenTransformManager.js');
const TokenHandler = require('./TokenHandler.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');
const { Util } = require('../../utils/Util.js');
const { KV, TagTk, EndTagTk, SelfclosingTagTk, NlTk, EOFTk, CommentTk } = require('../../tokens/TokenTypes.js');
const tu = require('../tokenizer.utils.js');

const AttributeTransformManager = TokenTransformManager.AttributeTransformManager;
const TokenAccumulator = TokenTransformManager.TokenAccumulator;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class TemplateHandler extends TokenHandler {
	static RANK() { return 1.1; }

	constructor(manager, options) {
		super(manager, options);
		this.wrapTemplates = !this.options.inTemplate;
		// Set this here so that it's available in the TokenStreamPatcher,
		// which continues to inherit from TemplateHandler.
		this.parserFunctions = new ParserFunctions(this.env);
		this.ae = null;
		if (options.tsp) { return; /* don't register handlers */ }
		// Register for template and templatearg tag tokens
		this.manager.addTransform(
			(token, cb) => this.onTemplate(token, cb),
			"TemplateHandler:onTemplate", TemplateHandler.RANK(), 'tag', 'template');
		// Template argument expansion
		this.manager.addTransform(
			(token, cb) => this.onTemplateArg(token, cb),
			"TemplateHandler:onTemplateArg", TemplateHandler.RANK(), 'tag', 'templatearg');
		this.ae = new AttributeExpander(this.manager, { standalone: true, expandTemplates: true });
	}

	/**
	 * Main template token handler.
	 *
	 * Expands target and arguments (both keys and values) and either directly
	 * calls or sets up the callback to _expandTemplate, which then fetches and
	 * processes the template.
	 */
	onTemplate(token, cb) {
		var toks;

		function hasTemplateToken(tokens) {
			return Array.isArray(tokens) &&
				tokens.some(function(t) { return TokenUtils.isTemplateToken(t); });
		}

		// If the template name is templated, use the attribute transform manager
		// to process all attributes to tokens, and force reprocessing of the token.
		if (hasTemplateToken(token.attribs[0].k)) {
			cb({ async: true });
			this.ae.onToken(token, function(ret) {
				if (ret.tokens) {
					// Force reprocessing of the token by demoting its rank.
					//
					// Note that there's some hacky code in the attribute expander
					// to try and prevent it from returning templates in the
					// expanded attribs.  Otherwise, we can find outselves in a loop
					// here, where `hasTemplateToken` continuously returns true.
					//
					// That was happening when a template name depending on a top
					// level templatearg failed to expand.
					ret.tokens.rank = TemplateHandler.RANK() - 0.0001;
				}
				cb(ret);
			});
			return;
		}

		var env = this.env;
		var text = token.dataAttribs.src;
		var state = {
			token: token,
			wrapperType: 'mw:Transclusion',
			wrappedObjectId: env.newObjectId(),
			srcCB: this._startTokenPipeline,
		};

		// This template target resolution may be incomplete for
		// cases where the template's target itself was templated.
		var tgt = this.resolveTemplateTarget(state, token.attribs[0].k, token.attribs[0].srcOffsets.slice(0,2));
		if (tgt && tgt.magicWordType) {
			toks = this.processSpecialMagicWord(token, tgt);
			console.assert(toks !== null);
			cb({ tokens: Array.isArray(toks) ? toks : [toks] });
			return;
		}

		if (this.options.expandTemplates && tgt === null) {
			// Target contains tags, convert template braces and pipes back into text
			// Re-join attribute tokens with '=' and '|'
			this.convertAttribsToString(state, token.attribs, cb);
			return;
		}

		var accum;
		var accumReceiveToksFromSibling;
		var accumReceiveToksFromChild;

		if (env.conf.parsoid.usePHPPreProcessor) {
			if (this.options.expandTemplates) {
				// Use MediaWiki's action=expandtemplates preprocessor
				//
				// The tokenizer needs to use `text` as the cache key for caching
				// expanded tokens from the expanded transclusion text that we get
				// from the preprocessor, since parameter substitution will already
				// have taken place.
				//
				// It's sufficient to pass `[]` in place of attribs since they
				// won't be used.  In `usePHPPreProcessor`, there is no parameter
				// substitution coming from the frame.

				var templateName = tgt.target;
				var templateTitle = tgt.title;
				var attribs = [];

				// We still need to check for limit violations because of the
				// higher precedence of extension tags, which can result in nested
				// templates even while using the php preprocessor for expansion.
				var checkRes = this.checkRes(templateName, templateTitle, true);
				if (Array.isArray(checkRes)) {
					cb({ tokens: checkRes });
					return;
				}

				// Check if we have an expansion for this template in the cache already
				var cachedTransclusion = env.transclusionCache[text];
				if (cachedTransclusion) {
					// cache hit: reuse the expansion DOM
					// FIXME(SSS): How does this work again for
					// templates like {{start table}} and {[end table}}??
					toks = PipelineUtils.encapsulateExpansionHTML(env, token, cachedTransclusion, {
						fromCache: true,
					});
					cb({ tokens: toks });
				} else {
					// Use a TokenAccumulator to divide the template processing
					// in two parts: The child part will take care of the main
					// template element (including parameters) and the sibling
					// will process the returned template expansion
					accum = new TokenAccumulator(this.manager, cb);
					accumReceiveToksFromSibling = accum.receiveToksFromSibling.bind(accum);
					accumReceiveToksFromChild = accum.receiveToksFromChild.bind(accum);
					var srcHandler = state.srcCB.bind(
							this, state,
							accumReceiveToksFromSibling,
							{ name: templateName, title: templateTitle, attribs: attribs });

					// Process the main template element
					this._encapsulateTemplate(state,
						accumReceiveToksFromChild);
					// Fetch and process the template expansion
					this.fetchExpandedTpl(env.page.name || '',
							text, accumReceiveToksFromSibling, srcHandler);
				}
			} else {
				// We don't perform recursive template expansion- something
				// template-like that the PHP parser did not expand. This is
				// encapsulated already, so just return the plain text.
				console.assert(TokenUtils.isTemplateToken(token));
				this.convertAttribsToString(state, token.attribs, cb);
				return;
			}
		} else {
			if (this.options.expandTemplates) {
				// Use a TokenAccumulator to divide the template processing
				// in two parts: The child part will take care of the main
				// template element (including parameters) and the sibling
				// will do the template expansion
				accum = new TokenAccumulator(this.manager, cb);
				// console.warn("onTemplate created TA-" + accum.uid);
				accumReceiveToksFromSibling = accum.receiveToksFromSibling.bind(accum);
				accumReceiveToksFromChild = accum.receiveToksFromChild.bind(accum);

				// Process the main template element
				this._encapsulateTemplate(state,
					accum.receiveToksFromChild.bind(accum));
			} else {
				// Don't wrap templates, so we don't need to use the
				// TokenAccumulator and can return the expansion directly
				accumReceiveToksFromSibling = cb;
			}

			accumReceiveToksFromSibling({ tokens: [], async: true });

			// expand argument keys, with callback set to next processing step
			// XXX: would likely be faster to do this in a tight loop here
			var atm = new AttributeTransformManager(
				this.manager,
				{ expandTemplates: false, inTemplate: true }
			);
			(atm.process(token.attribs).promises || Promise.resolve()).then(
				() => this._expandTemplate(state, accumReceiveToksFromSibling, atm.getNewKVs(token.attribs))
			).done();
		}
	}

	/**
	 * Parser functions also need template wrapping.
	 */
	_parserFunctionsWrapper(state, cb, ret) {
		if (ret.tokens) {
			console.assert(Array.isArray(ret.tokens));

			// This is only for the Parsoid native expansion pipeline used in
			// parser tests. The "" token sometimes changes foster parenting
			// behavior and trips up some tests.
			var i = 0;
			while (i < ret.tokens.length) {
				if (ret.tokens[i] === "") {
					ret.tokens.splice(i, 1);
				} else {
					i++;
				}
			}
			// token chunk should be flattened
			console.assert(ret.tokens.every(el => !Array.isArray(el)));
			this._onChunk(state, cb, ret.tokens);
		}
		if (!ret.async) {
			// Now, ready to finish up
			this._onEnd(state, cb);
		}
	}

	encapTokens(state, tokens, extraDict) {
		var toks = this.getEncapsulationInfo(state, tokens);
		toks.push(this.getEncapsulationInfoEndTag(state));
		if (this.wrapTemplates) {
			var argInfo = this.getArgInfo(state);
			if (extraDict) { Object.assign(argInfo.dict, extraDict); }
			toks[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
		}
		return toks;
	}

	/**
	 * Process the special magic word as specified by `resolvedTgt.magicWordType`.
	 * ```
	 * magicWordType === '!'    => {{!}} is the magic word
	 * magicWordtype === 'MASQ' => DEFAULTSORT, DISPLAYTITLE are the magic words
	 *                             (Util.magicMasqs.has(..))
	 * ```
	 */
	processSpecialMagicWord(tplToken, resolvedTgt) {
		var env = this.manager.env;

		// Special case for {{!}} magic word.  Note that this is only necessary
		// because of the call from the TokenStreamPatcher.  Otherwise, ! is a
		// variable like any other and can be dropped from this function.
		// However, we keep both cases flowing through here for consistency.
		if ((resolvedTgt && resolvedTgt.magicWordType === '!') || tplToken.attribs[0].k === "!") {
			// If we're not at the top level, return a table cell. This will always
			// be the case. Either {{!}} was tokenized as a td, or it was tokenized
			// as template but the recursive call to fetch its content returns a
			// single | in an ambiguous context which will again be tokenized as td.
			if (!this.atTopLevel) {
				return [new TagTk("td")];
			}
			var state = {
				token: tplToken,
				wrapperType: "mw:Transclusion",
				wrappedObjectId: env.newObjectId(),
			};
			this.resolveTemplateTarget(state, "!", tplToken.attribs[0].srcOffsets.slice(0, 2));
			return this.encapTokens(state, ["|"]);
		}

		if (!resolvedTgt || resolvedTgt.magicWordType !== 'MASQ') {
			// Nothing to do
			return null;
		}

		var magicWord = resolvedTgt.prefix.toLowerCase();
		var pageProp = 'mw:PageProp/';
		if (magicWord === 'defaultsort') {
			pageProp += 'category';
		}
		pageProp += magicWord;

		var metaToken = new SelfclosingTagTk('meta',
			[ new KV('property', pageProp) ],
			Util.clone(tplToken.dataAttribs)
		);

		if ((tplToken.dataAttribs.tmp || {}).templatedAttribs) {
			// No shadowing if templated
			//
			// SSS FIXME: post-tpl-expansion, WS won't be trimmed. How do we handle this?
			metaToken.addAttribute("content", resolvedTgt.pfArgToks, tu.expandTsrV(resolvedTgt.srcOffsets));
			metaToken.addAttribute("about", env.newAboutId());
			metaToken.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");

			// See [[mw:Specs/HTML/1.4.0#Transclusion-affected_attributes]]
			//
			// For every attribute that has a templated name and/or value,
			// AttributeExpander creates a 2-item array for that attribute.
			//    [ {txt: '..', html: '..'}, { html: '..'} ]
			// 'txt' is the plain-text name/value
			// 'html' is the HTML-version of the name/value
			//
			// Massage the templated magic-word info into a similar format.
			// In this case, the attribute name is 'content' (implicit) and
			// since it is implicit, the name itself cannot be attribute.
			// Hence 'html' property is empty.
			//
			// The attribute value has been templated and is encoded there.
			//
			// NOTE: If any part of the 'MAGIC_WORD:value' string is templated,
			// we consider the magic word as having expanded attributes, rather
			// than only when the 'value' part of it. This is because of the
			// limitation of our token representation for templates. This is
			// an edge case that it is not worth a refactoring right now to
			// handle this properly and choose mw:Transclusion or mw:ExpandedAttrs
			// depending on which part is templated.
			//
			// FIXME: Is there a simpler / better repn. for templated attrs?
			// FIXME: the content still contains the parser function prefix
			//  (eg, the html is 'DISPLAYTITLE:Foo' even though the stripped
			//   content attribute is 'Foo')
			var ta = tplToken.dataAttribs.tmp.templatedAttribs;
			ta[0][0].txt = 'content';      // Magic-word attribute name
			ta[0][1].html = ta[0][0].html; // HTML repn. of the attribute value
			ta[0][0].html = undefined;
			metaToken.addAttribute("data-mw", JSON.stringify({ attribs: ta }));
		} else {
			// Leading/trailing WS should be stripped
			var key = resolvedTgt.pfArg.trim();

			var src = (tplToken.dataAttribs || {}).src;
			if (src) {
				// If the token has original wikitext, shadow the sort-key
				var origKey = src.replace(/[^:]+:?/, '').replace(/}}$/, '');
				metaToken.addNormalizedAttribute("content", key, origKey);
			} else {
				// If not, this token came from an extension/template
				// in which case, dont bother with shadowing since the token
				// will never be edited directly.
				metaToken.addAttribute("content", key);
			}
		}
		return metaToken;
	}

	resolveTemplateTarget(state, targetToks, srcOffsets) {
		function toStringOrNull(tokens) {
			var maybeTarget = TokenUtils.tokensToString(TokenUtils.stripIncludeTokens(tokens), true, { retainNLs: true });
			if (Array.isArray(maybeTarget)) {
				var buf = maybeTarget[0];
				var tgtTokens = maybeTarget[1];
				var preNlContent = null;
				for (var i = 0, l = tgtTokens.length; i < l; i++) {
					var ntt = tgtTokens[i];
					switch (ntt.constructor) {
						case String:
							buf += ntt;
							break;

						case SelfclosingTagTk:
							// Quotes are valid template targets
							if (ntt.name === 'mw-quote') {
								buf += ntt.getAttribute('value');
							} else if (!TokenUtils.isEmptyLineMetaToken(ntt)
									&& ntt.name !== 'template'
									&& ntt.name !== 'templatearg') {
								// We are okay with empty (comment-only) lines,
								// {{..}} and {{{..}}} in template targets.
								return null;
							}
							break;

						case TagTk:
						case EndTagTk:
							return null;

						case CommentTk:
							// Ignore comments as well
							break;

						case NlTk:
							// Ignore only the leading or trailing newlnes
							// (module whitespace and comments)

							// empty target .. ignore nl
							if (/^\s*$/.test(buf)) {
								break;
							} else if (!preNlContent) {
								// Buffer accumulated content
								preNlContent = buf;
								buf = '';
								break;
							} else {
								return null;
							}

						default:
							console.assert(false, 'Unexpected token type: ' + ntt.constructor);
					}
				}

				if (preNlContent && !/^\s*$/.test(buf)) {
					// intervening newline makes this an invalid target
					return null;
				} else {
					// all good! only whitespace/comments post newline
					return (preNlContent || '') + buf;
				}
			} else {
				return maybeTarget;
			}
		}

		// Normalize to an array
		targetToks = !Array.isArray(targetToks) ? [targetToks] : targetToks;

		var env = this.manager.env;
		var wiki = env.conf.wiki;
		var isTemplate = true;
		var target = toStringOrNull(targetToks);
		if (target === null) {
			// Retry with a looser attempt to convert tokens to a string.
			// This lenience only applies to parser functions.
			isTemplate = false;
			target = TokenUtils.tokensToString(TokenUtils.stripIncludeTokens(targetToks));
		}

		// safesubst found in content should be treated as if no modifier were
		// present.  See https://en.wikipedia.org/wiki/Help:Substitution#The_safesubst:_modifier
		target = target.trim().replace(/^safesubst:/, '');

		var pieces = target.split(':');
		var prefix = pieces[0].trim();
		var lowerPrefix = prefix.toLowerCase();
		// The check for pieces.length > 1 is require to distinguish between
		// {{lc:FOO}} and {{lc|FOO}}.  The latter is a template transclusion
		// even though the target (=lc) matches a registered parser-function name.
		var isPF = pieces.length > 1;

		// Check if we have a parser function
		var canonicalFunctionName =
			wiki.functionHooks.get(prefix) || wiki.functionHooks.get(lowerPrefix) ||
			wiki.variables.get(prefix) || wiki.variables.get(lowerPrefix);

		if (canonicalFunctionName !== undefined) {
			// Extract toks that make up pfArg
			var pfArgToks;
			var re = new RegExp('^(.*?)' + prefix, 'i');

			// Because of the lenient stringifying above, we need to find the
			// prefix.  The strings we've seen so far are buffered in case they
			// combine to our prefix.  FIXME: We need to account for the call
			// to TokenUtils.stripIncludeTokens above and the safesubst replace.
			var buf = '';
			var i = targetToks.findIndex(function(t) {
				if (typeof t !== 'string') { return false; }
				buf += t;
				var match = re.exec(buf);
				if (match) {
					// Check if they combined
					var offset = buf.length - t.length - match[1].length;
					if (offset > 0) {
						re = new RegExp('^' + prefix.substring(offset), 'i');
					}
					return true;
				}
				return false;
			});

			if (i > -1) {
				// Strip parser-func / magic-word prefix
				var firstTok = targetToks[i].replace(re, '');
				targetToks = targetToks.slice(i + 1);

				if (isPF) {
					// Strip ":", again, after accounting for the lenient stringifying
					while (targetToks.length > 0 &&
							(typeof firstTok !== 'string' || /^\s*$/.test(firstTok))) {
						firstTok = targetToks[0];
						targetToks = targetToks.slice(1);
					}
					console.assert(typeof firstTok === 'string' && /^\s*:/.test(firstTok),
						'Expecting : in parser function definiton');
					pfArgToks = [firstTok.replace(/^\s*:/, '')].concat(targetToks);
				} else {
					pfArgToks = [firstTok].concat(targetToks);
				}
			}

			if (pfArgToks === undefined) {
				// FIXME: Protect from crashers by using the full token -- this is
				// still going to generate incorrect output, but it won't crash.
				pfArgToks = targetToks;
			}

			state.parserFunctionName = canonicalFunctionName;

			var magicWordType = null;
			if (canonicalFunctionName === '!') {
				magicWordType = '!';
			} else if (Util.magicMasqs.has(canonicalFunctionName)) {
				magicWordType = 'MASQ';
			}

			return {
				isPF: true,
				prefix: canonicalFunctionName,
				magicWordType: magicWordType,
				target: 'pf_' + canonicalFunctionName,
				title: env.makeTitleFromURLDecodedStr('Special:ParserFunction/' + canonicalFunctionName),
				pfArg: target.substr(prefix.length + 1),
				pfArgToks: pfArgToks,
				srcOffsets,
			};
		}

		if (!isTemplate) { return null; }

		// `resolveTitle()` adds the namespace prefix when it resolves fragments
		// and relative titles, and a leading colon should resolve to a template
		// from the main namespace, hence we omit a default when making a title
		var namespaceId = /^[:#\/\.]/.test(target) ?
			undefined : wiki.canonicalNamespaces.template;

		// Resolve a possibly relative link and
		// normalize the target before template processing.
		var title;
		try {
			title = env.resolveTitle(target);
		} catch (e) {
			// Invalid template target!
			return null;
		}

		// Entities in transclusions aren't decoded in the PHP parser
		// So, treat the title as a url-decoded string!
		title = env.makeTitleFromURLDecodedStr(title, namespaceId, true);
		if (!title) {
			// Invalid template target!
			return null;
		}

		// data-mw.target.href should be a url
		state.resolvedTemplateTarget = env.makeLink(title);

		return {
			isPF: false,
			magicWordType: null,
			target: title.getPrefixedDBKey(),
			title: title,
		};
	}

	convertAttribsToString(state, attribs, cb) {
		cb({ tokens: [], async: true });
		let attribTokens = [];

		// Leading whitespace, if any
		const leadWS = (state.token.dataAttribs.tmp || {}).leadWS || '';
		if (leadWS !== '') {
			attribTokens.push(leadWS);
		}

		// Re-join attribute tokens with '=' and '|'
		attribs.forEach((kv) => {
			if (kv.k) {
				attribTokens = TokenUtils.flattenAndAppendToks(attribTokens, null, kv.k);
			}
			if (kv.v) {
				attribTokens = TokenUtils.flattenAndAppendToks(attribTokens,
					kv.k ? "=" : '',
					kv.v);
			}
			attribTokens.push('|');
		});
		// pop last pipe separator
		attribTokens.pop();

		// Trailing whitespace, if any
		const trailWS = (state.token.dataAttribs.tmp || {}).trailWS || '';
		if (trailWS !== '') {
			attribTokens.push(trailWS);
		}

		var tokens = ['{{'].concat(attribTokens, ['}}', new EOFTk()]);

		// Process exploded token in a new pipeline
		var tplHandler = this;
		var newTokens = [];
		var endCB = () => {
			var hasTemplatedTarget = !!(state.token.dataAttribs.tmp || {}).templatedAttribs;
			if (hasTemplatedTarget && this.wrapTemplates) {
				// Add encapsulation if we had a templated target
				// FIXME: This is a deliberate wrapping of the entire
				// "broken markup" where one or more templates are nested
				// inside invalid transclusion markup. The proper way to do
				// this would be to disentangle everything and identify
				// transclusions and wrap them individually with meta tags
				// and data-mw info. But, this is an edge case which can be
				// more readily fixed by fixing the markup. The goal here is
				// to ensure that the output renders properly and it roundtrips
				// without dirty diffs rather then faithful DOMspec representation.
				newTokens = tplHandler.encapTokens(state, newTokens);
			}

			newTokens.rank = TemplateHandler.RANK(); // Assign the correct rank to the tokens
			cb({ tokens: newTokens });
		};
		PipelineUtils.processContentInPipeline(
			this.manager.env,
			this.manager.frame,
			tokens,
			{
				pipelineType: "tokens/x-mediawiki",
				pipelineOpts: {
					expandTemplates: this.options.expandTemplates,
					inTemplate: this.options.inTemplate,
				},
				chunkCB: function(chunk) {
					// SSS FIXME: This pattern of attempting to strip
					// EOFTk from every chunk is a bit ugly, but unavoidable
					// since EOF token comes with the entire chunk rather
					// than coming through the end event callback.
					newTokens = newTokens.concat(TokenUtils.stripEOFTkfromTokens(chunk));
				},
				endCB: endCB,
				sol: true,
				srcOffsets: state.token.dataAttribs.tsr,
			}
		);
	}

	/**
	 * checkRes
	 */
	checkRes(target, title, ignoreLoop) {
		var checkRes = this.manager.frame.loopAndDepthCheck(title, this.env.conf.parsoid.maxDepth, ignoreLoop);
		if (checkRes) {
			// Loop detected or depth limit exceeded, abort!
			var res = [
				new TagTk('span',[new KV('class', 'error')]),
				checkRes,
				new SelfclosingTagTk('wikilink',[new KV('href', target)]),
				new EndTagTk('span'),
			];
			return res;
		}
	}

	/**
	 * Fetch, tokenize and token-transform a template after all arguments and the
	 * target were expanded.
	 */
	_expandTemplate(state, cb, attribs) {
		var env = this.manager.env;
		var target = attribs[0].k;

		if (!target) {
			env.log('debug', 'No target! ', attribs);
		}

		// Resolve the template target again now that the template token's
		// attributes have been expanded by the AttributeTransformManager.
		const resolvedTgt = this.resolveTemplateTarget(state, target, attribs[0].srcOffsets.slice(0, 2));
		if (resolvedTgt === null) {
			// Target contains tags, convert template braces and pipes back into text
			// Re-join attribute tokens with '=' and '|'
			this.convertAttribsToString(state, attribs, cb);
			return;
		}

		// TODO:
		// check for 'subst:'
		// check for variable magic names
		// check for msg, msgnw, raw magics
		// check for parser functions

		// XXX: wrap attribs in object with .dict() and .named() methods,
		// and each member (key/value) into object with .tokens(), .dom() and
		// .wikitext() methods (subclass of Array)

		var res;
		target = resolvedTgt.target;
		if (resolvedTgt.isPF) {
			// FIXME: Parsoid may not have implemented the parser function natively
			// Emit an error message, but encapsulate it so it roundtrips back.
			if (!this.parserFunctions[target]) {
				res = [ "Parser function implementation for " + target + " missing in Parsoid." ];
				res.rank = TemplateHandler.RANK();
				if (this.wrapTemplates) {
					res.push(this.getEncapsulationInfoEndTag(state));
				}
				cb({ tokens: res });
				return;
			}

			var pfAttribs = new Params(attribs);
			pfAttribs[0] = new KV(resolvedTgt.pfArg, [], tu.expandTsrK(resolvedTgt.srcOffsets));
			env.log('debug', 'entering prefix', target, state.token);
			var newCB;
			if (this.wrapTemplates) {
				newCB = ret => this._parserFunctionsWrapper(state, cb, ret);
			} else {
				newCB = cb;
			}
			this.parserFunctions[target](state.token, this.manager.frame, newCB, pfAttribs);
			return;
		}

		// Loop detection needs to be enabled since we're doing our own template
		// expansion
		var checkRes = this.checkRes(target, resolvedTgt.title, false);
		if (Array.isArray(checkRes)) {
			checkRes.rank = this.manager.phaseEndRank;
			cb({ tokens: checkRes });
			return;
		}

		// XXX: notes from brion's mediawiki.parser.environment
		// resolve template name
		// load template w/ canonical name
		// load template w/ variant names (language variants)

		// strip template target
		attribs = attribs.slice(1);

		// For now, just fetch the template and pass the callback for further
		// processing along.
		var srcHandler = state.srcCB.bind(
			this, state, cb,
			{ name: target, title: resolvedTgt.title, attribs: attribs }
		);
		this._fetchTemplateAndTitle(target, cb, srcHandler, state);
	}

	/**
	 * Process a fetched template source to a token stream.
	 */
	_startTokenPipeline(state, cb, tplArgs, err, src) {
		// We have a choice between aborting or keeping going and reporting the
		// error inline.
		// TODO: report as special error token and format / remove that just
		// before the serializer. (something like <mw:error ../> as source)
		if (err) {
			src = '';
			//  this.manager.env.errCB(err);
		}

		var psd = this.manager.env.conf.parsoid;
		if (psd.dumpFlags && psd.dumpFlags.has("tplsrc")) {
			console.warn("=".repeat(80));
			console.warn("TEMPLATE:", tplArgs.name, "; TRANSCLUSION:", JSON.stringify(state.token.dataAttribs.src));
			console.warn("-".repeat(80));
			console.warn(src);
			console.warn("-".repeat(80));
		}

		this.manager.env.log('debug', 'TemplateHandler._startTokenPipeline', tplArgs.name, tplArgs.attribs);

		// Get a nested transformation pipeline for the input type. The input
		// pipeline includes the tokenizer, synchronous stage-1 transforms for
		// 'text/wiki' input and asynchronous stage-2 transforms).
		PipelineUtils.processContentInPipeline(
			this.manager.env,
			this.manager.frame,
			src,
			{
				pipelineType: 'text/x-mediawiki',
				pipelineOpts: {
					inTemplate: true,
					isInclude: true,
					// FIXME: In reality, this is broken for parser tests where
					// we expand templates natively. We do want all nested templates
					// to be expanded. But, setting this to !usePHPPreProcessor seems
					// to break a number of tests. Not pursuing this line of enquiry
					// for now since this parserTests vs production distinction will
					// disappear with parser integration. We'll just bear the stench
					// till that time.
					//
					// NOTE: No expansion required for nested templates.
					expandTemplates: false,
					extTag: this.options.extTag,
				},
				srcText: src,
				srcOffsets: [0, src.length],
				tplArgs: tplArgs,
				chunkCB: chunk => this._onChunk(state, cb, chunk),
				endCB: () => this._onEnd(state, cb),
				sol: true,
			}
		);
	}

	getEncapsulationInfo(state, chunk) {
		// TODO
		// * only add this information for top-level includes, but track parameter
		// expansion in lower-level templates
		// * ref all tables to this (just add about)
		// * ref end token to this, add property="mw:Transclusion/End"

		var attrs = [
			new KV('typeof', state.wrapperType),
			new KV('about', '#' + state.wrappedObjectId),
		];
		var dataParsoid = {
			tsr: Util.clone(state.token.dataAttribs.tsr),
			src: state.token.dataAttribs.src,
			tmp: {},  // We'll add the arginfo here if necessary
		};

		var meta = [new SelfclosingTagTk('meta', attrs, dataParsoid)];
		chunk = chunk ? meta.concat(chunk) : meta;
		chunk.rank = TemplateHandler.RANK();
		return chunk;
	}

	getEncapsulationInfoEndTag(state) {
		var tsr = state.token.dataAttribs.tsr;
		return new SelfclosingTagTk('meta', [
			new KV('typeof', state.wrapperType + '/End'),
			new KV('about', '#' + state.wrappedObjectId),
		], {
			tsr: [null, tsr ? tsr[1] : null],
		});
	}

	/**
	 * Parameter processing helpers.
	 */
	static _isSimpleParam(tokens) {
		var isSimpleToken = function(token) {
			return (token.constructor === String ||
					token.constructor === CommentTk ||
					token.constructor === NlTk);
		};
		if (!Array.isArray(tokens)) {
			return isSimpleToken(tokens);
		}
		return tokens.every(isSimpleToken);
	}

	// Add its HTML conversion to a parameter, and return a Promise which is
	// fulfilled when the conversion is complete.
	static *getParamHTMLG(manager, paramData) {
		var param = paramData.param;
		var srcStart = paramData.info.srcOffsets[2];
		var srcEnd = paramData.info.srcOffsets[3];
		if (paramData.info.spc) {
			srcStart += paramData.info.spc[2].length;
			srcEnd -= paramData.info.spc[3].length;
		}

		var html = yield PipelineUtils.promiseToProcessContent(
			manager.env, manager.frame,
			param.wt,
			{
				pipelineType: "text/x-mediawiki/full",
				pipelineOpts: {
					isInclude: false,
					expandTemplates: true,
					// No need to do paragraph-wrapping here
					inlineContext: true,
				},
				srcOffsets: [ srcStart, srcEnd ],
				sol: true,
			});
		// FIXME: We're better off setting a pipeline option above
		// to skip dsr computation to begin with.  Worth revisitting
		// if / when `addHTMLTemplateParameters` is enabled.
		// Remove DSR from children
		DOMUtils.visitDOM(html.body, function(node) {
			if (!DOMUtils.isElt(node)) { return; }
			var dp = DOMDataUtils.getDataParsoid(node);
			dp.dsr = undefined;
		});
		param.html = ContentUtils.ppToXML(html.body, { innerXML: true });
		return;
	}

	/**
	 * Process the main template element, including the arguments.
	 */
	_encapsulateTemplate(state, cb) {
		var i, n;
		var env = this.manager.env;
		var chunk = this.getEncapsulationInfo(state);

		// Template encapsulation normally wouldn't happen in nested context,
		// since they should have already been expanded, and indeed we set
		// expandTemplates === false in the srcCB, _startTokenPipeline.  However,
		// extension tags from templates can have content that requires wikitext
		// parsing and, due to precedence, contain unexpanded templates.
		//
		// For example, {{1x|hi<ref>{{1x|ho}}</ref>}}
		//
		// Since extensions can require template expansion unconditionally, we can
		// end up here inTemplate, in which case the substrings of env.page.src
		// used in getArgInfo are no longer accurate, and so tplarginfo should be
		// omitted.  Presumably, template wrapping in the dom post processor won't
		// be happening anyways, so this is unnecessary work as it is.
		if (this.wrapTemplates) {
			// Get the arg dict
			var argInfo = this.getArgInfo(state);
			var argDict = argInfo.dict;

			if (env.conf.parsoid.addHTMLTemplateParameters) {
				// Collect the parameters that need parsing into HTML, that is,
				// those that are not simple strings.
				// This optimizes for the common case where all are simple strings,
				// in which we don't need to go async.
				var params = [];
				for (i = 0, n = argInfo.paramInfos.length; i < n; i++) {
					var paramInfo = argInfo.paramInfos[i];
					var param = argDict.params[paramInfo.k];
					var paramTokens;
					if (paramInfo.named) {
						paramTokens = state.token.getAttribute(paramInfo.k);
					} else {
						paramTokens = state.token.attribs[paramInfo.k].v;
					}

					// No need to pass through a whole sub-pipeline to get the
					// html if the param is either a single string, or if it's
					// just text, comments or newlines.
					if (paramTokens &&
							(paramTokens.constructor === String ||
								TemplateHandler._isSimpleParam(paramTokens))) {
						param.html = param.wt;
					} else if (param.wt.match(/^https?:\/\/[^[\]{}\s]*$/)) {
						// If the param is just a simple URL, we can process it to
						// HTML directly without going through a sub-pipeline.
						param.html = "<a rel='mw:ExtLink' href='" + param.wt.replace(/'/g, '&#39;') +
							"'>" + param.wt + "</a>";
					} else {
						// Prepare the data needed to parse to HTML
						params.push({
							param: param,
							info: paramInfo,
							tokens: paramTokens,
						});
					}
				}

				if (params.length) {
					// TODO: We could avoid going async by checking if all params are strings
					// and, in that case returning them immediately.
					cb({ tokens: [], async: true });
					Promise.all(params.map(
						paramData => TemplateHandler._getParamHTML(this.manager, paramData)
					))
					.then(function() {
						// Use a data-attribute to prevent the sanitizer from stripping this
						// attribute before it reaches the DOM pass where it is needed.
						chunk[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
						env.log('debug', 'TemplateHandler._encapsulateTemplate', chunk);
						cb({ tokens: chunk });
					}).done();
					return;
				} else {
					chunk[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
				}
			} else {
				// Don't add the HTML template parameters, just use their wikitext
				chunk[0].dataAttribs.tmp.tplarginfo = JSON.stringify(argInfo);
			}
		}

		env.log('debug', 'TemplateHandler._encapsulateTemplate', chunk);
		cb({ tokens: chunk });
	}

	/**
	 * Handle chunk emitted from the input pipeline after feeding it a template.
	 */
	_onChunk(state, cb, chunk) {
		chunk = TokenUtils.stripEOFTkfromTokens(chunk);

		var i, n;
		for (i = 0, n = chunk.length; i < n; i++) {
			if (chunk[i] && chunk[i].dataAttribs && chunk[i].dataAttribs.tsr) {
				chunk[i].dataAttribs.tsr = undefined;
			}
			var t = chunk[i];
			if (t.constructor === SelfclosingTagTk &&
					t.name.toLowerCase() === 'meta' &&
					t.getAttribute('typeof') === 'mw:Placeholder') {
				// replace with empty string to avoid metas being foster-parented out
				chunk[i] = '';
			}
		}

		if (!this.options.expandTemplates) {
			// Ignore comments in template transclusion mode
			var newChunk = [];
			for (i = 0, n = chunk.length; i < n; i++) {
				if (chunk[i].constructor !== CommentTk) {
					newChunk.push(chunk[i]);
				}
			}
			chunk = newChunk;
		}

		this.manager.env.log('debug', 'TemplateHandler._onChunk', chunk);
		chunk.rank = TemplateHandler.RANK();
		cb({ tokens: chunk, async: true });
	}

	/**
	 * Handle the end event emitted by the parser pipeline after fully processing
	 * the template source.
	 */
	_onEnd(state, cb) {
		this.manager.env.log('debug', 'TemplateHandler._onEnd');
		if (this.wrapTemplates) {
			var endTag = this.getEncapsulationInfoEndTag(state);
			var res = { tokens: [endTag] };
			res.tokens.rank = TemplateHandler.RANK();
			cb(res);
		} else {
			cb({ tokens: [] });
		}
	}

	/**
	 * Get the public data-mw structure that exposes the template name and
	 * parameters.
	 */
	getArgInfo(state) {
		var src = this.manager.frame.srcText;
		var params = state.token.attribs;
		// TODO: `dict` might be a good candidate for a T65370 style cleanup as a
		// Map, but since it's intended to be stringified almost immediately, we'll
		// just have to be cautious with it by checking for own properties.
		var dict = Object.create(null);
		var paramInfos = [];
		var argIndex = 1;

		// Use source offsets to extract arg-name and arg-value wikitext
		// since the 'k' and 'v' values in params will be expanded tokens
		//
		// Ignore params[0] -- that is the template name
		for (var i = 1, n = params.length; i < n; i++) {
			var srcOffsets = params[i].srcOffsets;
			var kSrc, vSrc;
			if (srcOffsets) {
				kSrc = src.substring(srcOffsets[0], srcOffsets[1]);
				vSrc = src.substring(srcOffsets[2], srcOffsets[3]);
			} else {
				kSrc = params[i].k;
				vSrc = params[i].v;
			}

			var kWt = kSrc.trim();
			var k = TokenUtils.tokensToString(params[i].k, true, { stripEmptyLineMeta: true });
			if (Array.isArray(k)) {
				// The PHP parser only removes comments and whitespace to construct
				// the real parameter name, so if there were other tokens, use the
				// original text
				k = kWt;
			} else {
				k = k.trim();
			}
			var v = vSrc;

			// Number positional parameters
			var isPositional;
			// Even if k is empty, we need to check v immediately follows. If not,
			// it's a blank parameter name (which is valid) and we shouldn't make it
			// positional.
			if (k === '' && srcOffsets[1] === srcOffsets[2]) {
				isPositional = true;
				k = argIndex.toString();
				argIndex++;
			} else {
				isPositional = false;
				// strip ws from named parameter values
				v = v.trim();
			}

			if (!Object.prototype.hasOwnProperty.call(dict, k)) {
				var paramInfo = {
					k: k,
					srcOffsets: srcOffsets,
				};

				var keySpaceMatch = kSrc.match(/^(\s*)(?:[^]*\S)?(\s*)$/);
				var valueSpaceMatch;

				if (isPositional) {
					// PHP parser does not strip whitespace around
					// positional params and neither will we.
					valueSpaceMatch = [null, '', ''];
				} else {
					paramInfo.named = true;
					valueSpaceMatch = v ? vSrc.match(/^(\s*)(?:[^]*\S)?(\s*)$/) : [null, '', vSrc];
				}

				// Preserve key and value space prefix / postfix, if any.
				// "=" is the default spacing used by the serializer,
				if (keySpaceMatch[1] || keySpaceMatch[2] ||
					valueSpaceMatch[1] || valueSpaceMatch[2]) {
					// Remember non-standard spacing
					paramInfo.spc = [
						keySpaceMatch[1], keySpaceMatch[2],
						valueSpaceMatch[1], valueSpaceMatch[2],
					];
				}

				paramInfos.push(paramInfo);
			}

			dict[k] = { wt: v };
			// Only add the original parameter wikitext if named and different from
			// the actual parameter.
			if (!isPositional && kWt !== k) {
				dict[k].key = { wt: kWt };
			}
		}

		var tplTgtSrcOffsets = params[0].srcOffsets;
		if (tplTgtSrcOffsets) {
			var tplTgtWT = src.substring(tplTgtSrcOffsets[0], tplTgtSrcOffsets[1]);
			return {
				dict: {
					target: {
						wt: tplTgtWT,
						// Add in tpl-target/pf-name info
						// Only one of these will be set.
						'function': state.parserFunctionName,
						href: state.resolvedTemplateTarget,
					},
					params: dict,
				},
				paramInfos: paramInfos,
			};
		}
	}

	/**
	 * Fetch a template.
	 */
	_fetchTemplateAndTitle(title, parentCB, cb, state) {
		var env = this.manager.env;
		if (title in env.pageCache) {
			cb(null, env.pageCache[title]);
		} else if (!env.conf.parsoid.fetchTemplates) {
			var tokens = [state.token.dataAttribs.src];
			if (this.wrapTemplates) {
				// FIXME: We've already emitted a start meta to the accumulator in
				// `_encapsulateTemplate`.  We could reach for that and modify it,
				// or refactor to emit it later for all paths, but the pragmatic
				// thing to do is just ignore it and wrap this anew.
				state.wrappedObjectId = env.newObjectId();
				tokens = this.encapTokens(state, tokens, {
					errors: [
						{
							key: 'mw-api-tplfetch-error',
							message: 'Page / template fetching disabled, and no cache for ' + title,
						},
					],
				});
				var typeOf = tokens[0].getAttribute('typeof');
				tokens[0].setAttribute('typeof', 'mw:Error ' + typeOf);
			}
			parentCB({ tokens: tokens });
		} else {
			// We are about to start an async request for a template
			env.log('debug', 'Note: trying to fetch ', title);
			// Start a new request if none is outstanding
			if (env.requestQueue[title] === undefined) {
				env.requestQueue[title] = new TemplateRequest(env, title);
			}
			// append request, process in document order
			env.requestQueue[title].once('src', function(err, page) {
				cb(err, page ? Util.getStar(page.revision)['*'] : null);
			});
			parentCB({ tokens: [], async: true });
		}
	}

	/**
	 * Fetch the preprocessed wikitext for a template-like construct.
	 */
	fetchExpandedTpl(title, text, parentCB, cb) {
		var env = this.manager.env;
		if (!env.conf.parsoid.fetchTemplates) {
			parentCB({ tokens: [ 'Warning: Page/template fetching disabled cannot expand ' + text] });
		} else {
			// We are about to start an async request for a template
			env.log('debug', 'Note: trying to expand ', text);
			parentCB({ tokens: [], async: true });
			env.batcher.preprocess(title, text).nodify(cb);
		}
	}

	/* ********************** Template argument expansion ****************** */

	/**
	 * Expand template arguments with tokens from the containing frame.
	 */

	onTemplateArg(token, cb) {
		var args = this.manager.frame.args.named();
		var attribs = token.attribs;
		var newCB;

		if (this.options.expandTemplates) {
			// This is a bare use of template arg syntax at the top level
			// outside any template use context.  Wrap this use with RDF attrs.
			// so that this chunk can be RT-ed en-masse.
			var tplHandler = this;
			newCB = function(res) {
				var toks = TokenUtils.stripEOFTkfromTokens(res.tokens);
				var state = {
					token: token,
					wrapperType: "mw:Param",
					wrappedObjectId: tplHandler.manager.env.newObjectId(),
				};
				toks = tplHandler.encapTokens(state, toks);
				cb({ tokens: toks });
			};
		} else {
			newCB = cb;
		}

		this.fetchArg(attribs[0].k, attribs[0].srcOffsets.slice(0,2), ret => this.lookupArg(args, attribs, newCB, cb, ret), cb);
	}

	fetchArg(arg, srcOffsets, argCB, asyncCB) {
		if (arg.constructor === String) {
			argCB({ tokens: [arg] });
		} else {
			this.manager.frame.expand(arg, {
				expandTemplates: false,
				type: "tokens/x-mediawiki/expanded",
				asyncCB: asyncCB,
				srcOffsets,
				cb: function(tokens) {
					argCB({ tokens: TokenUtils.stripEOFTkfromTokens(tokens) });
				},
			});
		}
	}

	lookupArg(args, attribs, cb, asyncCB, ret) {
		var toks    = ret.tokens;
		// FIXME: Why is there a trim in one, but not the other??
		// Feels like a bug
		var argName = toks.constructor === String ? toks : TokenUtils.tokensToString(toks).trim();
		var res     = args.dict[argName];

		// The 'res.constructor !== Function' protects against references to
		// tpl-args named 'prototype' or 'constructor' that haven't been passed in.
		if (res !== null && res !== undefined && res.constructor !== Function) {
			if (res.constructor === String) {
				res = [res];
			}
			cb({ tokens: args.namedArgs[argName] ? TokenUtils.tokenTrim(res) : res });
		} else if (attribs.length > 1) {
			this.fetchArg(attribs[1].v, attribs[1].srcOffsets.slice(2, 4), cb, asyncCB);
		} else {
			cb({ tokens: [ '{{{' + argName + '}}}' ] });
		}
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
TemplateHandler._getParamHTML = Promise.async(TemplateHandler.getParamHTMLG);

if (typeof module === "object") {
	module.exports.TemplateHandler = TemplateHandler;
}
