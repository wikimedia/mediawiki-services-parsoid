'use strict';
require('./core-upgrade.js');

var Util = require('./mediawiki.Util.js').Util;
var api = require('./mediawiki.ApiRequest.js');

/**
 * @class
 *
 * This class combines requests into batches for dispatch to the
 * ParsoidBatchAPI extension, and calls the item callbacks when the batch
 * result is returned. It handles scheduling and concurrency of batch requests.
 * It also has a legacy mode which sends requests to the MW core API.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 */
function Batcher(env) {
	this.env = env;
	this.itemCallbacks = {};
	this.currentBatch = [];
	this.pendingBatches = [];
	this.resultCache = {};
	this.numOutstanding = 0;
	this.idleTimer = false;

	this.maxBatchSize = env.conf.parsoid.batchSize;
	this.targetConcurrency = env.conf.parsoid.batchConcurrency;
}

/**
 * Internal function for adding a generic work item.
 *
 * @param {Object} params
 * @param {Function} cb item callback
 */
Batcher.prototype.pushGeneric = function(params, cb) {
	var hash = params.hash;
	if (hash in this.itemCallbacks) {
		this.trace("Appending callback for hash", hash);
		this.itemCallbacks[hash].push(cb);
	} else {
		this.trace("Creating batch item:", params);
		this.itemCallbacks[hash] = [cb];
		this.currentBatch.push(params);
		if (this.currentBatch.length >= this.maxBatchSize) {
			this.sealBatch();
		}
	}
};

/**
 * Declare a batch complete and move it to the queue ready for dispatch. Moving
 * batches to a queue instead of dispatching them immediately allows for an
 * upper limit on concurrency.
 */
Batcher.prototype.sealBatch = function() {
	if (this.currentBatch.length > 0) {
		this.pendingBatches.push(this.currentBatch);
		this.currentBatch = [];
	}
};

/**
 * Dispatch batches from the pending queue, if it is currently possible.
 */
Batcher.prototype.dispatch = function() {
	while (this.numOutstanding < this.targetConcurrency && this.pendingBatches.length) {
		var batch = this.pendingBatches.shift();

		this.trace("Dispatching batch with", batch.length, "items");
		this.request(batch).once('batch',
			this.onBatchResponse.bind(this, batch));

		this.numOutstanding++;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = false;
		}
	}
};

/**
 * Schedule an idle event for the next tick. The idle event will dispatch
 * batches if necessary to keep the job going. The idle event will be cancelled
 * if a dispatch is done before returning to the event loop.
 *
 * This must be called after the completion of parsing work, and after any
 * batch response is received, to avoid hanging the request by having an
 * undispatched batch.
 */
Batcher.prototype.scheduleIdle = function() {
	if (!this.idleTimer) {
		this.idleTimer = setTimeout(this.onIdle.bind(this), 0);
	}
};

/**
 * Handler for the idle event. Dispatch batches if there is not enough work
 * outstanding.
 */
Batcher.prototype.onIdle = function() {
	this.idleTimer = false;

	this.trace("Idle with outstanding =", this.numOutstanding,
		", pending =", this.pendingBatches.length, "x", this.maxBatchSize,
		", current =", this.currentBatch.length);

	if (this.numOutstanding < this.targetConcurrency) {
		this.sealBatch();
		this.dispatch();
	}
};

/**
 * Handle a batch response and call item callbacks, after the request is
 * decoded by BatchRequest.
 *
 * @param {Object} batchParams The parameters as in pushGeneric().
 * @param {Error/null} error
 * @param {Array} batchResult
 */
Batcher.prototype.onBatchResponse = function(batchParams, error, batchResult) {
	var i, j, result, params, callbacks;
	this.numOutstanding--;
	if (error) {
		this.trace("Received error in batch response:", error);
	} else {
		this.trace("Received batch response with", batchResult.length, "items");
	}
	for (i = 0; i < batchParams.length; i++) {
		params = batchParams[i];
		callbacks = this.itemCallbacks[params.hash];
		if (error) {
			for (j = 0; j < callbacks.length; j++) {
				callbacks[j](error, null);
			}
		} else {
			result = batchResult[i];
			this.resultCache[params.hash] = result;
			delete this.itemCallbacks[params.hash];
			for (j = 0; j < callbacks.length; j++) {
				callbacks[j](null, result);
			}
		}
	}
	this.scheduleIdle();
};

/**
 * Schedule a proprocess (expandtemplates) operation.
 * @param {string} title The title of the page to use as the context
 * @param {string} text
 * @param {Function} cb The completion callback
 */
Batcher.prototype.preprocess = function(title, text, cb) {
	var env = this.env;
	var hash = Util.makeHash(["preprocess", text, title]);
	if (hash in this.resultCache) {
		this.trace("Result cache hit for hash", hash);
		return this.resultCache[hash];
	}
	if (!env.conf.parsoid.useBatchAPI) {
		this.trace("Non-batched preprocess request");
		this.legacyRequest(api.PreprocessorRequest,
			[env, title, text, hash], hash, cb);
		return;
	}

	// Add the item to the batch
	this.pushGeneric(
		{
			action: "preprocess",
			title: title,
			text: text,
			hash: hash,
		}, cb
	);
};

/**
 * Schedule an MW parse operation.
 * @param {string} title The title of the page to use as the context
 * @param {string} text
 * @param {Function} cb The completion callback
 */
Batcher.prototype.parse = function(title, text, cb) {
	var env = this.env;
	var hash = Util.makeHash(["parse", text, title]);
	if (hash in this.resultCache) {
		return this.resultCache[hash];
	}
	if (!env.conf.parsoid.useBatchAPI) {
		this.trace("Non-batched parse request");
		this.legacyRequest(api.PHPParseRequest,
			[env, title, text, false, hash], hash, cb);
		return;
	}

	this.pushGeneric(
		{
			action: "parse",
			title: title,
			text: text,
			hash: hash,
		}, cb
	);
};

/**
 * Schedule fetching of image info.
 * @param {string} filename
 * @param {Object} dims
 * @param {Function} cb The completion callback
 */
Batcher.prototype.imageinfo = function(filename, dims, cb) {
	var env = this.env;
	var hash = Util.makeHash(["imageinfo", filename, dims.width || "", dims.height || ""]);
	if (hash in this.resultCache) {
		return this.resultCache[hash];
	}
	if (!env.conf.parsoid.useBatchAPI) {
		this.trace("Non-batched imageinfo request");
		this.legacyRequest(api.ImageInfoRequest,
			[env, filename, dims, hash], hash, cb);
		return;
	}

	var params = {
		action: "imageinfo",
		filename: filename,
		hash: hash,
	};
	if (dims.width !== null || dims.height !== null) {
		params.txopts = {};
		if (dims.width !== null) {
			params.txopts.width = dims.width;
		}
		if (dims.height !== null) {
			params.txopts.height = dims.height;
		}
	}

	this.pushGeneric(params, cb);
};

/**
 * Helper for sending legacy requests when the extension is not available
 * @param {Function} Constructor The ApiRequest subclass constructor
 * @param {Array} args The constructor arguments
 * @param {string} hash The request identifier hash
 * @param {Function} cb The completion callback
 */
Batcher.prototype.legacyRequest = function(Constructor, args, hash, cb) {
	var env = this.env;
	if (env.requestQueue[hash] === undefined) {
		var req = Object.create(Constructor.prototype);
		Constructor.apply(req, args);
		env.requestQueue[hash] = req;
	}
	env.requestQueue[hash].once('src', this.onLegacyResponse.bind(this, hash, cb));
};

/**
 * Helper for handling a legacy response
 */
Batcher.prototype.onLegacyResponse = function(hash, cb, error, src) {
	if (!error) {
		this.resultCache[hash] = src;
	}
	cb(error, src);
};

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
		} else {
			apiItemParams = {
				action: params.action,
				title: params.title,
				text: params.text,
			};
		}
		apiBatch.push(apiItemParams);
		key.push(params.hash);
	}
	return new api.BatchRequest(this.env, apiBatch, key.join(':'));
};

/**
 * Convenience helper for tracing
 */
Batcher.prototype.trace = function() {
	this.env.log.apply(null, ["trace/batcher"].concat(Array.prototype.slice.call(arguments)));
};

module.exports = {
	Batcher: Batcher,
};
