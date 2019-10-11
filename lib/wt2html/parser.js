/**
 * This module assembles parser pipelines from parser stages with
 * asynchronous communnication between stages based on events. Apart from the
 * default pipeline which converts WikiText to HTML DOM, it also provides
 * sub-pipelines for the processing of template transclusions.
 *
 * See http://www.mediawiki.org/wiki/Parsoid and
 * http://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for illustrations of the pipeline architecture.
 * @module
 */

'use strict';

var Promise = require('../utils/promise.js');
var PegTokenizer = require('./tokenizer.js').PegTokenizer;
var TokenTransformManager = require('./TokenTransformManager.js');
var ExtensionHandler = require('./tt/ExtensionHandler.js').ExtensionHandler;
var NoIncludeOnly = require('./tt/NoIncludeOnly.js');
var QuoteTransformer = require('./tt/QuoteTransformer.js').QuoteTransformer;
var TokenStreamPatcher = require('./tt/TokenStreamPatcher.js').TokenStreamPatcher;
var PreHandler = require('./tt/PreHandler.js').PreHandler;
var ParagraphWrapper = require('./tt/ParagraphWrapper.js').ParagraphWrapper;
var SanitizerHandler = require('./tt/Sanitizer.js').SanitizerHandler;
var TemplateHandler = require('./tt/TemplateHandler.js').TemplateHandler;
var AttributeExpander = require('./tt/AttributeExpander.js').AttributeExpander;
var ListHandler = require('./tt/ListHandler.js').ListHandler;
var WikiLinkHandler = require('./tt/WikiLinkHandler.js').WikiLinkHandler;
var ExternalLinkHandler = require('./tt/ExternalLinkHandler.js').ExternalLinkHandler;
var BehaviorSwitchHandler = require('./tt/BehaviorSwitchHandler.js').BehaviorSwitchHandler;
var LanguageVariantHandler = require('./tt/LanguageVariantHandler.js').LanguageVariantHandler;
var DOMFragmentBuilder = require('./tt/DOMFragmentBuilder.js').DOMFragmentBuilder;
var HTML5TreeBuilder = require('./HTML5TreeBuilder.js').HTML5TreeBuilder;
var DOMPostProcessor = require('./DOMPostProcessor.js').DOMPostProcessor;
var JSUtils = require('../utils/jsutils.js').JSUtils;

var SyncTokenTransformManager = TokenTransformManager.SyncTokenTransformManager;
var AsyncTokenTransformManager = TokenTransformManager.AsyncTokenTransformManager;
var IncludeOnly = NoIncludeOnly.IncludeOnly;
var NoInclude = NoIncludeOnly.NoInclude;
var OnlyInclude = NoIncludeOnly.OnlyInclude;


var ParserPipeline; // forward declaration
var globalPipelineId = 0;

/**
 * @class
 * @param {MWParserEnvironment} env
 */
function ParserPipelineFactory(env) {
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
 * Should perhaps be moved to {@link MWParserEnvironment}, so that all
 * configuration can be found in a single place.
 */
ParserPipelineFactory.prototype.recipes = {
	// The full wikitext pipeline
	'text/x-mediawiki/full': [
		// Input pipeline including the tokenizer
		'text/x-mediawiki',
		// Final synchronous token transforms and DOM building / processing
		'tokens/x-mediawiki/expanded',
	],

	// A pipeline from wikitext to expanded tokens. The input pipeline for
	// wikitext.
	'text/x-mediawiki': [
		[ PegTokenizer, [] ],
		'tokens/x-mediawiki',
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
				OnlyInclude,  // 0.01
				IncludeOnly,  // 0.02
				NoInclude,  // 0.03
			],
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
				TemplateHandler,  // 1.1
				ExtensionHandler,  // 1.11

				// Expand attributes after templates to avoid expanding unused branches
				// No expansion of quotes, paragraphs etc in attributes, as in
				// PHP parser- up to text/x-mediawiki/expanded only.
				AttributeExpander,  // 1.12

				// now all attributes expanded to tokens or string

				// more convenient after attribute expansion
				WikiLinkHandler,  // 1.15
				ExternalLinkHandler,  // 1.15
				LanguageVariantHandler, // 1.16

				// This converts dom-fragment-token tokens all the way to DOM
				// and wraps them in DOMFragment wrapper tokens which will then
				// get unpacked into the DOM by a dom-fragment unpacker.
				DOMFragmentBuilder,  // 1.99
			],
		],
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
				SanitizerHandler,       // 2.90, 2.91
				// Wrap tokens into paragraphs post-sanitization so that
				// tags that converted to text by the sanitizer have a chance
				// of getting wrapped into paragraphs.  The sanitizer does not
				// require the existence of p-tags for its functioning.
				ParagraphWrapper,       // 2.95 -- 2.97
			],
		],

		// Build a tree out of the fully processed token stream
		[ HTML5TreeBuilder, [] ],

		/*
		 * Final processing on the HTML DOM.
		 */

		/*
		 * Generic DOM transformer.
		 * This performs a lot of post-processing of the DOM
		 * (Template wrapping, broken wikitext/html detection, etc.)
		 */
		[ DOMPostProcessor, [] ],
	],
};

var supportedOptions = new Set([
	// If true, templates found in content will have its contents expanded
	'expandTemplates',

	// If true, indicates pipeline is processing the expanded content of a
	// template or its arguments
	'inTemplate',

	// If true, indicates that we are in a <includeonly> context
	// (in current usage, isInclude === inTemplate)
	'isInclude',

	// The extension tag that is being processed (Ex: ref, references)
	// (in current usage, only used for native tag implementation)
	'extTag',

	// Extension-specific options
	'extTagOpts',

	// Content being parsed is used in an inline context
	'inlineContext',

	// FIXME: Related to PHP parser doBlockLevels side effect.
	// Primarily exists for backward compatibility reasons.
	// Might eventually go away in favor of something else.
	'inPHPBlock',

	// Are we processing content of attributes?
	// (in current usage, used for transcluded attr. keys/values)
	'attrExpansion',
]);

// Default options processing
var defaultOptions = function(options) {
	if (!options) { options = {}; }

	Object.keys(options).forEach(function(k) {
		console.assert(supportedOptions.has(k), 'Invalid cacheKey option: ' + k);
	});

	// default: not an include context
	if (options.isInclude === undefined) {
		options.isInclude = false;
	}

	// default: wrap templates
	if (options.expandTemplates === undefined) {
		options.expandTemplates = true;
	}

	return options;
};

/**
 * Generic pipeline creation from the above recipes.
 */
ParserPipelineFactory.prototype.makePipeline = function(type, options) {
	// SSS FIXME: maybe there is some built-in method for this already?
	options = defaultOptions(options);

	var recipe = this.recipes[type];
	if (!recipe) {
		console.trace();
		throw 'Error while trying to construct pipeline for ' + type;
	}
	var stages = [];
	for (var i = 0, l = recipe.length; i < l; i++) {
		// create the stage
		var stageData = recipe[i];
		var stage;

		if (stageData.constructor === String) {
			// Points to another subpipeline, get it recursively
			// Clone options object and clear cache type
			var newOpts = Object.assign({}, options);
			stage = this.makePipeline(stageData, newOpts);
		} else {
			console.assert(stageData[1].length <= 2);
			stage = new (stageData[0])(this.env, options, this, stageData[1][0], stageData[1][1]);
			if (stageData.length >= 3) {
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
				for (var j = 0; j < transforms.length; j++) {
					const T = transforms[j];
					stage.transformers.push(new T(stage, options));
				}
			}
		}

		// connect with previous stage
		if (i) {
			stage.addListenersOn(stages[i - 1]);
		}
		stages.push(stage);
	}

	return new ParserPipeline(
		type,
		stages,
		this.env
	);
};

function getCacheKey(cacheKey, options) {
	cacheKey = cacheKey || '';
	if (!options.isInclude) {
		cacheKey += '::noInclude';
	}
	if (!options.expandTemplates) {
		cacheKey += '::noExpand';
	}
	if (options.inlineContext) {
		cacheKey += '::inlineContext';
	}
	if (options.inPHPBlock) {
		cacheKey += '::inPHPBlock';
	}
	if (options.inTemplate) {
		cacheKey += '::inTemplate';
	}
	if (options.attrExpansion) {
		cacheKey += '::attrExpansion';
	}
	if (options.extTag) {
		cacheKey += '::' + options.extTag;
		// FIXME: This is not the best strategy. But, instead of
		// premature complexity, let us see how extensions want to
		// use this and then figure out what constraints are needed.
		if (options.extTagOpts) {
			cacheKey += '::' + JSON.stringify(options.extTagOpts);
		}
	}
	return cacheKey;
}

/**
 * @param {string} src
 * @param {Function} [cb]
 * @return {Promise}
 */
ParserPipelineFactory.prototype.parse = function(src, cb) {
	return new Promise((resolve, reject) => {
		// Now go ahead with the actual parsing
		var parser = this.getPipeline('text/x-mediawiki/full');
		parser.once('document', resolve);
		parser.processToplevelDoc(src);
	}).nodify(cb);
};


/**
 * Get a subpipeline (not the top-level one) of a given type.
 *
 * Subpipelines are cached as they are frequently created.
 */
ParserPipelineFactory.prototype.getPipeline = function(type, options) {
	options = defaultOptions(options);

	var cacheKey = getCacheKey(type, options);
	if (!this.pipelineCache[cacheKey]) {
		this.pipelineCache[cacheKey] = [];
	}

	var pipe;
	if (this.pipelineCache[cacheKey].length) {
		pipe = this.pipelineCache[cacheKey].pop();
		pipe.resetState();
		// Clear both 'end' and 'document' handlers
		pipe.removeAllListeners('end');
		pipe.removeAllListeners('document');
		// Also remove chunk listeners, although ideally that would already
		// happen in resetState. We'd need to avoid doing so when called from
		// processToplevelDoc though, so lets do it here for now.
		pipe.removeAllListeners('chunk');
	} else {
		pipe = this.makePipeline(type, options);
	}
	// add a cache callback
	var returnPipeline = () => this.returnPipeline(cacheKey, pipe);
	// Token pipelines emit an 'end' event
	pipe.addListener('end', returnPipeline);
	// Document pipelines emit a final 'document' even instead
	pipe.addListener('document', returnPipeline);

	// Debugging aid: Assign unique id to the pipeline
	pipe.setPipelineId(globalPipelineId++);

	return pipe;
};

/**
 * Callback called by a pipeline at the end of its processing. Returns the
 * pipeline to the cache.
 */
ParserPipelineFactory.prototype.returnPipeline = function(cacheKey, pipe) {
	// Clear all listeners, but do so after all other handlers have fired
	// pipe.on('end', function() { pipe.removeAllListeners( ) });
	var cache = this.pipelineCache[cacheKey];
	if (!cache) {
		cache = this.pipelineCache[cacheKey] = [];
	}
	if (cache.length < 100) {
		cache.push(pipe);
	}
};

/* ******************* ParserPipeline *************************** */

/**
 * Wrap some stages into a pipeline. The last member of the pipeline is
 * supposed to emit events, while the first is supposed to support a process()
 * method that sets the pipeline in motion.
 * @class
 */
ParserPipeline = function(type, stages, env) {
	this.pipeLineType = type;
	this.stages = stages;
	this.first = stages[0];
	this.last = JSUtils.lastItem(stages);
	this.env = env;
};

/**
 * Applies the function across all stages and transformers registered at each stage.
 * @private
 */
ParserPipeline.prototype._applyToStage = function(fn, args) {
	// Apply to each stage
	this.stages.forEach(function(stage) {
		if (stage[fn] && stage[fn].constructor === Function) {
			stage[fn].apply(stage, args);
		}
		// Apply to each registered transformer for this stage
		if (stage.transformers) {
			stage.transformers.forEach(function(t) {
				if (t[fn] && t[fn].constructor === Function) {
					t[fn].apply(t, args);
				}
			});
		}
	});
};

/**
 * This is useful for debugging.
 */
ParserPipeline.prototype.setPipelineId = function(id) {
	this.id = id;
	this._applyToStage("setPipelineId", [id]);
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
ParserPipeline.prototype.resetState = function(opts) {
	this._applyToStage("resetState", [opts]);
};

/**
 * Set source offsets for the source that this pipeline will process.
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
 * Feed input tokens to the first pipeline stage.
 *
 * @param {Array|string} input tokens
 * @param {boolean} sol Whether tokens should be processed in start-of-line
 *   context.
 */
ParserPipeline.prototype.process = function(input, sol) {
	try {
		return this.first.process(input, sol);
	} catch (err) {
		this.env.log("fatal", err);
	}
};

/**
 * Feed input tokens to the first pipeline stage.
 */
ParserPipeline.prototype.processToplevelDoc = function(input) {
	// Reset pipeline state once per top-level doc.
	// This clears state from any per-doc global state
	// maintained across all pipelines used by the document.
	// (Ex: Cite state)
	this.resetState({ toplevel: true });
	if (!this.env.startTime) {
		this.env.startTime = JSUtils.startTime();
	}
	this.env.log('trace/time', 'Starting parse at ', this.env.startTime);
	this.process(input, /* sol */true);
};

/**
 * Set the frame on the last pipeline stage (normally the
 * AsyncTokenTransformManager).
 */
ParserPipeline.prototype.setFrame = function(frame, title, args, srcText) {
	return this._applyToStage("setFrame", [frame, title, args, srcText]);
};

/**
 * Register the first pipeline stage with the last stage from a separate pipeline.
 */
ParserPipeline.prototype.addListenersOn = function(stage) {
	return this.first.addListenersOn(stage);
};

// Forward the EventEmitter API to this.last
ParserPipeline.prototype.on = function(ev, cb) {
	return this.last.on(ev, cb);
};
ParserPipeline.prototype.once = function(ev, cb) {
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
ParserPipeline.prototype.removeAllListeners = function(event) {
	this.last.removeAllListeners(event);
};

if (typeof module === "object") {
	module.exports.ParserPipelineFactory = ParserPipelineFactory;
}
