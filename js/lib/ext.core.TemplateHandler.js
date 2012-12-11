"use strict";
/**
 * Template and template argument handling, first cut.
 *
 * AsyncTokenTransformManager objects provide preprocessor-frame-like
 * functionality once template args etc are fully expanded, and isolate
 * individual transforms from concurrency issues. Template expansion is
 * controlled using a tplExpandData structure created independently for each
 * handled template tag.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 * @author Brion Vibber <brion@wikimedia.org>
 */
var events = require('events'),
	ParserFunctions = require('./ext.core.ParserFunctions.js').ParserFunctions,
	AttributeTransformManager = require('./mediawiki.TokenTransformManager.js')
									.AttributeTransformManager,
	defines = require('./mediawiki.parser.defines.js'),
	TemplateRequest = require('./mediawiki.ApiRequest.js').TemplateRequest,
	PreprocessorRequest = require('./mediawiki.ApiRequest.js').PreprocessorRequest,
	Util = require('./mediawiki.Util.js').Util;

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

	var state = { token: token };
	if (this.options.wrapTemplates) {
		state.templateId = this.manager.env.newObjectId();
		state.emittedFirstChunk = false;
	}

	if ( this.manager.env.usePHPPreProcessor ) {
		if ( this.options.wrapTemplates ) {
			// Use MediaWiki's action=expandtemplates preprocessor
			var text = token.getWTSource( this.manager.env ),
				srcHandler = this._processTemplateAndTitle.bind( this, state, frame,
						cb, text, [] );
			//console.log( text );
			cb( { async: true } );
			this.fetchExpandedTemplate( this.manager.env.pageName || '',
					text, cb, srcHandler);
		} else {
			// We don't perform recursive template expansion- something
			// template-like that the PHP parser did not expand. This is
			// encapsulated already, so just return the plain text.
			cb( { tokens: [ Util.tokensToString( [token] ) ] } );
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

TemplateHandler.prototype.targetToString = function ( tokens ) {
	var maybeTarget = Util.tokensToString( tokens, true );
	if ( maybeTarget.constructor === Array ) {
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
					return null;
				}
			}
		}
		// No tag tokens, strip comments and newlines
		return Util.tokensToString(tokens).trim();
	} else {
		// Only string
		return maybeTarget.trim();
	}
};


/**
 * Fetch, tokenize and token-transform a template after all arguments and the
 * target were expanded.
 */
TemplateHandler.prototype._expandTemplate = function ( state, frame, cb, attribs ) {

	//console.warn('TemplateHandler.expandTemplate: ' +
	//		JSON.stringify( tplExpandData, null, 2 ) );
	var env = this.manager.env,
		target = attribs[0].k,
		self = this;

	if ( ! target ) {
		env.ap( 'No target! ', attribs );
		console.trace();
	}

	// TODO:
	// check for 'subst:'
	// check for variable magic names
	// check for msg, msgnw, raw magics
	// check for parser functions


	//var args = Util.KVtoHash( tplExpandData.expandedArgs );

	// Convert the target to a string while stripping all non-text tokens
	target = Util.tokensToString(target);

	// strip subst for now.
	target = target.replace( /^(safe)?subst:/, '' );

	// XXX: wrap attribs in object with .dict() and .named() methods,
	// and each member (key/value) into object with .tokens(), .dom() and
	// .wikitext() methods (subclass of Array)

	var prefix = target.split(':', 1)[0].toLowerCase().trim();
	if ( prefix && 'pf_' + prefix in this.parserFunctions ) {
		var pfAttribs = new Params( env, attribs );
		pfAttribs[0] = new KV( target.substr( prefix.length + 1 ), [] );
		//env.dp( 'func prefix/args: ', prefix,
		//		tplExpandData.expandedArgs,
		//		'unnamedArgs', tplExpandData.origToken.attribs,
		//		'funcArg:', funcArg
		//		);
		env.dp( 'entering prefix', target, state.token  );
		var newCB;
		if (this.options.wrapTemplates) {
			newCB = this._parserFunctionsWrapper.bind(this, state, cb);
		} else {
			newCB = cb;
		}
		this.parserFunctions['pf_' + prefix](state.token, this.manager.frame, newCB, pfAttribs);
		return;
	}

	// We are dealing with a real template, not a parser function.
	// Apply more stringent standards for template targets.
	target = this.targetToString(attribs[0].k);
	if ( target === null ) {
		// Target contains tags, convert template braces and pipes back into text
		// Re-join attribute tokens with '=' and '|'
		cb( { async: true } );
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
		return;
	}
	// strip subst for now.
	target = target.replace( /^(safe)?subst:/, '' );
	env.tp( 'template target: ' + target );

	// now normalize the target before template processing
	target = env.normalizeTitle( target );

	// Resolve a possibly relative link
	var templateName = env.resolveTitle(target, 'Template');

	var checkRes = this.manager.frame.loopAndDepthCheck( templateName, env.maxDepth );
	if( checkRes ) {
		// Loop detected or depth limit exceeded, abort!
		var res = [
				checkRes,
				new TagTk( 'a', [{k: 'href', v: target}] ),
				templateName,
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
	this._fetchTemplateAndTitle(
			templateName,
			cb,
			this._processTemplateAndTitle.bind( this, state, frame, cb, templateName, attribs )
		);
};

/**
 * Process a fetched template source
 */
TemplateHandler.prototype._processTemplateAndTitle = function( state, frame, cb, name, attribs, err, src, type ) {

	// We have a choice between aborting or keeping going and reporting the
	// error inline.
	// TODO: report as special error token and format / remove that just
	// before the serializer. (something like <mw:error ../> as source)
	if ( err ) {
		src = '';
		//this.manager.env.errCB(err);
	}

	//console.log( "=================================");
	//console.log( name );
	//console.log( "---------------------------------");
	//console.log( src );

	// Get a nested transformation pipeline for the input type. The input
	// pipeline includes the tokenizer, synchronous stage-1 transforms for
	// 'text/wiki' input and asynchronous stage-2 transforms).
	//
	// NOTE: No template wrapping required for nested templates.
	var pipelineOpts = {
		isInclude: true,
		wrapTemplates: false
	};
	var pipeline = this.manager.pipeFactory.getPipeline(
				type || 'text/x-mediawiki', pipelineOpts
			);

	pipeline.setFrame( this.manager.frame, name, attribs );

	// Hook up the inputPipeline output events to our handlers
	pipeline.addListener( 'chunk', this._onChunk.bind ( this, state, cb ) );
	pipeline.addListener( 'end', this._onEnd.bind ( this, state, cb ) );
	// Feed the pipeline. XXX: Support different formats.
	this.manager.env.dp( 'TemplateHandler._processTemplateAndTitle', name, attribs );
	pipeline.process ( src, name );
};

TemplateHandler.prototype.addAboutToTableElements = function ( state, tokens ) {
	for ( var i = 0, l = tokens.length; i < l; i++ ) {
		var token = tokens[i];
		if ( token.constructor === TagTk && token.name === 'table' ) {
			// clone before update attributes
			token = token.clone();
			token.addAttribute( 'about', '#' + state.templateId );
			tokens[i] = token;
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
	// * ref end token to this, add property="mw:Object/Template/End"

	var tsr = state.token.dataAttribs.tsr;
	var src = state.token.getWTSource(this.manager.env);
	var done = false;
	if ( chunk.length ) {
		var firstToken = chunk[0];
		if ( firstToken.constructor === String ) {
			// Also include following string tokens
			var stringTokens = [ chunk.shift() ];
			while ( chunk.length && chunk[0].constructor === String ) {
				stringTokens.push( chunk.shift() );
			}
			// Wrap in span with info
			var span = new TagTk( 'span',
						[
							new KV('typeof', 'mw:Object/Template'),
							new KV('about', '#' + state.templateId),
							new KV('id', state.templateId)
						],
						{
							tsr: Util.clone(tsr),
							src: src
						}
					);
			chunk = [span].concat(stringTokens, [ new EndTagTk( 'span' ) ], chunk);
			done = true;
		}
	}

	if (!done) {
		// add meta tag
		var mtag = new SelfclosingTagTk( 'meta', [
					new KV( 'about', '#' + state.templateId ),
					new KV( 'typeof', 'mw:Object/Template' ),
					new KV('id', state.templateId)
				], {
					tsr: Util.clone(tsr),
					src: src
				});
		chunk = [mtag].concat(chunk);
	}

	// add about ref to all tables
	return this.addAboutToTableElements( state, chunk );
};

TemplateHandler.prototype.getEncapsulationInfoEndTag = function ( state ) {
	var tsr = state.token.dataAttribs.tsr;
	return new SelfclosingTagTk( 'meta',
				[
					new KV( 'typeof', 'mw:Object/Template/End' ),
					new KV( 'about', '#' + state.templateId )
				], {
					tsr: [null, tsr ? tsr[1] : null]
				});
};

/**
 * Handle chunk emitted from the input pipeline after feeding it a template
 */
TemplateHandler.prototype._onChunk = function( state, cb, chunk ) {
	var env = this.manager.env;
	if (env.trace) {
		env.tracer.startPass("TemplateHandler:onChunk (" + state.token.toString(true) + ")");
	}
	chunk = Util.stripEOFTkfromTokens( chunk );

	var i, n;
	for (i = 0, n = chunk.length; i < n; i++) {
		// FIXME: This modifies without cloning! Instead, move the tsr
		// clearing to an earlier stage before the tokens enter the cache.
		if (chunk[i].dataAttribs && chunk[i].dataAttribs.tsr ) {
			if ( Object.isFrozen( chunk[i] ) ) {
				if ( ! Object.isFrozen( chunk ) ) {
					env.tp( 'TemplateHandler: Cloning object for tsr' );
					chunk[i] = Util.clone(chunk[i], true);
				} else {
					env.tp( 'ERROR: would need to clone the entire chunk' );
				}
			}
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
			if (chunk[i].constructor !== CommentTk) {
				newChunk.push(chunk[i]);
			}
		}
		chunk = newChunk;
	}

	env.dp( 'TemplateHandler._onChunk', chunk );
	cb( { tokens: chunk, async: true } );
	if (env.trace) {
		env.tracer.endPass("TemplateHandler:onChunk (" + state.token.toString(true) + ")");
	}
};

/**
 * Handle the end event emitted by the parser pipeline after fully processing
 * the template source.
 */
TemplateHandler.prototype._onEnd = function( state, cb ) {
	this.manager.env.dp( 'TemplateHandler._onEnd' );
	if (this.options.wrapTemplates) {
		var tsr = state.token.dataAttribs.tsr,
			endTag = this.getEncapsulationInfoEndTag(state),
			res = { tokens: [endTag] };
		state.emittedFirstChunk = false;
		cb( res );
	} else {
		cb( { tokens: [] } );
	}
};

/**
 * Fetch a template
 */
TemplateHandler.prototype._fetchTemplateAndTitle = function ( title, parentCB, cb ) {
	// @fixme normalize name?
	var env = this.manager.env;
	if ( title in env.pageCache ) {
		// XXX: store type too (and cache tokens/x-mediawiki)
		cb(null, env.pageCache[title] /* , type */ );
	} else if ( ! env.fetchTemplates ) {
		parentCB(  { tokens: [ 'Warning: Page/template fetching disabled, and no cache for ' +
				title ] } );
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
		env.requestQueue[title].listeners( 'src' ).push( cb );

		//}
		parentCB ( { async: true } );
	}
};

/**
 * Fetch the preprocessed wikitext for a template-like construct
 */
TemplateHandler.prototype.fetchExpandedTemplate = function ( title, text, parentCB, cb ) {
	var env = this.manager.env;
	if ( text in env.pageCache ) {
		// XXX: store type too (and cache tokens/x-mediawiki)
		cb(null, env.pageCache[text] /* , type */ );
	} else if ( ! env.fetchTemplates ) {
		parentCB(  { tokens: [ 'Warning: Page/template fetching disabled, and no cache for ' +
				text ] } );
	} else {

		// We are about to start an async request for a template
		env.dp( 'Note: trying to expand ', text );

		// Start a new request if none is outstanding
		//env.dp( 'requestQueue: ', env.requestQueue );
		if ( env.requestQueue[text] === undefined ) {
			env.tp( 'Note: Starting new request for ' + text );
			env.requestQueue[text] = new PreprocessorRequest( env, title, text );
		}
		// append request, process in document order
		env.requestQueue[text].listeners( 'src' ).push( cb );

		parentCB ( { async: true } );
	}
};

/*********************** Template argument expansion *******************/

/**
 * Expand template arguments with tokens from the containing frame.
 */

TemplateHandler.prototype.onTemplateArg = function (token, frame, cb) {
	// SSS FIXME: Are 'frame' and 'this.manager.frame' different?
	var args    = this.manager.frame.args.named();
	var attribs = token.attribs;
	this.fetchArg(attribs[0].k, this.lookupArg.bind(this, args, attribs, cb));
};

TemplateHandler.prototype.fetchArg = function(arg, argCB) {
	if (arg.constructor === String) {
		argCB({tokens: arg});
	} else {
		this.manager.frame.expand(arg, {
			wrapTemplates: false,
			type: "tokens/x-mediawiki/expanded",
			cb: function(tokens) {
				argCB({tokens: Util.stripEOFTkfromTokens(tokens)});
			}
		});
	}
};

TemplateHandler.prototype.lookupArg = function(args, attribs, cb, ret) {
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
				asyncCB: cb,
				cb: (args.namedArgs[argName] ?
						function(res) { cb( {tokens: Util.tokenTrim(res)} ); } :
						function(res) { cb( {tokens: res} ); })
			});
		}
	} else if (attribs.length > 1 ) {
		this.fetchArg(attribs[1].v, cb);
	} else {
		//console.warn('no default for ' + argName + JSON.stringify( attribs ));
		cb({ tokens: [ '{{{' + argName + '}}}' ] });
	}
};

if (typeof module === "object") {
	module.exports.TemplateHandler = TemplateHandler;
}
