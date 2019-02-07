/** @module */

'use strict';

require('../../core-upgrade.js');

var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var api = require('./ApiRequest.js');

/**
 * This class combines requests into batches for dispatch to the
 * ParsoidBatchAPI extension, and calls the item callbacks when the batch
 * result is returned. It handles scheduling and concurrency of batch requests.
 * It also has a legacy mode which sends requests to the MW core API.
 *
 * @class
 * @param {MWParserEnvironment} env
 */
function Batcher(env) {
	this.env = env;
	this.itemCallbacks = {};
	this.currentBatch = [];
	this.pendingBatches = [];
	this.resultCache = {};
	this.numOutstanding = 0;
	this.forwardProgressTimer = null;
	this.maxBatchSize = env.conf.parsoid.batchSize;
	this.targetConcurrency = env.conf.parsoid.batchConcurrency;
	// Max latency before we give up on a batch response and terminate the req.
	this.maxResponseLatency = env.conf.parsoid.timeouts.mwApi.batch *
		(1 + env.conf.parsoid.retries.mwApi.all) + 5 * 1000;
}

/**
 * Internal function for adding a generic work item.
 *
 * @param {Object} params
 * @param {Function} cb item callback
 */
Batcher.prototype.pushGeneric = Promise.promisify(function(params, cb) {
	var hash = params.hash;
	if (hash in this.itemCallbacks) {
		this.trace("Appending callback for hash", hash);
		this.itemCallbacks[hash].push(cb);
		return;
	} else {
		this.trace("Creating batch item:", params);
		this.itemCallbacks[hash] = [cb];
		this.currentBatch.push(params);
		if (this.currentBatch.length >= this.maxBatchSize) {
			this.clearForwardProgressTimer();
			return this.sealBatchAndDispatch();
		}
	}

	// Don't dispatch right away, but set a 0-value timeout
	// to ensure that we keep the event loop alive. This also
	// ensures that we make forward progress by dispatching a
	// batch whenever the batcher is idle.
	//
	// As long as we get new requests within that timeout period,
	// keep postponing the premature dispatch. When the current
	// batch reaches its max batch size, it will get dispatched
	// automatically above. This kicks off the
	//   dispatch -> API response -> dispatch -> .. loop
	// which keeps things moving.
	this.resetForwardProgressTimer();
});

Batcher.prototype.clearForwardProgressTimer = function() {
	if (this.forwardProgressTimer) {
		clearTimeout(this.forwardProgressTimer);
		this.forwardProgressTimer = null;
	}
};

Batcher.prototype.resetForwardProgressTimer = function() {
	this.clearForwardProgressTimer();
	// `setTimeout` is guaranteed to be called *after* `setImmediate`,
	// `process.nextTick`, and `Promise#then` callbacks.  So long as
	// the Parsoid pipeline uses the above mechanisms, then the forward
	// progress timer will be invoked only after all available work has
	// been done.
	this.forwardProgressTimer = setTimeout(() => this.makeForwardProgress(), 0);
};

/**
 * If we don't have any outstanding requests, dispatch what
 * we have right now to make sure that we make forward progress
 * with the request.
 */
Batcher.prototype.makeForwardProgress = function() {
	if (this.numOutstanding < this.targetConcurrency) {
		this.trace("makeForwardProgress with outstanding =", this.numOutstanding,
			", pending =", this.pendingBatches.length, "x", this.maxBatchSize,
			", current =", this.currentBatch.length);
		this.forceDispatch();
		this.forwardProgressTimer = null;
	}
};

/**
 * Force immediate dispatch of a minimum unit of work, to avoid a stall. If a
 * complete batch is pending, we will dispatch that, otherwise we will dispatch
 * an incomplete batch.
 */
Batcher.prototype.forceDispatch = function() {
	// If this is invoked when we are above the concurrency limit, we would
	// prematurely seal a batch.
	console.assert(this.numOutstanding < this.targetConcurrency);
	if (this.pendingBatches.length === 0 && this.currentBatch.length > 0) {
		this.sealBatchAndDispatch();
	} else {
		this.dispatch();
	}
};

/**
 * Declare a batch complete and initiate dispatch.
 */
Batcher.prototype.sealBatchAndDispatch = function() {
	console.assert(this.currentBatch.length > 0);

	this.pendingBatches.push(this.currentBatch);
	this.currentBatch = [];

	this.dispatch();
};

/**
 * Dispatch batches from the pending queue, if it is currently possible.
 */
Batcher.prototype.dispatch = function() {
	while (this.numOutstanding < this.targetConcurrency && this.pendingBatches.length) {
		var batch = this.pendingBatches.shift();

		this.trace("Dispatching batch with", batch.length, "items");
		this.request(batch).once('batch',
			(err, res) => this.onBatchResponse(batch, err, res));

		// This is to catch scenarios where we get no response back.
		batch.responseTimer = setTimeout(
			() => this.handleResponseTimeout(batch),
			this.maxResponseLatency);

		this.numOutstanding++;
	}
};

Batcher.prototype.handleResponseTimeout = function(batch) {
	// Treat this as a fatal failure -- after we are done here,
	// we are likely to just drop out of the event loop.
	// So, this worker will need a restart.
	this.env.log('fatal',
		'Timed out. No response from the batching API for batch: ',
		batch);
};

/**
 * Handle a batch response and call item callbacks, after the request is
 * decoded by BatchRequest.
 *
 * @param {Object} batchParams The parameters as in pushGeneric().
 * @param {Error|null} error
 * @param {Array} batchResult
 */
Batcher.prototype.onBatchResponse = function(batchParams, error, batchResult) {
	this.numOutstanding--;

	// We got a response. All well and good.
	clearTimeout(batchParams.responseTimer);

	// Dispatch any pending batch to refill the concurrency limit.
	this.forceDispatch();

	var i, j, result;
	if (error) {
		this.trace("Received error in batch response:", error);
	} else {
		this.trace("Received batch response with", batchResult.length, "items");
	}

	try {
		for (i = 0; i < batchParams.length; i++) {
			var params = batchParams[i];
			var callbacks = this.itemCallbacks[params.hash];
			delete this.itemCallbacks[params.hash];
			if (error) {
				for (j = 0; j < callbacks.length; j++) {
					callbacks[j](error, null);
				}
			} else {
				result = batchResult[i];
				this.resultCache[params.hash] = result;
				for (j = 0; j < callbacks.length; j++) {
					callbacks[j](null, result);
				}
			}
		}
	} catch (e) {
		// Since these callbacks aren't supposed to be erroring,
		// we are doing a global try-catch around the entire
		this.env.log('fatal/request',
			'Exception ', e,
			'while processing callback ', j, ' for batch req: ', batchParams[i],
			'batch response: ', result);
	}
};

/**
 * Schedule a proprocess (expandtemplates) operation.
 * @param {string} title The title of the page to use as the context
 * @param {string} text
 * @return {Promise}
 */
Batcher.prototype.preprocess = Promise.method(function(title, text) {
	var env = this.env;
	var hash = Util.makeHash(["preprocess", text, title]);
	if (hash in this.resultCache) {
		this.trace("Result cache hit for hash", hash);
		return this.resultCache[hash];
	} else if (!env.conf.parsoid.useBatchAPI) {
		this.trace("Non-batched preprocess request");
		return this.legacyRequest(api.PreprocessorRequest, [
			env, title, text, hash,
		], hash);
	} else {
		// Add the item to the batch
		return this.pushGeneric({
			action: "preprocess",
			title: title,
			text: text,
			hash: hash,
			revid: env.page.meta.revision.revid,
		});
	}
});

/**
 * Schedule an MW parse operation.
 * @param {string} title The title of the page to use as the context
 * @param {string} text
 * @return {Promise}
 */
Batcher.prototype.parse = Promise.method(function(title, text) {
	var env = this.env;
	var hash = Util.makeHash(["parse", text, title]);
	if (hash in this.resultCache) {
		return this.resultCache[hash];
	} else if (!env.conf.parsoid.useBatchAPI) {
		this.trace("Non-batched parse request");
		return this.legacyRequest(api.PHPParseRequest, [
			env, title, text, false, hash,
		], hash);
	} else {
		return this.pushGeneric({
			action: "parse",
			title: title,
			text: text,
			hash: hash,
			revid: env.page.meta.revision.revid,
		});
	}
});

/**
 * Schedule fetching of image info.
 * @param {string} filename
 * @param {Object} dims
 * @return {Promise}
 */
Batcher.prototype.imageinfo = Promise.method(function(filename, dims) {
	var env = this.env;
	var vals = Object.keys(dims).map(function(k) { return dims[k] || ''; });
	var hash = Util.makeHash(["imageinfo", filename, env.page.name].concat(vals));
	if (hash in this.resultCache) {
		return this.resultCache[hash];
	} else if (!env.conf.parsoid.useBatchAPI) {
		this.trace("Non-batched imageinfo request");
		return this.legacyRequest(api.ImageInfoRequest, [
			env, filename, dims, hash,
		], hash);
	} else {
		var params = {
			action: "imageinfo",
			filename: filename,
			hash: hash,
			page: env.page.name,
		};
		if (dims.width !== null || dims.height !== null || dims.seek !== undefined) {
			params.txopts = {};
			if (dims.width !== null) {
				params.txopts.width = dims.width;
				if (dims.page !== undefined) {
					params.txopts.page = dims.page;
				}
			}
			if (dims.height !== null) {
				params.txopts.height = dims.height;
			}
			if (dims.seek !== undefined) {
				params.txopts.thumbtime = dims.seek;
			}
		}
		return this.pushGeneric(params);
	}
});

/**
 * Helper for sending legacy requests when the extension is not available
 *
 * @param {Function} Constructor The ApiRequest subclass constructor
 * @param {Array} args The constructor arguments
 * @param {string} hash The request identifier hash
 * @param {Function} cb The completion callback
 */
Batcher.prototype.legacyRequest = Promise.promisify(function(Constructor, args, hash, cb) {
	var env = this.env;
	if (env.requestQueue[hash] === undefined) {
		var req = new Constructor(...args);
		env.requestQueue[hash] = req;
	}
	env.requestQueue[hash].once('src', (error, src) => {
		if (!error) {
			this.resultCache[hash] = src;
		}
		cb(error, src);
	});
});

/**
 * Actually send a single batch request with the specified parameters.
 */
Batcher.prototype.request = function(batchParams) {
	var i;
	var params;
	var apiBatch = [];
	var key = [];
	var apiItemParams;
	for (i = 0; i < batchParams.length; i++) {
		params = batchParams[i];
		if (params.action === 'imageinfo') {
			apiItemParams = {
				action: params.action,
				filename: params.filename,
			};
			if ("txopts" in params) {
				apiItemParams.txopts = params.txopts;
			}
			if ("page" in params) {
				apiItemParams.page = params.page;
			}
		} else {
			apiItemParams = {
				action: params.action,
				title: params.title,
				text: params.text,
				revid: params.revid,
			};
		}
		apiBatch.push(apiItemParams);
		key.push(params.hash);
	}
	return new api.BatchRequest(this.env, apiBatch, key.join(':'));
};

/**
 * Convenience helper for tracing.
 */
Batcher.prototype.trace = function() {
	this.env.log.apply(null, ["trace/batcher"].concat(Array.from(arguments)));
};

/**
 * NOTE: We're making a direct call to the batching api here, rather than
 * adding to an instantiated batcher, as defined above.
 * We also don't have any support for getting this information via a
 * legacy non-batcher API, although it could be done in principle; see
 * https://github.com/wikimedia/mediawiki-extensions-ParsoidBatchAPI/commit/57fdabb2007437bef4e3f8b03e4593372d7d9974
 */
Batcher.getPageProps = Promise.method(function(env, titles) {
	const batches = [];
	while (titles.length > 0) {
		// Split these up by php's ApiBase::LIMIT_BIG1 for more sensible queries
		batches.push({
			action: 'pageprops',
			titles: titles.splice(0, 500),
		});
	}

	return Promise.map(batches, (batch) => {
		const hash = Util.makeHash(['pageprops'].concat(batch.titles));
		var br = new api.BatchRequest(env, [batch], hash);
		return new Promise(function(resolve, reject) {
			br.once('batch', function(err, result) {
				if (err) { return reject(err); }
				resolve(result);
			});
		});
	}).reduce((arr, res) => {
		return arr.concat(res);
	}, []);
});

module.exports = {
	Batcher: Batcher,
};
