/**
 * This module assembles parser pipelines from parser stages with
 * asynchronous communnication between stages based on events. Apart from the
 * default pipeline which converts WikiText to HTML DOM, it also provides
 * sub-pipelines for the processing of template transclusions.
 *
 * See http://www.mediawiki.org/wiki/Parsoid and
 * http://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for illustrations of the pipeline architecture.
 */
"use strict";

// make this global for now
// XXX: figure out a way to get away without a global for PEG actions!
var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	TokenTransformManager = require('./mediawiki.TokenTransformManager.js'),
	SyncTokenTransformManager = TokenTransformManager.SyncTokenTransformManager,
	AsyncTokenTransformManager = TokenTransformManager.AsyncTokenTransformManager,
	ExtensionHandler = require('./ext.core.ExtensionHandler.js').ExtensionHandler,
	NoIncludeOnly = require('./ext.core.NoIncludeOnly.js'),
	IncludeOnly = NoIncludeOnly.IncludeOnly,
	NoInclude = NoIncludeOnly.NoInclude,
	OnlyInclude	= NoIncludeOnly.OnlyInclude,
	QuoteTransformer = require('./ext.core.QuoteTransformer.js').QuoteTransformer,
	TokenStreamPatcher = require('./ext.core.TokenStreamPatcher.js').TokenStreamPatcher,
	PreHandler = require('./ext.core.PreHandler.js').PreHandler,
	ParagraphWrapper = require('./ext.core.ParagraphWrapper.js').ParagraphWrapper,
	Sanitizer = require('./ext.core.Sanitizer.js').Sanitizer,
	TemplateHandler = require('./ext.core.TemplateHandler.js').TemplateHandler,
	AttributeExpander = require('./ext.core.AttributeExpander.js').AttributeExpander,
	ListHandler = require('./ext.core.ListHandler.js').ListHandler,
	LinkHandler = require('./ext.core.LinkHandler.js'),
	WikiLinkHandler	= LinkHandler.WikiLinkHandler,
	ExternalLinkHandler	= LinkHandler.ExternalLinkHandler,
	BehaviorSwitch = require('./ext.core.BehaviorSwitchHandler.js'),
	BehaviorSwitchHandler = BehaviorSwitch.BehaviorSwitchHandler,
	BehaviorSwitchPreprocessor = BehaviorSwitch.BehaviorSwitchPreprocessor,
	DOMFragmentBuilder = require('./ext.core.DOMFragmentBuilder.js').DOMFragmentBuilder,
	TreeBuilder = require('./mediawiki.HTML5TreeBuilder.node.js').FauxHTML5.TreeBuilder,
	DOMPostProcessor = require('./mediawiki.DOMPostProcessor.js').DOMPostProcessor;

var ParserPipeline; // forward declaration

function ParserPipelineFactory ( env ) {
	this.pipelineCache = {};
	this.env = env;
}

/**
 * Recipe for parser pipelines and -subpipelines, depending on input types.
 *
 * Token stream transformations to register by type and per phase. The
 * possible ranks for individual transformation registrations are [0,1)
 * (excluding 1.0) for sync01, [1,2) for async12 and [2,3) for sync23.
 *
 * Should perhaps be moved to mediawiki.parser.environment.js, so that all
 * configuration can be found in a single place.
 */

ParserPipelineFactory.prototype.recipes = {
	// The full wikitext pipeline
	'text/x-mediawiki/full': [
		// Input pipeline including the tokenizer
		'text/x-mediawiki',
		// Final synchronous token transforms and DOM building / processing
		'tokens/x-mediawiki/expanded'
	],

	// A pipeline from wikitext to expanded tokens. The input pipeline for
	// wikitext.
	'text/x-mediawiki': [
		[ PegTokenizer, [] ],
		'tokens/x-mediawiki'
	],

	// Synchronous per-input and async token stream transformations. Produces
	// a fully expanded token stream ready for consumption by the
	// tokens/expanded pipeline.
	'tokens/x-mediawiki': [
		// Synchronous in-order per input
		[
			SyncTokenTransformManager,
			[ 1, 'tokens/x-mediawiki' ],
			[
				// PHASE RANGE: [0,1)
				OnlyInclude,	// 0.01
				IncludeOnly,	// 0.02
				NoInclude,		// 0.03

				// Preprocess behavior switches
				BehaviorSwitchPreprocessor // 0.05
			]
		],
		/*
		* Asynchronous out-of-order per input. Each async transform can only
		* operate on a single input token, but can emit multiple output
		* tokens. If multiple tokens need to be collected per-input, then a
		* separate collection transform in sync01 can be used to wrap the
		* collected tokens into a single one later processed in an async12
		* transform.
		*/
		[
			AsyncTokenTransformManager,
			[ 2, 'tokens/x-mediawiki' ],
			[
				// PHASE RANGE: [1,2)
				TemplateHandler,	// 1.1
				ExtensionHandler,   // 1.11

				// Expand attributes after templates to avoid expanding unused branches
				// No expansion of quotes, paragraphs etc in attributes, as in
				// PHP parser- up to text/x-mediawiki/expanded only.
				AttributeExpander,	// 1.12

				// now all attributes expanded to tokens or string

				// more convenient after attribute expansion
				WikiLinkHandler,	// 1.15

				ExternalLinkHandler, // 1.15
				/* ExtensionHandler2, */ // using expanded args
				// Finally expand attributes to plain text

				// This converts dom-fragment-token tokens all the way to DOM
				// and wraps them in DOMFragment wrapper tokens which will then
				// get unpacked into the DOM by a dom-fragment unpacker.
				DOMFragmentBuilder       // 1.99
			]
		]
	],

	// Final stages of main pipeline, operating on fully expanded tokens of
	// potentially mixed origin.
	'tokens/x-mediawiki/expanded': [
		// Synchronous in-order on fully expanded token stream (including
		// expanded templates etc). In order to support mixed input (from
		// wikitext and plain HTML, say) all applicable transforms need to be
		// included here. Input-specific token types avoid any runtime
		// overhead for unused transforms.
		[
			SyncTokenTransformManager,
				// PHASE RANGE: [2,3)
			[ 3, 'tokens/x-mediawiki/expanded' ],
			[
				TokenStreamPatcher,     // 2.001 -- 2.003
					// add <pre>s
				PreHandler,             // 2.051 -- 2.054
				QuoteTransformer,       // 2.1
					// add before transforms that depend on behavior switches
					// examples: toc generation, edit sections
				BehaviorSwitchHandler,  // 2.14

				ListHandler,            // 2.49
				Sanitizer,              // 2.90, 2.91
					// Wrap tokens into paragraphs post-sanitization so that
					// tags that converted to text by the sanitizer have a chance
					// of getting wrapped into paragraphs.  The sanitizer does not
					// require the existence of p-tags for its functioning.
				ParagraphWrapper        // 2.95 -- 2.97
			]
		],

		// Build a tree out of the fully processed token stream
		[ TreeBuilder, [] ],

		/*
		 * Final processing on the HTML DOM.
		 */

		/*
		 * Generic DOM transformer.
		 * This performs a lot of post-processing of the DOM
		 * (Template wrapping, broken wikitext/html detection, etc.)
		 */
		[ DOMPostProcessor, [] ]
	]
};

// SSS FIXME: maybe there is some built-in method for this already?
// Default options processing
ParserPipelineFactory.prototype.defaultOptions = function(options) {
	if (!options) {
		options = {};
	}

	// default: not an include context
	if (options.isInclude === undefined) {
		options.isInclude = false;
	}

	// default: wrap templates
	if (options.wrapTemplates === undefined) {
		options.wrapTemplates = true;
	}

	if (options.cacheKey === undefined) {
		options.cacheKey = null;
	}

	return options;
};

/**
 * Generic pipeline creation from the above recipes
 */
ParserPipelineFactory.prototype.makePipeline = function( type, options ) {
	// SSS FIXME: maybe there is some built-in method for this already?
	options = this.defaultOptions(options);

	var recipe = this.recipes[type];
	if ( ! recipe ) {
		console.trace();
		throw( 'Error while trying to construct pipeline for ' + type );
	}
	var stages = [];
	for ( var i = 0, l = recipe.length; i < l; i++ ) {
		// create the stage
		var stageData = recipe[i],
			stage;

		if ( stageData.constructor === String ) {
			// Points to another subpipeline, get it recursively
			// Clone options object and clear cache type
			var newOpts = Object.assign({}, options);
			newOpts.cacheKey = null;
			stage = this.makePipeline( stageData, newOpts);
		} else {
			stage = Object.create( stageData[0].prototype );
			// call the constructor
			stageData[0].apply( stage, [ this.env, options, this ].concat( stageData[1] ) );
			if ( stageData.length >= 3 ) {
				// FIXME: This code here adds the 'transformers' property to every stage
				// behind the back of that stage.  There are two alternatives to this:
				//
				// 1. Add 'recordTransformer' and 'getTransformers' functions to every stage.
				//    But, seems excessive compared to current approach where the stages
				//    aren't concerned with unnecessary details of state maintained for
				//    the purposes of top-level orchestration.
				// 2. Alternatively, we could also maintain this information as a separate
				//    object rather than tack it onto '.transformers' property of each stage.
				//    this.stageTransformers = [
				//      [stage1-transformers],
				//      [stage2-transformers],
				//      ...
				//    ];

				stage.transformers = [];
				// Create (and implicitly register) transforms
				var transforms = stageData[2];
				for ( var j = 0; j < transforms.length; j++ ) {
					var t = new transforms[j](stage, options);
					stage.transformers.push(t);
				}
			}
		}

		// connect with previous stage
		if ( i ) {
			stage.addListenersOn( stages[i-1] );
		}
		stages.push( stage );
	}
	//console.warn( 'stages' + stages + JSON.stringify( stages ) );
	return new ParserPipeline(
		type,
		stages,
		options.cacheKey ? this.returnPipeline.bind( this, options.cacheKey ) : null,
		this.env
	);
};

function getCacheKey(cacheKey, options) {
	cacheKey = cacheKey || '';
	if ( ! options.isInclude ) {
		cacheKey += '::noInclude';
	}
	if ( ! options.wrapTemplates ) {
		cacheKey += '::noWrap';
	}
	if ( options.inBlockToken ) {
		cacheKey += '::inBlockToken';
	}
	if ( options.noPre ) {
		cacheKey += '::noPre';
	}
	if ( options.inTemplate ) {
		cacheKey += '::inTemplate';
	}
	if ( options.attrExpansion ) {
		cacheKey += '::attrExpansion';
	}
	if ( options.extTag ) {
		cacheKey += '::'+options.extTag;
	}
	return cacheKey;
}

/**
 * Get a subpipeline (not the top-level one) of a given type.
 *
 * Subpipelines are cached as they are frequently created.
 */
ParserPipelineFactory.prototype.getPipeline = function ( type, options ) {
	options = this.defaultOptions(options);

	var cacheKey = getCacheKey(type, options);
	if ( ! this.pipelineCache[cacheKey] ) {
		this.pipelineCache[cacheKey] = [];
	}
	var pipe;
	if ( this.pipelineCache[cacheKey].length ) {
		//console.warn( JSON.stringify( this.pipelineCache[cacheKey] ));
		pipe = this.pipelineCache[cacheKey].pop();
	} else {
		options.cacheKey = cacheKey;
		pipe = this.makePipeline( type, options );
	}
	// add a cache callback
	if ( this.returnToCacheCB ) {
		pipe.last.addListener( 'end', this.returnToCacheCB );
	}
	return pipe;
};

/**
 * Callback called by a pipeline at the end of its processing. Returns the
 * pipeline to the cache.
 */
ParserPipelineFactory.prototype.returnPipeline = function ( type, pipe ) {
	// Clear all listeners, but do so after all other handlers have fired
	//pipe.on('end', function() { pipe.removeAllListeners( ) });
	pipe.removeAllListeners( );
	var cache = this.pipelineCache[type];
	if ( cache.length < 8 ) {
		cache.push( pipe );
	}
};


/* ******************* ParserPipeline *************************** */

/**
 * Wrap some stages into a pipeline. The last member of the pipeline is
 * supposed to emit events, while the first is supposed to support a process()
 * method that sets the pipeline in motion.
 */
var globalPipelineId = 0;
ParserPipeline = function( type, stages, returnToCacheCB, env ) {
	this.uid = globalPipelineId++;
	this.pipeLineType = type;
	this.stages = stages;
	this.first = stages[0];
	this.last = stages.last();
	this.env = env;

	// Debugging aid
	var id = this.uid;
	this.stages.forEach(function(stage) { stage.pipelineId = id; });

	if ( returnToCacheCB ) {
		var self = this;
		this.returnToCacheCB = function () {
			returnToCacheCB( self );
		};
	}
};

/*
 * Applies the function across all stages and transformers registered at each stage
 */
ParserPipeline.prototype._applyToStage = function(fn, args) {
	// Apply to each stage
	this.stages.map(function(stage) {
		if (stage[fn] && stage[fn].constructor === Function) {
			stage[fn].apply(stage, args);
		}
		// Apply to each registered transformer for this stage
		if (stage.transformers) {
			stage.transformers.map(function(t) {
				if (t[fn] && t[fn].constructor === Function) {
					t[fn].apply(t, args);
				}
			});
		}
	});

	// Apply to all known native extensions
	var nativeExts = this.env.conf.parsoid.nativeExtensions;
	Object.keys(nativeExts).map(function(extName) {
		var ext = nativeExts[extName];
		if (ext[fn] && ext[fn].constructor === Function) {
			ext[fn].apply(ext, args);
		}
	});
};

/**
 * This is primarily required to reset native extensions
 * which might have be shared globally per parsing environment
 * (unlike pipeline stages and transformers that exist one per
 * pipeline). So, cannot rely on 'end' event to reset pipeline
 * because there will be one 'end' event per pipeline.
 *
 * Ex: cite needs to maintain a global sequence across all
 * template transclusion pipelines, extension, and top-level
 * pipelines.
 *
 * This lets us reuse pipelines to parse unrelated top-level pages
 * Ex: parser tests. Currently only parser tests exercise
 * this functionality.
 */
ParserPipeline.prototype.resetState = function() {
	this._applyToStage("resetState", []);
};


/**
 * Set source offsets for the source that this pipeline will process
 *
 * This lets us use different pipelines to parse fragments of the same page
 * Ex: extension content (found on the same page) is parsed with a different
 * pipeline than the top-level page.
 *
 * Because of this, the source offsets are not [0, page.length) always
 * and needs to be explicitly initialized
 */
ParserPipeline.prototype.setSourceOffsets = function(start, end) {
	this._applyToStage("setSourceOffsets", [start, end]);
};

/**
 * Feed input tokens to the first pipeline stage
 */
ParserPipeline.prototype.process = function(input, key) {
	try {
		return this.first.process(input, key);
	} catch ( err ) {
		this.env.log("fatal", err);
	}
};

/**
 * Feed input tokens to the first pipeline stage
 */
ParserPipeline.prototype.processToplevelDoc = function(input) {
	try {
		// Reset pipeline state once per top-level doc.
		// This clears state from any per-doc global state
		// maintained across all pipelines used by the document.
		// (Ex: Cite state)
		this.resetState();
		return this.first.process(input);
	} catch ( err ) {
		this.env.log("fatal", err);
	}
};

/**
 * Set the frame on the last pipeline stage (normally the
 * AsyncTokenTransformManager).
 */
ParserPipeline.prototype.setFrame = function(frame, title, args) {
	return this._applyToStage("setFrame", [frame, title, args]);
};

/**
 * Register the first pipeline stage with the last stage from a separate pipeline
 */
ParserPipeline.prototype.addListenersOn = function(stage) {
	return this.first.addListenersOn(stage);
};

// Forward the EventEmitter API to this.last
ParserPipeline.prototype.on = function (ev, cb) {
	return this.last.on(ev, cb);
};
ParserPipeline.prototype.once = function (ev, cb) {
	return this.last.once(ev, cb);
};
ParserPipeline.prototype.addListener = function(ev, cb) {
	return this.last.addListener(ev, cb);
};
ParserPipeline.prototype.removeListener = function(ev, cb) {
	return this.last.removeListener(ev, cb);
};
ParserPipeline.prototype.setMaxListeners = function(n) {
	return this.last.setMaxListeners(n);
};
ParserPipeline.prototype.listeners = function(ev) {
	return this.last.listeners(ev);
};
ParserPipeline.prototype.removeAllListeners = function ( event ) {
	this.last.removeAllListeners(event);
};

if (typeof module === "object") {
	module.exports.ParserPipeline = ParserPipeline;
	module.exports.ParserPipelineFactory = ParserPipelineFactory;
}
