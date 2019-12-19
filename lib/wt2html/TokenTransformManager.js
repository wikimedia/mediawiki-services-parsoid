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
 * @module
 */

'use strict';

const events = require('events');
const { JSUtils } = require('../utils/jsutils.js');
const Promise = require('../utils/promise.js');
const { TokenUtils } = require('../utils/TokenUtils.js');
const { KV, EOFTk } = require('../tokens/TokenTypes.js');

function verifyTokensIntegrity(env, ret) {
	// Only the following forms are valid (T187848):
	// {async:true} -- used to signal the start of an async pipeline
	// {async:true|false,tokens:[...]} -- used in sync/async generic code
	// {tokens:[...]} -- most common
	console.assert(!Array.isArray(ret));
	console.assert(ret.async === undefined || ret.async === true || ret.async === false);
	console.assert(ret.token === undefined); // legacy form, no longer used
	console.assert(
		Array.isArray(ret.tokens) ||
		(ret.tokens === undefined && ret.async === true)
	);
	return ret;
}

/**
 * Base class for token transform managers.
 *
 * @class
 * @extends EventEmitter
 */
class TokenTransformManager extends events.EventEmitter {
	/**
	 * @param {MWParserEnvironment} env
	 * @param {Object} options
	 */
	constructor(env, options) {
		super();
		this.env = env;
		this.options = options;
		this.defaultTransformers = [];	// any transforms
		this.tokenTransformers   = {};	// non-any transforms
		this.cachedTransformers  = {};	// merged any + non-any transforms
		this.pipelineModified = false;
		this.frame = env.topFrame;
	}

	setFrame(parentFrame, title, args, srcText) {
		if (parentFrame) {
			if (title === null) {
				this.frame = parentFrame.newChild(parentFrame.title, parentFrame.args, srcText);
			} else {
				this.frame = parentFrame.newChild(title, args, srcText);
			}
		} else {
			this.frame = this.env.topFrame.newChild(title, args, srcText);
		}
	}

	// Map of: token constructor ==> transfomer type
	// Used for returning active transformers for a token
	static tkConstructorToTkTypeMap(c) {
		switch (c) {
			case "String": return "text";
			case "NlTk": return "newline";
			case "CommentTk": return "comment";
			case "EOFTk": return "end";
			case "TagTk": // fall through
			case "EndTagTk": // fall through
			case "SelfclosingTagTk": return "tag";
		}
		console.assert(false, c);
	}

	static tokenTransformersKey(tkType, tagName) {
		return (tkType === 'tag') ? "tag:" + tagName : tkType;
	}

	/**
	 * Register to a token source, normally the tokenizer.
	 * The event emitter emits a 'chunk' event with a chunk of tokens,
	 * and signals the end of tokens by triggering the 'end' event.
	 * XXX: Perform registration directly in the constructor?
	 *
	 * @param {EventEmitter} tokenEmitter Token event emitter.
	 */
	addListenersOn(tokenEmitter) {
		tokenEmitter.addListener('chunk', this.onChunk.bind(this));
		tokenEmitter.addListener('end', this.onEndEvent.bind(this));
	}

	/**
	 * Predicate for sorting transformations by ascending rank.
	 * @private
	 */
	static _cmpTransformations(a, b) {
		return a.rank - b.rank;
	}

	// Use a new method to create this to prevent the closure
	// from holding onto more state than necessary.
	timeTracer(transform, traceName) {
		const self = this;
		return function() {
			const s = JSUtils.startTime();
			const ret = transform.apply(this, arguments);
			const t = JSUtils.elapsedTime(s);
			self.env.bumpTimeUse(traceName, t, "TT");
			self.env.bumpCount(traceName);
			self.lastTokenTime = t;
			return ret;
		};
	}

	/**
	 * Add a transform registration.
	 *
	 * @param {Function} transformation
	 *   @param {Token} transformation.token
	 *   @param {Object} transformation.frame
	 *   @param {Function} transformation.cb
	 *     @param {Object} transformation.cb.result
	 *       @param {Token[]} transformation.cb.result.tokens
	 *   @param {Object} transformation.return
	 *     @param {Token[]} transformation.return.tokens
	 * @param {string} debugName
	 *   Debug string to identify the transformer in a trace.
	 * @param {number} rank A number in [0,3) with:
	 *   * [0,1) in-order on input token stream,
	 *   * [1,2) out-of-order and
	 *   * [2,3) in-order on output token stream.
	 * @param {string} type
	 *   One of 'tag', 'text', 'newline', 'comment', 'end',
	 *   'martian' (unknown token), 'any' (any token, matched before other matches).
	 * @param {string} name
	 *   Tag name for tags, omitted for non-tags
	 */
	addTransform(transformation, debugName, rank, type, name) {
		const traceFlags = this.env.conf.parsoid.traceFlags;
		const traceTime = traceFlags && traceFlags.has("time");
		if (traceTime) {
			transformation = this.timeTracer(transformation, debugName);
		}
		const t = {
			rank: rank,
			name: debugName,
			transform: transformation,
		};

		this.pipelineModified = true;

		if (type === 'any') {
			// Record the any transformation
			this.defaultTransformers.push(t);

			// clear cache
			this.cachedTransformers = {};
		} else {
			const key = TokenTransformManager.tokenTransformersKey(type, name);
			let tArray = this.tokenTransformers[key];
			if (!tArray) {
				tArray = this.tokenTransformers[key] = [];
			}

			// assure no duplicate transformers
			console.assert(tArray.every(function(tr) {
				return tr.rank !== t.rank;
			}), "Trying to add a duplicate transformer: " + t.name);

			tArray.push(t);
			tArray.sort(TokenTransformManager._cmpTransformations);

			// clear the relevant cache entry
			this.cachedTransformers[key] = null;
		}
	}

	// Helper to register transforms that return a promise for the value,
	// instead of invoking the callback synchronously.
	addTransformP(context, transformation, debugName, rank, type, name) {
		this.addTransform(function(token, cb) {
			// this is an async transformation
			cb({ async: true });
			// invoke the transformation to get a promise
			transformation.call(context, token)
				.then(result => cb(result))
				.done();
		}, debugName, rank, type, name);
	}

	/**
	 * Get all transforms for a given token.
	 * @private
	 */
	_getTransforms(token, minRank) {
		const tkType = TokenTransformManager.tkConstructorToTkTypeMap(token.constructor.name);
		const key = TokenTransformManager.tokenTransformersKey(tkType, token.name);
		console.assert(tkType, key);
		let tts = this.cachedTransformers[key];
		if (!tts) {
			// generate and cache -- dont cache if there are no default transformers
			tts = this.tokenTransformers[key] || [];
			if (this.defaultTransformers.length > 0) {
				tts = tts.concat(this.defaultTransformers);
				tts.sort(TokenTransformManager._cmpTransformations);
				this.cachedTransformers[key] = tts;
			}
		}

		let i = 0;
		if (minRank !== undefined) {
			// skip transforms <= minRank
			while (i < tts.length && tts[i].rank <= minRank) {
				i += 1;
			}
		}
		return { first: i, transforms: tts, empty: i >= tts.length };
	}
}

// Async token transforms: Phase 2


class AccumChain {
	constructor(ttm, parentCB) {
		this.ttm = ttm;
		this.debugId = 0;

		// Shared accum-chain state accessible to synchronous transforms in maybeSyncReturn
		this.state = {
			// Indicates we are still in the transformTokens loop
			transforming: true,
			// debug id for this expansion
			c: 'c-' + AccumChain._counter++,
		};

		this.numNodes = 0;
		this.addNode(parentCB);

		// Local accum for synchronously returned fully processed tokens
		this.firstAccum = [];
		this.firstAccum.append = (chunk) => {
			// All tokens in firstAccum are fully processed
			this.firstAccum.push.apply(this.firstAccum, chunk);
		};
		this.accum = this.firstAccum;
	}

	initRes() {
		this.state.res = {};
	}
	addNode(cb) {
		if (!cb) {
			// cb will be passed in for the very first accumulator.
			// For every other node in the chain, the callback will
			// be the previous accumulator's sibling callback.
			cb = this.next.receiveToksFromSibling.bind(this.next);
			this.accum = this.next;
		}

		// 'newAccum' is never used unless we hit async mode.
		// Even though maybeAsyncCB references newAccum via cbs.parentCB,
		// that code path is exercised only when async mode is entered,
		// so we are all good on that front.
		const newAccum = new TokenAccumulator(this.ttm, cb);
		const cbs = { parentCB: newAccum.receiveToksFromChild.bind(newAccum) };
		cbs.self = this.ttm.maybeSyncReturn.bind(this.ttm, this.state, cbs);

		// console.warn("--> ATT-" + this.ttm.pipelineId + " new link in chain");
		this.next = newAccum;
		this.maybeAsyncCB = cbs.self;
		this.numNodes++;
	}
	push(tok) {
		// Token is fully processed for this phase, so make sure to set
		// phaseEndRank. The TokenAccumulator checks the rank and coalesces
		// consecutive chunks of equal rank.
		if (this.accum === this.firstAccum) {
			this.firstAccum.push(tok);
		} else {
			const chunk = [tok];
			chunk.rank = this.ttm.phaseEndRank;
			this.accum.append(chunk);
		}
	}
	append(toks) {
		this.accum.append(toks);
	}
}

// Debug counter, provides an UID for transformTokens calls so that callbacks
// associated with it can be identified in debugging output as c-XXX across
// all instances of the Async TTM.
AccumChain._counter = 0;

/**
 *
 * Asynchronous and potentially out-of-order token transformations, used in phase 2.
 *
 * Return protocol for individual transforms:
 * ```
 *     { tokens: [tokens], async: true }: async expansion -> outstanding++ in parent
 *     { tokens: [tokens] }: fully expanded, tokens will be reprocessed
 * ```
 * @class
 * @extends ~TokenTransformManager
 */
class AsyncTokenTransformManager extends TokenTransformManager {
	constructor(env, options, pipeFactory, phaseEndRank, attributeType) {
		super(env, options);
		this.pipeFactory = pipeFactory;
		this.phaseEndRank = phaseEndRank;
		this.attributeType = attributeType;
		// Move this property to this.env.currentFrame once we get rid of
		// async template processing.
		this.frame = this.env.topFrame;
		this.traceType = "trace/async:" + phaseEndRank;
		this.pipelineId = null;
		this.reset();
	}

	/**
	 * Debugging aid: set pipeline id
	 */
	setPipelineId(id) {
		this.pipelineId = id;
	}

	/**
	 * Reset state between uses.
	 */
	reset() {
		this.tailAccumulator = null;
		this.tokenCB = this.emitChunk.bind(this);
	}

	/**
	 * Reset the internal token and outstanding-callback state of the
	 * TokenTransformManager, but keep registrations untouched.
	 *
	 * @param {Frame} parentFrame
	 * @param {string|null} title
	 * @param {Array} args
	 * @param {string} srcText
	 */
	setFrame(parentFrame, title, args, srcText) {
		console.assert(typeof (srcText) === 'string'); // not null/undefined
		this.env.log('debug', 'AsyncTokenTransformManager.setFrame', title, args);

		// Reset accumulators
		this.reset();
		// now actually set up the frame
		super.setFrame(parentFrame, title, args, srcText);
	}

	checkForEOFTkErrors(tokens, atEnd) {
		if (this.frame.depth === 0 && tokens && tokens.length) {
			const last = atEnd && JSUtils.lastItem(tokens);
			if (last && last.constructor !== EOFTk) {
				this.env.log("error", "EOFTk went missing in AsyncTokenTransformManager");
				tokens.push(new EOFTk());
			}
			for (let i = 0, l = tokens.length; i < l - 1; i++) {
				if (tokens[i] && tokens[i].constructor === EOFTk) {
					this.env.log("error", "EOFTk in the middle of chunk");
				}
			}
		}
	}

	/**
	 * Callback for async returns from head of TokenAccumulator chain.
	 *
	 * @param {Object} ret The chunk we're returning from the transform.
	 * @private
	 */
	emitChunk(ret) {
		this.env.log('debug', 'AsyncTokenTransformManager.emitChunk', ret);
		// This method is often the root of the call stack, so makes a good point
		// for a try/catch to ensure error handling.
		try {
			// Check if an EOFTk went missing
			this.checkForEOFTkErrors(ret.tokens, !ret.async);
			this.emit('chunk', ret.tokens);
			if (ret.async) {
				// Our work is done here, but more async tokens are yet to come.
				//
				// Allow accumulators to bypass their callbacks and go directly
				// through emitChunk for those future token chunks.
				return this.emitChunk.bind(this);
			} else {
				this.emit('end');
				this.reset(); // Reset accumulators
			}
		} catch (e) {
			this.env.log("fatal", e);
		}
	}

	/**
	 * Simple wrapper that processes all tokens passed in.
	 */
	process(tokens) {
		this.onChunk(tokens);
		this.onEndEvent();
	}

	/**
	 * Transform and expand tokens. Transformed token chunks will be emitted in
	 * the 'chunk' event.
	 *
	 * @param {Array} tokens
	 * @private
	 */
	onChunk(tokens) {
		// Set top-level callback to next transform phase
		const res = this.transformTokens(tokens, this.tokenCB);
		verifyTokensIntegrity(this.env, res);
		this.env.log('debug', 'AsyncTokenTransformManager onChunk', res.async ? 'async' : 'sync', res.tokens);
		if (!res.tokens.rank) {
			res.tokens.rank = this.phaseEndRank;
		}

		// Emit or append the returned tokens
		if (!this.tailAccumulator) {
			this.env.log('debug', 'emitting');
			this.emit('chunk', res.tokens);
		} else {
			// console.warn("--> ATT-" + this.pipelineId + " appending: " + JSON.stringify(res.tokens));
			this.env.log('debug', 'appending to tail');
			this.tailAccumulator.append(res.tokens);
		}

		// Update the tail of the current accumulator chain
		if (res.asyncAccum) {
			this.tailAccumulator = res.asyncAccum;
			this.tokenCB = res.asyncAccum.receiveToksFromSibling.bind(res.asyncAccum);
		}
	}

	/**
	 * Callback for the end event emitted from the tokenizer.
	 * Either signals the end of input to the tail of an ongoing asynchronous
	 * processing pipeline, or directly emits 'end' if the processing was fully
	 * synchronous.
	 * @private
	 */
	onEndEvent() {
		if (this.tailAccumulator) {
			this.env.log(
				this.traceType, this.pipelineId,
				'AsyncTokenTransformManager.onEndEvent: calling siblingDone',
				this.frame.title
			);
			this.tailAccumulator.siblingDone();
		} else {
			// nothing was asynchronous, so we'll have to emit end here.
			this.env.log(
				this.traceType, this.pipelineId,
				'AsyncTokenTransformManager.onEndEvent: synchronous done',
				this.frame.title
			);
			this.emit('end');

			// Reset accumulators
			this.reset();
		}
	}

	/**
	 * Run asynchronous transformations. This is the big workhorse where
	 * templates, images, links and other async expansions (see the transform
	 * recipe parser.js) are processed.
	 *
	 * The returned chunk is fully expanded for this phase, and the rank set
	 * to reflect this.
	 *
	 * @param {Array} tokens
	 *   Chunk of tokens, potentially with rank and other meta information
	 *   associated with it.
	 * @param {Function} parentCB
	 *   Callback for asynchronous results.
	 * @return {Object}
	 * @return {Array} return.tokens
	 * @return {TokenAccumulator|null} return.asyncAccum
	 *   The tail TokenAccumulator, or else `null`.
	 */
	transformTokens(tokens, parentCB) {
		// Trivial case
		if (tokens.length === 0) {
			return { tokens: tokens, asyncAccum: null };
		}

		// Time tracing related state
		const traceFlags = this.env.conf.parsoid.traceFlags;
		const traceTime = traceFlags && traceFlags.has('time');
		const startTime = traceTime && JSUtils.startTime();
		let tokenTimes = 0;

		// New accumulator chain
		const accumChain = new AccumChain(this, parentCB);

		// Stack of token arrays to process
		// Initialize to the token array that was passed in
		const workStack = [];
		workStack.pushChunk = function(toks) {
			this.push(toks);
			toks.eltIndex = 0;
		};

		workStack.pushChunk(tokens);

		const inputRank = tokens.rank || 0;
		while (workStack.length > 0) {
			const curChunk = JSUtils.lastItem(workStack);

			// Once the chunk is processed, switch to a new accum
			// if it has async mode set since it might generate more
			// tokens that have to be appended to the accum associated with it.
			if (curChunk.eltIndex === curChunk.length) {
				if (curChunk.inAsyncMode) {
					accumChain.addNode();
				}

				// remove processed chunk
				workStack.pop();
				continue;
			}

			let token = curChunk[curChunk.eltIndex++];
			const minRank = curChunk.rank || inputRank;

			console.assert(!Array.isArray(token));

			this.env.log(this.traceType, this.pipelineId, function() { return JSON.stringify(token); });

			const ts = this._getTransforms(token, minRank);

			if (ts.empty) {
				// nothing to do for this token
				accumChain.push(token);
			} else {
				let res, resTokens;
				for (let j = ts.first, lts = ts.transforms.length; j < lts; j++) {
					const transformer = ts.transforms[j];

					// shared state is only used when we are still in this transfomer loop.
					// In that scenario, it is safe to reset this each time around
					// since s.res.tokens is retrieved after the transformation is done.
					accumChain.initRes();

					// Transform the token.  This will call accumChain.maybeAsyncCB either
					// with tokens or with an async signal.  In either case,
					// state tokens will be populated.
					transformer.transform(token, accumChain.maybeAsyncCB);
					if (traceTime) {
						tokenTimes += this.lastTokenTime;
					}

					res = accumChain.state.res;
					resTokens = res.tokens;

					// Check the result, which is changed using the
					// maybeSyncReturn callback
					if (resTokens && resTokens.length) {
						if (resTokens.length === 1) {
							const soleToken = resTokens[0];
							if (token === soleToken && !resTokens.rank) {
								// token not modified, continue with transforms.
								continue;
							} else if (
								resTokens.rank === this.phaseEndRank ||
								(
									soleToken.constructor === String &&
									!this.tokenTransformers.text
								)
							) {
								// Fast path for text token, and nothing to do for it
								// Abort processing, but treat token as done.
								token = soleToken;
								resTokens.rank = this.phaseEndRank;
								break;
							}
						}

						// SSS FIXME: This workstack code below can insert a workstack
						// chunk even when there is just a single token to process.
						// Could be fixed.
						//
						// token(s) were potentially modified
						if (!resTokens.rank || resTokens.rank < this.phaseEndRank) {
							// There might still be something to do for these
							// tokens. Prepare them for the workStack.
							const oldRank = resTokens.rank;
							// Don't apply earlier transforms to results of a
							// transformer to avoid loops and keep the
							// execution model sane.
							resTokens.rank = oldRank || transformer.rank;
							// resTokens.rank = Math.max( resTokens.rank || 0, transformer.rank );
							if (res.async) {
								resTokens.inAsyncMode = true;
								// don't trigger activeAccum switch / _makeNextAccum call below
								res.async = false;
							}

							// console.warn("--> ATT" + this.pipelineId + ": new work chunk" + JSON.stringify(resTokens));
							workStack.pushChunk(resTokens);

							if (this.debug) {
								// Avoid expensive map and slice if we dont need to.
								this.env.log(
									'debug',
									'workStack',
									accumChain.state.c,
									resTokens.rank,
									// Filter out processed tokens
									workStack.map(a => a.slice(a.eltIndex))
								);
							}
						} else {
							// resTokens.rank === this.phaseEndRank
							// No need to process them any more => accum. them.
							accumChain.append(resTokens);
						}
					}

					// Abort processing for this token
					token = null;
					break;
				}

				if (token !== null) {
					// token is done.
					// push to accumulator
					accumChain.push(token);
				}

				if (res.async) {
					this.env.log('debug', 'res.async, creating new TokenAccumulator', accumChain.state.c);
					accumChain.addNode();
				}
			}
		}

		// console.warn("--> ATT" + this.pipelineId + ": chain sync processing done!");

		// we are no longer transforming, maybeSyncReturn needs to follow the
		// async code path
		accumChain.state.transforming = false;

		// All tokens in firstAccum are fully processed
		const firstAccum = accumChain.firstAccum;
		firstAccum.rank = this.phaseEndRank;

		this.env.log(
			'debug',
			'firstAccum',
			accumChain.numNodes > 1 ? 'async' : 'sync',
			accumChain.state.c,
			firstAccum
		);

		if (traceTime) {
			this.env.bumpTimeUse("AsyncTTM (Partial)", (JSUtils.startTime() - startTime - tokenTimes), "TTM");
		}

		// Return finished tokens directly to caller, and indicate if further
		// async actions are outstanding. The caller needs to point a sibling to
		// the returned accumulator, or call .siblingDone() to mark the end of a
		// chain.
		return {
			tokens: firstAccum,
			asyncAccum: accumChain.numNodes > 1 ? accumChain.accum : null,
		};
	}

	/**
	 * Callback for async transforms.
	 *
	 * Converts direct callbacks into a synchronous return by collecting the
	 * results in s.res. Re-start transformTokens for any async returns, and calls
	 * the provided asyncCB (TokenAccumulator._returnTokens normally).
	 *
	 * @private
	 */
	maybeSyncReturn(s, cbs, ret) {
		ret = verifyTokensIntegrity(this.env, ret);

		if (s.transforming) {
			// transformTokens is still ongoing, handle as sync return by
			// collecting the results in s.res
			this.env.log('debug', 'maybeSyncReturn transforming', s.c, ret);
			if (ret.tokens && ret.tokens.length > 0) {
				if (s.res.tokens) {
					const newRank = ret.tokens.rank;
					const oldRank = s.res.tokens.rank;
					s.res.tokens = JSUtils.pushArray(s.res.tokens, ret.tokens);
					if (oldRank && newRank) {
						// Conservatively set the overall rank to the minimum.
						// This assumes that multi-pass expansion for some tokens
						// is safe. We might want to revisit that later.
						s.res.tokens.rank = Math.min(oldRank, newRank);
					}
				} else {
					s.res = ret;
				}
			}

			s.res.async = ret.async;
		} else {
			// Since the original transformTokens call is already done, we have to
			// re-start application of any remaining transforms here.
			this.env.log('debug', 'maybeSyncReturn async', s.c, ret);
			const asyncCB = cbs.parentCB;
			const tokens = ret.tokens;
			if (tokens) {
				if (tokens.length &&
					(!tokens.rank || tokens.rank < this.phaseEndRank) &&
					!(tokens.length === 1 && tokens[0].constructor === String)) {
					// Re-process incomplete tokens
					this.env.log(
						'debug',
						'maybeSyncReturn: recursive transformTokens',
						this.frame.title, ret.tokens
					);

					// Set up a new child callback with its own callback state
					const _cbs = { parentCB: cbs.parentCB };
					const childCB = this.maybeSyncReturn.bind(this, s, _cbs);
					_cbs.self = childCB;

					const res = this.transformTokens(ret.tokens, childCB);
					ret.tokens = res.tokens;
					if (res.asyncAccum) {
						// Insert new child accumulator chain- any further chunks from
						// the transform will be passed as sibling to the last accum
						// in this chain, and the new chain will pass its results to
						// the former parent accumulator.

						if (!ret.async) {
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
							cbs.parentCB = res.asyncAccum.receiveToksFromSibling.bind(res.asyncAccum);
						}
					}
				}
			} else if (ret.async === true) {
				// No tokens, was supposed to indicate async processing but came
				// too late.
				// TODO: Track down sources for these (unnecessary) calls and try
				// to avoid them if possible.
				return;
			}

			if (!ret.tokens.rank) {
				ret.tokens.rank = this.phaseEndRank;
			}
			asyncCB(ret);

			if (ret.async) {
				// Pass reference to maybeSyncReturn to TokenAccumulators to allow
				// them to call directly
				return cbs.self;
			}
		}
	}
}


// In-order, synchronous transformer (phase 1 and 3)


/**
 * Subclass for phase 3, in-order and synchronous processing.
 *
 * @class
 * @extends ~TokenTransformManager
 */
class SyncTokenTransformManager extends TokenTransformManager {
	constructor(env, options, pipeFactory, phaseEndRank, attributeType) {
		super(env, options);
		this.pipeFactory = pipeFactory;
		this.phaseEndRank = phaseEndRank;
		this.attributeType = attributeType;
		this.traceType = "trace/sync:" + phaseEndRank;
		this.pipelineId = null;
	}

	/**
	 * Debugging aid: set pipeline id
	 */
	setPipelineId(id) {
		this.pipelineId = id;
	}

	/**
	 * @param {Token[]} tokens
	 */
	process(tokens) {
		this.onChunk(tokens);
		this.onEndEvent();
	}

	computeTraceNames() {
		const traceNames = [];
		this.transformers.forEach(function(transformer, i) {
			const baseName = transformer.constructor.name + ":";
			traceNames.push([
				baseName + "onNewline",
				baseName + "onEnd",
				baseName + "onTag",
				baseName + "onAny",
			]);
		});

		this.traceNames = traceNames;
	}

	/**
	 * Global in-order and synchronous traversal on token stream. Emits
	 * transformed chunks of tokens in the 'chunk' event.
	 *
	 * @private
	 * @param {Token[]} tokens
	 */
	onChunk(tokens) {
		// Trivial case
		if (tokens.length === 0) {
			this.emit('chunk', tokens);
			return;
		}

		// Tracing, timing, and unit-test generation related state
		const env = this.env;
		const traceFlags = env.conf.parsoid.traceFlags;
		let traceState = null;
		let startTime;
		if (traceFlags) {
			traceState = {
				tokenTimes: 0,
				traceFlags: traceFlags,
				traceTime: traceFlags && traceFlags.has('time'),
				tracer: (token, transformer) => {
					env.log(
						this.traceType, this.pipelineId, transformer.constructor.name,
						() => JSON.stringify(token)
					);
				},
			};

			if (!this.traceNames) {
				this.computeTraceNames();
			}
			if (traceState.traceTime) {
				startTime = JSUtils.startTime();
			}
		}

		this.transformers.forEach((transformer, i) => {
			if (!transformer.disabled) {
				if (traceState) {
					traceState.traceNames = this.traceNames[i];
				}
				if (tokens.length === 0) {
					return;
				}
				tokens = transformer.processTokensSync(env, tokens, traceState);
			}
		});

		if (traceState && traceState.traceTime) {
			this.env.bumpTimeUse("SyncTTM", (JSUtils.startTime() - startTime - traceState.tokenTimes), "TTM");
		}
		tokens.rank = this.phaseEndRank;
		this.emit('chunk', tokens);
	}

	/**
	 * Callback for the end event emitted from the tokenizer.
	 * Either signals the end of input to the tail of an ongoing asynchronous
	 * processing pipeline, or directly emits 'end' if the processing was fully
	 * synchronous.
	 * @private
	 */
	onEndEvent() {
		this.env.log(this.traceType, this.pipelineId, 'SyncTokenTransformManager.onEndEvent');

		// This phase is fully synchronous, so just pass the end along and prepare
		// for the next round.
		try {
			this.emit('end');
		} catch (e) {
			this.env.log("fatal", e);
		}
	}
}

// AttributeTransformManager

/**
 * Utility transformation manager for attributes, using an attribute
 * transformation pipeline (normally phase1 SyncTokenTransformManager and
 * phase2 AsyncTokenTransformManager). This pipeline needs to be independent
 * of the containing TokenTransformManager to isolate transforms from each
 * other. The AttributeTransformManager returns its result as a Promise
 * returned from the {@link .process} method.
 *
 * @class
 */
class AttributeTransformManager {
	/**
	 * @param {TokenTransformManager} manager
	 * @param {Object} options
	 */
	constructor(manager, options) {
		this.manager = manager;
		this.options = options;
		this.frame = this.manager.frame;
		this.expandedKVs = [];
		this._async = false;
	}

	// A few constants
	static _toType() { return 'tokens/x-mediawiki/expanded'; }

	/**
	 * Expand both key and values of all key/value pairs. Used for generic
	 * (non-template) tokens in the AttributeExpander handler, which runs after
	 * templates are already expanded.
	 *
	 * @return {Object}
	 * @return {boolean} return.async - will this expansion happy async-ly?
	 * @return {Promise} return.promises - if async, the promises to do the work
	 */
	process(attributes) {
		// Transform each argument (key and value), and handle asynchronous returns
		// map-then-yield in order to let the individual attributes execute async
		// For performance reasons, avoid a yield if possible (common case where
		// no async expansion is necessary).
		this._async = false;
		const p = attributes.map(this._processOne, this);
		return {
			async: this._async,
			promises: this._async ? Promise.all(p) : null,
		};
	}

	getNewKVs(attributes) {
		const newKVs = [];
		newKVs.length = attributes.length;
		attributes.forEach((curr, i) => {
			// newKVs[i] = Util.clone(curr, true);
			newKVs[i] = new KV(curr.k, curr.v, curr.srcOffsets);
		});
		this.expandedKVs.forEach((curr) => {
			const i = curr.index;
			newKVs[i].k = curr.k || newKVs[i].k;
			newKVs[i].v = curr.v || newKVs[i].v;
		});
		return newKVs;
	}

	/** @private */
	_processOne(cur, i) {
		const k = cur.k;
		let v = cur.v;

		if (!v) {
			cur.v = v = '';
		}

		// fast path for string-only attributes
		if (k.constructor === String && v.constructor === String) {
			return;
		}

		let p;
		let n = v.length;
		if (Array.isArray(v) && (n > 1 || (n === 1 && v[0].constructor !== String))) {
			// transform the value
			this._async = true;
			p = this.frame.expand(v, {
				expandTemplates: this.options.expandTemplates,
				inTemplate: this.options.inTemplate,
				type: AttributeTransformManager._toType(),
				srcOffsets: cur.srcOffsets.slice(2, 4),
			}).then((tokens) => {
				this.expandedKVs.push({ index: i, v: TokenUtils.stripEOFTkfromTokens(tokens) });
			});
		}

		n = k.length;
		if (Array.isArray(k) && (n > 1 || (n === 1 && k[0].constructor !== String))) {
			// transform the key
			this._async = true;
			p = Promise.join(p, this.frame.expand(k, {
				expandTemplates: this.options.expandTemplates,
				inTemplate: this.options.inTemplate,
				type: AttributeTransformManager._toType(),
				srcOffsets: cur.srcOffsets.slice(0, 2),
			}).then(
				(tokens) => {
					this.expandedKVs.push({ index: i, k: TokenUtils.stripEOFTkfromTokens(tokens) });
				}
			));
		}

		return p;
	}
}


/* ******************************* TokenAccumulator ************************* */

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
*/
class TokenAccumulator {
	/**
	 * @param {TokenTransformManager} manager
	 * @param {Function} parentCB The callback to call after we've finished accumulating.
	 */
	constructor(manager, parentCB) {
		this.uid = TokenAccumulator._tid++; // useful for debugging
		this.manager = manager;
		this.parentCB = parentCB;
		this.siblingChunks = [];
		this.waitForChild = true;
		this.waitForSibling = true;
	}

	setParentCB(cb) {
		this.parentCB = cb;
	}

	/**
	 * Concatenates an array of tokens to the tokens kept in siblingChunks.
	 * If the ranks are the same, just concat to the last chunk. If not, set apart
	 * as its own chunk.
	 *
	 * @param {Array} tokens
	 */
	concatTokens(tokens) {
		// console.warn("\nTA-"+this.uid+" concatTokens", JSON.stringify(tokens));
		if (!tokens.length) {
			// Nothing to do
			return;
		}

		let lastChunk = JSUtils.lastItem(this.siblingChunks);
		if (!tokens.rank) {
			this.manager.env.log('error/tta/conc/rank/none', tokens);
			tokens.rank = this.manager.phaseEndRank;
		}
		if (!lastChunk) {
			this.siblingChunks.push(tokens);
		} else if (tokens.rank === lastChunk.rank) {
			lastChunk = JSUtils.pushArray(this.siblingChunks.pop(), tokens);
			lastChunk.rank = tokens.rank;
			this.siblingChunks.push(lastChunk);
		} else {
			this.manager.env.log('trace/tta/conc/rank/differs', tokens, lastChunk.rank);
			this.siblingChunks.push(tokens);
		}
	}

	/**
	 * Sends all accumulated tokens in order.
	 *
	 * @param {boolean} async
	 */
	emitTokens(async) {
		if (this.siblingChunks.length) {
			for (let i = 0, len = this.siblingChunks.length; i < len; i++) {
				this._callParentCB({
					tokens: this.siblingChunks[i],
					async: (i < len - 1) ? true : async,
				});
			}
			this.siblingChunks = [];
		} else {
			this._callParentCB({ tokens: [], async: async });
		}
	}

	/**
	 * Receives tokens from a child accum/pipeline/cb.
	 *
	 * @param {Object} ret
	 * @param {Array} ret.tokens
	 * @param {boolean} ret.async
	 * @return {Function|null} New parent callback for caller or falsy value.
	 */
	receiveToksFromChild(ret) {
		ret = verifyTokensIntegrity(this.manager.env, ret);
		// console.warn("\nTA-" + this.uid + "; c: " + this.waitForChild + "; s: " + this.waitForSibling + " <-- from child: " + JSON.stringify(ret));
		// Empty tokens are used to signal async, so they don't need to be in the
		// same rank
		if (ret.tokens.length && !ret.tokens.rank) {
			this.manager.env.log('error/tta/child/rank/none', ret.tokens);
			ret.tokens.rank = this.manager.phaseEndRank;
		}

		// Send async if child or sibling haven't finished or if there's sibling
		// tokens waiting
		if (!ret.async && this.siblingChunks.length
			&& this.siblingChunks[0].rank === ret.tokens.rank) {
			const tokens = JSUtils.pushArray(ret.tokens, this.siblingChunks.shift());
			tokens.rank = ret.tokens.rank;
			ret.tokens = tokens;
		}
		const async = ret.async || this.waitForSibling || (this.siblingChunks.length > 0);
		this._callParentCB({ tokens: ret.tokens, async: async });

		if (!ret.async) {
			// Child is all done => can pass along sibling toks as well
			// since any tokens we receive now will already be in order
			// and no buffering is necessary.
			this.waitForChild = false;
			if (this.siblingChunks.length) {
				this.emitTokens(this.waitForSibling);
			}
		}

		return null;
	}

	/**
	 * Receives tokens from a sibling accum/cb.
	 *
	 * @param {Object} ret
	 * @param {Array} ret.tokens
	 * @param {boolean} ret.async
	 * @return {Function|null} New parent callback for caller or falsy value.
	 */
	receiveToksFromSibling(ret) {
		ret = verifyTokensIntegrity(this.manager.env, ret);

		if (!ret.async) {
			this.waitForSibling = false;
		}

		if (this.waitForChild) {
			// Just continue to accumulate sibling tokens.
			this.concatTokens(ret.tokens);
			this.manager.env.log(
				'debug',
				'TokenAccumulator._receiveToksFromSibling: async=',
				ret.async,
				', this.outstanding=',
				(this.waitForChild + this.waitForSibling),
				', this.siblingChunks=',
				this.siblingChunks,
				' frame.title=',
				this.manager.frame.title
			);
		} else if (this.waitForSibling) {
			// Sibling is not yet done, but child is. Return own parentCB to
			// allow the sibling to go direct, and call back parent with
			// tokens. The internal accumulator is empty at this stage, as its
			// tokens got passed to the parent when the child was done.
			if (ret.tokens.length && !ret.tokens.rank) {
				this.manager.env.log('debug', 'TokenAccumulator.receiveToksFromSibling without rank', ret.tokens);
				ret.tokens.rank = this.manager.phaseEndRank;
			}
			return this._callParentCB(ret);
		} else {
			// console.warn("TA-" + this.uid + " --ALL DONE!--");
			// All done
			this.concatTokens(ret.tokens);
			this.emitTokens(false);
			return null;
		}
	}

	/**
	 * Mark the sibling as done (normally at the tail of a chain).
	 */
	siblingDone() {
		this.receiveToksFromSibling({ tokens: [], async: false });
	}

	/**
	 * @return {Function}
	 */
	_callParentCB(ret) {
		// console.warn("\nTA-" + this.uid + "; c: " + this.waitForChild + "; s: " + this.waitForSibling + " --> _callParentCB: " + JSON.stringify(ret));
		const cb = this.parentCB(ret);
		if (cb) {
			this.parentCB = cb;
		}
		return this.parentCB;
	}

	/**
	 * Push a token into the accumulator.
	 *
	 * @param {Token} token
	 */
	push(token) {
		// Treat a token push as a token-receive from a sibling
		// in whatever async state the accum is currently in.
		return this.receiveToksFromSibling({ tokens: [token], async: this.waitForSibling });
	}

	/**
	 * Append tokens to an accumulator.
	 *
	 * @param {Token[]} tokens
	 */
	append(tokens) {
		// Treat tokens append as a token-receive from a sibling
		// in whatever async state the accum is currently in.
		return this.receiveToksFromSibling({ tokens: tokens, async: this.waitForSibling });
	}
}

TokenAccumulator._tid = 0;


if (typeof module === "object") {
	module.exports.AsyncTokenTransformManager = AsyncTokenTransformManager;
	module.exports.SyncTokenTransformManager = SyncTokenTransformManager;
	module.exports.AttributeTransformManager = AttributeTransformManager;
	module.exports.TokenAccumulator = TokenAccumulator;
}
