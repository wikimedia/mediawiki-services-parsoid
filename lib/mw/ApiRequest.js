/** @module */

'use strict';

require('../../core-upgrade.js');

var domino = require('domino');
var events = require('events');
var request = require('request');
var url = require('url');
var util = require('util');

var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var JSUtils = require('../utils/jsutils.js').JSUtils;


function setupConnectionTimeout(env, protocol) {
	var http = require(protocol);
	var Agent = http.Agent;

	function ConnectTimeoutAgent() {
		Agent.apply(this, arguments);
	}
	util.inherits(ConnectTimeoutAgent, Agent);

	ConnectTimeoutAgent.prototype.createSocket = function() {
		var args = Array.from(arguments);
		var options = this.options;
		var cb = args[2];
		args[2] = function(err, s) {
			if (err) { return cb(err, s); }
			// Set up a connect timeout if connectTimeout option is set
			if (options.connectTimeout && !s.connectTimeoutTimer) {
				s.connectTimeoutTimer = setTimeout(function() {
					var e = new Error('ETIMEDOUT');
					e.code = 'ETIMEDOUT';
					s.end();
					s.emit('error', e);
					s.destroy();
				}, options.connectTimeout);
				s.once('connect',  function() {
					if (s.connectTimeoutTimer) {
						clearTimeout(s.connectTimeoutTimer);
						s.connectTimeoutTimer = undefined;
					}
				});
			}
			cb(null, s);
		};
		Agent.prototype.createSocket.apply(this, args);
	};

	return new ConnectTimeoutAgent({
		connectTimeout: env.conf.parsoid.timeouts.mwApi.connect,
		maxSockets: env.conf.parsoid.maxSockets,
	});
}

var latestSerial = 0;

var logAPIWarnings = function(req, data) {
	if (req.env.conf.parsoid.logMwApiWarnings &&
			data && data.hasOwnProperty('warnings')) {
		// split up warnings by API module
		Object.keys(data.warnings).forEach(function(apiModule) {
			var re = req.env.conf.parsoid.suppressMwApiWarnings;
			var msg = data.warnings[apiModule].warnings || data.warnings[apiModule]['*'];
			if (re instanceof RegExp && re.test(msg)) {
				return; // suppress this message
			}
			req.env.log('warn/api/' + apiModule, req.reqType, msg);
		});
	}
};

// Helper to return a promise returning function for the result of an
// (Ctor-type) ApiRequest.
var promiseFor = function(Ctor) {
	return function() {
		var args = Array.from(arguments);
		return new Promise(function(resolve, reject) {
			var req = Object.create(Ctor.prototype);
			Ctor.apply(req, args);
			req.once('src', function(err, src) {
				if (err) {
					reject(err);
				} else {
					resolve(src);
				}
			});
		});
	};
};

var manglePreprocessorResponse = function(env, response) {
	var src = '';
	if (response.wikitext !== undefined) {
		src = response.wikitext;
	} else if (response["*"] !== undefined) {
		// For backwards compatibility. Older wikis still put the data here.
		src = response["*"];
	} else {
		env.log('warn/api', "Invalid API preprocessor response");
	}

	// Add the categories which were added by parser functions directly
	// into the page and not as in-text links.
	if (Array.isArray(response.categories)) {
		for (var i in response.categories) {
			var category = response.categories[i];
			src += '\n[[Category:' + (category.category || category['*']);
			if (category.sortkey) {
				src += "|" + category.sortkey;
			}
			src += ']]';
		}
	}
	// Ditto for page properties (like DISPLAYTITLE and DEFAULTSORT)
	var checkProp = (name, value) => {
		if (name === 'displaytitle' || name === 'defaultsort') {
			src += '\n{{' + name.toUpperCase() + ':' + value + '}}';
		}
	};
	if (Array.isArray(response.properties)) {
		// JSON formatversion 1 returns an array here
		response.properties.forEach(prop => checkProp(prop.name, prop['*']));
	} else if (response.properties) {
		// JSON formatversion 2 returns an object w/ key value maps
		Object.keys(response.properties).forEach(
			name => checkProp(name, response.properties[name])
		);
	}
	// The same for ResourceLoader modules
	env.setPageProperty(response.modules, "extensionModules");
	env.setPageProperty(response.modulescripts, "extensionModuleScripts");
	env.setPageProperty(response.modulestyles, "extensionModuleStyles");

	return src;
};

var dummyDoc = domino.createDocument();
var mangleParserResponse = function(env, response) {
	var parsedHtml = '';
	if (typeof response.text === "string") {
		parsedHtml = response.text;
	} else if (response.text['*'] !== undefined) {
		parsedHtml = response.text['*'];
	} else {
		env.log('warn/api', "Invalid API parser response");
	}

	// Strip a paragraph wrapper, if any
	parsedHtml = parsedHtml.replace(/(^<p>)|(\n<\/p>$)/g, '');

	// Add the modules to the page data
	env.setPageProperty(response.modules, "extensionModules");
	env.setPageProperty(response.modulescripts, "extensionModuleScripts");
	env.setPageProperty(response.modulestyles, "extensionModuleStyles");

	// Add the categories which were added by extensions directly into the
	// page and not as in-text links
	if (response.categories) {
		for (var i in response.categories) {
			var category = response.categories[i];

			var link = dummyDoc.createElement("link");
			link.setAttribute("rel", "mw:PageProp/Category");

			var href = env.page.relativeLinkPrefix + "Category:" + encodeURIComponent(category.category || category['*']);
			if (category.sortkey) {
				href += "#" + encodeURIComponent(category.sortkey);
			}
			link.setAttribute("href", href);

			parsedHtml += "\n" + link.outerHTML;
		}
	}

	return parsedHtml;
};

/**
 * @class
 * @extends Error
 */
class DoesNotExistError extends Error {
	constructor(message) {
		super(message || "Something doesn't exist");
		this.name = this.constructor.name;
		this.httpStatus = 404;
		this.suppressLoggingStack = true;
	}
}

/**
 * @class
 * @extends Error
 */
class ParserError extends Error {
	constructor(message) {
		super(message || "Generic parser error");
		this.name = this.constructor.name;
		this.httpStatus = 500;
	}
}

/**
 * @class
 * @extends Error
 */
class AccessDeniedError extends Error {
	constructor(message) {
		super(message || 'Your wiki requires a logged-in account to access the API.');
		this.name = this.constructor.name;
		this.httpStatus = 401;
	}
}

/**
 *
 * Abstract API request base class.
 *
 * @class
 * @extends EventEmitter
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page we should fetch from the API.
 */
function ApiRequest(env, title) {
	// call the EventEmitter constructor
	events.EventEmitter.call(this);

	// Update the number of maximum listeners
	this.setMaxListeners(env.conf.parsoid.maxListeners);

	this.retries = env.conf.parsoid.retries.mwApi.all;
	this.env = env;
	this.title = title;
	this.queueKey = title;
	this.serial = ++latestSerial;
	this.reqType = "Page Fetch";
	this.traceTime = env.conf.parsoid.traceFlags && env.conf.parsoid.traceFlags.has("time");
}

// Inherit from EventEmitter
util.inherits(ApiRequest, events.EventEmitter);

var httpAgent = null;
var httpsAgent = null;

ApiRequest.prototype.request = function(requestOpts) {
	var env = this.env;

	// Proxy to the MW API.
	var proxy = env.conf.wiki.apiProxy;

	// If you want to funnel all connections to a specific host/ip
	// This can be useful if you want to hit an internal endpoint instead of the
	// public one.
	var mwApiServer = env.conf.parsoid.mwApiServer;

	// requestOpts is reused on retries (see _requestCB).
	// Clone it to prevent destructive clobbering.
	var options = Object.assign({}, requestOpts);

	// This was an old way of doing things that we expect to no longer be around
	console.assert(options.proxy === undefined, 'Unexpected proxy definition.');

	// this is a good place to put debugging statements
	// if you want to watch network requests.

	// Forward the request id
	if (!options.headers) { options.headers = {}; }
	options.headers['X-Request-ID'] = env.reqId;
	// Set default options, forward cookie if set.
	options.headers['User-Agent'] = env.conf.parsoid.userAgent;
	options.headers.Connection = 'close';
	options.strictSSL = (env.conf.wiki.strictSSL !== undefined) ?
		env.conf.wiki.strictSSL : env.conf.parsoid.strictSSL;
	if (env.cookie) {
		options.headers.Cookie = env.cookie;
	}

	// If mwApiServer is specified, we want to send all our requests to that server.
	// This means that we should substitute the host part of the URI with that, and
	// indicate which site we're interested in with the Host: header.
	// There might be exceptions, where we do NOT want to funnel traffic via this server.
	// In those cases, the wiki should be defined as "non-global".
	// See ParsoidConfig.loadWMFApiMap
	if (mwApiServer && !env.conf.wiki.nonGlobal) {
		var urlobj = url.parse(options.uri);
		options.headers.Host = urlobj.hostname;
		options.uri = mwApiServer;
	}

	// Do this after updating the `options.uri` to account for the `mwApiServer`
	// since that's where we'll be connecting.
	if (httpAgent === null) {
		httpAgent = setupConnectionTimeout(env, 'http');
		httpsAgent = setupConnectionTimeout(env, 'https');
	}
	options.agent = /^https[:]/.test(options.uri) ? httpsAgent : httpAgent;

	// Proxy options should only be applied to MW API endpoints.
	// Allow subclasses to manually set proxy to `null` or to a different
	// proxy to override MW API proxy. If proxy.uri is false (so either the default
	// API proxy is not set, or the wiki is private/fishbowl/non-global), skip proxying.
	if (proxy && proxy.uri) {
		options.proxy = proxy.uri;
		options.agent = /^https[:]/.test(proxy.uri) ? httpsAgent : httpAgent;
		if (proxy.headers) {
			Object.assign(options.headers, proxy.headers);
		}
		if (proxy.strip_https && /^https[:]/.test(options.uri)) {
			// When proxying, strip TLS and lie to the appserver to indicate
			// unwrapping has just occurred. The appserver isn't listening on
			// port 443 but a site setting may require a secure connection,
			// which the header identifies.  (This is primarily for proxies
			// used in WMF production, for which loadWMFApiMap sets the
			// proxy.strip_https flag.)
			options.uri = options.uri.replace(/^https/, 'http');
			options.headers['X-Forwarded-Proto'] = 'https';
		}
	}

	this.trace("Starting HTTP request: ", function() {
		// Omit agent since it isn't exactly serializable
		return Object.assign({}, options, { agent: undefined });
	});
	const startTime = this.traceTime ? JSUtils.startTime() : undefined;
	return request(options,
		(error, response, body) => this._requestCB(startTime, error, response, body));
};

/**
 * @private
 * @param {Object} data API response body.
 * @param {string} requestStr Request string -- useful to help debug what went wrong.
 * @param {string} defaultMsg Default error message if there were no data.error property.
 */
ApiRequest.prototype._errorObj = function(data, requestStr, defaultMsg) {
	return new Error('API response Error for ' +
		this.constructor.name + ': request=' +
		(requestStr || '') + "; error=" +
		JSON.stringify((data && data.error) || defaultMsg));
};

/**
 * @private
 * @param {Error|null} error
 * @param {string} data Wikitext / html / metadata.
 */
ApiRequest.prototype._processListeners = function(error, data) {
	// Process only a few callbacks in each event loop iteration to
	// reduce memory usage.
	var processSome = () => {
		// listeners() returns a copy (slice) of the listeners array in
		// 0.10. Get a new copy including new additions before processing
		// each batch.
		var listeners = this.listeners('src');
		// XXX: experiment a bit with the number of callbacks per
		// iteration!
		var maxIters = Math.min(1, listeners.length);
		for (var it = 0; it < maxIters; it++) {
			var nextListener = listeners.shift();
			this.removeListener('src', nextListener);

			// We expect these listeners to remove themselves when being
			// called - always add them with once().
			try {
				nextListener.call(this, error || null, data);
			} catch (e) {
				return this.env.log('fatal', e);
			}
		}
		if (listeners.length) {
			setImmediate(processSome);
		}
	};
	setImmediate(processSome);
};

/**
 * @private
 * @param {Object} startTime
 * @param {Error|null} error
 * @param {Object} response The API response object, with error code.
 * @param {string} body The body of the response from the API.
 */
ApiRequest.prototype._requestCB = function(startTime, error, response, body) {
	var s;
	if (this.traceTime) {
		this.env.bumpIOTime(this.constructor.name, JSUtils.elapsedTime(startTime));
		this.env.bumpCount(this.constructor.name);
		this.env.bumpCount("io.requests");
		s = JSUtils.startTime();
	}
	if (error) {
		this.trace("Received error:", error);
		this.env.log('warn/api' + (error.code ? ("/" + error.code).toLowerCase() : ''),
			'Failed API request,', {
				"error": error,
				"status": response && response.statusCode,
				"retries-remaining": this.retries,
			}
		);
		if (this.retries) {
			this.retries--;
			// retry
			this.requestOptions.timeout *= 3 + Math.random();
			this.request(this.requestOptions);
			return;
		} else {
			var dnee = new Error(this.reqType + ' failure for '
					+ JSON.stringify(this.queueKey.substr(0, 80)) + ': ' + error);
			this._handleBody(dnee, '{}');
		}
	} else if (response.statusCode === 200) {
		this.trace("Received HTTP 200, ", body.length, "bytes");
		this._handleBody(null, body);
	} else {
		this.trace("Received HTTP", response.statusCode, ": ", body);
		if (response.statusCode === 412) {
			this.env.log("info", "Cache MISS:", response.request.href);
		} else {
			this.env.log("warn", "non-200 response:", response.statusCode, body);
		}
		error = new Error(this.reqType + ' failure for '
					+ JSON.stringify(this.queueKey.substr(0, 80)) + ': ' + response.statusCode);
		this._handleBody(error, '{}');
	}

	// XXX: handle other status codes

	// Remove self from request queue
	delete this.env.requestQueue[this.queueKey];
	if (this.traceTime) {
		// Add this to TT's ledger since the vast majority of api requests
		// are in the service of token transforms.
		this.env.bumpTimeUse("API response processing time", JSUtils.elapsedTime(s), 'TT');
		this.env.bumpCount("API response processing time");
	}
};

ApiRequest.prototype._logWarningsAndHandleJSON = function(error, data) {
	logAPIWarnings(this, data);
	this._handleJSON(error, data);
};

/**
 * Default body handler: Parse to JSON and call _handleJSON.
 *
 * @private
 * @param {Error|null} error
 * @param {string} body The body of the response from the API.
 */
ApiRequest.prototype._handleBody = function(error, body) {
	if (error) {
		this._logWarningsAndHandleJSON(error, {});
		return;
	}
	var data;
	try {
		// Strip the UTF8 BOM since it knowingly breaks parsing.
		if (body[0] === '\uFEFF') {
			this.env.log('warn', 'Stripping a UTF8 BOM. Your webserver is' +
				' likely broken.');
			body = body.slice(1);
		}
		data = JSON.parse(body);
	} catch (e) {
		if (!body) {
			// This is usually due to a fatal error on the PHP side, although
			// it would be nice (!) if PHP would return a non-200 error code
			// for this!
			error = new ParserError('Empty JSON response returned for ' +
				this.reqType);
		} else {
			error = new ParserError('Failed to parse the JSON response for ' +
				this.reqType);
		}
	}
	this._logWarningsAndHandleJSON(error, data);
};

ApiRequest.prototype.trace = function() {
	this.env.log.apply(null, ["trace/apirequest", "#" + this.serial].concat(Array.from(arguments)));
};

/**
 * Template fetch request helper class.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} title The template (or really, page) we should fetch from the wiki.
 * @param {string} oldid The revision ID you want to get, defaults to "latest revision".
 */
function TemplateRequest(env, title, oldid, opts) {
	ApiRequest.call(this, env, title);
	// IMPORTANT: Set queueKey to the 'title'
	// since TemplateHandler uses it for recording listeners
	this.queueKey = title;
	this.reqType = "Template Fetch";
	opts = opts || {}; // optional extra arguments

	var apiargs = {
		format: 'json',
		// XXX: should use formatversion=2
		action: 'query',
		prop: 'info|revisions',
		rawcontinue: 1,
		// all revision properties which parsoid is interested in.
		rvprop: 'content|ids|timestamp|size|sha1|contentmodel',
		rvslots: 'main',
	};

	if (oldid) {
		this.oldid = oldid;
		apiargs.revids = oldid;
	} else {
		apiargs.titles = title;
	}

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.srcFetch,
	};

	this.request(this.requestOptions);
}

util.inherits(TemplateRequest, ApiRequest);

// Function which returns a promise for the result of a template request.
TemplateRequest.promise = promiseFor(TemplateRequest);

// Function which returns a promise to set page src info.
TemplateRequest.setPageSrcInfo = Promise.async(function *(env, target, oldid, opts) {
	const src = yield TemplateRequest.promise(env, target, oldid, opts);
	env.setPageSrcInfo(src);
});

/**
 * @private
 * @param {Error} error
 * @param {Object} data The response from the server - parsed JSON object.
 */
TemplateRequest.prototype._handleJSON = function(error, data) {
	if (!error && !data.query) {
		error = this._errorObj(data, '', 'Missing data.query');
	}

	if (error) {
		this._processListeners(error, null);
		return;
	}

	var metadata, content;
	if (!data.query.pages) {
		if (data.query.interwiki) {
			// Essentially redirect, but don't actually redirect.
			var interwiki = data.query.interwiki[0];
			var title = interwiki.title;
			var regex = new RegExp('^' + interwiki.iw + ':');
			title = title.replace(regex, '');
			var iwstr = this.env.conf.wiki.interwikiMap.get(interwiki.iw).url ||
				this.env.conf.parsoid.mwApiMap.get(interwiki.iw).uri ||
				'/' + interwiki.iw + '/' + '$1';
			var location = iwstr.replace('$1', title);
			error = new DoesNotExistError('The page at ' + this.title +
				' can be found at a different location: ' + location);
		} else {
			error = new DoesNotExistError(
				'No pages were returned from the API request for ' +
				this.title);
		}
	} else {
		// we've only requested one title (or oldid)
		// but we get a hash of pageids
		if (!Object.keys(data.query.pages).some((pageid) => {
			var page = data.query.pages[pageid];
			if (!page || !page.revisions || !page.revisions.length) {
				return false;
			}
			metadata = {
				id: page.pageid,
				// If we requested by `oldid`, the title normalization won't be
				// returned in `data.query.normalized`, so use the page property
				// uniformly.
				title: page.title,
				ns: page.ns,
				latest: page.lastrevid,
				revision: page.revisions[0],
				pagelanguage: page.pagelanguage,
				pagelanguagedir: page.pagelanguagedir,
			};
			content = Util.getStar(metadata.revision);
			if (metadata.revision.texthidden || !content || !content.hasOwnProperty('*')) {
				error = new DoesNotExistError("Source is hidden for " + this.title);
			}
			return true;
		})) {
			error = new DoesNotExistError('Did not find page revisions for ' + this.title);
		}
	}

	if (error) {
		this._processListeners(error, null);
		return;
	}

	this.trace('Retrieved ' + this.title, metadata);

	// Add the source to the cache
	// (both original title as well as possible redirected title)
	this.env.pageCache[this.queueKey] = this.env.pageCache[this.title] = content['*'];

	this._processListeners(null, metadata);
};

/**
 * Passes the source of a single preprocessor construct including its
 * parameters to action=expandtemplates.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page to use as the context.
 * @param {string} text
 * @param {string} queueKey The queue key.
 */
function PreprocessorRequest(env, title, text, queueKey) {
	ApiRequest.call(this, env, title);
	this.queueKey = queueKey;
	this.text = text;
	this.reqType = "Template Expansion";

	var apiargs = {
		format: 'json',
		formatversion: 2,
		action: 'expandtemplates',
		prop: 'wikitext|categories|properties|modules|jsconfigvars',
		text: text,
	};

	// the empty string is an invalid title
	// default value is: API
	if (title) {
		apiargs.title = title;
	}

	if (env.page.meta.revision.revid) {
		apiargs.revid = env.page.meta.revision.revid;
	}

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.preprocessor,
	};

	this.request(this.requestOptions);
}

util.inherits(PreprocessorRequest, ApiRequest);

PreprocessorRequest.prototype._handleJSON = function(error, data) {
	if (!error && !(data && data.expandtemplates)) {
		error = this._errorObj(data, this.text, 'Missing data.expandtemplates.');
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error,
			manglePreprocessorResponse(this.env, data.expandtemplates));
	}
};

/**
 * Gets the PHP parser to parse content for us.
 * Used for handling extension content right now.
 * And, probably magic words later on.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page to use as context.
 * @param {string} text
 * @param {boolean} [onlypst] Pass onlypst to PHP parser.
 * @param {string} [queueKey] The queue key.
 */
function PHPParseRequest(env, title, text, onlypst, queueKey) {
	ApiRequest.call(this, env, title);
	this.text = text;
	this.queueKey = queueKey || text;
	this.reqType = "Extension Parse";

	var apiargs = {
		format: 'json',
		formatversion: 2,
		action: 'parse',
		text: text,
		disablelimitreport: 'true',
		contentmodel: 'wikitext',
		prop: 'text|modules|jsconfigvars|categories',
		wrapoutputclass: '',
	};
	if (onlypst) {
		apiargs.onlypst = 'true';
	}

	// Pass the page title to the API
	if (title) {
		apiargs.title = title;
	}

	if (env.page.meta.revision.revid) {
		apiargs.revid = env.page.meta.revision.revid;
	}

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.extParse,
	};

	this.request(this.requestOptions);
}

util.inherits(PHPParseRequest, ApiRequest);

// Function which returns a promise for the result of a parse request.
PHPParseRequest.promise = promiseFor(PHPParseRequest);

PHPParseRequest.prototype._handleJSON = function(error, data) {
	if (!error && !(data && data.parse)) {
		error = this._errorObj(data, this.text, 'Missing data.parse.');
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error, mangleParserResponse(this.env, data.parse));
	}
};

/**
 * Do a mixed-action batch request using the ParsoidBatchAPI extension.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {Array} batchParams An array of objects.
 * @param {string} key The queue key.
 */
function BatchRequest(env, batchParams, key) {
	ApiRequest.call(this, env);
	this.queueKey = key;
	this.batchParams = batchParams;
	this.reqType = 'Batch request';

	this.batchText = JSON.stringify(batchParams);
	var apiargs = {
		format: 'json',
		formatversion: 2,
		action: 'parsoid-batch',
		batch: this.batchText,
	};

	this.requestOptions = {
		method: 'POST',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.batch,
	};

	// Use multipart form encoding to get more efficient transfer if the gain
	// will be larger than the typical overhead.
	if (encodeURIComponent(apiargs.batch).length - apiargs.batch.length > 600) {
		this.requestOptions.formData = apiargs;
	} else {
		this.requestOptions.form = apiargs;
	}

	this.request(this.requestOptions);
}

util.inherits(BatchRequest, ApiRequest);

BatchRequest.prototype._handleJSON = function(error, data) {
	if (!error && !(data && data['parsoid-batch'] && Array.isArray(data['parsoid-batch']))) {
		error = this._errorObj(data, this.batchText, 'Missing/invalid data.parsoid-batch');
	}

	if (error) {
		this.env.log("error", error);
		this.emit('batch', error, null);
		return;
	}

	var batchResponse = data['parsoid-batch'];

	// Time accounting
	if (this.traceTime) {
		this.env.bumpCount("batches");
		this.env.bumpCount("batch.requests", batchResponse.length);
		if (data['parsoid-batch-time']) {
			// convert to milliseconds
			this.env.bumpMWTime('Batch CPU', Math.round(data['parsoid-batch-time'] * 1000));
		}
	}

	var callbackData = [];
	var index, itemParams, itemResponse, mangled;
	for (index = 0; index < batchResponse.length; index++) {
		itemParams = this.batchParams[index];
		itemResponse = batchResponse[index];
		switch (itemParams.action) {
			case 'parse':
				mangled = mangleParserResponse(this.env, itemResponse);
				break;
			case 'preprocess':
				mangled = manglePreprocessorResponse(this.env, itemResponse);
				break;
			case 'imageinfo':
			case 'pageprops':
				mangled = { batchResponse: itemResponse };
				break;
			default:
				error = new Error("BatchRequest._handleJSON: Invalid action");
				this.emit('batch', error, null);
				return;
		}
		callbackData.push(mangled);

	}
	this.emit('batch', error, callbackData);
};

/**
 * A request for the wiki's configuration variables.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 */
var ConfigRequest = function(env, formatversion) {
	ApiRequest.call(this, env, null);
	this.queueKey = env.conf.wiki.apiURI;
	this.reqType = "Config Request";

	var metas = [ 'siteinfo' ];
	var siprops = [
		'namespaces',
		'namespacealiases',
		'magicwords',
		'functionhooks',
		'extensiontags',
		'general',
		'interwikimap',
		'languages',
		'languagevariants', // T153341
		'protocols',
		'specialpagealiases',
		'defaultoptions',
		'variables',
	];
	var apiargs = {
		format: 'json',
		// XXX: should use formatversion=2
		formatversion: formatversion || 1,
		action: 'query',
		meta: metas.join('|'),
		siprop: siprops.join('|'),
		rawcontinue: 1,
	};

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.configInfo,
	};

	this.request(this.requestOptions);
};

util.inherits(ConfigRequest, ApiRequest);

// Function which returns a promise for the result of a config request.
ConfigRequest.promise = promiseFor(ConfigRequest);

ConfigRequest.prototype._handleJSON = function(error, data) {
	var resultConf = null;

	if (!error) {
		if (data && data.query) {
			error = null;
			resultConf = data.query;
		} else if (data && data.error) {
			if (data.error.code === 'readapidenied') {
				error = new AccessDeniedError();
			} else {
				error = this._errorObj(data);
			}
		} else {
			error = this._errorObj(data, '',
				'No result.\n' + JSON.stringify(data, '\t', 2));
			error.suppressLoggingStack = true;
		}
	}

	this._processListeners(error, resultConf);
};

/**
 * Fetch information about an image.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} filename
 * @param {Object} [dims]
 * @param {number} [dims.width]
 * @param {number} [dims.height]
 */
function ImageInfoRequest(env, filename, dims, key) {
	ApiRequest.call(this, env, null);
	this.env = env;
	this.queueKey = key;
	this.reqType = "Image Info Request";

	var conf = env.conf.wiki;
	var filenames = [ filename ];
	var imgnsid = conf.canonicalNamespaces.image;
	var imgns = conf.namespaceNames[imgnsid];
	var props = [
		'mediatype',
		'mime',
		'size',
		'url',
		'badfile',
	];

	// If the videoinfo prop is available, as determined by our feature
	// detection when initializing the wiki config, use that to fetch the
	// derivates for videos.  videoinfo is just a wrapper for imageinfo,
	// so all our media requests should go there, and the response can be
	// disambiguated by the returned mediatype.
	var prop, prefix;
	if (conf.useVideoInfo) {
		prop = 'videoinfo';
		prefix = 'vi';
		props.push('derivatives', 'timedtext');
	} else {
		prop = 'imageinfo';
		prefix = 'ii';
	}

	this.ns = imgns;

	for (var ix = 0; ix < filenames.length; ix++) {
		filenames[ix] = imgns + ':' + filenames[ix];
	}

	var apiArgs = {
		action: 'query',
		format: 'json',
		formatversion: 2,
		prop: prop,
		titles: filenames.join('|'),
		rawcontinue: 1,
	};

	apiArgs[prefix + 'prop'] = props.join('|');
	apiArgs[prefix + 'badfilecontexttitle'] = env.page.name;

	if (dims) {
		if (dims.width !== undefined && dims.width !== null) {
			console.assert(typeof (dims.width) === 'number');
			apiArgs[prefix + 'urlwidth'] = dims.width;
			if (dims.page !== undefined) {
				// NOTE: This format is specific to PDFs.  Not sure how to
				// support this generally, though it seems common enough /
				// shared with other file types.
				apiArgs[prefix + 'urlparam'] = `page${dims.page}-${dims.width}px`;
			}
		}
		if (dims.height !== undefined && dims.height !== null) {
			console.assert(typeof (dims.height) === 'number');
			apiArgs[prefix + 'urlheight'] = dims.height;
		}
		if (dims.seek !== undefined) {
			apiArgs[prefix + 'urlparam'] = `seek=${dims.seek}`;
		}
	}

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		qs: apiArgs,
		timeout: env.conf.parsoid.timeouts.mwApi.imgInfo,
	};

	this.request(this.requestOptions);
}

util.inherits(ImageInfoRequest, ApiRequest);

ImageInfoRequest.prototype._handleJSON = function(error, data) {
	var pagenames, names, newpages, pages, pagelist, p, ix;

	if (error) {
		this._processListeners(error, { imgns: this.ns });
		return;
	}

	if (data && data.query) {
		pages = data.query.pages;
		names = data.query.normalized;
		pagenames = {};
		if (names) {
			for (ix = 0; ix < names.length; ix++) {
				pagenames[names[ix].to] = names[ix].from;
			}
		}
		if (Array.isArray(pages)) {
			// formatversion=2 returns an array for both pages and normalized
			newpages = {};
			for (ix = 0; ix < pages.length; ix++) {
				p = pages[ix];
				if (pagenames[p.title]) {
					newpages[pagenames[p.title]] = p;
				}
				newpages[p.title] = p;
			}
		} else {
			// The formatversion=1 API (and old ParsoidBatchAPI) indexes its
			// data.query.pages response by page ID. That's inconvenient.
			newpages = {};
			pagelist = Object.keys(pages);

			for (ix = 0; ix < pagelist.length; ix++) {
				p = pages[pagelist[ix]];
				if (pagenames[p.title]) {
					newpages[pagenames[p.title]] = p;
				}
				newpages[p.title] = p;
			}
		}

		data.query.pages = newpages;
		data.query.imgns = this.ns;
		this._processListeners(null, data.query);
	} else if (data && data.error) {
		if (data.error.code === 'readapidenied') {
			error = new AccessDeniedError();
		} else {
			error = this._errorObj(data);
		}
		this._processListeners(error, {});
	} else {
		this._processListeners(null, {});
	}
};

/**
 * Fetch TemplateData info for a template.
 * This is used by the html -> wt serialization path.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} template
 * @param {string} [queueKey] The queue key.
 */
function TemplateDataRequest(env, template, queueKey) {
	ApiRequest.call(this, env, null);
	this.env = env;
	this.text = template;
	this.queueKey = queueKey;
	this.reqType = "TemplateData Request";

	var apiargs = {
		format: 'json',
		// XXX: should use formatversion=2
		action: 'templatedata',
		includeMissingTitles: '1',
		titles: template,
		redirects: '1',
	};

	this.requestOptions = {
		// Use GET so this request can be cached in Varnish
		method: 'GET',
		qs: apiargs,
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.templateData,
	};

	this.request(this.requestOptions);
}

util.inherits(TemplateDataRequest, ApiRequest);

// Function which returns a promise for the result of a templatedata request.
TemplateDataRequest.promise = promiseFor(TemplateDataRequest);

TemplateDataRequest.prototype._handleJSON = function(error, data) {
	if (!error && !(data && data.pages)) {
		error = this._errorObj(data, this.text, 'Missing data.pages.');
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error, data.pages);
	}
};

/**
 * Record lint information.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} data
 * @param {string} [queueKey] The queue key.
 */
function LintRequest(env, data, queueKey) {
	ApiRequest.call(this, env, null);
	this.queueKey = queueKey || data;
	this.reqType = 'Lint Request';

	var apiargs = {
		data: data,
		page: env.page.name,
		revision: env.page.meta.revision.revid,
		action: 'record-lint',
		format: 'json',
		formatversion: 2,
	};

	this.requestOptions = {
		method: 'POST',
		form: apiargs,
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.lint,
	};

	this.request(this.requestOptions);
}

util.inherits(LintRequest, ApiRequest);

// Function which returns a promise for the result of a lint request.
LintRequest.promise = promiseFor(LintRequest);

LintRequest.prototype._handleJSON = function(error, data) {
	this._processListeners(error, data);
};

/**
 * Obtain information about MediaWiki API modules.
 *
 * @class
 * @extends ~ApiRequest
 * @param {MWParserEnvironment} env
 * @param {string} [queueKey] The queue key.
 */
function ParamInfoRequest(env, queueKey) {
	ApiRequest.call(this, env, null);
	this.reqType = 'ParamInfo Request';

	var apiargs = {
		format: 'json',
		// XXX: should use formatversion=2
		action: 'paraminfo',
		modules: 'query',
		rawcontinue: 1,
	};

	this.queueKey = queueKey || JSON.stringify(apiargs);

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.paramInfo,
	};

	this.request(this.requestOptions);
}

util.inherits(ParamInfoRequest, ApiRequest);

// Function which returns a promise for the result of a paraminfo request.
ParamInfoRequest.promise = promiseFor(ParamInfoRequest);

ParamInfoRequest.prototype._handleJSON = function(error, data) {
	var query = data && data.paraminfo && data.paraminfo.modules &&
			data.paraminfo.modules[0];
	this._processListeners(error, query || {});
};


if (typeof module === "object") {
	module.exports.ApiRequest = ApiRequest;
	module.exports.ConfigRequest = ConfigRequest;
	module.exports.TemplateRequest = TemplateRequest;
	module.exports.PreprocessorRequest = PreprocessorRequest;
	module.exports.PHPParseRequest = PHPParseRequest;
	module.exports.BatchRequest = BatchRequest;
	module.exports.ImageInfoRequest = ImageInfoRequest;
	module.exports.TemplateDataRequest = TemplateDataRequest;
	module.exports.LintRequest = LintRequest;
	module.exports.ParamInfoRequest = ParamInfoRequest;
	module.exports.DoesNotExistError = DoesNotExistError;
	module.exports.ParserError = ParserError;
}
