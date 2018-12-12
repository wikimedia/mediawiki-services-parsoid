/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 * @module
 */

'use strict';

const { PegTokenizer } = require('../tokenizer.js');
const { WikitextConstants } = require('../../config/WikitextConstants.js');
const { Sanitizer } = require('./Sanitizer.js');
const { ContentUtils } = require('../../utils/ContentUtils.js');
const { PipelineUtils } = require('../../utils/PipelineUtils.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');
const { Util } = require('../../utils/Util.js');
const { DOMUtils } = require('../../utils/DOMUtils.js');
const TokenHandler = require('./TokenHandler.js');
const { JSUtils } = require('../../utils/jsutils.js');
const Promise = require('../../utils/promise.js');
const { KV, EOFTk, TagTk, SelfclosingTagTk, EndTagTk, Token } = require('../../tokens/TokenTypes.js');

// shortcuts
const lastItem = JSUtils.lastItem;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class WikiLinkHandler extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		// Handle redirects first (since they used to emit additional link tokens)
		this.manager.addTransformP(this, this.onRedirect,
			'WikiLinkHandler:onRedirect', WikiLinkHandler.rank(), 'tag', 'mw:redirect');

		// Now handle regular wikilinks.
		this.manager.addTransformP(this, this.onWikiLink,
			'WikiLinkHandler:onWikiLink', WikiLinkHandler.rank() + 0.001, 'tag', 'wikilink');

		// Create a new peg parser for image options.
		if (!this.urlParser) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			WikiLinkHandler.prototype.urlParser = new PegTokenizer(this.env);
		}
	}

	static rank() { return 1.15; /* after AttributeExpander */ }

	static _hrefParts(str) {
		const m = str.match(/^([^:]+):(.*)$/);
		return m && { prefix: m[1], title: m[2] };
	}

	/**
	 * Normalize and analyze a wikilink target.
	 *
	 * Returns an object containing
	 * - href: The expanded target string
	 * - hrefSrc: The original target wikitext
	 * - title: A title object *or*
	 * - language: An interwikiInfo object *or*
	 * - interwiki: An interwikiInfo object.
	 * - localprefix: Set if the link had a localinterwiki prefix (or prefixes)
	 * - fromColonEscapedText: Target was colon-escaped ([[:en:foo]])
	 * - prefix: The original namespace or language/interwiki prefix without a
	 *   colon escape.
	 *
	 * @return {Object} The target info.
	 */
	getWikiLinkTargetInfo(token, hrefKV) {
		const env = this.manager.env;

		let info = {
			href: TokenUtils.tokensToString(hrefKV.v),
			hrefSrc: hrefKV.vsrc,
		};

		if (Array.isArray(hrefKV.v) && hrefKV.v.some((t) => {
			if (t instanceof Token &&
					TokenUtils.isDOMFragmentType(t.getAttribute('typeof'))) {
				const firstNode = env.fragmentMap.get(token.dataAttribs.html)[0];
				return firstNode && DOMUtils.isElt(firstNode) &&
					/\bmw:(Nowiki|Extension)/.test(firstNode.getAttribute('typeof'));
			}
			return false;
		})) {
			throw new Error('Xmlish tags in title position are invalid.');
		}

		if (/^:/.test(info.href)) {
			info.fromColonEscapedText = true;
			// remove the colon escape
			info.href = info.href.substr(1);
		}
		if (/^:/.test(info.href)) {
			if (env.conf.parsoid.linting) {
				const lint = {
					dsr: token.dataAttribs.tsr,
					params: { href: ':' + info.href },
					templateInfo: undefined,
				};
				if (this.options.inTemplate) {
					// `frame.title` is already the result of calling
					// `getPrefixedDBKey`, but for the sake of consistency with
					// `findEnclosingTemplateName`, we do a little more work to
					// match `env.makeLink`.
					const name = Sanitizer.sanitizeTitleURI(
						env.page.relativeLinkPrefix +
							this.manager.frame.title
					).replace(/^\.\//, '');
					lint.templateInfo = { name: name };
					// TODO(arlolra): Pass tsr info to the frame
					lint.dsr = [0, 0];
				}
				env.log('lint/multi-colon-escape', lint);
			}
			// This will get caught by the caller, and mark the target as invalid
			throw new Error('Multiple colons prefixing href.');
		}

		const title = env.resolveTitle(Util.decodeURIComponent(info.href));
		const hrefBits = WikiLinkHandler._hrefParts(info.href);
		if (hrefBits) {
			const nsPrefix = hrefBits.prefix;
			info.prefix = nsPrefix;
			const nnn = Util.normalizeNamespaceName(nsPrefix.trim());
			const interwikiInfo = env.conf.wiki.interwikiMap.get(nnn);
			// check for interwiki / language links
			const ns = env.conf.wiki.namespaceIds.get(nnn);
			// also check for url to protect against [[constructor:foo]]
			if (ns !== undefined) {
				info.title = env.makeTitleFromURLDecodedStr(title);
			} else if (interwikiInfo && interwikiInfo.localinterwiki !== undefined) {
				if (hrefBits.title === '') {
					// Empty title => main page (T66167)
					info.title = env.makeTitleFromURLDecodedStr(env.conf.wiki.mainpage);
				} else {
					info.href = hrefBits.title;
					// Recurse!
					hrefKV = new KV('href', (/:/.test(info.href) ? ':' : '') + info.href);
					hrefKV.vsrc = info.hrefSrc;
					info = this.getWikiLinkTargetInfo(token, hrefKV);
					info.localprefix = nsPrefix +
						(info.localprefix ? (':' + info.localprefix) : '');
				}
			} else if (interwikiInfo && interwikiInfo.url) {
				info.href = hrefBits.title;
				// Ensure a valid title, even though we're discarding the result
				env.makeTitleFromURLDecodedStr(title);
				// Interwiki or language link? If no language info, or if it starts
				// with an explicit ':' (like [[:en:Foo]]), it's not a language link.
				if (info.fromColonEscapedText ||
					(interwikiInfo.language === undefined && interwikiInfo.extralanglink === undefined)) {
					// An interwiki link.
					info.interwiki = interwikiInfo;
				} else {
					// A language link.
					info.language = interwikiInfo;
				}
			} else {
				info.title = env.makeTitleFromURLDecodedStr(title);
			}
		} else {
			info.title = env.makeTitleFromURLDecodedStr(title);
		}

		return info;
	}

	/**
	 * Handle mw:redirect tokens.
	 */
	*onRedirectG(token) {
		// Avoid duplicating the link-processing code by invoking the
		// standard onWikiLink handler on the embedded link, intercepting
		// the generated tokens using the callback mechanism, reading
		// the href from the result, and then creating a
		// <link rel="mw:PageProp/redirect"> token from it.

		const rlink = new SelfclosingTagTk('link', Util.clone(token.attribs), Util.clone(token.dataAttribs));
		const wikiLinkTk = rlink.dataAttribs.linkTk;
		rlink.setAttribute('rel', 'mw:PageProp/redirect');

		// Remove the nested wikiLinkTk token and the cloned href attribute
		rlink.dataAttribs.linkTk = undefined;
		rlink.removeAttribute('href');

		// Transfer href attribute back to wikiLinkTk, since it may have been
		// template-expanded in the pipeline prior to this point.
		wikiLinkTk.attribs = Util.clone(token.attribs);

		// Set "redirect" attribute on the wikilink token to indicate that
		// image and category links should be handled as plain links.
		wikiLinkTk.setAttribute('redirect', 'true');

		// Render the wikilink (including interwiki links, etc) then collect
		// the resulting href and transfer it to rlink.
		const r = yield this.onWikiLink(wikiLinkTk);
		const isValid = r && r.tokens && r.tokens[0] &&
			/^(a|link)$/.test(r.tokens[0].name);
		if (isValid) {
			const da = r.tokens[0].dataAttribs;
			rlink.addNormalizedAttribute('href', da.a.href, da.sa.href);
			return { tokens: [rlink] };
		} else {
			// Bail!  Emit tokens as if they were parsed as a list item:
			//  #REDIRECT....
			const src = rlink.dataAttribs.src;
			const tsr = rlink.dataAttribs.tsr;
			const srcMatch = /^([^#]*)(#)/.exec(src);
			const ntokens = srcMatch[1].length ? [ srcMatch[1] ] : [];
			const hashPos = tsr[0] + srcMatch[1].length;
			const li = new TagTk('listItem', [], { tsr: [hashPos, hashPos + 1] });
			li.bullets = [ '#' ];
			ntokens.push(li);
			ntokens.push(src.slice(srcMatch[0].length));
			return { tokens: ntokens.concat(r.tokens) };
		}
	}

	static bailTokens(env, token, isExtLink) {
		const count = isExtLink ? 1 : 2;
		let tokens = ["[".repeat(count)];
		let content = [];

		if (isExtLink) {
			// FIXME: Use this attribute in regular extline
			// cases to rt spaces correctly maybe?  Unsure
			// it is worth it.
			const spaces = token.getAttribute('spaces') || '';
			if (spaces.length) { content.push(spaces); }

			const mwc = token.getAttribute('mw:content');
			if (mwc.length) { content = content.concat(mwc); }
		} else {
			token.attribs.forEach((a) => {
				if (a.k === "mw:maybeContent") {
					content = content.concat("|", a.v);
				}
			});
		}

		let dft;
		if (/mw:ExpandedAttrs/.test(token.getAttribute("typeof"))) {
			const dataMW = JSON.parse(token.getAttribute("data-mw")).attribs;
			let html;
			for (let i = 0; i < dataMW.length; i++) {
				if (dataMW[i][0].txt === "href") {
					html = dataMW[i][1].html;
					break;
				}
			}

			// Since we are splicing off '['s and ']'s from the incoming token,
			// adjust TSR of the DOM-fragment by `count` each on both end.
			let tsr = token.dataAttribs && token.dataAttribs.tsr;
			if (tsr && typeof (tsr[0]) === 'number' && typeof (tsr[1]) === 'number') {
				// If content is present, the fragment we're building doesn't
				// extend all the way to the end of the token, so the end tsr
				// is invalid.
				const end = content.length > 0 ? null : tsr[1] - count;
				tsr = [tsr[0] + count, end];
			} else {
				tsr = null;
			}

			const body = ContentUtils.ppToDOM(html);
			dft = PipelineUtils.buildDOMFragmentTokens(env, token, body, {
				tsr: tsr,
				pipelineOpts: { inlineContext: true },
			});
		} else {
			dft = token.getAttribute("href");
		}

		tokens = tokens.concat(dft, content, "]".repeat(count));
		return tokens;
	}

	/**
	 * Handle a mw:WikiLink token.
	 */
	*onWikiLinkG(token) {
		const env = this.manager.env;
		const hrefKV = KV.lookupKV(token.attribs, 'href');
		let target;

		try {
			target = this.getWikiLinkTargetInfo(token, hrefKV);
		} catch (e) {
			// Invalid title
			target = null;
		}

		if (!target) {
			return { tokens: WikiLinkHandler.bailTokens(env, token, false) };
		}

		// First check if the expanded href contains a pipe.
		if (/[|]/.test(target.href)) {
			// It does. This 'href' was templated and also returned other
			// parameters separated by a pipe. We don't have any sane way to
			// handle such a construct currently, so prevent people from editing
			// it.
			// TODO: add useful debugging info for editors ('if you would like to
			// make this content editable, then fix template X..')
			// TODO: also check other parameters for pipes!
			return { tokens: TokenUtils.placeholder(null, token.dataAttribs) };
		}

		// Don't allow internal links to pages containing PROTO:
		// See Parser::replaceInternalLinks2()
		if (env.conf.wiki.hasValidProtocol(target.href)) {
			// NOTE: Tokenizing this as src seems little suspect
			const src = '[' + token.attribs.slice(1).reduce((prev, next) => {
				return prev + '|' + TokenUtils.tokensToString(next.v);
			}, target.href) + ']';

			let extToks = this.urlParser.tokenizeExtlink(src);
			if (!(extToks instanceof Error)) {
				const tsr = token.dataAttribs && token.dataAttribs.tsr;
				TokenUtils.shiftTokenTSR(extToks, 1 + (tsr ? tsr[0] : 0));
			} else {
				extToks = src;
			}

			const tokens = ['['].concat(extToks, ']');
			tokens.rank = WikiLinkHandler.rank() - 0.002;  // Magic rank, since extlink is -0.001
			return { tokens: tokens };
		}

		// Ok, it looks like we have a sane href. Figure out which handler to use.
		const isRedirect = !!token.getAttribute('redirect');
		return (yield this._wikiLinkHandler(token, target, isRedirect));
	}

	/**
	 * Figure out which handler to use to render a given WikiLink token. Override
	 * this method to add new handlers or swap out existing handlers based on the
	 * target structure.
	 */
	_wikiLinkHandler(token, target, isRedirect) {
		const title = target.title;
		if (title) {
			if (isRedirect) {
				return this.renderWikiLink(token, target);
			}
			if (title.getNamespace().isMedia()) {
				// Render as a media link.
				return this.renderMedia(token, target);
			}
			if (!target.fromColonEscapedText) {
				if (title.getNamespace().isFile()) {
					// Render as a file.
					return this.renderFile(token, target);
				}
				if (title.getNamespace().isCategory()) {
					// Render as a category membership.
					return this.renderCategory(token, target);
				}
			}
			// Render as plain wiki links.
			return this.renderWikiLink(token, target);

			// language and interwiki links
		} else {
			if (target.interwiki) {
				return this.renderInterwikiLink(token, target);
			} else if (target.language) {
				const noLanguageLinks = this.env.page.title.getNamespace().isATalkNamespace() ||
					!this.env.conf.wiki.interwikimagic;
				if (noLanguageLinks) {
					target.interwiki = target.language;
					return this.renderInterwikiLink(token, target);
				} else {
					return this.renderLanguageLink(token, target);
				}
			}
		}

		// Neither a title, nor a language or interwiki. Should not happen.
		throw new Error("Unknown link type");
	}

	/* ------------------------------------------------------------
	* This (overloaded) function does three different things:
	* - Extracts link text from attrs (when k === "mw:maybeContent").
	*   As a performance micro-opt, only does if asked to (getLinkText)
	* - Updates existing rdfa type with an additional rdf-type,
	*   if one is provided (rdfaType)
	* - Collates about, typeof, and linkAttrs into a new attr. array
	* ------------------------------------------------------------ */
	static buildLinkAttrs(attrs, getLinkText, rdfaType, linkAttrs) {
		let newAttrs = [];
		const linkTextKVs = [];
		let about;

		// In one pass through the attribute array, fetch about, typeof, and linkText
		//
		// about && typeof are usually at the end of the array if at all present
		for (let i = 0, l = attrs.length; i < l; i++) {
			const kv = attrs[i];
			const k  = kv.k;
			const v  = kv.v;

			// link-text attrs have the key "maybeContent"
			if (getLinkText && k === "mw:maybeContent") {
				linkTextKVs.push(kv);
			} else if (k.constructor === String && k) {
				if (k.trim() === "typeof") {
					rdfaType = rdfaType ? rdfaType + " " + v : v;
				} else if (k.trim() === "about") {
					about = v;
				} else if (k.trim() === "data-mw") {
					newAttrs.push(kv);
				}
			}
		}

		if (rdfaType) {
			newAttrs.push(new KV('typeof', rdfaType));
		}

		if (about) {
			newAttrs.push(new KV('about', about));
		}

		if (linkAttrs) {
			newAttrs = newAttrs.concat(linkAttrs);
		}

		return {
			attribs: newAttrs,
			contentKVs: linkTextKVs,
			hasRdfaType: rdfaType !== null,
		};
	}

	/**
	 * Generic wiki link attribute setup on a passed-in new token based on the
	 * wikilink token and target. As a side effect, this method also extracts the
	 * link content tokens and returns them.
	 *
	 * @return {Array} Content tokens.
	 */
	addLinkAttributesAndGetContent(newTk, token, target, buildDOMFragment) {
		const attribs = token.attribs;
		const dataAttribs = token.dataAttribs;
		const newAttrData = WikiLinkHandler.buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]);
		let content = newAttrData.contentKVs;
		const env = this.manager.env;

		// Set attribs and dataAttribs
		newTk.attribs = newAttrData.attribs;
		newTk.dataAttribs = Util.clone(dataAttribs);
		newTk.dataAttribs.src = undefined; // clear src string since we can serialize this

		// Note: Link tails are handled on the DOM in handleLinkNeighbours, so no
		// need to handle them here.
		if (content.length > 0) {
			newTk.dataAttribs.stx = 'piped';
			let out = [];
			const l = content.length;
			// re-join content bits
			for (let i = 0; i < l; i++) {
				let toks = content[i].v;
				// since this is already a link, strip autolinks from content
				if (!Array.isArray(toks)) { toks = [ toks ]; }
				toks = toks.filter(t => t !== '');
				toks = toks.map((t, j) => {
					if (t.constructor === TagTk && t.name === 'a') {
						if (toks[j + 1] && toks[j + 1].constructor === EndTagTk &&
							toks[j + 1].name === 'a') {
							// autonumbered links in the stream get rendered
							// as an <a> tag with no content -- but these ought
							// to be treated as plaintext since we don't allow
							// nested links.
							return '[' + t.getAttribute('href') + ']';
						}
						return ''; // suppress <a>
					}
					if (t.constructor === EndTagTk && t.name === 'a') {
						return ''; // suppress </a>
					}
					return t;
				});
				toks = toks.filter(t => t !== '');
				out = out.concat(toks);
				if (i < l - 1) {
					out.push('|');
				}
			}

			if (buildDOMFragment) {
				// content = [part 0, .. part l-1]
				// offsets = [start(part-0), end(part l-1)]
				const offsets = dataAttribs.tsr ? [content[0].srcOffsets[0], content[l - 1].srcOffsets[1]] : null;
				content = [ PipelineUtils.getDOMFragmentToken(out, offsets, { inlineContext: true, token: token }) ];
			} else {
				content = out;
			}
		} else {
			newTk.dataAttribs.stx = 'simple';
			let morecontent = Util.decodeURIComponent(target.href);

			// Strip leading colon
			morecontent = morecontent.replace(/^:/, '');

			// Try to match labeling in core
			if (env.conf.wiki.namespacesWithSubpages[env.page.ns]) {
				// subpage links with a trailing slash get the trailing slashes stripped.
				// See https://gerrit.wikimedia.org/r/173431
				const match = morecontent.match(/^((\.\.\/)+|\/)(?!\.\.\/)(.*?[^\/])\/+$/);
				if (match) {
					morecontent = match[3];
				} else if (/^\.\.\//.test(morecontent)) {
					morecontent = env.resolveTitle(morecontent);
				}
			}

			// for interwiki links, include the interwiki prefix in the link text
			if (target.interwiki) {
				morecontent = target.prefix + ':' + morecontent;
			}

			// for local links, include the local prefix in the link text
			if (target.localprefix) {
				morecontent = target.localprefix + ':' + morecontent;
			}

			content = [ morecontent ];
		}
		return content;
	}

	/**
	 * Render a plain wiki link.
	 */
	*renderWikiLinkG(token, target) { // eslint-disable-line require-yield
		const newTk = new TagTk('a');
		const content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

		newTk.addNormalizedAttribute('href', this.env.makeLink(target.title), target.hrefSrc);

		// Add title unless it's just a fragment
		if (target.href[0] !== '#') {
			newTk.setAttribute('title', target.title.getPrefixedText());
		}

		return { tokens: [newTk].concat(content, [new EndTagTk('a')]) };
	}

	/**
	 * Render a category 'link'. Categories are really page properties, and are
	 * normally rendered in a box at the bottom of an article.
	 */
	*renderCategoryG(token, target) {
		const tokens = [];
		const newTk = new SelfclosingTagTk('link');
		const content = this.addLinkAttributesAndGetContent(newTk, token, target);
		const env = this.manager.env;

		// Change the rel to be mw:PageProp/Category
		KV.lookupKV(newTk.attribs, 'rel').v = 'mw:PageProp/Category';

		const strContent = TokenUtils.tokensToString(content);
		const saniContent = Sanitizer.sanitizeTitleURI(strContent).replace(/#/g, '%23');
		newTk.addNormalizedAttribute('href', env.makeLink(target.title), target.hrefSrc);
		// Change the href to include the sort key, if any (but don't update the rt info)
		if (strContent && strContent !== '' && strContent !== target.href) {
			const hrefkv = KV.lookupKV(newTk.attribs, 'href');
			hrefkv.v += '#';
			hrefkv.v += saniContent;
		}

		tokens.push(newTk);

		if (content.length === 1) {
			return { tokens: tokens };
		} else {
			// Deal with sort keys that come from generated content (transclusions, etc.)
			const inVals = [ { "txt": "mw:sortKey" }, { "html": content } ];
			const outVals = yield PipelineUtils.expandValuesToDOM(
				this.manager.env,
				this.manager.frame,
				inVals,
				this.options.expandTemplates,
				this.options.inTemplate
			);
			let dataMW = newTk.getAttribute("data-mw");
			if (dataMW) {
				dataMW = JSON.parse(dataMW);
				dataMW.attribs.push(outVals);
			} else {
				dataMW = { attribs: [outVals] };
			}

			// Mark token as having expanded attrs
			newTk.addAttribute("about", env.newAboutId());
			newTk.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
			newTk.addAttribute("data-mw", JSON.stringify(dataMW));

			return { tokens: tokens };
		}
	}

	/**
	 * Render a language link. Those normally appear in the list of alternate
	 * languages for an article in the sidebar, so are really a page property.
	 */
	*renderLanguageLinkG(token, target) { // eslint-disable-line require-yield
		// The prefix is listed in the interwiki map

		const newTk = new SelfclosingTagTk('link', [], token.dataAttribs);
		this.addLinkAttributesAndGetContent(newTk, token, target);

		// add title attribute giving the presentation name of the
		// "extra language link"
		if (target.language.extralanglink !== undefined &&
			target.language.linktext) {
			newTk.addNormalizedAttribute('title', target.language.linktext);
		}

		// We set an absolute link to the article in the other wiki/language
		const title = Sanitizer.sanitizeTitleURI(Util.decodeURIComponent(target.href));
		let absHref = target.language.url.replace("$1", title);
		if (target.language.protorel !== undefined) {
			absHref = absHref.replace(/^https?:/, '');
		}
		newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

		// Change the rel to be mw:PageProp/Language
		KV.lookupKV(newTk.attribs, 'rel').v = 'mw:PageProp/Language';

		return { tokens: [newTk] };
	}

	/**
	 * Render an interwiki link.
	 */
	*renderInterwikiLinkG(token, target) { // eslint-disable-line require-yield
		// The prefix is listed in the interwiki map

		let tokens = [];
		const newTk = new TagTk('a', [], token.dataAttribs);
		const content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

		// We set an absolute link to the article in the other wiki/language
		const title = Sanitizer.sanitizeTitleURI(Util.decodeURIComponent(target.href));
		let absHref = target.interwiki.url.replace("$1", title);
		if (target.interwiki.protorel !== undefined) {
			absHref = absHref.replace(/^https?:/, '');
		}
		newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

		// Change the rel to be mw:ExtLink
		KV.lookupKV(newTk.attribs, 'rel').v = 'mw:WikiLink/Interwiki';
		// Remember that this was using wikitext syntax though
		newTk.dataAttribs.isIW = true;
		// Add title unless it's just a fragment (and trim off fragment)
		// (The normalization here is similar to what Title#getPrefixedDBKey() does.)
		if (target.href[0] !== "#") {
			const titleAttr = target.interwiki.prefix + ':' +
				Util.decodeURIComponent(target.href.replace(/#[\s\S]*/, '').replace(/_/g, ' '));
			newTk.setAttribute("title", titleAttr);
		}
		tokens.push(newTk);

		tokens = tokens.concat(content, [new EndTagTk('a')]);
		return { tokens: tokens };
	}

	/**
	 * Get the format for media.
	 */
	static getFormat(opts) {
		if (opts.manualthumb) {
			return "thumbnail";
		}
		return opts.format && opts.format.v;
	}

	/**
	 * Extract the dimensions for media.
	 */
	static handleSize(env, opts, info) {
		let height = info.height;
		let width = info.width;

		console.assert(typeof height === 'number' && !Number.isNaN(height));
		console.assert(typeof width === 'number' && !Number.isNaN(width));

		if (info.thumburl && info.thumbheight) {
			height = info.thumbheight;
		}

		if (info.thumburl && info.thumbwidth) {
			width = info.thumbwidth;
		}

		// Audio files don't have dimensions, so we fallback to these arbitrary
		// defaults, and the "mw-default-audio-height" class is added.
		if (info.mediatype === 'AUDIO') {
			height = /* height || */ 32;  // Arguably, audio should respect a defined height
			width = width || env.conf.wiki.widthOption;
		}

		let mustRender;
		if (info.mustRender !== undefined) {
			mustRender = info.mustRender;
		} else {
			mustRender = info.mediatype !== 'BITMAP';
		}

		// Handle client-side upscaling (including 'border')

		// Calculate the scaling ratio from the user-specified width and height
		let ratio = null;
		if (opts.size.v.height && info.height) {
			ratio = opts.size.v.height / info.height;
		}
		if (opts.size.v.width && info.width) {
			const r = opts.size.v.width / info.width;
			ratio = (ratio === null || r < ratio) ? r : ratio;
		}

		if (ratio !== null && ratio > 1) {
			// If the user requested upscaling, then this is denied in the thumbnail
			// and frameless format, except for files with mustRender.
			const format = WikiLinkHandler.getFormat(opts);
			if (!mustRender && (format === 'thumbnail' || format === 'frameless')) {
				// Upscaling denied
				height = info.height;
				width = info.width;
			} else {
				// Upscaling allowed
				// In the batch API, these will already be correct, but the non-batch
				// API returns the source width and height whenever client-side scaling
				// is requested.
				if (!env.conf.parsoid.useBatchAPI) {
					height = Math.round(info.height * ratio);
					width = Math.round(info.width * ratio);
				}
			}
		}

		return { height: height, width: width };
	}

	/**
	 * Get the style and class lists for an image's wrapper element.
	 *
	 * @private
	 * @param {Object} opts The option hash from renderFile.
	 * @param {Object} info The info hash from handleInfo.
	 * @return {Object}
	 * @return {boolean} return.isInline Whether the image is inline after handling options.
	 * @return {Array} return.classes The list of classes for the wrapper.
	 */
	static getWrapperInfo(opts, info) {
		const format = WikiLinkHandler.getFormat(opts);
		let isInline = !(format === 'thumbnail' || format === 'framed');
		const wrapperClasses = [];
		let halign = (opts.format && opts.format.v === 'framed') ? 'right' : null;

		if (!opts.size.src) {
			wrapperClasses.push('mw-default-size');
		}

		// Hardcoded until defined heights are respected.  See `handleSize`
		if (info.mediatype === 'AUDIO') {
			wrapperClasses.push('mw-default-audio-height');
		}

		if (opts.border) {
			wrapperClasses.push('mw-image-border');
		}

		if (opts.halign) {
			halign = opts.halign.v;
		}

		const halignOpt = opts.halign && opts.halign.v;
		switch (halign) {
			case 'none':
			// PHP parser wraps in <div class="floatnone">
				isInline = false;
				if (halignOpt === 'none') {
					wrapperClasses.push('mw-halign-none');
				}
				break;

			case 'center':
			// PHP parser wraps in <div class="center"><div class="floatnone">
				isInline = false;
				if (halignOpt === 'center') {
					wrapperClasses.push('mw-halign-center');
				}
				break;

			case 'left':
			// PHP parser wraps in <div class="floatleft">
				isInline = false;
				if (halignOpt === 'left') {
					wrapperClasses.push('mw-halign-left');
				}
				break;

			case 'right':
			// PHP parser wraps in <div class="floatright">
				isInline = false;
				if (halignOpt === 'right') {
					wrapperClasses.push('mw-halign-right');
				}
				break;
		}

		if (isInline) {
			const valignOpt = opts.valign && opts.valign.v;
			switch (valignOpt) {
				case 'middle':
					wrapperClasses.push('mw-valign-middle');
					break;

				case 'baseline':
					wrapperClasses.push('mw-valign-baseline');
					break;

				case 'sub':
					wrapperClasses.push('mw-valign-sub');
					break;

				case 'super':
					wrapperClasses.push('mw-valign-super');
					break;

				case 'top':
					wrapperClasses.push('mw-valign-top');
					break;

				case 'text_top':
					wrapperClasses.push('mw-valign-text-top');
					break;

				case 'bottom':
					wrapperClasses.push('mw-valign-bottom');
					break;

				case 'text_bottom':
					wrapperClasses.push('mw-valign-text-bottom');
					break;
			}
		}

		return {
			classes: wrapperClasses,
			isInline: isInline,
		};
	}

	/**
	 * Abstract way to get the path for an image given an info object.
	 *
	 * @private
	 * @param {Object} info
	 * @param {string|null} info.thumburl The URL for a thumbnail.
	 * @param {string} info.url The base URL for the image.
	 */
	static getPath(info) {
		let path = '';
		if (info.thumburl) {
			path = info.thumburl;
		} else if (info.url) {
			path = info.url;
		}
		return path.replace(/^https?:\/\//, '//');
	}

	/**
	 * Determine the name of an option.
	 * @return {Object}
	 * @return {string} return.ck Canonical key for the image option.
	 * @return {string} return.v Value of the option.
	 * @return {string} return.ak
	 *   Aliased key for the image option - includes `"$1"` for placeholder.
	 * @return {string} return.s
	 *   Whether it's a simple option or one with a value.
	 */
	static getOptionInfo(optStr, env) {
		const oText = optStr.trim();
		const lowerOText = oText.toLowerCase();
		const getOption = env.conf.wiki.getMagicPatternMatcher(
			WikitextConstants.Media.PrefixOptions);
		// oText contains the localized name of this option.  the
		// canonical option names (from mediawiki upstream) are in
		// English and contain an '(img|timedmedia)_' prefix.  We drop the
		// prefix before stuffing them in data-parsoid in order to
		// save space (that's shortCanonicalOption)
		const canonicalOption = env.conf.wiki.magicWords[oText] ||
			env.conf.wiki.magicWords[lowerOText] || '';
		let shortCanonicalOption = canonicalOption.replace(/^(img|timedmedia)_/,  '');
		// 'imgOption' is the key we'd put in opts; it names the 'group'
		// for the option, and doesn't have an img_ prefix.
		const imgOption = WikitextConstants.Media.SimpleOptions.get(canonicalOption);
		const bits = getOption(optStr.trim());
		const normalizedBit0 = bits ? bits.k.trim().toLowerCase() : null;
		const key = bits ? WikitextConstants.Media.PrefixOptions.get(normalizedBit0) : null;

		if (imgOption && key === null) {
			return {
				ck: imgOption,
				v: shortCanonicalOption,
				ak: optStr,
				s: true,
			};
		} else {
			// bits.a has the localized name for the prefix option
			// (with $1 as a placeholder for the value, which is in bits.v)
			// 'normalizedBit0' is the canonical English option name
			// (from mediawiki upstream) with a prefix.
			// 'key' is the parsoid 'group' for the option; it doesn't
			// have a prefix (it's the key we'd put in opts)

			if (bits && key) {
				shortCanonicalOption = normalizedBit0.replace(/^(img|timedmedia)_/,  '');
				// map short canonical name to the localized version used

				// Note that we deliberately do entity decoding
				// *after* splitting so that HTML-encoded pipes don't
				// separate options.  This matches PHP, whether or
				// not it's a good idea.
				return {
					ck: shortCanonicalOption,
					v: Util.decodeWtEntities(bits.v),
					ak: optStr,
					s: false,
				};
			} else {
				return null;
			}
		}
	}

	/**
	 * Make option token streams into a stringy thing that we can recognize.
	 *
	 * @param {Array} tstream
	 * @param {string} prefix Anything that came before this part of the recursive call stack.
	 * @return {string|null}
	 */
	static stringifyOptionTokens(tstream, prefix, env) {
		// Seems like this should be a more general "stripTags"-like function?
		let tokenType, tkHref, nextResult, optInfo, skipToEndOf;
		let resultStr = '';
		const cachedOptInfo = () => {
			if (optInfo === undefined) {
				optInfo = WikiLinkHandler.getOptionInfo(prefix + resultStr, env);
			}
			return optInfo;
		};
		const isWhitelistedOpt = () => {
			// link and alt options are whitelisted for accepting arbitrary
			// wikitext (even though only strings are supported in reality)
			// SSS FIXME: Is this actually true of all options rather than
			// just link and alt?
			return cachedOptInfo() && /^(link|alt)$/.test(cachedOptInfo().ck);
		};

		prefix = prefix || '';

		for (let i = 0; i < tstream.length; i++) {
			const currentToken = tstream[i];

			if (skipToEndOf) {
				if (currentToken.name === skipToEndOf && currentToken.constructor === EndTagTk) {
					skipToEndOf = undefined;
				}
				continue;
			}

			if (currentToken.constructor === String) {
				resultStr += currentToken;
			} else if (Array.isArray(currentToken)) {
				nextResult = WikiLinkHandler.stringifyOptionTokens(currentToken, prefix + resultStr, env);

				if (nextResult === null) {
					return null;
				}

				resultStr += nextResult;
			} else if (currentToken.constructor !== EndTagTk) {
				// This is actually a token
				if (TokenUtils.isDOMFragmentType(currentToken.getAttribute('typeof'))) {
					if (isWhitelistedOpt()) {
						resultStr += TokenUtils.tokensToString([currentToken], false, {
							unpackDOMFragments: true,
							env,  // FIXME: Sneaking in `env` to avoid changing the signature
						});
						optInfo = undefined; // might change the nature of opt
						continue;
					} else {
						// if this is a nowiki, we must be in a caption
						return null;
					}
				}
				if (currentToken.name === 'mw-quote') {
					if (isWhitelistedOpt()) {
						// just recurse inside
						optInfo = undefined; // might change the nature of opt
						continue;
					}
				}
				// Similar to TokenUtils.tokensToString()'s includeEntities
				if (TokenUtils.isEntitySpanToken(currentToken)) {
					resultStr += currentToken.dataAttribs.src;
					skipToEndOf = 'span';
					continue;
				}
				if (currentToken.name === 'a') {
					if (optInfo === undefined) {
						optInfo = WikiLinkHandler.getOptionInfo(prefix + resultStr, env);
						if (optInfo === null) {
							// An <a> tag before a valid option?
							// This is most likely a caption.
							optInfo = undefined;
							return null;
						}
					}

					if (isWhitelistedOpt()) {
						tokenType = currentToken.getAttribute('rel');
						tkHref = currentToken.getAttribute('href');
						const isLink = (optInfo.ck === 'link');
						// Reset the optInfo since we're changing the nature of it
						optInfo = undefined;
						// Figure out the proper string to put here and break.
						if (
							tokenType === 'mw:ExtLink' &&
								currentToken.dataAttribs.stx === 'url'
						) {
							// Add the URL
							resultStr += tkHref;
							// Tell our loop to skip to the end of this tag
							skipToEndOf = 'a';
						} else if (tokenType === 'mw:WikiLink/Interwiki') {
							if (isLink) {
								resultStr += currentToken.getAttribute('href');
								i += 2;
								continue;
							}
							// Nothing to do -- the link content will be
							// captured by walking the rest of the tokens.
						} else if (tokenType === 'mw:WikiLink' || tokenType === 'mw:MediaLink') {
							// Nothing to do -- the link content will be
							// captured by walking the rest of the tokens.
						} else {
							// There shouldn't be any other kind of link...
							// This is likely a caption.
							return null;
						}
					} else {
						// Why would there be an a tag without a link?
						return null;
					}
				}
			}
		}

		return resultStr;
	}

	// Set up the actual image structure, attributes etc
	handleImage(opts, info, _, dataMw, optSources) {
		const img = new SelfclosingTagTk('img', []);

		if ('alt' in opts) {
			img.addNormalizedAttribute('alt', opts.alt.v, opts.alt.src);
		}

		img.addNormalizedAttribute('resource', this.env.makeLink(opts.title.v), opts.title.src);
		img.addAttribute('src', WikiLinkHandler.getPath(info));

		if (opts.lang) {
			img.addNormalizedAttribute('lang', opts.lang.v, opts.lang.src);
		}

		if (!dataMw.errors) {
			// Add (read-only) information about original file size (T64881)
			img.addAttribute('data-file-width', String(info.width));
			img.addAttribute('data-file-height', String(info.height));
			img.addAttribute('data-file-type', info.mediatype && info.mediatype.toLowerCase());
		}

		const size = WikiLinkHandler.handleSize(this.env, opts, info);
		img.addNormalizedAttribute('height', String(size.height));
		img.addNormalizedAttribute('width', String(size.width));

		if (opts.page) {
			dataMw.page = opts.page.v;
		}

		// Handle "responsive" images, i.e. srcset
		if (info.responsiveUrls) {
			const candidates = [];
			Object.keys(info.responsiveUrls).forEach((density) => {
				candidates.push(
					info.responsiveUrls[density].replace(/^https?:\/\//, '//') +
						' ' + density + 'x');
			});
			if (candidates.length > 0) {
				img.addAttribute('srcset', candidates.join(', '));
			}
		}

		return {
			rdfaType: 'mw:Image',
			elt: img,
			hasLink: (opts.link === undefined || opts.link && opts.link.v !== ''),
		};
	}

	static addTracks(info) {
		let timedtext;
		if (info.thumbdata && Array.isArray(info.thumbdata.timedtext)) {
			// BatchAPI's `getAPIData`
			timedtext = info.thumbdata.timedtext;
		} else if (Array.isArray(info.timedtext)) {
			// "videoinfo" prop
			timedtext = info.timedtext;
		} else {
			timedtext = [];
		}
		return timedtext.map((o) => {
			const track = new SelfclosingTagTk('track');
			track.addAttribute('kind', o.kind);
			track.addAttribute('type', o.type);
			track.addAttribute('src', o.src);
			track.addAttribute('srclang', o.srclang);
			track.addAttribute('label', o.label);
			track.addAttribute('data-mwtitle', o.title);
			track.addAttribute('data-dir', o.dir);
			return track;
		});
	}

	// This is a port of TMH's parseTimeString()
	static parseTimeString(timeString, length) {
		let time = 0;
		const parts = timeString.split(':');
		if (parts.length > 3) {
			return false;
		}
		for (let i = 0; i < parts.length; i++) {
			const num = parseInt(parts[i], 10);
			if (Number.isNaN(num)) {
				return false;
			}
			time += num * Math.pow(60, parts.length - 1 - i);
		}
		if (time < 0) {
			time = 0;
		} else if (length !== undefined) {
			console.assert(typeof length === 'number');
			if (time > length) { time = length - 1; }
		}
		return time;
	}

	// Handle media fragments
	// https://www.w3.org/TR/media-frags/
	static parseFrag(info, opts, dataMw) {
		let time;
		let frag = '';
		if (opts.starttime || opts.endtime) {
			frag += '#t=';
			if (opts.starttime) {
				time = WikiLinkHandler.parseTimeString(opts.starttime.v, info.duration);
				if (time !== false) {
					frag += time;
				}
				dataMw.starttime = opts.starttime.v;
			}
			if (opts.endtime) {
				time = WikiLinkHandler.parseTimeString(opts.endtime.v, info.duration);
				if (time !== false) {
					frag += ',' + time;
				}
				dataMw.endtime = opts.endtime.v;
			}
		}
		return frag;
	}

	static addSources(info, opts, dataMw, hasDimension) {
		const frag = WikiLinkHandler.parseFrag(info, opts, dataMw);

		let derivatives;
		let dataFromTMH = true;
		if (info.thumbdata && Array.isArray(info.thumbdata.derivatives)) {
			// BatchAPI's `getAPIData`
			derivatives = info.thumbdata.derivatives;
		} else if (Array.isArray(info.derivatives)) {
			// "videoinfo" prop
			derivatives = info.derivatives;
		} else {
			derivatives = [
				{
					src: info.url,
					type: info.mime,
					width: String(info.width),
					height: String(info.height),
				},
			];
			dataFromTMH = false;
		}

		return derivatives.map((o) => {
			const source = new SelfclosingTagTk('source');
			source.addAttribute('src', o.src + frag);
			source.addAttribute('type', o.type);
			const fromFile = o.transcodekey !== undefined ? '' : '-file';
			if (hasDimension) {
				source.addAttribute('data' + fromFile + '-width', o.width);
				source.addAttribute('data' + fromFile + '-height', o.height);
			}
			if (dataFromTMH) {
				source.addAttribute('data-title', o.title);
				source.addAttribute('data-shorttitle', o.shorttitle);
			}
			return source;
		});
	}

	// These options don't exist for media.  They can be specified, but not added
	// to the output.  However, we make sure to preserve them.  Note that if
	// `optSources` is not `null`, all options are preserved so this is redundant.
	static silentOptions(opts, dataMw, optSources) {
		if (!optSources) {
			if (opts.hasOwnProperty('alt')) {
				if (!dataMw.attribs) { dataMw.attribs = []; }
				dataMw.attribs.push(['alt', { html: opts.alt.src }]);
			}
			if (opts.hasOwnProperty('link')) {
				if (!dataMw.attribs) { dataMw.attribs = []; }
				dataMw.attribs.push(['href', { html: opts.link.src }]);
			}
		}
	}

	handleVideo(opts, info, manualinfo, dataMw, optSources) {
		const start = new TagTk('video');

		if (manualinfo || info.thumburl) {
			start.addAttribute('poster', WikiLinkHandler.getPath(manualinfo || info));
		}

		start.addAttribute('controls', '');
		start.addAttribute('preload', 'none');

		const size = WikiLinkHandler.handleSize(this.env, opts, info);
		start.addNormalizedAttribute('height', String(size.height));
		start.addNormalizedAttribute('width', String(size.width));

		start.addNormalizedAttribute(
			'resource',
			this.env.makeLink(opts.title.v),
			opts.title.src
		);

		WikiLinkHandler.silentOptions(opts, dataMw, optSources);

		if (opts.thumbtime) {
			dataMw.thumbtime = opts.thumbtime.v;
		}

		const sources = WikiLinkHandler.addSources(info, opts, dataMw, true);
		const tracks = WikiLinkHandler.addTracks(info);

		const end = new EndTagTk('video');
		const elt = [start].concat(sources, tracks, end);

		return {
			rdfaType: 'mw:Video',
			elt: elt,
			hasLink: false,
		};
	}

	handleAudio(opts, info, manualinfo, dataMw, optSources) {
		const start = new TagTk('audio');

		start.addAttribute('controls', '');
		start.addAttribute('preload', 'none');

		const size = WikiLinkHandler.handleSize(this.env, opts, info);
		start.addNormalizedAttribute('height', String(size.height));
		start.addNormalizedAttribute('width', String(size.width));

		start.addNormalizedAttribute(
			'resource',
			this.env.makeLink(opts.title.v),
			opts.title.src
		);

		WikiLinkHandler.silentOptions(opts, dataMw, optSources);

		const sources = WikiLinkHandler.addSources(info, opts, dataMw, false);
		const tracks = WikiLinkHandler.addTracks(info);

		const end = new EndTagTk('audio');
		const elt = [start].concat(sources, tracks, end);

		return {
			rdfaType: 'mw:Audio',
			elt: elt,
			hasLink: false,
		};
	}

	// Unfortunately, we need the size and title before doing the info request,
	// which depend on having parsed options.  Since `getOptionInfo()` happens
	// before knowing the mediatype, we end up being too liberal in what options
	// are permitted, and then need to retroactively flag them as bogus.  This
	// leads to a problem with needing the original tokens of the bogus options
	// that then become the caption.  For example:
	//  [[File:Foo.jpg|thumbtime=[[Foo]]]]
	// Since Foo.jpg is not a video, PHP will parse everything after | as a caption.
	// If Parsoid were to emulate this, we'd have trouble making [[Foo]] a valid
	// link without the original tokens. See the FIXME.
	//
	// However, the fact that the caption is dependent on the exact set of options
	// parsed is a bug, not a feature.  It prevents anyone from ever safely adding
	// media options in the future, since any new option could potentially change
	// the caption in existing wikitext.  So, rather than jumping through hoops
	// to support this, we should probably look towards being stricter on the PHP
	// side, and migrating content. (T163582)
	static markAsBogus(opts, optList, prefix) {
		let seenCaption = false;
		for (let i = optList.length - 1; i > -1; i--) {
			const o = optList[i];
			const key = prefix + o.ck;
			if (
				o.ck === 'bogus' ||
				WikitextConstants.Media.SimpleOptions.has(key) ||
					WikitextConstants.Media.PrefixOptions.has(key)
			) {
				continue;
			}
			// Aha! bogus
			if (seenCaption) {
				o.ck = 'bogus';
				continue;
			}
			seenCaption = true;
			if (o.ck === 'caption') {
				continue;
			}
			opts.caption = opts[o.ck];
			// FIXME: This should use the original tokens.
			opts.caption.v = opts.caption.src || opts.caption.v;
			opts[o.ck] = undefined;
			o.ck = 'caption';
		}
	}

	static extractInfo(env, o) {
		// FIXME: this is more complicated than it ought to be because
		// we're trying to handle more than one different data format:
		// batching returns one, videoinfo returns another, imageinfo
		// returns a third.  We should fix this!  If we need to do
		// conversions, they should probably live inside Batcher, since
		// all of these results ultimately come from the Batcher.imageinfo
		// method (no one calls ImageInfoRequest directly any more).
		const data = o.data;
		if (env.conf.parsoid.useBatchAPI) {
			return data.batchResponse;
		} else {
			const ns = data.imgns;
			// `useVideoInfo` is for legacy requests; batching returns thumbdata.
			const prop = env.conf.wiki.useVideoInfo ? 'videoinfo' : 'imageinfo';
			// title is guaranteed to be not null here
			const image = data.pages[ns + ':' + o.title.getKey()];
			if (
				!image || !image[prop] || !image[prop][0] ||
				// Fallback to adding mw:Error
					(image.missing !== undefined && image.known === undefined)
			) {
				return null;
			} else {
				return image[prop][0];
			}
		}
	}

	// Use sane defaults
	static errorInfo(env, opts) {
		const widthOption = env.conf.wiki.widthOption;
		return {
			url: './Special:FilePath/' + Sanitizer.sanitizeTitleURI(opts.title.v.getKey()),
			// Preserve width and height from the wikitext options
			// even if the image is non-existent.
			width: opts.size.v.width || widthOption,
			height: opts.size.v.height || opts.size.v.width || widthOption,
		};
	}

	static makeErr(key, message, params) {
		const e = { key: key, message: message };
		// Additional error info for clients that could fix the error.
		if (params !== undefined) { e.params = params; }
		return e;
	}

	// Internal Helper
	*_requestInfoG(reqs, errorHandler) {
		const env = this.manager.env;
		let errs = [];
		let infos;
		try {
			const result = yield Promise.all(
				reqs.map(s => s.promise)
			);
			infos = result.map((r, i) => {
				let info = WikiLinkHandler.extractInfo(env, r);
				if (!info) {
					info = errorHandler();
					errs.push(WikiLinkHandler.makeErr('apierror-filedoesnotexist', 'This image does not exist.', reqs[i].params));
				} else if (info.hasOwnProperty('thumberror')) {
					errs.push(WikiLinkHandler.makeErr('apierror-unknownerror', info.thumberror));
				}
				return info;
			});
		} catch (e) {
			errs = [WikiLinkHandler.makeErr('apierror-unknownerror', e)];
			infos = reqs.map(() => errorHandler());
		}
		return { errs: errs, info: infos };
	}

	// Handle a response to an (image|video)info API request.
	*handleInfoG(token, opts, optSources, errs, info, manualinfo) {
		console.assert(Array.isArray(errs));

		// FIXME: Not doing this till we fix up wt2html error handling
		//
		// Bump resource use
		// this.manager.env.bumpParserResourceUse('image');

		const dataMwAttr = token.getAttribute('data-mw');
		const dataMw = dataMwAttr ? JSON.parse(dataMwAttr) : {};

		// Add error info to data-mw
		if (errs.length > 0) {
			if (Array.isArray(dataMw.errors)) {
				errs = dataMw.errors.concat(errs);
			}
			dataMw.errors = errs;
		}

		// T110692: The batching API seems to return these as strings.
		// Till that is fixed, let us make sure these are numbers.
		// (This was fixed in Sep 2015, FWIW.)
		info.height = Number(info.height);
		info.width = Number(info.width);

		let o;
		switch (info.mediatype) {
			case 'AUDIO':
				o = this.handleAudio(opts, info, manualinfo, dataMw, optSources);
				break;
			case 'VIDEO':
				o = this.handleVideo(opts, info, manualinfo, dataMw, optSources);
				break;
			default:
				if (manualinfo) { info = manualinfo; }
				// Now that we have a mediatype, let's mark opts that don't apply
				// as bogus, while being mindful of caption.
				WikiLinkHandler.markAsBogus(opts, token.dataAttribs.optList, 'img_');
				o = this.handleImage(opts, info, null, dataMw, optSources);
		}

		const iContainerName = o.hasLink ? 'a' : 'span';
		const innerContain = new TagTk(iContainerName, []);
		const innerContainClose = new EndTagTk(iContainerName);

		if (o.hasLink) {
			if (opts.link) {
				// FIXME: handle tokens here!
				if (this.urlParser.tokenizesAsURL(opts.link.v)) {
					// an external link!
					innerContain.addNormalizedAttribute('href', opts.link.v, opts.link.src);
				} else if (opts.link.v) {
					const link = this.env.makeTitleFromText(opts.link.v, undefined, true);
					if (link !== null) {
						innerContain.addNormalizedAttribute('href', this.env.makeLink(link), opts.link.src);
					} else {
						// Treat same as if opts.link weren't present
						innerContain.addNormalizedAttribute('href', this.env.makeLink(opts.title.v), opts.title.src);
						// but maybe consider it a caption
						const pos = token.dataAttribs.optList.reduce((prv, cur, ind) => {
							return cur.ck === 'link' ? ind : prv;
						}, 0);
						if (!opts.caption || opts.caption.pos < pos) {
							opts.link.v = opts.link.src;
							opts.caption = opts.link;
						}
					}
				}
				// No href if link= was specified
			} else {
				innerContain.addNormalizedAttribute('href', this.env.makeLink(opts.title.v), opts.title.src);
			}
		}

		const wrapperInfo = WikiLinkHandler.getWrapperInfo(opts, info);
		let wrapperClasses = wrapperInfo.classes;
		const isInline = wrapperInfo.isInline === true;
		const containerName = isInline ? 'figure-inline' : 'figure';
		const container = new TagTk(containerName, [], Util.clone(token.dataAttribs));
		const dataAttribs = container.dataAttribs;
		const containerClose = new EndTagTk(containerName);

		if (!dataAttribs.uneditable) {
			dataAttribs.src = undefined;
		}

		if (opts.class) {
			wrapperClasses = wrapperClasses.concat(opts.class.v.split(' '));
		}

		if (wrapperClasses.length) {
			container.addAttribute('class', wrapperClasses.join(' '));
		}

		let rdfaType = o.rdfaType;
		const format = WikiLinkHandler.getFormat(opts);

		// Add mw:Error to the RDFa type.
		// Prepend since rdfaType is updated with /<format> further down.
		if (errs.length > 0) {
			rdfaType = "mw:Error " + rdfaType;
		}

		// If the format is something we *recognize*, add the subtype
		switch (format) {
			case 'thumbnail':
				rdfaType += '/Thumb';
				break;
			case 'framed':
				rdfaType += '/Frame';
				break;
			case 'frameless':
				rdfaType += '/Frameless';
				break;
		}

		// Tell VE that it shouldn't try to edit this
		if (dataAttribs.uneditable) {
			rdfaType += " mw:Placeholder";
		}

		// Set typeof and transfer existing typeof over as well
		container.addAttribute("typeof", rdfaType);
		const type = token.getAttribute("typeof");
		if (type) {
			container.addSpaceSeparatedAttribute("typeof", type);
		}

		let tokens = [container, innerContain].concat(o.elt, innerContainClose);
		const manager = this.manager;

		if (optSources && !dataAttribs.uneditable) {
			const inVals = optSources.map(e => e[1]);
			const outVals = yield PipelineUtils.expandValuesToDOM(
				manager.env, manager.frame, inVals,
				this.options.expandTemplates,
				this.options.inTemplate
			);
			if (!dataMw.attribs) { dataMw.attribs = []; }
			for (let i = 0; i < outVals.length; i++) {
				dataMw.attribs.push([optSources[i][0].optKey, outVals[i]]);
			}
			container.addAttribute("about", manager.env.newAboutId());
			container.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
		}

		if (opts.caption !== undefined) {
			if (!isInline) {
				tokens = tokens.concat([
					new TagTk('figcaption'),
					PipelineUtils.getDOMFragmentToken(
						opts.caption.v, opts.caption.srcOffsets, {
							inlineContext: true, token: token,
						}),
					new EndTagTk('figcaption'),
				]);
			} else {
				if (!Array.isArray(opts.caption.v)) {
					opts.caption.v = [ opts.caption.v ];
				}
				// Parse the caption asynchronously.
				const captionDOM = yield PipelineUtils.promiseToProcessContent(
					manager.env, manager.frame,
					opts.caption.v.concat([new EOFTk()]), {
						pipelineType: "tokens/x-mediawiki/expanded",
						pipelineOpts: {
							inlineContext: true,
							expandTemplates: this.options.expandTemplates,
							inTemplate: this.options.inTemplate,
						},
						srcOffsets: opts.caption.srcOffsets
					});
				// Use parsed DOM given in `captionDOM`
				dataMw.caption = ContentUtils.ppToXML(captionDOM.body, { innerXML: true });
			}
		}

		if (opts.manualthumb !== undefined) {
			dataMw.thumb = opts.manualthumb.v;
		}

		if (Object.keys(dataMw).length) {
			container.addAttribute("data-mw", JSON.stringify(dataMw));
		}

		tokens.push(containerClose);
		return { tokens: tokens };
	}

	/**
	 * Render a file. This can be an image, a sound, a PDF etc.
	 */
	*renderFileG(token, target) {
		const title = target.title;

		// First check if we have a cached copy of this image expansion, and
		// avoid any further processing if we have a cache hit.
		const env = this.manager.env;
		const cachedMedia = env.mediaCache[token.dataAttribs.src];
		if (cachedMedia) {
			const wrapperTokens = PipelineUtils.encapsulateExpansionHTML(env, token, cachedMedia, {
				fromCache: true,
			});
			const firstWrapperToken = wrapperTokens[0];

			// Capture the delta between the old/new wikitext start posn.
			// 'tsr' values are stripped in the original DOM and won't be
			// present.  Since dsr[0] is identical to tsr[0] in this case,
			// dsr[0] is a safe substitute, if present.
			const firstDa = firstWrapperToken.dataAttribs;
			if (token.dataAttribs.tsr && firstDa.dsr) {
				if (!firstDa.tmp) { firstDa.tmp = {}; }
				firstDa.tmp.tsrDelta = token.dataAttribs.tsr[0] - firstDa.dsr[0];
			}

			return { tokens: wrapperTokens };
		}

		const content = WikiLinkHandler.buildLinkAttrs(token.attribs, true, null, null).contentKVs;

		const opts = {
			title: {
				v: title,
				src: KV.lookupKV(token.attribs, 'href').vsrc,
			},
			size: {
				v: {
					height: null,
					width: null,
				},
			},
		};

		token.dataAttribs.optList = [];

		let optKVs = content;
		let optSources = [];
		let hasExpandableOpt = false;
		const hasTransclusion = (toks) => {
			return Array.isArray(toks) && toks.find((t) => {
				return t.constructor === SelfclosingTagTk &&
					t.getAttribute("typeof") === "mw:Transclusion";
			}) !== undefined;
		};

		while (optKVs.length > 0) {
			const oContent = optKVs.shift();
			let origOptSrc, optInfo, oText;

			origOptSrc = oContent.v;
			if (Array.isArray(origOptSrc) && origOptSrc.length === 1) {
				origOptSrc = origOptSrc[0];
			}
			oText = TokenUtils.tokensToString(oContent.v, true, { includeEntities: true });

			if (oText.constructor !== String) {
				// Might be that this is a valid option whose value is just
				// complicated. Try to figure it out, step through all tokens.
				const maybeOText = WikiLinkHandler.stringifyOptionTokens(oText, '', env);
				if (maybeOText !== null) {
					oText = maybeOText;
				}
			}

			if (oText.constructor === String) {
				if (oText.match(/\|/)) {
					// Split the pipe-separated string into pieces
					// and convert each one into a KV obj and add them
					// to the beginning of the array. Note that this is
					// a hack to support templates that provide multiple
					// image options as a pipe-separated string. We aren't
					// really providing editing support for this yet, or
					// ever, maybe.
					//
					// TODO(arlolra): Tables in captions suppress breaking on
					// "linkdesc" pipes so `stringifyOptionTokens` should account
					// for pipes in table cell content.  For the moment, breaking
					// here is acceptable since it matches the php implementation
					// bug for bug.
					const pieces = oText.split("|").map(
						s => new KV("mw:maybeContent", s)
					);
					optKVs = pieces.concat(optKVs);

					// Record the fact that we won't provide editing support for this.
					token.dataAttribs.uneditable = true;
					continue;
				} else {
					// We're being overly accepting of media options at this point,
					// since we don't know the type yet.  After the info request,
					// we'll filter out those that aren't appropriate.
					optInfo = WikiLinkHandler.getOptionInfo(oText, env);
				}
			}

			// For the values of the caption and options, see
			// getOptionInfo's documentation above.
			//
			// If there are multiple captions, this code always
			// picks the last entry. This is the spec; see
			// "Image with multiple captions" parserTest.
			if (
				oText.constructor !== String || optInfo === null ||
				// Deprecated options
				['noicon', 'noplayer', 'disablecontrols'].includes(optInfo.ck)
			) {
				// No valid option found!?
				// Record for RT-ing
				const optsCaption = {
					v: oContent.constructor === String ? oContent : oContent.v,
					src: oContent.vsrc || oText,
					srcOffsets: oContent.srcOffsets,
					// remember the position
					pos: token.dataAttribs.optList.length,
				};
				// if there was a 'caption' previously, round-trip it as a
				// "bogus option".
				if (opts.caption) {
					token.dataAttribs.optList.splice(opts.caption.pos, 0, {
						ck: 'bogus',
						ak: opts.caption.src,
					});
					optsCaption.pos++;
				}
				opts.caption = optsCaption;
				continue;
			}

			const opt = {
				ck: optInfo.v,
				ak: oContent.vsrc || optInfo.ak,
			};

			if (optInfo.s === true) {
				// Default: Simple image option
				if (optInfo.ck in opts) {
					// first option wins, the rest are 'bogus'
					token.dataAttribs.optList.push({
						ck: 'bogus',
						ak: optInfo.ak,
					});
					continue;
				}
				opts[optInfo.ck] = { v: optInfo.v };
			} else {
				// Map short canonical name to the localized version used.
				opt.ck = optInfo.ck;

				// The MediaWiki magic word for image dimensions is called 'width'
				// for historical reasons
				// Unlike other options, use last-specified width.
				if (optInfo.ck === 'width') {
					// We support a trailing 'px' here for historical reasons
					// (T15500, T53628)
					const maybeDim = Util.parseMediaDimensions(optInfo.v);
					if (maybeDim !== null) {
						opts.size.v.width = Util.validateMediaParam(maybeDim.x) ?
							maybeDim.x : null;
						opts.size.v.height = maybeDim.hasOwnProperty('y') &&
							Util.validateMediaParam(maybeDim.y) ?
							maybeDim.y : null;
						// Only round-trip a valid size
						opts.size.src = oContent.vsrc || optInfo.ak;
					}
				} else {
					if (optInfo.ck in opts) { continue; } // first option wins
					opts[optInfo.ck] = {
						v: optInfo.v,
						src: oContent.vsrc || optInfo.ak,
						srcOffsets: oContent.srcOffsets,
					};
				}
			}

			// Collect option in dataAttribs (becomes data-parsoid later on)
			// for faithful serialization.
			token.dataAttribs.optList.push(opt);

			// Collect source wikitext for image options for possible template expansion.
			// FIXME: Does VE need the wikitext version as well in a "txt" key?
			optSources.push([{ "optKey": opt.ck }, { "html": origOptSrc }]);
			if (hasTransclusion(origOptSrc)) {
				hasExpandableOpt = true;
			}
		}

		// Handle image default sizes and upright option after extracting all
		// options
		if (opts.format && opts.format.v === 'framed') {
			// width and height is ignored for framed images
			// https://phabricator.wikimedia.org/T64258
			opts.size.v.width = null;
			opts.size.v.height = null;
		} else if (opts.format) {
			if (!opts.size.v.height && !opts.size.v.width) {
				let defaultWidth = env.conf.wiki.widthOption;
				if (opts.upright !== undefined) {
					if (opts.upright.v > 0) {
						defaultWidth *= opts.upright.v;
					} else {
						defaultWidth *= 0.75;
					}
					// round to nearest 10 pixels
					defaultWidth = 10 * Math.round(defaultWidth / 10);
				}
				opts.size.v.width = defaultWidth;
			}
		}

		// Add the last caption in the right position if there is one
		if (opts.caption) {
			token.dataAttribs.optList.splice(opts.caption.pos, 0, {
				ck: 'caption',
				ak: opts.caption.src,
			});
		}

		if (!hasExpandableOpt) {
			optSources = null;
		}

		let err;

		if (!env.conf.parsoid.fetchImageInfo) {
			err = WikiLinkHandler.makeErr('apierror-unknownerror', 'Fetch of image info disabled.');
			return this.handleInfo(token, opts, optSources, [err], WikiLinkHandler.errorInfo(env, opts));
		}

		const wrapResp = (aTitle) => {
			return (data) => { return { title: aTitle, data: data }; };
		};

		const dims = Object.assign({}, opts.size.v);
		if (opts.page && dims.width !== null) {
			dims.page = opts.page.v;
		}

		// "starttime" should be used if "thumbtime" isn't present,
		// but only for rendering.
		if (opts.thumbtime || opts.starttime) {
			let seek = opts.thumbtime ? opts.thumbtime.v : opts.starttime.v;
			seek = WikiLinkHandler.parseTimeString(seek);
			if (seek !== false) {
				dims.seek = seek;
			}
		}

		const reqs = [{
			promise: env.batcher.imageinfo(title.getKey(), dims).then(wrapResp(title)),
		}];

		// If this is a manual thumbnail, fetch the info for that as well
		if (opts.manualthumb) {
			const manualThumbTitle = env.makeTitleFromText(opts.manualthumb.v, undefined, true);
			if (!manualThumbTitle) {
				err = WikiLinkHandler.makeErr('apierror-invalidtitle', 'Invalid thumbnail title.', { name: opts.manualthumb.v });
				return this.handleInfo(token, opts, optSources, [err], WikiLinkHandler.errorInfo(env, opts));
			}
			if (manualThumbTitle.nskey === '') {
				// inherit namespace from main image
				manualThumbTitle.ns = title.ns;
				manualThumbTitle.nskey = title.nskey;
			}
			reqs.push({
				promise: env.batcher
					.imageinfo(manualThumbTitle.getKey(), opts.size.v)
					.then(wrapResp(manualThumbTitle)),
				params: { name: opts.manualthumb.v },
			});
		}

		const result = yield this._requestInfo(
			reqs,
			() => WikiLinkHandler.errorInfo(env, opts)
		);
		return this.handleInfo(
			token, opts, optSources, result.errs, result.info[0], result.info[1]
		);
	}

	linkToMedia(token, target, errs, info) {
		// Only pass in the url, since media links should not link to the thumburl
		const imgHref = WikiLinkHandler.getPath({ url: info.url });
		const imgHrefFileName = imgHref.replace(/.*\//, '');

		const link = new TagTk('a', [], Util.clone(token.dataAttribs));
		link.addAttribute('rel', 'mw:MediaLink');
		link.addAttribute('href', imgHref);
		// html2wt will use the resource rather than try to parse the href.
		link.addNormalizedAttribute(
			'resource',
			this.env.makeLink(target.title),
			target.hrefSrc
		);
		// Normalize title according to how PHP parser does it currently
		link.setAttribute('title', imgHrefFileName.replace(/_/g, ' '));
		link.dataAttribs.src = undefined; // clear src string since we can serialize this

		const type = token.getAttribute('typeof');
		if (type) {
			link.addSpaceSeparatedAttribute('typeof', type);
		}

		if (errs.length > 0) {
			// Set RDFa type to mw:Error so VE and other clients
			// can use this to do client-specific action on these.
			link.addAttribute('typeof', 'mw:Error');

			// Update data-mw
			const dataMwAttr = token.getAttribute('data-mw');
			const dataMw = dataMwAttr ? JSON.parse(dataMwAttr) : {};
			if (Array.isArray(dataMw.errors)) {
				errs = dataMw.errors.concat(errs);
			}
			dataMw.errors = errs;
			link.addAttribute('data-mw', JSON.stringify(dataMw));
		}

		let content = TokenUtils.tokensToString(token.getAttribute('href')).replace(/^:/, '');
		content = token.getAttribute('mw:maybeContent') || [content];
		const tokens = [link].concat(content, [new EndTagTk('a')]);
		return { tokens: tokens };
	}

	*renderMediaG(token, target) {
		const env = this.manager.env;
		const title = target.title;
		const reqs = [{
			promise: env.batcher
				.imageinfo(title.getKey(), { height: null, width: null })
				.then((data) => {
					return { title: title, data: data };
				}),
		}];

		const result = yield this._requestInfo(reqs, () => {
			return {
				url: './Special:FilePath/' + (title ? Sanitizer.sanitizeTitleURI(title.getKey()) : ''),
			};
		});
		return this.linkToMedia(token, target, result.errs, result.info[0]);
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
WikiLinkHandler.prototype.onRedirect =
	Promise.async(WikiLinkHandler.prototype.onRedirectG);
WikiLinkHandler.prototype.onWikiLink =
	Promise.async(WikiLinkHandler.prototype.onWikiLinkG);
WikiLinkHandler.prototype.renderWikiLink =
	Promise.async(WikiLinkHandler.prototype.renderWikiLinkG);
WikiLinkHandler.prototype.renderCategory =
	Promise.async(WikiLinkHandler.prototype.renderCategoryG);
WikiLinkHandler.prototype.renderLanguageLink =
	Promise.async(WikiLinkHandler.prototype.renderLanguageLinkG);
WikiLinkHandler.prototype.renderInterwikiLink =
	Promise.async(WikiLinkHandler.prototype.renderInterwikiLinkG);
WikiLinkHandler.prototype._requestInfo =
	Promise.async(WikiLinkHandler.prototype._requestInfoG);
WikiLinkHandler.prototype.handleInfo =
	Promise.async(WikiLinkHandler.prototype.handleInfoG);
WikiLinkHandler.prototype.renderFile =
	Promise.async(WikiLinkHandler.prototype.renderFileG);
WikiLinkHandler.prototype.renderMedia =
	Promise.async(WikiLinkHandler.prototype.renderMediaG);

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ExternalLinkHandler extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.manager.addTransform(
			(token, cb) => this.onUrlLink(token, cb),
			'ExternalLinkHandler:onUrlLink',
			ExternalLinkHandler.rank(), 'tag', 'urllink');
		this.manager.addTransform(
			(token, cb) => this.onExtLink(token, cb),
			'ExternalLinkHandler:onExtLink',
			ExternalLinkHandler.rank() - 0.001, 'tag', 'extlink');
		this.manager.addTransform(
			(token, cb) => this.onEnd(token, cb),
			'ExternalLinkHandler:onEnd',
			ExternalLinkHandler.rank(), 'end');

		// Create a new peg parser for image options.
		if (!this.urlParser) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			ExternalLinkHandler.prototype.urlParser = new PegTokenizer(this.env);
		}

		this._reset();
	}

	static rank() { return 1.15; }

	_reset() {
		this.linkCount = 1;
	}

	static _imageExtensions(str) {
		switch (str) {
			case 'jpg': // fall through
			case 'png': // fall through
			case 'gif': // fall through
			case 'svg': // fall through
				return true;
			default:
				return false;
		}
	}

	_hasImageLink(href) {
		const allowedPrefixes = this.manager.env.conf.wiki.allowExternalImages;
		const bits = href.split('.');
		const hasImageExtension = bits.length > 1 &&
			ExternalLinkHandler._imageExtensions(lastItem(bits)) &&
			href.match(/^https?:\/\//i);
		// Typical settings for mediawiki configuration variables
		// $wgAllowExternalImages and $wgAllowExternalImagesFrom will
		// result in values like these:
		//  allowedPrefixes = undefined; // no external images
		//  allowedPrefixes = [''];      // allow all external images
		//  allowedPrefixes = ['http://127.0.0.1/', 'http://example.com'];
		// Note that the values include the http:// or https:// protocol.
		// See https://phabricator.wikimedia.org/T53092
		return hasImageExtension && Array.isArray(allowedPrefixes) &&
			// true iff some prefix in the list matches href
			allowedPrefixes.some(
				prefix => href.indexOf(prefix) === 0
			);
	}

	onUrlLink(token, cb) {
		let tagAttrs, builtTag;
		const env = this.manager.env;
		const origHref = token.getAttribute('href');
		const href = TokenUtils.tokensToString(origHref);
		const dataAttribs = Util.clone(token.dataAttribs);

		if (this._hasImageLink(href)) {
			tagAttrs = [
				new KV('src', href),
				new KV('alt', lastItem(href.split('/'))),
				new KV('rel', 'mw:externalImage'),
			];

			// combine with existing rdfa attrs
			tagAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
			cb({ tokens: [ new SelfclosingTagTk('img', tagAttrs, dataAttribs) ] });
		} else {
			tagAttrs = [
				new KV('rel', 'mw:ExtLink'),
				// href is set explicitly below
			];

			// combine with existing rdfa attrs
			tagAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
			builtTag = new TagTk('a', tagAttrs, dataAttribs);
			dataAttribs.stx = 'url';

			if (!this.options.inTemplate) {
				// Since we messed with the text of the link, we need
				// to preserve the original in the RT data. Or else.
				builtTag.addNormalizedAttribute('href', href, token.getWTSource(env));
			} else {
				builtTag.addAttribute('href', href);
			}

			cb({
				tokens: [
					builtTag,
					// Make sure there are no IDN-ignored characters in the text so
					// the user doesn't accidentally copy any.
					Sanitizer.cleanUrl(env, href),
					new EndTagTk('a', [], { tsr: [dataAttribs.tsr[1], dataAttribs.tsr[1]] }),
				],
			});
		}
	}

	// Bracketed external link
	onExtLink(token, cb) {
		let newAttrs, aStart;
		const env = this.manager.env;
		const origHref = token.getAttribute('href');
		const hasExpandedAttrs = /mw:ExpandedAttrs/.test(token.getAttribute('typeof'));
		const href = TokenUtils.tokensToString(origHref);
		const hrefWithEntities = TokenUtils.tokensToString(origHref, false, {
			includeEntities: true,
		});
		let content = token.getAttribute('mw:content');
		const dataAttribs = Util.clone(token.dataAttribs);
		let rdfaType = token.getAttribute('typeof');
		const magLinkRe = /(?:^|\s)(mw:(?:Ext|Wiki)Link\/(?:ISBN|RFC|PMID))(?=$|\s)/;
		let tokens;

		if (rdfaType && magLinkRe.test(rdfaType)) {
			let newHref = href;
			let newRel = 'mw:ExtLink';
			if (/(?:^|\s)mw:(Ext|Wiki)Link\/ISBN/.test(rdfaType)) {
				newHref = env.page.relativeLinkPrefix + href;
				// ISBNs use mw:WikiLink instead of mw:ExtLink
				newRel = 'mw:WikiLink';
			}
			newAttrs = [
				new KV('href', newHref),
				new KV('rel', newRel),
			];
			token.removeAttribute('typeof');

			// SSS FIXME: Right now, Parsoid does not support templating
			// of ISBN attributes.  So, "ISBN {{echo|1234567890}}" will not
			// parse as you might expect it to.  As a result, this code below
			// that attempts to combine rdf attrs from earlier is unnecessary
			// right now.  But, it will become necessary if Parsoid starts
			// supporting templating of ISBN attributes.
			//
			// combine with existing rdfa attrs
			newAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
			aStart = new TagTk('a', newAttrs, dataAttribs);
			tokens = [aStart].concat(content, [new EndTagTk('a')]);
			cb({
				tokens: tokens
			});
		} else if (
			(!hasExpandedAttrs && typeof origHref === 'string') ||
				this.urlParser.tokenizesAsURL(hrefWithEntities)
		) {
			rdfaType = 'mw:ExtLink';
			if (
				content.length === 1 &&
				content[0].constructor === String &&
				env.conf.wiki.hasValidProtocol(content[0]) &&
				this.urlParser.tokenizesAsURL(content[0]) &&
				this._hasImageLink(content[0])
			) {
				const src = content[0];
				content = [
					new SelfclosingTagTk('img', [
						new KV('src', src),
						new KV('alt', lastItem(src.split('/'))),
					], { type: 'extlink' }),
				];
			}

			newAttrs = [
				new KV('rel', rdfaType),
				// href is set explicitly below
			];
			// combine with existing rdfa attrs
			newAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
			aStart = new TagTk('a', newAttrs, dataAttribs);

			if (!this.options.inTemplate) {
				// If we are from a top-level page, add normalized attr info for
				// accurate roundtripping of original content.
				//
				// targetOff covers all spaces before content
				// and we need src without those spaces.
				const tsr0a = dataAttribs.tsr[0] + 1;
				const tsr1a = dataAttribs.targetOff - (token.getAttribute('spaces') || '').length;
				aStart.addNormalizedAttribute('href', href, env.page.src.substring(tsr0a, tsr1a));
			} else {
				aStart.addAttribute('href', href);
			}

			content = PipelineUtils.getDOMFragmentToken(
				content,
				dataAttribs.tsr ? dataAttribs.contentOffsets : null,
				{ inlineContext: true, token: token }
			);

			tokens = [aStart].concat(content, [new EndTagTk('a')]);
			cb({
				tokens: tokens,
			});
		} else {
			// Not a link, convert href to plain text.
			cb({ tokens: WikiLinkHandler.bailTokens(env, token, true) });
		}
	}

	onEnd(token, cb) {
		this._reset();
		cb({ tokens: [ token ] });
	}
}

if (typeof module === "object") {
	module.exports.WikiLinkHandler = WikiLinkHandler;
	module.exports.ExternalLinkHandler = ExternalLinkHandler;
}
