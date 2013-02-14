/**
 * Token transformation managers with a (mostly) abstract
 * TokenTransformManager base class and AsyncTokenTransformManager and
 * SyncTokenTransformManager implementation subclasses. Individual
 * transformations register for the token types they are interested in and are
 * called on each matching token.
 *
 * Async token transformations are supported by the TokenAccumulator class,
 * that manages as-early-as-possible and in-order return of tokens including
 * buffering.
 *
 * See
 * https://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for more documentation.
 */
"use strict";

var events = require('events'),
	LRU = require("lru-cache"),
	jshashes = require('jshashes'),
	Util = require('./mediawiki.Util.js').Util;


function verifyTokensIntegrity(ret, nullOkay) {
	// FIXME: Where is this coming from?
	if (ret.constructor === Array) {
		console.warn(' ret is not an object: ' + JSON.stringify( ret ) );
		console.trace();
		ret = { tokens: ret };
	} else if (!nullOkay && ret.tokens === undefined) {
		console.warn( 'ret.tokens undefined: ' + JSON.stringify( ret ) );
		console.trace();
		ret.tokens = ( ret.token === undefined ) ? [] : [ret.token];
	}

	if (ret.tokens && ret.tokens.constructor !== Array) {
		console.warn( 'ret.tokens not an array: ' + JSON.stringify( ret ) );
		console.trace();
		ret.tokens = [ ret.tokens ];
	}

	return ret;
}

/**
 * Base class for token transform managers
 *
 * @class
 * @constructor
 * @param {Function} callback, a callback function accepting a token list as
 * its only argument.
 */
function TokenTransformManager( env, options, pipeFactory, phaseEndRank, attributeType ) {
	// Separate the constructor, so that we can call it from subclasses.
	this._construct();
}

function tokenTransformersKey(tkType, tagName) {
	return (tkType === 'tag') ? "tag:" + tagName : tkType;
}

// Map of: token constructor ==> transfomer type
// Used for returning active transformers for a token
TokenTransformManager.tkConstructorToTkTypeMap = {
	"String" : "text",
	"NlTk" : "newline",
	"CommentTk" : "comment",
	"EOFTk" : "end",
	"TagTk" : "tag",
	"EndTagTk" : "tag",
	"SelfclosingTagTk" : "tag",
	"InternalTk" : "internal"
};

// Inherit from EventEmitter
TokenTransformManager.prototype = new events.EventEmitter();
TokenTransformManager.prototype.constructor = TokenTransformManager;

TokenTransformManager.prototype._construct = function () {
	this.defaultTransformers = [];	// any transforms
	this.tokenTransformers   = {};	// non-any transforms
	this.cachedTransformers  = {};	// merged any + non-any transforms
};

/**
 * Register to a token source, normally the tokenizer.
 * The event emitter emits a 'chunk' event with a chunk of tokens,
 * and signals the end of tokens by triggering the 'end' event.
 * XXX: Perform registration directly in the constructor?
 *
 * @method
 * @param {Object} EventEmitter token even emitter.
 */
TokenTransformManager.prototype.addListenersOn = function ( tokenEmitter ) {
	tokenEmitter.addListener('chunk', this.onChunk.bind( this ) );
	tokenEmitter.addListener('end', this.onEndEvent.bind( this ) );
};

TokenTransformManager.prototype.setTokensRank = function ( tokens, rank ) {
	for ( var i = 0, l = tokens.length; i < l; i++ ) {
		tokens[i] = this.env.setTokenRank( rank, tokens[i] );
	}
};

/**
 * Predicate for sorting transformations by ascending rank.
 * */
TokenTransformManager.prototype._cmpTransformations = function ( a, b ) {
	return a.rank - b.rank;
};

/**
 * Add a transform registration.
 *
 * @method
 * @param {Function} transform.
 * @param {String} Debug string to identify the transformer in a trace.
 * @param {Number} rank, [0,3) with [0,1) in-order on input token stream,
 * [1,2) out-of-order and [2,3) in-order on output token stream
 * @param {String} type, one of 'tag', 'text', 'newline', 'comment', 'end',
 * 'martian' (unknown token), 'any' (any token, matched before other matches).
 * @param {String} tag name for tags, omitted for non-tags
 */
TokenTransformManager.prototype.addTransform = function ( transformation, debug_name, rank, type, name ) {
	var t = {
		rank: rank,
		name: debug_name
	};
	if (!this.env.conf.parsoid.trace) {
		t.transform = transformation;
	} else {
		// Trace info
		var mgr = this;
		t.transform = function() {
			mgr.env.tracer.startPass(debug_name + ":" + rank);
			var r = transformation.apply(null, arguments);
			mgr.env.tracer.endPass(debug_name + ":" + rank);
			return r;
		};
	}

	if (type === 'any') {
		// Record the any transformation
		this.defaultTransformers.push(t);

		// clear cache
		this.cachedTransformers = {};
	} else {
		var key = tokenTransformersKey(type, name);
		var tArray = this.tokenTransformers[key];
		if (!tArray) {
			tArray = this.tokenTransformers[key] = [];
		}
		tArray.push(t);
		tArray.sort(this._cmpTransformations);

		// clear the relevant cache entry
		this.cachedTransformers[key] = null;
	}
};

/**
 * Remove a transform registration
 *
 * @method
 * @param {Function} transform.
 * @param {Number} rank, [0,3) with [0,1) in-order on input token stream,
 * [1,2) out-of-order and [2,3) in-order on output token stream
 * @param {String} type, one of 'tag', 'text', 'newline', 'comment', 'end',
 * 'martian' (unknown token), 'any' (any token, matched before other matches).
 * @param {String} tag name for tags, omitted for non-tags
 */
TokenTransformManager.prototype.removeTransform = function ( rank, type, name ) {
	function removeMatchingTransform(transformers, rank) {
		var i = 0, n = transformers.length;
		while (i < n && rank !== transformers[i].rank) {
			i++;
		}
		transformers.splice(i, 1);
	}

	if (type === 'any') {
		// Remove from default transformers
		removeMatchingTransform(this.defaultTransformers, rank);

		// clear cache
		this.cachedTransformers = {};
	} else {
		var key = tokenTransformersKey(type, name);
		var tArray = this.tokenTransformers[key];
		if (tArray) {
			removeMatchingTransform(tArray, rank);
		}

		// clear the relevant cache entry
		this.cachedTransformers[key] = null;
	}
};

/**
 * Get all transforms for a given token
 */
TokenTransformManager.prototype._getTransforms = function ( token, minRank ) {
	var tkType = TokenTransformManager.tkConstructorToTkTypeMap[token.constructor.name];
	var key = tokenTransformersKey(tkType, token.name);
	var tts = this.cachedTransformers[key];
	if (!tts) {
		// generate and cache -- dont cache if there are no default transformers
		tts = this.tokenTransformers[key] || [];
		if (this.defaultTransformers.length > 0) {
			tts = tts.concat(this.defaultTransformers);
			tts.sort(this._cmpTransformations);
			this.cachedTransformers[key] = tts;
		}
	}

	if ( minRank !== undefined ) {
		// skip transforms <= minRank
		var i = 0;
		for ( var l = tts.length; i < l && tts[i].rank <= minRank; i++ ) { }
		return ( i && tts.slice( i ) ) || tts;
	} else {
		return tts;
	}
};

/******************** Async token transforms: Phase 2 **********************/

/**
 * Asynchronous and potentially out-of-order token transformations, used in phase 2.
 *
 * return protocol for individual transforms:
 *		{ tokens: [tokens], async: true }: async expansion -> outstanding++ in parent
 *		{ tokens: [tokens] }: fully expanded, tokens will be reprocessed
 *
 * @class
 * @constructor
 */
function AsyncTokenTransformManager ( env, options, pipeFactory, phaseEndRank, attributeType ) {
	this.env = env;
	this.options = options;
	this.pipeFactory = pipeFactory;
	this.phaseEndRank = phaseEndRank;
	this.attributeType = attributeType;
	this.setFrame( null, null, [] );
	this.debug = env.conf.parsoid.debug;
	this.trace = env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("async:" + phaseEndRank) !== -1);
	this._construct();
}

// Inherit from TokenTransformManager, and thus also from EventEmitter.
AsyncTokenTransformManager.prototype = new TokenTransformManager();
AsyncTokenTransformManager.prototype.constructor = AsyncTokenTransformManager;

// Reset state between uses
AsyncTokenTransformManager.prototype.reset = function() {
	this.tailAccumulator = null;
	// initial top-level callback, emits chunks
	this.tokenCB = this.emitChunk.bind( this );
};

/**
 * Reset the internal token and outstanding-callback state of the
 * TokenTransformManager, but keep registrations untouched.
 *
 * @method
 */
AsyncTokenTransformManager.prototype.setFrame = function ( parentFrame, title, args ) {
	this.env.dp( 'AsyncTokenTransformManager.setFrame', title, args );

	// Reset accumulators
	this.reset();

	// now actually set up the frame
	if (parentFrame) {
		if ( title === null ) {
			// attribute, simply reuse the parent frame
			this.frame = parentFrame;
		} else {
			this.frame = parentFrame.newChild( title, this, args );
		}
	} else {
		this.frame = new Frame(title, this, args );
	}
};

/**
 * Callback for async returns from head of TokenAccumulator chain
 */
AsyncTokenTransformManager.prototype.emitChunk = function( ret ) {
	this.env.dp( 'emitChunk', ret );

	function checkForEOFTkErrors(ttm, ret, atEnd) {
		if ( ttm.frame.depth === 0 &&
				ret.tokens && ret.tokens.length ) {
			if ( atEnd && ret.tokens.last() && ret.tokens.last().constructor !== EOFTk )
			{
				console.error("ERROR: EOFTk went missing in AsyncTokenTransformManager");
				ret.tokens.push(new EOFTk());
			}
			for ( var i = 0, l = ret.tokens.lengh; i < l - 1; i++ ) {
				if ( ret.tokens[i] && ret.tokens[i].constructor === EOFTk ) {
					console.error("ERROR: EOFTk in the middle of chunk");
					console.trace();
				}
			}

		}
	}

	// This method is often the root of the call stack, so makes a good point
	// for a try/catch to ensure error handling.
	try {
		// Check if an EOFTk went missing
		checkForEOFTkErrors(this, ret, !ret.async);
		this.emit( 'chunk', ret.tokens );

		if ( ret.async ) {
			// Our work is done here, but more async tokens are yet to come.
			//
			// Allow accumulators to bypass their callbacks and go directly
			// through emitChunk for those future token chunks.
			return this.emitChunk.bind( this );
		} else {
			this.emit('end');
			this.reset(); // Reset accumulators
		}
	} catch ( e ) {
		this.env.errCB( e );
	}
};


/**
 * Simple wrapper that processes all tokens passed in
 */
AsyncTokenTransformManager.prototype.process = function ( tokens ) {
	this.onChunk( tokens );
	this.onEndEvent();
};

/**
 * Transform and expand tokens. Transformed token chunks will be emitted in
 * the 'chunk' event.
 *
 * @method
 * @param {Array} chunk of tokens
 */
AsyncTokenTransformManager.prototype.onChunk = function ( tokens ) {
	this.env.tracer.startPass("onChunk (Async:" + this.attributeType + ")");

	// Set top-level callback to next transform phase
	var res = this.transformTokens ( tokens, this.tokenCB );
	this.env.dp( 'AsyncTokenTransformManager onChunk', res.async? 'async' : 'sync', res.tokens );

	// Emit or append the returned tokens
	if ( ! this.tailAccumulator ) {
		this.env.dp( 'emitting' );
		this.emit( 'chunk', res.tokens );
	} else {
		this.env.dp( 'appending to tail' );
		this.tailAccumulator.append( res.tokens );
	}

	// Update the tail of the current accumulator chain
	if ( res.asyncAccum ) {
		this.tailAccumulator = res.asyncAccum;
		this.tokenCB = res.asyncAccum.getParentCB ( 'sibling' );
	}

	this.env.tracer.endPass("onChunk (Async:" + this.attributeType + ")");
};

/**
 * Callback for the end event emitted from the tokenizer.
 * Either signals the end of input to the tail of an ongoing asynchronous
 * processing pipeline, or directly emits 'end' if the processing was fully
 * synchronous.
 */
AsyncTokenTransformManager.prototype.onEndEvent = function () {
	if ( this.tailAccumulator ) {
		this.env.dp( 'AsyncTokenTransformManager.onEndEvent: calling siblingDone',
				this.frame.title );
		this.tailAccumulator.siblingDone();
	} else {
		// nothing was asynchronous, so we'll have to emit end here.
		this.env.dp( 'AsyncTokenTransformManager.onEndEvent: synchronous done',
				this.frame.title );
		this.emit('end');

		// Reset accumulators
		this.reset();
	}
};


/**
 * Utility method to set up a new TokenAccumulator with the right callbacks.
 */
AsyncTokenTransformManager.prototype._makeNextAccum = function( cb, state ) {
	var newAccum = new TokenAccumulator( this, cb );
	var _cbs     = { parentCB: newAccum.getParentCB( 'child' ) };
	var newCB    = this.maybeSyncReturn.bind( this, state, _cbs );
	_cbs.self = newCB;

	return { accum: newAccum, cb: newCB };
};

// Debug counter, provides an UID for transformTokens calls so that callbacks
// associated with it can be identified in debugging output as c-XXX.
AsyncTokenTransformManager.prototype._counter = 0;

/**
 * Run asynchronous transformations. This is the big workhorse where
 * templates, images, links and other async expansions (see the transform
 * recipe mediawiki.parser.js) are processed.
 *
 * @param tokens {Array}: Chunk of tokens, potentially with rank and other
 * meta information associated with it.
 * @param parentCB {Function}: callback for asynchronous results
 * @returns {Object}: { tokens: [], async: falsy or the tail TokenAccumulator }
 * The returned chunk is fully expanded for this phase, and the rank set
 * to reflect this.
 */
AsyncTokenTransformManager.prototype.transformTokens = function ( tokens, parentCB ) {

	// Trivial case
	if (tokens.length === 0) {
		return { tokens: tokens };
	}

	//console.warn('AsyncTokenTransformManager.transformTokens: ' + JSON.stringify(tokens) );

	var inputRank = tokens.rank || 0,
		localAccum = [], // a local accum for synchronously returned fully processed tokens
		activeAccum = localAccum, // start out collecting tokens in localAccum
								// until the first async transform is hit
		s = { // Shared state accessible to synchronous transforms in this.maybeSyncReturn
			transforming: true,
			// debug id for this expansion
			c: 'c-' + AsyncTokenTransformManager.prototype._counter++
		},
		inAsyncMode = false;

	// make localAccum compatible with getParentCB('sibling')
	localAccum.getParentCB = function() { return parentCB; };
	var nextAccum = this._makeNextAccum( parentCB, s );

	// Stack of token arrays to process
	// Initialize to the token array that was passed in
	var workStack = [tokens];
	tokens.eltIndex = 0;

	while ( workStack.length > 0 ) {
		var token, minRank,
			curChunk = workStack.last();

		// Activate nextActiveAccum after consuming the chunk
		if ( curChunk.eltIndex === curChunk.length ) {
			if ( curChunk.nextActiveAccum ) {
				if ( activeAccum !== curChunk.oldActiveAccum ) {
					// update the callback of the next active accum
					curChunk.nextActiveAccum.setParentCB( activeAccum.getParentCB('sibling') );
				}
				activeAccum = curChunk.nextActiveAccum;
				// create new accum and cb for transforms
				nextAccum = this._makeNextAccum( activeAccum.getParentCB('sibling'), s );
			}

			// remove processed chunk
			workStack.pop();
			continue;
		}

		minRank = curChunk.rank || inputRank;
		token = curChunk[curChunk.eltIndex++];

		// Token type special cases -- FIXME: why do we have this?
		if ( token.constructor === Array ) {
			if ( ! token.length ) {
				// skip it
			} else if ( token.rank >= this.phaseEndRank ) {
				// don't process the array in this phase.
				activeAccum.push( token );
			} else {
				workStack.push( token );
			}
			continue;
		} else if ( token.constructor === ParserValue ) {
			// Parser functions etc that run before full attribute
			// expansion are responsible for the full expansion of
			// returned attributes in their respective environments.
			throw( 'Unexpected ParserValue in AsyncTokenTransformManager.transformTokens:' +
					JSON.stringify( token ) );
		}

		if (this.trace) {
			console.warn("A" + this.phaseEndRank + ": " + JSON.stringify(token));
		} else {
			// SSS FIXME: with individual stage tracing, this overall generic tracing
			// is becoming less and less useful now.  Do a cleanup one of these days.
			this.env.tracer.traceToken(token);
		}

		var ts = this._getTransforms( token, minRank );

		//this.env.dp( 'async token:', s.c, token, minRank, ts );

		if ( ! ts.length ) {
			// nothing to do for this token
			activeAccum.push( token );
		} else {
			//this.env.tp( 'async trans' );
			for (var j = 0, lts = ts.length; j < lts; j++ ) {
				var transformer = ts[j];

				// s.res is only used when we are still in this transfomer loop.
				// In that scenario, it is safe to reset this each time around
				// since s.res.tokens is retrieved after the transformation is done.
				s.res = { };

				// Transform the token.  This will call nextAccum.cb either
				// with tokens or with an async signal.  In either case,
				// s.res will be populated.
				transformer.transform( token, this.frame, nextAccum.cb );

				var resTokens = s.res.tokens;

				//this.env.dp( 's.res:', s.c, s.res );

				// Check the result, which is changed using the
				// maybeSyncReturn callback
				if ( resTokens && resTokens.length ) {
					if ( resTokens.length === 1 ) {
						var soleToken = resTokens[0];
						if ( soleToken === undefined ) {
							console.warn('transformer ' + transformer.rank +
									' returned undefined token!');
							resTokens.shift();
							break;
						}
						// SSS FIXME: AttributeExpander clones the token
						// So, this simplistic comparison for modification will
						// fail leading us to do extra work on most tokens.
						//
						// Can be fixed by passing an additional flag from
						// AttributeExpander that tells us if the token needs
						// reprocessing.
						if ( token === soleToken && ! resTokens.rank ) {
							// token not modified, continue with transforms.
							continue;
						} else if (
							resTokens.rank === this.phaseEndRank ||
							( soleToken.constructor === String &&
								! this.tokenTransformers.text ) )
						{
							// Fast path for text token, and nothing to do for it
							// Abort processing, but treat token as done.
							token = soleToken;
							break;
						}
					}

					// SSS FIXME: This workstack code below can insert a workstack
					// chunk even when there is just a single token to process.
					// Could be fixed.
					//
					// token(s) were potentially modified
					if ( ! resTokens.rank || resTokens.rank < this.phaseEndRank ) {
						// There might still be something to do for these
						// tokens. Prepare them for the workStack.
						resTokens = resTokens.slice();
						resTokens.eltIndex = 0;
						// Don't apply earlier transforms to results of a
						// transformer to avoid loops and keep the
						// execution model sane.
						resTokens.rank = resTokens.rank || transformer.rank;
						//resTokens.rank = Math.max( resTokens.rank || 0, transformer.rank );
						workStack.push( resTokens );
						if ( s.res.async ) {
							inAsyncMode = true;
							// don't trigger activeAccum switch / _makeNextAccum call below
							s.res.async = false;

							resTokens.oldActiveAccum = activeAccum;
							resTokens.nextActiveAccum = nextAccum.accum;

							// Since we've reserved nextAccum.accum for this token chunk,
							// create a new next-accum and cb for transforms
							nextAccum = this._makeNextAccum( activeAccum.getParentCB('sibling'), s );
						}

						if (this.debug) {
							// Avoid expensive map and slice if we dont need to.
							this.env.dp(
								'workStack',
								s.c,
								resTokens.rank,
								// Filter out processed tokens
								workStack.map(function(a) { return a.slice(a.eltIndex); }) );
						}
					}
				}

				// Abort processing for this token
				token = null;
				break;
			}

			if ( token !== null ) {
				// token is done.
				// push to accumulator
				//console.warn( 'pushing ' + token );
				activeAccum.push( token );
			}

			if ( s.res.async ) {
				this.env.dp( 'res.async, creating new TokenAccumulator', s.c );
				// The child now switched to activeAccum, we have to create a new
				// accumulator for the next potential child.
				activeAccum = nextAccum.accum;
				nextAccum = this._makeNextAccum( activeAccum.getParentCB('sibling'), s );
				inAsyncMode = true;
			}
		}
	}

	// we are no longer transforming, maybeSyncReturn needs to follow the
	// async code path
	s.transforming = false;

	// All tokens in localAccum are fully processed
	localAccum.rank = this.phaseEndRank;

	this.env.dp( 'localAccum', inAsyncMode ? 'async' : 'sync', s.c, localAccum );

	// Return finished tokens directly to caller, and indicate if further
	// async actions are outstanding. The caller needs to point a sibling to
	// the returned accumulator, or call .siblingDone() to mark the end of a
	// chain.
	return { tokens: localAccum, asyncAccum: inAsyncMode ? activeAccum : null };
};

/**
 * Callback for async transforms
 *
 * Converts direct callbacks into a synchronous return by collecting the
 * results in s.res. Re-start transformTokens for any async returns, and calls
 * the provided asyncCB (TokenAccumulator._returnTokens normally).
 */
AsyncTokenTransformManager.prototype.maybeSyncReturn = function ( s, cbs, ret ) {

	// Null ret.tokens is okay since ret could just be an async signal
	ret = verifyTokensIntegrity(ret, true);

	if ( s.transforming ) {
		// transformTokens is still ongoing, handle as sync return by
		// collecting the results in s.res
		this.env.dp( 'maybeSyncReturn transforming', s.c, ret );
		if ( ret.tokens ) {
			if ( s.res.tokens ) {
				var oldRank = s.res.tokens.rank;
				s.res.tokens = s.res.tokens.concat( ret.tokens );
				if ( oldRank && ret.tokens.rank ) {
					// Conservatively set the overall rank to the minimum.
					// This assumes that multi-pass expansion for some tokens
					// is safe. We might want to revisit that later.
					Math.min( oldRank, ret.tokens.rank );
				}
			} else {
				s.res = ret;
			}
		}

		s.res.async = ret.async;
	} else {
		// Since the original transformTokens call is already done, we have to
		// re-start application of any remaining transforms here.
		this.env.dp( 'maybeSyncReturn async', s.c, ret );
		var asyncCB = cbs.parentCB,
			tokens = ret.tokens;
		if ( tokens ) {
			if (  tokens.length &&
				( ! tokens.rank || tokens.rank < this.phaseEndRank ) &&
				! ( tokens.length === 1 && tokens[0].constructor === String ) )
			{
				// Re-process incomplete tokens
				this.env.dp( 'maybeSyncReturn: recursive transformTokens',
						this.frame.title, ret.tokens );

				// Set up a new child callback with its own callback state
				var _cbs = { parentCB: cbs.parentCB },
					childCB = this.maybeSyncReturn.bind( this, s, _cbs );
				_cbs.self = childCB;

				var res = this.transformTokens( ret.tokens, childCB );
				ret.tokens = res.tokens;
				if ( res.asyncAccum ) {
					// Insert new child accumulator chain- any further chunks from
					// the transform will be passed as sibling to the last accum
					// in this chain, and the new chain will pass its results to
					// the former parent accumulator.

					if ( ! ret.async ) {
						// There will be no more input to the child pipeline
						res.asyncAccum.siblingDone();

						// We need to indicate that more results will follow from
						// the child pipeline.
						ret.async = true;
					} else {
						// More tokens will follow from original expand.
						// Need to return results of recursive expand *before* further
						// async results, so we simply pass further results to the
						// last accumulator in the new chain.
						cbs.parentCB = res.asyncAccum.getParentCB( 'sibling' );
					}
				}
			}
		} else if ( ret.async === true ) {
			// No tokens, was supposed to indicate async processing but came
			// too late.
			// TODO: Track down sources for these (unnecessary) calls and try
			// to avoid them if possible.
			return;
		}

		asyncCB( ret );

		if ( ret.async ) {
			// Pass reference to maybeSyncReturn to TokenAccumulators to allow
			// them to call directly
			return cbs.self;
		}
	}
};





/*************** In-order, synchronous transformer (phase 1 and 3) ***************/

/**
 * Subclass for phase 3, in-order and synchronous processing.
 *
 * @class
 * @constructor
 * @param {Object} environment.
 */
function SyncTokenTransformManager ( env, options, pipeFactory, phaseEndRank, attributeType ) {
	this.env = env;
	this.options = options;
	this.pipeFactory = pipeFactory;
	this.phaseEndRank = phaseEndRank;
	this.attributeType = attributeType;
	this.trace = env.conf.parsoid.traceFlags && (env.conf.parsoid.traceFlags.indexOf("sync:" + phaseEndRank) !== -1);
	this._construct();
}

// Inherit from TokenTransformManager, and thus also from EventEmitter.
SyncTokenTransformManager.prototype = new TokenTransformManager();
SyncTokenTransformManager.prototype.constructor = SyncTokenTransformManager;


SyncTokenTransformManager.prototype.process = function ( tokens ) {
	this.onChunk( tokens );
	this.onEndEvent();
};


/**
 * Global in-order and synchronous traversal on token stream. Emits
 * transformed chunks of tokens in the 'chunk' event.
 *
 * @method
 * @param {Array} Token chunk.
 */
SyncTokenTransformManager.prototype.onChunk = function ( tokens ) {

	// Trivial case
	if (tokens.length === 0) {
		this.emit( 'chunk', tokens );
		return;
	}

	this.env.tracer.startPass("onChunk (Sync:" + this.attributeType + ")");
	this.env.dp( 'SyncTokenTransformManager.onChunk, input: ', tokens );

	var localAccum = [];

	// Stack of token arrays to process
	// Initialize to the token array that was passed in
	var workStack = [tokens];
	tokens.eltIndex = 0;

	while ( workStack.length > 0 ) {
		var token, minRank;

		var curChunk = workStack.last();
		minRank = curChunk.rank || this.phaseEndRank - 1;
		token = curChunk[curChunk.eltIndex++];
		if ( curChunk.eltIndex === curChunk.length ) {
			// remove processed chunk
			workStack.pop();
		}

		if (this.trace) {
			console.warn("S" + this.phaseEndRank + ": " + JSON.stringify(token));
		} else {
			// SSS FIXME: with individual stage tracing, this overall generic tracing
			// is becoming less and less useful now.  Do a cleanup one of these days.
			this.env.tracer.traceToken(token);
		}

		var transformer,
			ts = this._getTransforms( token, minRank ),
			res = { token: token };

		//this.env.dp( 'sync tok:', minRank, token.rank, token, ts );

		// Push the token through the transformations till it morphs
		var j = 0, numTransforms = ts.length;
		while (j < numTransforms && (token === res.token)) {
			transformer = ts[j];
			// Transform the token.
			res = transformer.transform( token, this, this.prevToken );
			//this.env.dp( 'sync res0:', res );
			j++;
		}

		if ( res.token && res.token !== token ) {
			res = { tokens: [res.token] };
		}

		//this.env.dp( 'sync res:', res );

		if ( res.tokens && res.tokens.length ) {
			if ( token.constructor === EOFTk &&
					res.tokens.last().constructor !== EOFTk ) {
				console.error( 'ERROR: EOFTk was dropped by ' + transformer.name );
				// fix it up for now by adding it back in
				res.tokens.push(token);
			}
			// Splice in the returned tokens (while replacing the original
			// token), and process them next.
			var resTokens = res.tokens.slice();
			resTokens.eltIndex = 0;
			resTokens.rank = res.tokens.rank || transformer.rank;
			workStack.push( resTokens );
		} else if ( res.token ) {
			localAccum.push(res.token);
			this.prevToken = res.token;
		} else {
			if ( token.constructor === EOFTk ) {
				console.error( 'ERROR: EOFTk was dropped by ' + transformer.name );
				localAccum.push(new EOFTk());
			}
			this.prevToken = token;
		}
	}

	localAccum.rank = this.phaseEndRank;
	localAccum.cache = tokens.cache;
	this.env.dp( 'SyncTokenTransformManager.onChunk: emitting ', localAccum );
	this.env.tracer.endPass("onChunk (Sync:" + this.attributeType + ")");
	this.emit( 'chunk', localAccum );
};


/**
 * Callback for the end event emitted from the tokenizer.
 * Either signals the end of input to the tail of an ongoing asynchronous
 * processing pipeline, or directly emits 'end' if the processing was fully
 * synchronous.
 */
SyncTokenTransformManager.prototype.onEndEvent = function () {
	// This phase is fully synchronous, so just pass the end along and prepare
	// for the next round.
	this.prevToken = null;
	this.emit('end');
};


/********************** AttributeTransformManager *************************/

/**
 * Utility transformation manager for attributes, using an attribute
 * transformation pipeline (normally phase1 SyncTokenTransformManager and
 * phase2 AsyncTokenTransformManager). This pipeline needs to be independent
 * of the containing TokenTransformManager to isolate transforms from each
 * other. The AttributeTransformManager returns its result by calling the
 * supplied callback.
 *
 * @class
 * @constructor
 * @param {Object} Containing AsyncTokenTransformManager
 * @param {Function} Callback function, called with expanded attribute array.
 */
function AttributeTransformManager ( manager, options, callback ) {
	this.manager = manager;
	this.options = options;
	this.frame = this.manager.frame;
	this.callback = callback;
	this.outstanding = 1;
	this.kvs = [];
	//this.pipe = manager.getAttributePipeline( manager.args );
}

// A few constants
AttributeTransformManager.prototype._toType = 'tokens/x-mediawiki/expanded';

/**
 * Expand both key and values of all key/value pairs. Used for generic
 * (non-template) tokens in the AttributeExpander handler, which runs after
 * templates are already expanded.
 */
AttributeTransformManager.prototype.process = function (attributes) {
	var n, pipe, ref;
	// console.warn( 'AttributeTransformManager.process: ' + JSON.stringify( attributes ) );

	// transform each argument (key and value), and handle asynchronous returns
	for ( var i = 0, l = attributes.length; i < l; i++ ) {
		var cur = attributes[i],
		    k   = cur.k,
			v   = cur.v;

		// fast path for string-only attributes
		if ( k.constructor === String && v.constructor === String ) {
			this.kvs.push( cur );
			continue;
		}

		var kv = new KV( [], [] );
		this.kvs.push( kv );

		if (v.constructor === Array) {
			n = v.length;
			if (n === 0 || (n === 1 && v[0].constructor === String)) {
				kv.v = v;
			} else {
				// Assume that the return is async, will be decremented in callback
				this.outstanding++;

				// transform the value
				this.frame.expand( v, {
							wrapTemplates: this.options.wrapTemplates,
							type: this._toType,
							cb: this._returnAttributeValue.bind( this, i )
						} );
			}
		} else {
			// NOTE: 'v' can be an unexpanded parser value
			// This will be lazily expanded when it is needed.
			kv.v = v;
		}

		if ( k.constructor === Array) {
			n = k.length;
			if (n === 0 || (n === 1 && k[0].constructor === String)) {
				kv.k = k;
			} else {
				// Assume that the return is async, will be decremented in callback
				this.outstanding++;

				// transform the key
				this.frame.expand( k, {
							wrapTemplates: this.options.wrapTemplates,
							type: this._toType,
							cb: this._returnAttributeKey.bind( this, i )
						} );
			}
		} else {
			kv.k = k;
		}
	}
	this.outstanding--;
	if ( this.outstanding === 0 ) {
		// synchronous, done
		this.callback( this.kvs );
	}
};

/**
 * Expand only keys of key/value pairs. This is generally used for template
 * parameters to avoid expanding unused values, which is very important for
 * constructs like switches.
 */
AttributeTransformManager.prototype.processKeys = function (attributes) {
	var pipe,
		ref;
	// console.warn( 'AttributeTransformManager.processKeys: ' + JSON.stringify(attributes) );

	// TODO: wrap in chunk and call
	// .get( { type: 'text/x-mediawiki/expanded' } ) on it

	// transform the key for each attribute pair
	var kv;
	var pvOpts = { wrapTemplates: this.options.wrapTemplates };
	for ( var i = 0, l = attributes.length; i < l; i++ ) {
		var cur = attributes[i];
		var k = cur.k;

		// fast path for string-only attributes
		if ( k.constructor === String && cur.v.constructor === String ) {
			kv = new KV( k, this.frame.newParserValue( cur.v, pvOpts ) );
			this.kvs.push( kv );
			continue;
		}

		// Wrap the value in a ParserValue for lazy expansion
		kv = new KV( [], this.frame.newParserValue( cur.v, pvOpts ) );
		this.kvs.push( kv );

		// And expand the key, if needed
		if ( k.constructor === Array && k.length && ! k.get ) {
			// Assume that the return is async, will be decremented in callback
			this.outstanding++;

			// transform the key
			this.frame.expand( k,
					{
						wrapTemplates: this.options.wrapTemplates,
						type: this._toType,
						cb: this._returnAttributeKey.bind( this, i )
					} );
		} else {
			kv.k = k;
		}
	}

	this.outstanding--;
	if ( this.outstanding === 0 ) {
		// synchronously done
		this.callback( this.kvs );
	}
};

/**
 * Callback for async argument value expansions
 */
AttributeTransformManager.prototype._returnAttributeValue = function ( ref, tokens ) {
	this.manager.env.dp( 'check _returnAttributeValue: ', ref,  tokens );
	this.kvs[ref].v = Util.stripEOFTkfromTokens(tokens);
	this.outstanding--;
	if ( this.outstanding === 0 ) {
		this.callback( this.kvs );
	}
};

/**
 * Callback for async argument key expansions
 */
AttributeTransformManager.prototype._returnAttributeKey = function ( ref, tokens ) {
	this.manager.env.dp( 'check _returnAttributeKey: ', ref,  tokens );
	this.kvs[ref].k = Util.stripEOFTkfromTokens(tokens);
	this.outstanding--;
	if ( this.outstanding === 0 ) {
		this.callback( this.kvs );
	}
};


/******************************* TokenAccumulator *************************/
/**
 * Token accumulators buffer tokens between asynchronous processing points,
 * and return fully processed token chunks in-order and as soon as possible.
 * They support the AsyncTokenTransformManager.
 *
 * They receive tokens from sibling transformers and child transformers,
 * merge them in-order (all-child-tokens followed by all-sibling-tokens)
 * and pass them to whoever wanted them (another sibling or a parent).
 *
 * @class
 * @constructor
 * @param {Object} next TokenAccumulator to link to
 * @param {Array} (optional) tokens, init accumulator with tokens or []
 */
function TokenAccumulator ( manager, parentCB ) {
	this.manager = manager;
	this.parentCB = parentCB;
	this.siblingToks = [];
	this.waitForChild = true;
	this.waitForSibling = true;
}

/**
 * Curry a parentCB with the object and reference.
 *
 * @method
 * @param {Object} TokenAccumulator
 * @param {misc} Reference / key for callback
 * @returns {Function}
 */
TokenAccumulator.prototype.getParentCB = function ( reference ) {
	return this._returnTokens.bind( this, reference );
};

TokenAccumulator.prototype.setParentCB = function ( cb ) {
	this.parentCB = cb;
};

/**
 * Pass tokens to an accumulator
 *
 * @method
 * @param {String}: reference, 'child' or 'sibling'.
 * @param {Object}: { tokens, async }
 * @returns {Mixed}: new parent callback for caller or falsy value
 */
TokenAccumulator.prototype._returnTokens = function ( reference, ret ) {
	this.manager.env.dp( 'TokenAccumulator._returnTokens', reference, ret );

	verifyTokensIntegrity(ret, false);

	if ( reference === 'child' ) {
		if ( !ret.async ) {
			// Child is all done => can pass along sibling toks as well
			// since any tokens we receive now will already be in order
			// and no buffering is necessary.
			this.waitForChild = false;
			ret.tokens = ret.tokens.concat( this.siblingToks );
			this.siblingToks = [];
		}

		ret.tokens.rank = this.manager.phaseEndRank;
		ret.async = this.waitForSibling || this.waitForChild;

		this._callParentCB( ret );

		return null;
	} else {
		// received tokens from sibling
		if (!ret.async) {
			this.waitForSibling = false;
		}

		if (this.waitForChild) {
			// Just continue to accumulate sibling tokens.
			this.siblingToks = this.siblingToks.concat( ret.tokens );
			this.manager.env.dp( 'TokenAccumulator._returnTokens: sibling done, but not overall. async=',
					ret.async, ', this.outstanding=', (this.waitForChild + this.waitForSibling),
					', this.siblingToks=', this.siblingToks, ' frame.title=', this.manager.frame.title );
		} else if (this.waitForSibling) {
			// Sibling is not yet done, but child is. Return own parentCB to
			// allow the sibling to go direct, and call back parent with
			// tokens. The internal accumulator is empty at this stage, as its
			// tokens got passed to the parent when the child was done.
			ret.tokens.rank = this.manager.phaseEndRank;
			return this._callParentCB( ret );
		} else {
			// All done
			ret.tokens = this.siblingToks.concat( ret.tokens );
			ret.tokens.rank = this.manager.phaseEndRank;
			ret.async = false;
			this.parentCB( ret );
			return null;
		}
	}
};

/**
 * Mark the sibling as done (normally at the tail of a chain).
 */
TokenAccumulator.prototype.siblingDone = function () {
	//console.warn( 'TokenAccumulator.siblingDone: ' );
	this._returnTokens ( 'sibling', { tokens: [], async: false } );
};


TokenAccumulator.prototype._callParentCB = function ( ret ) {
	var cb = this.parentCB( ret );
	if ( cb ) {
		this.parentCB = cb;
	}
	return this.parentCB;
};

/**
 * Push a token into the accumulator
 *
 * @method
 * @param {Object} token
 */
TokenAccumulator.prototype.push = function ( token ) {
	return this.siblingToks.push(token);
};

/**
 * Append tokens to an accumulator
 *
 * @method
 * @param {Object} token
 */
TokenAccumulator.prototype.append = function ( token ) {
	this.siblingToks = this.siblingToks.concat( token );
};


/******************************* Frame ******************************/

/**
 * The Frame object
 *
 * A frame represents a template expansion scope including parameters passed
 * to the template (args). It provides a generic 'expand' method which
 * expands / converts individual parameter values in its scope.  It also
 * provides methods to check if another expansion would lead to loops or
 * exceed the maximum expansion depth.
 */

function Frame ( title, manager, args, parentFrame ) {
	this.title = title;
	this.manager = manager;
	this.args = new Params( this.manager.env, args );
	// Cache key fragment for expansion cache
	// FIXME: We are hashing the unexpanded args here. To keep things correct,
	// we thus need to assume that the parent frame can affect the argument
	// value. It would be more efficient to use the fully expanded args for
	// the cache key instead, as this would allow sharing of all expansions of
	// a template with identical expanded parameters independent of its
	// containing frame.
	var MD5 = new jshashes.MD5();
	if ( args._cacheKey === undefined ) {
		args._cacheKey = MD5.hex( JSON.stringify( args ) );
	}

	if ( parentFrame ) {
		this.parentFrame = parentFrame;
		this.depth = parentFrame.depth + 1;
		// FIXME: Since our args are unexpanded, the expanded value might
		// depend on the parent frame.
		this._cacheKey = MD5.hex( parentFrame._cacheKey + args._cacheKey );
	} else {
		this.parentFrame = null;
		this.depth = 0;
		this._cacheKey = args._cacheKey;
	}
}

/**
 * Create a new child frame
 */
Frame.prototype.newChild = function ( title, manager, args ) {
	return new Frame( title, manager, args, this );
};

/**
 * Expand / convert a thunk (a chunk of tokens not yet fully expanded).
 *
 * XXX: support different input formats, expansion phases / flags and more
 * output formats.
 */
Frame.prototype.expand = function ( chunk, options ) {
	var outType = options.type || 'text/x-mediawiki/expanded';
	var cb = options.cb || console.warn( JSON.stringify( options ) );
	this.manager.env.dp( 'Frame.expand', this._cacheKey, chunk );

	if ( chunk.constructor === String ) {
		// Plain text remains text. Nothing to do.
		if ( outType !== 'text/x-mediawiki/expanded' ) {
			return cb( [ chunk ] );
		} else {
			return cb( chunk );
		}
	} else if ( chunk.constructor === ParserValue ) {
		// Delegate to ParserValue
		return chunk.get( options );
	}


	// We are now dealing with an Array of tokens. See if the chunk is
	// a source chunk with a cache attached.
	var maybeCached;
	if ( ! chunk.length ) {
		// nothing to do, simulate a cache hit..
		maybeCached = chunk;
	} else if ( chunk.cache === undefined ) {
		// add a cache to the chunk
		Object.defineProperty( chunk, 'cache',
				// XXX: play with cache size!
				{ value: new ExpansionCache( 5 ), enumerable: false } );
	} else {
		// try to retrieve cached expansion
		maybeCached = chunk.cache.get( this, options );
		// XXX: disable caching of error messages!
	}
	if ( maybeCached ) {
		this.manager.env.dp( 'got cache', this.title, this._cacheKey, maybeCached );
		return cb( maybeCached );
	}

	// not cached, actually have to do some work.
	if ( outType === 'text/x-mediawiki/expanded' ) {
		// Simply wrap normal expansion ;)
		// XXX: Integrate this into the pipeline setup?
		outType = 'tokens/x-mediawiki/expanded';
		var self = this,
			origCB = cb;
		cb = function( resChunk ) {
			var res = Util.tokensToString( resChunk );
			// cache the result
			chunk.cache.set( self, options, res );
			origCB( res );
		};
	}

	// XXX: Should perhaps create a generic from..to conversion map in
	// mediawiki.parser.js, at least for forward conversions.
	if ( outType === 'tokens/x-mediawiki/expanded' ) {
		if ( options.asyncCB ) {
			// Signal (potentially) asynchronous expansion to parent.
			options.asyncCB({ async: true });
		}

		// Downstream template uses should be tracked and wrapped only if:
		// - not in a nested template        Ex: {{Templ:Foo}} and we are processing Foo
		// - not in a template use context   Ex: {{ .. | {{ here }} | .. }}
		// - the attribute use is wrappable  Ex: [[ ... | {{ .. link text }} ]]

		var pipelineOpts = {
			isInclude: this.depth > 0,
			wrapTemplates: options.wrapTemplates
		};

		var pipeline = this.manager.pipeFactory.getPipeline(
				// XXX: use input type
				this.manager.attributeType || 'tokens/x-mediawiki', pipelineOpts
				);
		pipeline.setFrame( this, null );
		// In the name of interface simplicity, we accumulate all emitted
		// chunks in a single accumulator.
		var eventState = { cache: chunk.cache, options: options, accum: [], cb: cb };
		pipeline.addListener( 'chunk',
				this.onThunkEvent.bind( this, eventState, true ) );
		pipeline.addListener( 'end',
				this.onThunkEvent.bind( this, eventState, false ) );
		if ( chunk[chunk.length - 1].constructor === EOFTk ) {
			pipeline.process( chunk, this.title );
		} else {
			var newChunk = chunk.concat( this._eofTkList );
			newChunk.rank = chunk.rank;
			pipeline.process( newChunk, this.title );
		}
	} else {
		throw "Frame.expand: Unsupported output type " + outType;
	}
};

// constant chunk terminator
Frame.prototype._eofTkList = [ new EOFTk() ];
Object.freeze(Frame.prototype._eofTkList[0]);

/**
 * Event handler for chunk conversion pipelines
 */
Frame.prototype.onThunkEvent = function ( state, notYetDone, ret ) {
	if ( notYetDone ) {
		state.accum = state.accum.concat(Util.stripEOFTkfromTokens( ret ) );
		this.manager.env.dp( 'Frame.onThunkEvent accum:', this._cacheKey, state.accum );
	} else {
		this.manager.env.dp( 'Frame.onThunkEvent:', this._cacheKey, state.accum );
		state.cache.set( this, state.options, state.accum );
		// Add cache to accum too
		if ( ! Object.isFrozen( state.accum ) ) {
			Object.defineProperty( state.accum, 'cache',
					{ value: state.cache, enumerable: false } );
		}
		state.cb ( state.accum );
	}
};


/**
 * Check if expanding <title> would lead to a loop, or would exceed the
 * maximum expansion depth.
 *
 * @method
 * @param {String} Title to check.
 */
Frame.prototype.loopAndDepthCheck = function ( title, maxDepth ) {
	// XXX: set limit really low for testing!
	//console.warn( 'Loopcheck: ' + title + JSON.stringify( this, null, 2 ) );
	if ( this.depth > maxDepth ) {
		// too deep
		//console.warn( 'Loopcheck: ' + JSON.stringify( this, null, 2 ) );
		return 'Error: Expansion depth limit exceeded at ';
	}
	var elem = this;
	do {
		//console.warn( 'loop check: ' + title + ' vs ' + elem.title );
		if ( elem.title === title ) {
			// Loop detected
			return 'Error: Expansion loop detected at ';
		}
		elem = elem.parentFrame;
	} while ( elem );
	// No loop detected.
	return false;
};

/**
 * ParserValue factory
 *
 * ParserValues wrap a piece of content that can be retrieved in different
 * expansion stages and different content types using the get() method.
 * Content types currently include 'tokens/x-mediawiki/expanded' for
 * pre-processed tokens and 'text/x-mediawiki/expanded' for pre-processed
 * wikitext.
 */
Frame.prototype.newParserValue = function ( source, options ) {
	// TODO: support more options:
	// options.type to specify source type
	// options.phase to specify source expansion stage
	if ( source.constructor === String ) {
		source = new String( source );
		source.get = this._getID;
		return source;
	} else {
		if (!options) {
			options = { frame: this, wrapTemplates: false };
		} else if (!options.frame) {
			options.frame = this;
		}

		return new ParserValue( source, options);
	}
};

Frame.prototype._getID = function( options ) {
	if ( !options || !options.cb ) {
		console.trace();
		console.warn('Error in Frame._getID: no cb in options!');
	} else {
		//console.warn('getID: ' + options.cb);
		return options.cb( this );
	}
};

/**
 * A specialized expansion cache, normally associated with a chunk of tokens.
 */
function ExpansionCache ( n ) {
	this._cache = new LRU( n );
}

ExpansionCache.prototype.makeKey = function ( frame, options ) {
	//console.warn( frame._cacheKey );
	return frame._cacheKey + options.type ;
};

ExpansionCache.prototype.set = function ( frame, options, value ) {
	//if ( frame.title !== null ) {
		//console.log( 'setting cache for ' + frame.title +
		//		' ' + this.makeKey( frame, options ) +
		//		' to: ' + JSON.stringify( value ) );
		return this._cache.set( this.makeKey( frame, options ), value );
	//}
};

ExpansionCache.prototype.get = function ( frame, options ) {
	var cachedTokens = this._cache.get( this.makeKey( frame, options ) );
	Util.deepFreeze(cachedTokens);
	return cachedTokens;
};


if (typeof module === "object") {
	module.exports.AsyncTokenTransformManager = AsyncTokenTransformManager;
	module.exports.SyncTokenTransformManager = SyncTokenTransformManager;
	module.exports.AttributeTransformManager = AttributeTransformManager;
}
