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
		state.templateId = 'mwt' + this.manager.env.generateUID();
		state.emittedFirstChunk = false;
	}

	// expand argument keys, with callback set to next processing step
	// XXX: would likely be faster to do this in a tight loop here
	var atm = new AttributeTransformManager(
				this.manager,
				{ wrapTemplates: false },
				this._expandTemplate.bind( this, state, frame, cb )
			);
	cb( { async: true } );
	atm.processKeys(token.attribs);
};

/**
 * Create positional (number) keys for arguments without explicit keys
 */
TemplateHandler.prototype._nameArgs = function ( attribs ) {
	var n = 1,
		out = [];
	for ( var i = 0, l = attribs.length; i < l; i++ ) {
		// FIXME: Also check for whitespace-only named args!
		if ( ! attribs[i].k.length ) {
			out.push( new KV( n.toString(), attribs[i].v ) );
			n++;
		} else {
			out.push( attribs[i] );
		}
	}
	this.manager.env.dp( '_nameArgs: ', out );
	return out;
};

/**
 * Parser functions also need template wrapping
 */
TemplateHandler.prototype._parserFunctionsWrapper = function(state, cb, ret) {
	if (!ret) {
		cb();
	} else {
		if (ret.tokens) {
			this._onChunk(state, cb, ret.tokens);
		}
		if (!ret.async) {
			// Now, ready to finish up
			this._onEnd(state, cb);
		}
	}
};

/**
 * Fetch, tokenize and token-transform a template after all arguments and the
 * target were expanded.
 */
TemplateHandler.prototype._expandTemplate = function ( state, frame, cb, attribs ) {
	//console.warn('TemplateHandler.expandTemplate: ' +
	//		JSON.stringify( tplExpandData, null, 2 ) );
	var env = this.manager.env;
	var target = attribs[0].k;

	if ( ! target ) {
		env.ap( 'No target! ', attribs );
		console.trace();
	}

	// TODO:
	// check for 'subst:'
	// check for variable magic names
	// check for msg, msgnw, raw magics
	// check for parser functions

	// First, check the target for loops
	target = Util.tokensToString( target ).trim();

	//var args = Util.KVtoHash( tplExpandData.expandedArgs );

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
			token.addSpaceSeparatedAttribute( 'typeof', 'mw:Object/Template/Content' );
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
	if ( ! state.emittedFirstChunk ) {
		var tsr = state.token.dataAttribs.tsr;
		var src = this.manager.env.text.substring(tsr[0], tsr[1]);
		if ( chunk.length ) {
			var firstToken = chunk[0];
			if ( firstToken.constructor === String ) {
				// Also include following string tokens
				var stringTokens = [ chunk.shift() ];
				while ( chunk.length && chunk[0].constructor === String ) {
					stringTokens.push( chunk.shift() );
				}
				// Wrap in span with info
				return [ new TagTk( 'span',
							[
								new KV('typeof', 'mw:Object/Template'),
								new KV('about', '#' + state.templateId),
								new KV('id', state.templateId)
							],
							{ 
								tsr: Util.clone(tsr),
								src: src,
							}
						) ]
					.concat( stringTokens, [ new EndTagTk( 'span' ) ], chunk );
			} else if ( firstToken.constructor === TagTk || firstToken.constructor === SelfclosingTagTk) {
				// XXX: handle id/about conflicts

				// clone token and update attributes
				chunk.shift();
				firstToken = firstToken.clone();
				firstToken.addSpaceSeparatedAttribute( 'typeof', 'mw:Object/Template' );
				firstToken.setAttribute( 'about', '#' + state.templateId );
				firstToken.setAttribute( 'id', state.templateId );
				firstToken.dataAttribs.src = src;
				chunk.unshift(firstToken);

				// add about ref to all tables
				return this.addAboutToTableElements( state, chunk );
			}
		} else {
			// add about ref to all tables
			return [ new SelfclosingTagTk( 'meta', [
						new KV( 'about', '#' + state.templateId ),
						new KV( 'typeof', 'mw:Object/Template' )
					], {
						tsr: Util.clone(tsr),
						src: src
					})
			];
		}
	} else {
		return this.addAboutToTableElements( state, chunk );
		//return chunk;
	}
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
	if (this.options.wrapTemplates) {
		if ( ! state.emittedFirstChunk ) {
			chunk = this.addEncapsulationInfo(state, chunk );
			state.emittedFirstChunk = true;
		} else {
			chunk = this.addAboutToTableElements( state, chunk );
		}
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
		var res = { tokens: [
			new SelfclosingTagTk( 'meta',
				[
					new KV( 'typeof', 'mw:Object/Template/End' ),
					new KV( 'about', '#' + state.templateId )
				] )
			] };
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
		// Append a listener to the request at the toplevel, but prepend at
		// lower levels to enforce depth-first processing
		if ( false && this.manager.options.isInclude ) {
			// prepend request: deal with requests from includes first
			env.requestQueue[title].listeners( 'src' ).unshift( cb );
		} else {
			// append request, process in document order
			env.requestQueue[title].listeners( 'src' ).push( cb );
		}
		parentCB ( { async: true } );
	}
};


/*********************** Template argument expansion *******************/

/**
 * Expand template arguments with tokens from the containing frame.
 */
TemplateHandler.prototype.onTemplateArg = function ( token, frame, cb ) {
	new AttributeTransformManager (
				this.manager,
				{ wrapTemplates: false },
				this._returnArgAttributes.bind( this, token, cb, frame )
			).process(token.attribs.slice() );
};

TemplateHandler.prototype._returnArgAttributes = function ( token, cb, frame, attributes ) {
	var env = this.manager.env;
	//console.warn( '_returnArgAttributes: ' + JSON.stringify( attributes ));
	var argName = Util.tokensToString( attributes[0].k ).trim(),
		dict = this.manager.frame.args.named(),
		res;
	env.dp( 'args', argName /*, dict*/ );
	if ( argName in dict ) {
		// return tokens for argument
		//console.warn( 'templateArg found: ' + argName +
		//		' vs. ' + JSON.stringify( this.manager.args ) );
		res = dict[argName];
		env.dp( 'arg res:', res );
		if ( res.constructor === String ) {
			cb( { tokens: [res] } );
		} else {
			dict[argName].get({
				type: 'tokens/x-mediawiki/expanded',
				cb: function( res ) { cb ( { tokens: res } ); },
				asyncCB: cb
			});
		}
	} else {
		env.dp( 'templateArg not found: ', argName /*' vs. ', dict */ );
		if ( attributes.length > 1 ) {
			res = attributes[1].v;
		} else {
			//console.warn('no default for ' + argName + JSON.stringify( attributes ));
			res = [ '{{{' + argName + '}}}' ];
		}
		cb( { tokens: res } );
	}
};

if (typeof module === "object") {
	module.exports.TemplateHandler = TemplateHandler;
}
