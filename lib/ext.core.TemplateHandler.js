/**
 * Template and template argument handling, first cut.
 *
 * AsyncTokenTransformManager objects provide preprocessor-frame-like
 * functionality once template args etc are fully expanded, and isolate
 * individual transforms from concurrency issues. Template expansion is
 * controlled using a tplExpandData structure created independently for each
 * handled template tag.
 */

"use strict";

var ParserFunctions = require('./ext.core.ParserFunctions.js').ParserFunctions,
	AttributeTransformManager = require('./mediawiki.TokenTransformManager.js')
									.AttributeTransformManager,
	defines = require('./mediawiki.parser.defines.js'),
	TemplateRequest = require('./mediawiki.ApiRequest.js').TemplateRequest,
	api = require('./mediawiki.ApiRequest.js'),
	PreprocessorRequest = api.PreprocessorRequest,
	Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	// define some constructor shortcuts
	KV = defines.KV,
	TagTk = defines.TagTk,
	SelfclosingTagTk = defines.SelfclosingTagTk,
	EndTagTk = defines.EndTagTk;

function TemplateHandler ( manager, options ) {
	this.register( manager );
	this.parserFunctions = new ParserFunctions( manager );
	this.options = options;
}

// constants
TemplateHandler.prototype.rank = 1.1;

TemplateHandler.prototype.register = function ( manager ) {
	this.manager = manager;
	// Register for template and templatearg tag tokens
	manager.addTransform( this.onTemplate.bind(this), "TemplateHandler:onTemplate",
			this.rank, 'tag', 'template' );

	// Template argument expansion
	manager.addTransform( this.onTemplateArg.bind(this), "TemplateHandler:onTemplateArg",
			this.rank, 'tag', 'templatearg' );
};

/**
 * Main template token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 */
TemplateHandler.prototype.onTemplate = function ( token, frame, cb ) {
	//console.warn('onTemplate! ' + JSON.stringify( token, null, 2 ) +
	//		' args: ' + JSON.stringify( this.manager.args ));

	// magic word variables can be mistaken for templates
	var magicWord = this.checkForMagicWordVariable(token);
	if (magicWord) {
		cb({ tokens: [magicWord] });
		return;
	}

	var env = this.manager.env;
	var state = { token: token };
	if (this.options.wrapTemplates) {
		state.wrapperType = 'mw:Transclusion';
		state.recordArgDict = true;
		state.wrappedObjectId = env.newObjectId();
		state.emittedFirstChunk = false;

		// Uncomment to use DOM-based template expansion
		// TODO gwicke: Determine when to use this!
		// - Collect stats per template and classify templates into
		// balanced/unbalanced ones based on it
		// - Always force nesting for new templates inserted by the VE
		//state.srcCB = this._startDocumentPipeline;

		// Default to 'safe' token-based template encapsulation for now.
		state.srcCB = this._startTokenPipeline;
	} else {
		state.srcCB = this._startTokenPipeline;
	}

	if ( env.conf.parsoid.usePHPPreProcessor &&
			env.conf.parsoid.apiURI !== null ) {
		if ( this.options.wrapTemplates ) {
			// Use MediaWiki's action=expandtemplates preprocessor
			// We'll never get to frame depth beyond 1 in this scenario
			// which means cached content in this frame will not be used
			// by any child frames since there won't be any children.
			// So, it is sufficient to pass in '[]' in place of attribs
			// since the cache key for Frame doesn't matter.
			//
			// However, tokenizer needs to use 'text' as the cache key
			// for caching expanded tokens from the expanded transclusion text
			// that we get from the preprocessor.
			var text = token.dataAttribs.src,
				tgt = this.resolveTemplateTarget(state, token.attribs[0].k);

			if (tgt === null) {
				// Target contains tags, convert template braces and pipes back into text
				// Re-join attribute tokens with '=' and '|'
				this.convertAttribsToString(state, token.attribs, cb);
				return;
			} else {
				var templateName = tgt.target,
					srcHandler = state.srcCB.bind(
						this, state, frame, cb,
						{ name: templateName, attribs: [], cacheKey: text });
				// Check if we have an expansion for this template in the cache
				// already
				if (env.transclusionCache[text]) {
					// cache hit: reuse the expansion DOM
					//console.log('cache hit for', JSON.stringify(text.substr(0, 50)));
					var expansion = env.transclusionCache[text],
						opts = { setDSR: true, isForeignContent: true },
						toks = DU.encapsulateExpansionHTML(env, token, expansion, opts);

					cb({ tokens: toks });
				} else {
					this.fetchExpandedTpl( env.page.name || '',
							text, PreprocessorRequest, cb, srcHandler);
				}
			}
		} else {
			// We don't perform recursive template expansion- something
			// template-like that the PHP parser did not expand. This is
			// encapsulated already, so just return the plain text.
			if (Util.isTemplateToken(token)) {
				this.convertAttribsToString(state, token.attribs, cb);
				return;
			} else {
				cb( { tokens: [ Util.tokensToString( [token] ) ] } );
			}
		}
	} else {
		// expand argument keys, with callback set to next processing step
		// XXX: would likely be faster to do this in a tight loop here
		var atm = new AttributeTransformManager(
					this.manager,
					{ wrapTemplates: false },
					this._expandTemplate.bind( this, state, frame, cb )
				);
		cb( { async: true } );
		atm.processKeys(token.attribs);
	}
};

/**
 * Parser functions also need template wrapping
 */
TemplateHandler.prototype._parserFunctionsWrapper = function(state, cb, ret) {
	if (ret.tokens) {
		this._onChunk(state, cb, ret.tokens);
	}
	if (!ret.async) {
		// Now, ready to finish up
		this._onEnd(state, cb);
	}
};

/**
 * Check if token is a magic word masquerading as a template
 * - currently only DEFAULTSORT is considered
 */
TemplateHandler.prototype.checkForMagicWordVariable = function(tplToken) {
	// Deal with the following scenarios:
	//
	// 1. Normal string:        {{DEFAULTSORT:foo}}
	// 2. String with entities: {{DEFAULTSORT:"foo"bar}}
	// 3. Templated key:        {{DEFAULTSORT:{{foo}}bar}}

	var property, key, propAndKey, keyToks,
		magicWord = tplToken.attribs[0].k;

	if (magicWord.constructor === String) {
		// Scenario 1. above -- common case
		propAndKey = magicWord.match(/^([^:]+:)(.*)$/);
		if (propAndKey) {
			property = propAndKey[1];
			key = propAndKey[2];
		}
	} else if ( Array.isArray(magicWord) ) {
		// Scenario 2. or 3. above -- uncommon case

		property = magicWord[0];
		if (!property || property.constructor !== String) {
			// FIXME: We don't know if this is a magic word at this point.
			// Ex: {{ {{echo|DEFAULTSORT}}:foo }}
			//     {{ {{echo|lc}}:foo }}
			// This requires more info from the preprocessor than
			// we have currently. This will be handled at a later point.
			return null;
		}

		propAndKey = property.match(/^([^:]+:)(.*)$/);
		if (propAndKey) {
			property = propAndKey[1];
			key = propAndKey[2];
		}

		keyToks = [key].concat(magicWord.slice(1));
	}

	// TODO gwicke: factor out generic magic word (and parser function) round-tripping logic!
	if (property && this.manager.env.conf.wiki.magicWords[property.trim()] === 'defaultsort') {
		var templatedKey = false;
		if (keyToks) {
			// Check if any part of the key is templated
			for (var i = 0, n = keyToks.length; i < n; i++) {
				if (Util.isTemplateToken(keyToks[i])) {
					templatedKey = true;
					break;
				}
			}
			key = Util.tokensToString(keyToks);
		}

		var metaToken = new defines.SelfclosingTagTk(
				'meta',
				[new KV('property', 'mw:PageProp/categorydefaultsort')],
				Util.clone(tplToken.dataAttribs)
			);

		if (templatedKey) {
			// No shadowing if templated
			//
			// SSS FIXME: post-tpl-expansion, WS won't be trimmed. How do we handle this?
			metaToken.addAttribute("content", keyToks);
		} else {
			// Leading/trailing WS should be stripped
			key = key.trim();

			var src = (tplToken.dataAttribs || {}).src;
			if (src) {
				// If the token has original wikitext, shadow the sort-key
				var origKey = src.replace(/[^:]+:/, '').replace(/}}$/, '');
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

	return null;
};

TemplateHandler.prototype.resolveTemplateTarget = function ( state, targetToks ) {

	function isConvertibleToString( tokens ) {
		var maybeTarget = Util.tokensToString( tokens, true );
		if ( Array.isArray(maybeTarget) ) {
			for ( var i = 0, l = maybeTarget[1].length; i < l; i++ ) {
				var ntt = maybeTarget[1][0];
				var nonTextTokenCons = ntt.constructor;
				if ( nonTextTokenCons === TagTk ||
						nonTextTokenCons === SelfclosingTagTk ||
						nonTextTokenCons === EndTagTk )
				{
					if (ntt.name !== 'meta' ||
							!ntt.getAttribute("typeof") ||
							!ntt.getAttribute("typeof").match(/mw:/))
					{
						return false;
					}
				}
			}

			return true;
		} else {
			return true;
		}
	}

	var env = this.manager.env;

	// Convert the target to a string while stripping all non-text tokens
	var target = Util.tokensToString(targetToks).trim();

	// strip subst for now.
	target = target.replace( /^(safe)?subst:/, '' );

	// Check if we have a parser function.
	//
	// Unalias to canonical form and look in config.functionHooks
	var pieces = target.split(':'),
		prefix = pieces[0].trim(),
		lowerPrefix = prefix.toLowerCase(),
		magicWordAlias = env.conf.wiki.magicWords[prefix] || env.conf.wiki.magicWords[lowerPrefix],
		translatedPrefix = magicWordAlias || lowerPrefix || '';

	// The check for pieces.length > 1 is require to distinguish between
	// {{lc:FOO}} and {{lc|FOO}}.  The latter is a template transclusion
	// even though the target (=lc) matches a registered parser-function name.
	if ((magicWordAlias && this.parserFunctions['pf_' + magicWordAlias]) ||
		(pieces.length > 1 && (translatedPrefix[0] === '#' || env.conf.wiki.functionHooks.has(translatedPrefix))))
	{
		state.parserFunctionName = translatedPrefix;
		return {
			isPF: true,
			prefix: prefix,
			target: 'pf_' + translatedPrefix,
			pfArg: target.substr( prefix.length + 1 )
		};
	}

	// We are dealing with a real template, not a parser function.
	// Apply more stringent standards for template targets.
	if (isConvertibleToString(targetToks)) {
		// We can use the stringified target tokens
		var namespaceId = env.conf.wiki.namespaceIds[lowerPrefix.replace(' ', '_')];

		// TODO: Should we assume Template here?
		if ( prefix === target ) {
			namespaceId = env.conf.wiki.canonicalNamespaces.template;
			target = env.conf.wiki.namespaceNames[namespaceId] + ':' + target;
		}

		// Normalize the target before template processing
		// preserve the leading colon in the target
		target = env.normalizeTitle( target, false, true );

		// Resolve a possibly relative link
		target = env.resolveTitle(target, namespaceId);

		// data-mw.target.href should be a url
		state.resolvedTemplateTarget = Util.sanitizeTitleURI(env.page.relativeLinkPrefix + target);

		return { isPF: false, target: target };
	} else {
		return null;
	}

};

TemplateHandler.prototype.convertAttribsToString = function (state, attribs, cb) {
	var self = this;
	cb( { async: true } );

	// Re-join attribute tokens with '=' and '|'
	Util.expandParserValueValues (
			attribs,
			function ( expandedAttrs ) {
				var attribTokens = [];
				expandedAttrs.map( function ( kv ) {
					if ( kv.k) {
						attribTokens = Util.flattenAndAppendToks(attribTokens, null, kv.k);
					}
					if (kv.v) {
						attribTokens = Util.flattenAndAppendToks(attribTokens,
							kv.k ? "=" : '',
							kv.v);
					}
					attribTokens.push('|');
				} );
				// pop last pipe separator
				attribTokens.pop();

				var tokens = ['{{'].concat(attribTokens, ['}}']);
				if ( self.options.wrapTemplates ) {
					// Encapsulate the output as a single template for
					// now. A finer-grained encapsulation of values is
					// already supported by passing true as the optional
					// last argument to expandParserValueValues, but
					// template-generated keys are still not covered by
					// that.
					// TODO: refine later!
					tokens = self.addEncapsulationInfo(state, tokens);
					tokens.push(self.getEncapsulationInfoEndTag(state));
				}
				cb( { tokens: tokens } );
			}
	);
};

/**
 * Fetch, tokenize and token-transform a template after all arguments and the
 * target were expanded.
 */
TemplateHandler.prototype._expandTemplate = function ( state, frame, cb, attribs ) {

	var env = this.manager.env,
		target = attribs[0].k,
		self = this;

	if ( ! target ) {
		env.ap( 'No target! ', attribs );
		console.trace();
	}

	var resolvedTgt = this.resolveTemplateTarget(state, target);
	if ( resolvedTgt === null ) {
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
	if ( resolvedTgt.isPF ) {
		// FIXME: Parsoid may not have implemented the parser function natively
		// Emit an error message, but encapsulate it so it roundtrips back.
		if (!this.parserFunctions[target]) {
			res = [ "Parser function implementation for " + target + " missing in Parsoid." ];
			if (this.options.wrapTemplates) {
				res = this.addEncapsulationInfo(state, res);
				res.push(this.getEncapsulationInfoEndTag(state));
			}
			cb( { tokens: res } );
			return;
		}

		var pfAttribs = new defines.Params( attribs );
		pfAttribs[0] = new KV( resolvedTgt.pfArg, [] );
		env.dp( 'entering prefix', target, state.token  );
		var newCB;
		if (this.options.wrapTemplates) {
			newCB = this._parserFunctionsWrapper.bind(this, state, cb);
		} else {
			newCB = cb;
		}
		this.parserFunctions[target](state.token, frame, newCB, pfAttribs);
		return;
	}

	var checkRes = frame.loopAndDepthCheck( target, env.conf.parsoid.maxDepth );
	if( checkRes ) {
		// Loop detected or depth limit exceeded, abort!
		res = [
				checkRes,
				new TagTk( 'a', [{k: 'href', v: target}] ),
				target,
				new EndTagTk( 'a' )
			];
		res.rank = this.manager.phaseEndRank;
		cb( { tokens: res } );
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
		this, state, frame, cb,
		{ name: target, attribs: attribs, cacheKey: target }
	);
	this._fetchTemplateAndTitle( target, cb, srcHandler, state );
};
/**
 * Process a fetched template source to a document, enforcing proper nesting
 * along the way.
 */
TemplateHandler.prototype._startDocumentPipeline = function( state, frame, cb, tplArgs, err, src )
{
	// We have a choice between aborting or keeping going and reporting the
	// error inline.
	// TODO: report as special error token and format / remove that just
	// before the serializer. (something like <mw:error ../> as source)
	if ( err ) {
		src = '';
		//this.manager.env.errCB(err);
	}

	this.manager.env.dp( 'TemplateHandler._startDocumentPipeline', tplArgs.name, tplArgs.attribs );
	Util.processContentInPipeline(
		this.manager.env,
		this.manager.frame,
		src,
		{
			// Full pipeline all the way to DOM
			pipelineType: 'text/x-mediawiki/full',
			pipelineOpts: {
				isInclude: true,
				// we *might* be able to get away without this if we transfer
				// more than just the about when unwrapping
				wrapTemplates: false,
				// suppress paragraphs
				// Should this be the default in all cases?
				inBlockToken: true
			},
			tplArgs: tplArgs,
			documentCB: this._onDocument.bind(this, state, cb)
		}
	);
};

/**
 * Process a fetched template source to a token stream
 */
TemplateHandler.prototype._startTokenPipeline = function( state, frame, cb, tplArgs, err, src, type )
{
	// The type parameter is passed in from the src fetcher. Typically it is
	// 'text/x-mediawiki' since we are fetching wikitext (search for it in
	// ApiRequest). We can probably remove it even, as it seems unlikely that
	// we will ever have other input types here.

	// We have a choice between aborting or keeping going and reporting the
	// error inline.
	// TODO: report as special error token and format / remove that just
	// before the serializer. (something like <mw:error ../> as source)
	if ( err ) {
		src = '';
		//this.manager.env.errCB(err);
	}

	var pConf = this.manager.env.conf.parsoid;
	if (pConf.dumpFlags && pConf.dumpFlags.indexOf("tplsrc") !== -1) {
		console.log( "=================================");
		console.log( tplArgs.name );
		console.log( "---------------------------------");
		console.log( src );
		console.log( "---------------------------------");
	}

	this.manager.env.dp( 'TemplateHandler._startTokenPipeline', tplArgs.name, tplArgs.attribs );

	// Get a nested transformation pipeline for the input type. The input
	// pipeline includes the tokenizer, synchronous stage-1 transforms for
	// 'text/wiki' input and asynchronous stage-2 transforms).
	Util.processContentInPipeline(
		this.manager.env,
		this.manager.frame,
		src,
		{
			pipelineType: type || 'text/x-mediawiki',
			pipelineOpts: {
				inTemplate: true,
				isInclude: true,
				// NOTE: No template wrapping required for nested templates.
				wrapTemplates: false,
				extTag: this.options.extTag
			},
			tplArgs: tplArgs,
			chunkCB: this._onChunk.bind ( this, state, cb ),
			endCB: this._onEnd.bind ( this, state, cb )
		}
	);
};

TemplateHandler.prototype.addAboutToTableElements = function ( state, tokens ) {
	for ( var i = 0, l = tokens.length; i < l; i++ ) {
		var token = tokens[i];
		if ( token.constructor === TagTk && token.name === 'table' ) {
			token.addAttribute( 'about', '#' + state.wrappedObjectId );
		}
	}
	return tokens;
};

TemplateHandler.prototype.addEncapsulationInfo = function ( state, chunk ) {
	// TODO
	// * only add this information for top-level includes, but track parameter
	// expansion in lower-level templates
	// * use global UID per transclusion -> get from env
	// * wrap leading text in span
	// * add uid as id and about to first element
	//	id == about marks first element
	// * ref all tables to this (just add about)
	// * ref end token to this, add property="mw:Transclusion/End"

	var done = false,
		attrs = [
			new KV('typeof', state.wrapperType),
			new KV('about', '#' + state.wrappedObjectId),
			new KV('id', state.wrappedObjectId)
		],
		dataParsoid = {
			tsr: Util.clone(state.token.dataAttribs.tsr),
			src: state.token.dataAttribs.src
		};

	if (state.recordArgDict) {
		// Get the arg dict
		var argInfo = this.getArgInfo(state),
			argDict = argInfo.dict;

		// Add in tpl-target/pf-name info
		// Only one of these will be set.
		argDict.target['function'] = state.parserFunctionName;
		argDict.target.href = state.resolvedTemplateTarget;

		// Use a data-attribute to prevent the sanitizer from stripping this
		// attribute before it reaches the DOM pass where it is needed.
		attrs.push(new KV("data-mw-arginfo", JSON.stringify(argInfo)));
	}

	if ( chunk.length ) {
		var firstToken = chunk[0];
		if ( firstToken.constructor === String ) {
			// Also include following string tokens
			var stringTokens = [ chunk.shift() ];
			while ( chunk.length && chunk[0].constructor === String ) {
				stringTokens.push( chunk.shift() );
			}
			// Wrap in span with info
			var span = new TagTk( 'span', attrs, dataParsoid );
			chunk = [span].concat(stringTokens, [ new EndTagTk( 'span' ) ], chunk);
			done = true;
		}
	}

	if (!done) {
		// add meta tag
		chunk = [new SelfclosingTagTk( 'meta', attrs, dataParsoid )].concat(chunk);
	}

	// add about ref to all tables
	return this.addAboutToTableElements( state, chunk );
};

TemplateHandler.prototype.getEncapsulationInfoEndTag = function ( state ) {
	var tsr = state.token.dataAttribs.tsr;
	return new SelfclosingTagTk( 'meta',
				[
					new KV( 'typeof', state.wrapperType + '/End' ),
					new KV( 'about', '#' + state.wrappedObjectId )
				], {
					tsr: [null, tsr ? tsr[1] : null]
				});
};

/**
 * Handle chunk emitted from the input pipeline after feeding it a template
 */
TemplateHandler.prototype._onChunk = function( state, cb, chunk ) {
	var env = this.manager.env;
	chunk = Util.stripEOFTkfromTokens( chunk );

	var i, n;
	for (i = 0, n = chunk.length; i < n; i++) {
		if (chunk[i] && chunk[i].dataAttribs && chunk[i].dataAttribs.tsr ) {
			delete chunk[i].dataAttribs.tsr;
		}
		var t = chunk[i];
		if ( t.constructor === SelfclosingTagTk &&
				t.name.toLowerCase() === 'meta' &&
				t.getAttribute('typeof') &&
				t.getAttribute('typeof') === 'mw:Placeholder' )
		{
			// replace with empty string to avoid metas being foster-parented out
			chunk[i] = '';
		}
	}

	if (this.options.wrapTemplates) {
		if ( ! state.emittedFirstChunk ) {
			chunk = this.addEncapsulationInfo(state, chunk );
			state.emittedFirstChunk = true;
		} else {
			chunk = this.addAboutToTableElements( state, chunk );
		}
	} else {
		// Ignore comments in template transclusion mode
		var newChunk = [];
		for (i = 0, n = chunk.length; i < n; i++) {
			if (chunk[i].constructor !== defines.CommentTk) {
				newChunk.push(chunk[i]);
			}
		}
		chunk = newChunk;
	}

	env.dp( 'TemplateHandler._onChunk', chunk );
	cb( { tokens: chunk, async: true } );
};

/**
 * Handle the end event emitted by the parser pipeline after fully processing
 * the template source.
 */
TemplateHandler.prototype._onEnd = function( state, cb ) {
	this.manager.env.dp( 'TemplateHandler._onEnd' );
	if (this.options.wrapTemplates) {
		var endTag = this.getEncapsulationInfoEndTag(state),
			res = { tokens: [endTag] };
		state.emittedFirstChunk = false;
		cb( res );
	} else {
		cb( { tokens: [] } );
	}
};

/**
 * Handle the sub-DOM produced by a DOM-based template expansion
 *
 * This uses the same encapsulation mechanism as we use for template expansion
 * recycling.
 */
TemplateHandler.prototype._onDocument = function(state, cb, doc) {
	//console.log('_onDocument:', doc.body.outerHTML.substr(0, 100));

	var argDict = this.getArgInfo(state).dict;
	var addWrapperAttrs = function(firstNode) {
		// Adds the wrapper attributes to the first element
		firstNode.setAttribute('typeof', state.wrapperType);
		firstNode.setAttribute('data-mw', JSON.stringify(argDict));
		firstNode.setAttribute('data-parsoid', JSON.stringify(
			{
				tsr: Util.clone(state.token.dataAttribs.tsr),
				src: state.token.dataAttribs.src
			}
		));
	};

	var toks = DU.buildDOMFragmentTokens(
		this.manager.env,
		state.token,
		doc,
		addWrapperAttrs,
		{ setDSR: state.token.name === 'extension', isForeignContent: true }
	);

	//console.log('toks', JSON.stringify(toks, null, 2));
	// All done for this template, so perform a callback without async: set.
	cb({ tokens: toks });
};

/**
 * Get the public data-mw structure that exposes the template name and parameters
 * ExtensionHandler provides its own getArgInfo function
 */
TemplateHandler.prototype.getArgInfo = function (state) {
	var src = this.manager.env.page.src,
		params = state.token.attribs,
		dict = {},
		paramInfos = [],
		argIndex = 1;

	// Use source offsets to extract arg-name and arg-value wikitext
	// since the 'k' and 'v' values in params will be expanded tokens
	//
	// Ignore params[0] -- that is the template name
	for (var i = 1, n = params.length; i < n; i++) {
		var srcOffsets = params[i].srcOffsets;
		var kSrc, k, vSrc, v, paramInfo;
		if (srcOffsets) {
			kSrc = src.substring(srcOffsets[0], srcOffsets[1]);
			vSrc = src.substring(srcOffsets[2], srcOffsets[3]);
		} else {
			kSrc = params[i].k;
			vSrc = params[i].v;
		}

		k = kSrc.trim();
		v = vSrc;

		// Number positional parameters
		var isPositional;
		if (k === '') {
			isPositional = true;
			k = argIndex.toString();
			argIndex++;
		} else {
			isPositional = false;
			// strip ws from named parameter values
			v = v.trim();
		}

		if (dict[k] === undefined) {
			paramInfo = {
				k: k
			};

			var keySpaceMatch = kSrc.match(/^(\s*)[^]*?(\s*)$/),
				valueSpaceMatch;

			if (isPositional) {
				valueSpaceMatch = ['', '', ''];
			} else {
				paramInfo.named = true;
				valueSpaceMatch = v ? vSrc.match(/^(\s*)[^]*?(\s*)$/) : ['', '', vSrc];
			}

			// Preserve key and value space prefix / postfix, if any.
			// " = " is the default spacing used by the serializer,
			// ==> a single space need not be recorded hence the !== ' ' check
			//
			// PHP parser does not strip whitespace around positional
			// params and neither will we.
			if (keySpaceMatch[1] ||
				keySpaceMatch[2] !== ' ' ||
				(!isPositional && valueSpaceMatch[1] !== ' ') ||
				valueSpaceMatch[2])
			{
				// Remember non-standard spacing
				paramInfo.spc = [
					keySpaceMatch[1], keySpaceMatch[2],
					isPositional ? '' : valueSpaceMatch[1],
					valueSpaceMatch[2]
				];
			}

			paramInfos.push(paramInfo);
		}

		dict[k] = { wt: v };
	}

	var tplTgtSrcOffsets = params[0].srcOffsets;
	if (tplTgtSrcOffsets) {
		var tplTgtWT = src.substring(tplTgtSrcOffsets[0], tplTgtSrcOffsets[1]);
		return {
			dict: {
				target: { wt: tplTgtWT },
				params: dict
			},
			paramInfos: paramInfos
		};
	}
};

/**
 * Fetch a template
 */
TemplateHandler.prototype._fetchTemplateAndTitle = function ( title, parentCB, cb, state ) {
	// @fixme normalize name?
	var env = this.manager.env;
	if ( title in env.pageCache ) {
		// XXX: store type too (and cache tokens/x-mediawiki)
		cb(null, env.pageCache[title] /* , type */ );
	} else if ( ! env.conf.parsoid.fetchTemplates ) {
		// TODO: Set mw:Error and provide error info in data-mw
		// see https://bugzilla.wikimedia.org/show_bug.cgi?id=48900
		var spanStart = new TagTk( 'span', [new KV('typeof', 'mw:Placeholder')]),
			spanEnd = new EndTagTk('span');
		spanStart.dataAttribs = state.token.dataAttribs;
		parentCB(  { tokens: [spanStart,
			'Warning: Page/template fetching disabled, and no cache for ' + title,
			spanEnd	] } );
	} else {

		// We are about to start an async request for a template
		env.dp( 'Note: trying to fetch ', title );

		// Start a new request if none is outstanding
		//env.dp( 'requestQueue: ', env.requestQueue );
		if ( env.requestQueue[title] === undefined ) {
			env.tp( 'Note: Starting new request for ' + title );
			env.requestQueue[title] = new TemplateRequest( env, title );
		}
		// Idea: Append a listener to the request at the toplevel, but prepend at
		// lower levels to enforce depth-first processing
		// Did not really speed things up, so disabled for now..
		//if ( false && this.manager.options.isInclude ) {
		//	// prepend request: deal with requests from includes first
		//	env.requestQueue[title].listeners( 'src' ).unshift( cb );
		//} else {

		// append request, process in document order
		env.requestQueue[title].once( 'src', function(err, page) {
			cb(err, page ? page.revision['*'] : null);
		});

		//}
		parentCB ( { async: true } );
	}
};

/**
 * Fetch the preprocessed wikitext for a template-like construct.
 * (The 'Processor' argument is a constructor, hence the capitalization.)
 */
TemplateHandler.prototype.fetchExpandedTpl = function ( title, text, Processor, parentCB, cb ) {
	var env = this.manager.env;
	if ( text in env.pageCache ) {
		// XXX: store type too (and cache tokens/x-mediawiki)
		cb(null, env.pageCache[text] /* , type */ );
	} else if ( ! env.conf.parsoid.fetchTemplates ) {
		parentCB( { tokens: [ 'Warning: Page/template fetching disabled, and no cache for ' + text] });
	} else {

		// We are about to start an async request for a template
		env.dp( 'Note: trying to expand ', text );

		// Start a new request if none is outstanding
		//env.dp( 'requestQueue: ', env.requestQueue );
		if ( env.requestQueue[text] === undefined ) {
			env.tp( 'Note: Starting new request for ' + text );
			env.requestQueue[text] = new Processor( env, title, text );
		}
		// append request, process in document order
		env.requestQueue[text].once( 'src', cb );

		parentCB ( { async: true } );
	}
};

/* ********************** Template argument expansion ****************** */

/**
 * Expand template arguments with tokens from the containing frame.
 */

TemplateHandler.prototype.onTemplateArg = function (token, frame, cb) {
	var args = frame.args.named(),
		attribs = token.attribs,
		newCB;

	if (this.options.wrapTemplates) {
		// This is a bare use of template arg syntax at the top level
		// outside any template use context.  Wrap this use with RDF attrs.
		// so that this chunk can be RT-ed en-masse.
		var tplHandler = this;
		newCB = function(res) {
			var toks = Util.stripEOFTkfromTokens(res.tokens);
			var state = {
				token: token,
				wrapperType: "mw:Param",
				wrappedObjectId: tplHandler.manager.env.newObjectId()
			};
			toks = tplHandler.addEncapsulationInfo(state, toks);
			toks.push(tplHandler.getEncapsulationInfoEndTag(state));
			cb( {tokens: toks});
		};
	} else {
		newCB = cb;
	}
	if (this.manager.env.conf.parsoid.usePHPPreProcessor) {
		// When using the PHP preprocessor, we only evaluate top-level
		// (directly in the page content) template parameters. The top-level
		// frame is empty, so looking up a template parameter at page scope
		// will always fail. With this knowledge we can directly return just
		// the source and encapsulate it for round-tripping.
		//
		// Without async operations here, we also avoid issues like
		// the token sharing encountered in bug 61298 when tokens are also
		// processed all the way to DOM which involves destructive
		// modifications of tokens in the sanitizer.
		newCB({tokens:[token.dataAttribs.src]});
	} else {
		this.fetchArg(attribs[0].k, this.lookupArg.bind(this, args, attribs, newCB, cb), cb);
	}
};

TemplateHandler.prototype.fetchArg = function(arg, argCB, asyncCB) {
	if (arg.constructor === String) {
		argCB({tokens: [arg]});
	} else {
		this.manager.frame.expand(arg, {
			wrapTemplates: false,
			type: "tokens/x-mediawiki/expanded",
			asyncCB: asyncCB,
			cb: function(tokens) {
				argCB({tokens: Util.stripEOFTkfromTokens(tokens)});
			}
		});
	}
};

TemplateHandler.prototype.lookupArg = function(args, attribs, cb, asyncCB, ret) {
	var toks    = ret.tokens;
	var argName = toks.constructor === String ? toks : Util.tokensToString(toks).trim();
	var res     = args.dict[argName];

	// The 'res.constructor !== Function' protects against references to
	// tpl-args named 'prototype' or 'constructor' that haven't been passed in.
	if ( res && res.constructor !== Function ) {
		if (res.constructor === String) {
			cb( { tokens: args.namedArgs[argName] ? Util.tokenTrim([res]) : [res] } );
		} else {
			res.get({
				type: 'tokens/x-mediawiki/expanded',
				asyncCB: asyncCB,
				cb: (args.namedArgs[argName] ?
						function(res) { cb( {tokens: Util.tokenTrim(res)} ); } :
						function(res) { cb( {tokens: res} ); })
			});
		}
	} else if (attribs.length > 1 ) {
		this.fetchArg(attribs[1].v, cb, asyncCB);
	} else {
		//console.warn('no default for ' + argName + JSON.stringify( attribs ));
		cb({ tokens: [ '{{{' + argName + '}}}' ] });
	}
};

if (typeof module === "object") {
	module.exports.TemplateHandler = TemplateHandler;
}
