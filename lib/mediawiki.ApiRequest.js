'use strict';
require('./core-upgrade.js');

// Max concurrency level for accessing the Mediawiki API
var HTTP_MAX_SOCKETS = 15;
// Timeout setting for the http agent
var HTTP_CONNECT_TIMEOUT = 5 * 1000; // 5 seconds

// many concurrent connections to the same host
var Agent = require('./_http_agent.js').Agent;
var httpAgent = new Agent({
	connectTimeout: HTTP_CONNECT_TIMEOUT,
	maxSockets: HTTP_MAX_SOCKETS,
});
require('http').globalAgent = httpAgent;

var request = require('request');
var events = require('events');
var util = require('util');
var domino = require('domino');

// all revision properties which parsoid is interested in.
var PARSOID_RVPROP = ('content|ids|timestamp|user|userid|size|sha1|contentmodel|comment');

var logAPIWarnings = function(request, data) {
	if (request.env.conf.parsoid.logMwApiWarnings &&
			data && data.hasOwnProperty('warnings')) {
		// split up warnings by API module
		Object.keys(data.warnings).forEach(function(apiModule) {
			var re = request.env.conf.parsoid.suppressMwApiWarnings;
			var msg = data.warnings[apiModule]['*'];
			if (re instanceof RegExp && re.test(msg)) {
				return; // suppress this message
			}
			request.env.log('warning/api/' + apiModule, request.reqType, msg);
		});
	}
};

// Helper to return a promise returning function for the result of an
// (Ctor-type) ApiRequest.
var promiseFor = function(Ctor) {
	return function() {
		var args = Array.prototype.slice.call(arguments);
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

var setPageProperty = function(env, src, property) {
	if (src && env.page) {
		// This info comes back from the MW API when extension tags are parsed.
		// Since a page can have multiple extension tags, we can hit this code
		// multiple times and run into an already initialized set.
		if (!env.page[property]) {
			env.page[property] = new Set();
		}
		for (var i in src) {
			env.page[property].add(src[i]);
		}
	}
};

var manglePreprocessorResponse = function(env, response) {
	var src = '';
	if (response.wikitext !== undefined) {
		src = response.wikitext;
	} else if (response["*"] !== undefined) {
		// For backwards compatibility. Older wikis still put the data here.
		src = response["*"];
	}

	// Add the categories which were added by parser functions directly
	// into the page and not as in-text links.
	if (Array.isArray(response.categories)) {
		for (var i in response.categories) {
			var category = response.categories[i];
			src += '\n[[Category:' + category['*'];
			if (category.sortkey) {
				src += "|" + category.sortkey;
			}
			src += ']]';
		}
	}
	// Ditto for page properties (like DISPLAYTITLE and DEFAULTSORT)
	if (Array.isArray(response.properties)) {
		response.properties.forEach(function(prop) {
			if (prop.name === 'displaytitle' || prop.name === 'defaultsort') {
				src += '\n{{' + prop.name.toUpperCase() + ':' + prop['*'] + '}}';
			}
		});
	}
	// The same for ResourceLoader modules
	setPageProperty(env, response.modules, "extensionModules");
	setPageProperty(env, response.modulescripts, "extensionModuleScripts");
	setPageProperty(env, response.modulestyles, "extensionModuleStyles");

	return src;
};

var dummyDoc = domino.createDocument();
var mangleParserResponse = function(env, response) {
	var parsedHtml = '';
	if (response.text['*'] !== undefined) {
		parsedHtml = response.text['*'];
	}

	// Strip two trailing newlines that action=parse adds after any
	// extension output
	parsedHtml = parsedHtml.replace(/\n\n$/, '');

	// Also strip a paragraph wrapper, if any
	parsedHtml = parsedHtml.replace(/(^<p>)|(<\/p>$)/g, '');

	// Add the modules to the page data
	setPageProperty(env, response.modules, "extensionModules");
	setPageProperty(env, response.modulescripts, "extensionModuleScripts");
	setPageProperty(env, response.modulestyles, "extensionModuleStyles");

	// Add the categories which were added by extensions directly into the
	// page and not as in-text links
	if (response.categories) {
		for (var i in response.categories) {
			var category = response.categories[i];

			var link = dummyDoc.createElement("link");
			link.setAttribute("rel", "mw:PageProp/Category");

			var href = env.page.relativeLinkPrefix + "Category:" + encodeURIComponent(category['*']);
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
function DoesNotExistError(message) {
	Error.captureStackTrace(this, DoesNotExistError);
	this.name = "DoesNotExistError";
	this.message = message || "Something doesn't exist";
	this.code = 404;
	this.stack = null;  // suppress stack
}
DoesNotExistError.prototype = Error.prototype;

/**
 * @class
 * @extends Error
 */
function ParserError(message) {
	Error.captureStackTrace(this, ParserError);
	this.name = "ParserError";
	this.message = message || "Generic parser error";
	this.code = 500;
}
ParserError.prototype = Error.prototype;

/**
 * @class
 * @extends Error
 */
function AccessDeniedError(message) {
	Error.captureStackTrace(this, AccessDeniedError);
	this.name = 'AccessDeniedError';
	this.message = message || 'Your wiki requires a logged-in account to access the API.';
	this.code = 401;
}
AccessDeniedError.prototype = Error.prototype;

/**
 *
 * Abstract API request base class
 *
 * @class
 * @extends EventEmitter
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page we should fetch from the API
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
	this.reqType = "Page Fetch";

	// Proxy to the MW API. Set to null for subclasses going somewhere else.
	// ie. ParsoidCacheRequest
	this.proxy = env.conf.wiki.apiProxy;
}

// Inherit from EventEmitter
util.inherits(ApiRequest, events.EventEmitter);

ApiRequest.prototype.request = function(options, callback) {
	var env = this.env;
	var proxy = this.proxy;
	// this is a good place to put debugging statements
	// if you want to watch network requests.
	//  console.log('ApiRequest', options);

	// Forward the request id
	if (!options.headers) { options.headers = {}; }
	options.headers['X-Request-ID'] = env.reqId;
	// Set default options, forward cookie if set.
	options.headers['User-Agent'] = env.conf.parsoid.userAgent;
	options.headers.Connection = 'close';
	options.strictSSL = env.conf.parsoid.strictSSL;
	if (env.cookie) {
		options.headers.Cookie = env.cookie;
	}
	// Proxy options should only be applied to MW API endpoints.
	// Allow subclasses (ie, ParsoidCacheRequest) to manually set proxy
	// to `null` or to a different proxy to override MW API proxy.
	if (proxy && options.proxy === undefined) {
		options.proxy = proxy.uri;
		if (proxy.headers) {
			Object.assign(options.headers, proxy.headers);
		}
		if (proxy.strip_https && options.proxy && /^https[:]/.test(options.uri)) {
			// When proxying, strip TLS and lie to the appserver to indicate
			// unwrapping has just occurred. The appserver isn't listening on
			// port 443 but a site setting may require a secure connection,
			// which the header identifies.  (This is primarily for proxies
			// used in WMF production, for which initMwApiMap sets the
			// proxy.strip_https flag.)
			options.uri = options.uri.replace(/^https/, 'http');
			options.headers['X-Forwarded-Proto'] = 'https';
		}
	}
	this.env.dp("Starting HTTP request", this.toString());

	return request(options, callback);
};

/**
 * @method
 * @private
 * @param {Error|null} error
 * @param {string} data wikitext / html / metadata
 */
ApiRequest.prototype._processListeners = function(error, data) {
	// Process only a few callbacks in each event loop iteration to
	// reduce memory usage.
	var self = this;
	var processSome = function() {
		// listeners() returns a copy (slice) of the listeners array in
		// 0.10. Get a new copy including new additions before processing
		// each batch.
		var listeners = self.listeners('src');
		// XXX: experiment a bit with the number of callbacks per
		// iteration!
		var maxIters = Math.min(1, listeners.length);
		for (var it = 0; it < maxIters; it++) {
			var nextListener = listeners.shift();

			// We only retrieve text/x-mediawiki source currently.
			// We expect these listeners to remove themselves when being
			// called - always add them with once().
			try {
				nextListener.call(self, error || null, data, 'text/x-mediawiki');
			} catch (e) {
				return self.env.log('fatal', e);
			}
		}
		if (listeners.length) {
			setImmediate(processSome);
		}
	};
	setImmediate(processSome);
};

/**
 * @method
 * @private
 * @param {Error|null} error
 * @param {Object} response The API response object, with error code
 * @param {string} body The body of the response from the API
 */
ApiRequest.prototype._requestCB = function(error, response, body) {
	var self = this;

	if (error) {
		this.env.log('warning/api' + (error.code ? ("/" + error.code).toLowerCase() : ''),
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
			this.request(this.requestOptions, this._requestCB.bind(this));
			return;
		} else {
			var dnee = new Error(this.reqType + ' failure for '
					+ JSON.stringify(this.queueKey.substr(0, 80)) + ': ' + error);
			this._handleBody(dnee, '{}');
		}
	} else if (response.statusCode === 200) {
		this._handleBody(null, body);
	} else {
		if (response.statusCode === 412) {
			this.env.log("info", "Cache MISS:", response.request.href);
		} else {
			this.env.log("warning", "non-200 response:", response.statusCode, body);
		}
		error = new Error(this.reqType + ' failure for '
					+ JSON.stringify(this.queueKey.substr(0, 80)) + ': ' + response.statusCode);
		this._handleBody(error, '{}');
	}

	// XXX: handle other status codes

	// Remove self from request queue
	delete this.env.requestQueue[this.queueKey];
};

/**
 * Default body handler: parse to JSON and call _handleJSON.
 *
 * @method
 * @private
 * @param {Error|null} error
 * @param {string} body The body of the response from the API
 */
ApiRequest.prototype._handleBody = function(error, body) {
	if (error) {
		this._handleJSON(error, {});
		return;
	}
	var data;
	try {
		// Strip the UTF8 BOM since it knowingly breaks parsing.
		if (body[0] === '\uFEFF') {
			this.env.log('warning', 'Stripping a UTF8 BOM. Your webserver is' +
				' likely broken.');
			body = body.slice(1);
		}
		data = JSON.parse(body);
	} catch (e) {
		error = new ParserError('Failed to parse the JSON response for ' +
				this.reqType);
	}
	this._handleJSON(error, data);
};

/**
 * @class
 * @extends ApiRequest
 *
 * Template fetch request helper class
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The template (or really, page) we should fetch from the wiki
 * @param {string} oldid The revision ID you want to get, defaults to "latest revision"
 */
function TemplateRequest(env, title, oldid) {
	ApiRequest.call(this, env, title);

	this.queueKey = title;
	this.reqType = "Template Fetch";

	var apiargs = {
		format: 'json',
		action: 'query',
		prop: 'revisions',
		rawcontinue: 1,
		rvprop: PARSOID_RVPROP,
	};

	if (oldid) {
		this.oldid = oldid;
		apiargs.revids = oldid;
	} else {
		apiargs.titles = title;
	}

	var uri = env.conf.wiki.apiURI;

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.srcFetch,
	};

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}

// Inherit from ApiRequest
util.inherits(TemplateRequest, ApiRequest);

/**
 * @method _handleJSON
 * @template
 * @private
 * @param {Error} error
 * @param {Object} data The response from the server - parsed JSON object
 */
TemplateRequest.prototype._handleJSON = function(error, data) {
	var regex, title, location, iwstr, interwiki;
	var metadata = { title: this.title };

	logAPIWarnings(this, data);

	if (!error && !data.query) {
		error = new Error("API response is missing query for: " + this.title);
	}

	if (error) {
		this._processListeners(error, null);
		return;
	}

	if (data.query.normalized && data.query.normalized.length) {
		// update title (ie, "foo_Bar" -> "Foo Bar")
		metadata.title = data.query.normalized[0].to;
	}

	if (!data.query.pages) {
		if (data.query.interwiki) {
			// Essentially redirect, but don't actually redirect.
			interwiki = data.query.interwiki[0];
			title = interwiki.title;
			regex = new RegExp('^' + interwiki.iw + ':');
			title = title.replace(regex, '');
			iwstr = this.env.conf.wiki.interwikiMap.get(interwiki.iw).url ||
				this.env.conf.parsoid.mwApiMap.get(interwiki.iw).uri ||
				'/' + interwiki.iw + '/' + '$1';
			location = iwstr.replace('$1', title);
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
		var self = this;
		if (!Object.keys(data.query.pages).some(function(pageid) {
			var page = data.query.pages[pageid];
			if (!page || !page.revisions || !page.revisions.length) {
				return false;
			}
			metadata.id = page.pageid;
			metadata.ns = page.ns;
			metadata.revision = page.revisions[0];

			if (metadata.revision.texthidden || !metadata.revision.hasOwnProperty("*")) {
				error = new DoesNotExistError("Source is hidden for " + self.title);
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

	this.env.tp('Retrieved ' + this.title, metadata);

	// Add the source to the cache
	// (both original title as well as possible redirected title)
	this.env.pageCache[this.queueKey] = this.env.pageCache[this.title] = metadata.revision['*'];

	this._processListeners(null, metadata);
};

// Function which returns a promise for the result of a template request.
TemplateRequest.promise = promiseFor(TemplateRequest);

// Function which returns a promise to set page src info.
TemplateRequest.setPageSrcInfo = function(env, target, oldid) {
	return TemplateRequest.promise(env, target, oldid).then(function(src) {
		env.setPageSrcInfo(src);
	});
};

/**
 * @class
 * @extends ApiRequest
 *
 * Passes the source of a single preprocessor construct including its
 * parameters to action=expandtemplates
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page to use as the context
 * @param {string} text
 * @param {string} hash The queue key
 */
function PreprocessorRequest(env, title, text, hash) {
	ApiRequest.call(this, env, title);

	this.queueKey = hash;
	this.text = text;
	this.reqType = "Template Expansion";

	var apiargs = {
		format: 'json',
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

	var uri = env.conf.wiki.apiURI;

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: uri,
		timeout: env.conf.parsoid.timeouts.mwApi.preprocessor,
	};

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}


// Inherit from ApiRequest
util.inherits(PreprocessorRequest, ApiRequest);

PreprocessorRequest.prototype._handleJSON = function(error, data) {
	logAPIWarnings(this, data);

	if (!error && !(data && data.expandtemplates)) {
		error = new Error(util.format('Expanding template for %s: %s',
			this.title, this.text));
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
 * @class
 * @extends ApiRequest
 *
 * Gets the PHP parser to parse content for us.
 * Used for handling extension content right now.
 * And, probably magic words later on.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} name The title of the page to use as context
 * @param {string} text
 * @param {boolean} [onlypst] Pass onlypst to PHP parser
 * @param {string} [hash] The queue key
 */
function PHPParseRequest(env, name, text, onlypst, hash) {
	ApiRequest.call(this, env, name);

	this.text = text;
	this.queueKey = hash || text;
	this.reqType = "Extension Parse";

	var apiargs = {
		format: 'json',
		action: 'parse',
		text: text,
		disablepp: 'true',
		contentmodel: 'wikitext',
		prop: 'text|modules|jsconfigvars|categories',
	};
	if (onlypst) {
		apiargs.onlypst = 'true';
	}

	var uri = env.conf.wiki.apiURI;
	var proxy = env.conf.wiki.apiProxy;

	// Pass the page title to the API
	var title = env.page && env.page.title && env.page.title.key;
	if (title) {
		apiargs.title = title;
	}

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: uri,
		timeout: env.conf.parsoid.timeouts.mwApi.extParse,
	};

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}

// Inherit from ApiRequest
util.inherits(PHPParseRequest, ApiRequest);

// Function which returns a promise for the result of a parse request.
PHPParseRequest.promise = promiseFor(PHPParseRequest);

PHPParseRequest.prototype._handleJSON = function(error, data) {
	logAPIWarnings(this, data);

	if (!error && !(data && data.parse)) {
		error = new Error(util.format('Parsing extension for %s: %s',
			this.title, this.text));
	}

	if (error) {
		this.env.log("error", error);
		this._processListeners(error, '');
	} else {
		this._processListeners(error, mangleParserResponse(this.env, data.parse));
	}
};

/**
 * @class
 * @extends ApiRequest
 *
 * Do a mixed-action batch request using the ParsoidBatchAPI extension.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {Array} batchParams An array of objects
 * @param {string} key The queue key
 */
function BatchRequest(env, batchParams, key) {
	ApiRequest.call(this, env);
	this.queueKey = key;
	this.batchParams = batchParams;
	this.reqType = 'Batch request';

	var apiargs = {
		format: 'json',
		formatversion: '2',
		action: 'parsoid-batch',
		batch: JSON.stringify(batchParams),
	};

	this.requestOptions = {
		method: 'POST',
		followRedirect: true,
		uri: env.conf.wiki.apiURI,
		timeout: env.conf.parsoid.timeouts.mwApi.batch,
	};
	var req = this.request(this.requestOptions, this._requestCB.bind(this));

	// Use multipart form encoding to get more efficient transfer if the gain
	// will be larger than the typical overhead. In later versions of the request
	// library, this can easily be done with the formData option, but coveralls
	// depends on request 2.40.0.
	if (encodeURIComponent(apiargs.batch).length - apiargs.batch.length > 600) {
		var form = req.form();
		for (var optName in apiargs) {
			form.append(optName, apiargs[optName]);
		}
	} else {
		req.form(apiargs);
	}
}

util.inherits(BatchRequest, ApiRequest);

BatchRequest.prototype._handleJSON = function(error, data) {
	if (!error && !(data && data['parsoid-batch'] && Array.isArray(data['parsoid-batch']))) {
		error = new Error('Invalid result when expanding template batch');
	}

	if (error) {
		this.env.log("error", error);
		this.emit('batch', error, null);
		return;
	}

	var batchResponse = data['parsoid-batch'];
	var callbackData = [];
	var index, itemParams, itemResponse, j, mangled;
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
				mangled = {batchResponse: itemResponse};
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
 * @class
 * @extends ApiRequest
 *
 * Requests a cached parsed page from a Parsoid cache, but try to avoid
 * triggering re-parsing.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} title The title of the page to use as context
 * @param {oldid} oldid The oldid to request
 */
function ParsoidCacheRequest(env, title, oldid, options) {
	ApiRequest.call(this, env, title);

	if (!options) {
		options = {};
	}

	this.oldid = oldid;
	this.queueKey = title + '?oldid=' + oldid;
	this.reqType = "Parsoid cache request";

	// Don't use MW API proxy.
	this.proxy = null;

	var apiargs = {
		oldid: oldid,
	};

	var uri = env.conf.parsoid.parsoidCacheURI +
		env.conf.wiki.iwp + '/' + encodeURIComponent(title.replace(/ /g, '_'));

	this.retries = env.conf.parsoid.retries.parsoidCacheReq;
	this.requestOptions = {
		// Use GET so that our request is cacheable
		method: 'GET',
		followRedirect: false,
		uri: uri,
		qs: apiargs,
		headers: {
			'x-parsoid-request': 'cache',
		},
	};

	var timeouts = env.conf.parsoid.timeouts;
	if (options.evenIfNotCached) {
		this.requestOptions.timeout = timeouts.parsoidCacheReq + timeouts.parsoidCacheReparse;
	} else {
		// Request a reply only from cache.
		this.requestOptions.timeout = timeouts.parsoidCacheReq;
		this.requestOptions.headers['Cache-control'] = 'only-if-cached';
	}

	// Start the request
	this.request(this.requestOptions, this._requestCB.bind(this));
}

// Inherit from ApiRequest
util.inherits(ParsoidCacheRequest, ApiRequest);

/**
 * Handle the HTML body
 */
ParsoidCacheRequest.prototype._handleBody = function(error, body) {
	if (error) {
		this._processListeners(error, '');
		return;
	}
	this._processListeners(error, body);
};

// Function which returns a promise for the result of a cache request.
ParsoidCacheRequest.promise = promiseFor(ParsoidCacheRequest);

/**
 * @class
 * @extends ApiRequest
 *
 * A request for the wiki's configuration variables.
 *
 * @constructor
 * @param {string} uri The API URI to use for fetching
 * @param {MWParserEnvironment} env
 * @param {string} proxy (optional) The proxy to use for the ConfigRequest.
 */
var ConfigRequest = function(uri, env, proxy) {
	ApiRequest.call(this, env, null);
	this.queueKey = uri;
	this.reqType = "Config Request";

	// Use the passed in proxy to the mw api. The default proxy set in
	// the ApiRequest constructor might not be the right one.
	this.proxy = proxy;

	if (!uri) {
		this.retries = env.conf.parsoid.retries.mwApi.configInfo;
		this._requestCB(new Error('There was no base URI for the API we tried to use.'));
		return;
	}

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
		'protocols',
		'specialpagealiases',
	];
	var apiargs = {
		format: 'json',
		action: 'query',
		meta: metas.join('|'),
		siprop: siprops.join('|'),
		rawcontinue: 1,
	};

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		qs: apiargs,
		timeout: env.conf.parsoid.timeouts.mwApi.configInfo,
	};

	this.request(this.requestOptions, this._requestCB.bind(this));
};

util.inherits(ConfigRequest, ApiRequest);

ConfigRequest.prototype._handleJSON = function(error, data) {
	var resultConf = null;

	logAPIWarnings(this, data);

	if (!error) {
		if (data && data.query) {
			error = null;
			resultConf = data.query;
		} else if (data && data.error) {
			if (data.error.code === 'readapidenied') {
				error = new AccessDeniedError();
			} else {
				error = new Error('Something happened on the API side. Message: ' +
					data.error.code + ': ' + data.error.info);
			}
		} else {
			error = new Error("Config request returned no result.\n" +
				JSON.stringify(data, "\t", 2));
			error.stack = null;
		}
	}

	this._processListeners(error, resultConf);
};

// Function which returns a promise for the result of a config request.
ConfigRequest.promise = promiseFor(ConfigRequest);

/**
 * @class
 * @extends ApiRequest
 * @constructor
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
	var uri = conf.apiURI;
	var filenames = [ filename ];
	var imgnsid = conf.canonicalNamespaces.image;
	var imgns = conf.namespaceNames[imgnsid];
	var props = [
		'mediatype',
		'size',
		'url',
	];

	this.ns = imgns;

	for (var ix = 0; ix < filenames.length; ix++) {
		filenames[ix] = imgns + ':' + filenames[ix];
	}

	var apiArgs = {
		action: 'query',
		format: 'json',
		prop: 'imageinfo',
		titles: filenames.join('|'),
		iiprop: props.join('|'),
		rawcontinue: 1,
	};

	if (dims) {
		if (dims.width) {
			apiArgs.iiurlwidth = dims.width;
		}
		if (dims.height) {
			apiArgs.iiurlheight = dims.height;
		}
	}

	var proxy = env.conf.wiki.apiProxy;

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		qs: apiArgs,
		timeout: env.conf.parsoid.timeouts.mwApi.imgInfo,
	};

	this.request(this.requestOptions, this._requestCB.bind(this));
}

util.inherits(ImageInfoRequest, ApiRequest);

ImageInfoRequest.prototype._handleJSON = function(error, data) {
	var pagenames, names, namelist, newpages, pages, pagelist, ix;

	logAPIWarnings(this, data);

	if (error) {
		this._processListeners(error, { imgns: this.ns });
		return;
	}

	if (data && data.query) {
		// The API indexes its response by page ID. That's inconvenient.
		newpages = {};
		pagenames = {};
		pages = data.query.pages;
		names = data.query.normalized;
		pagelist = Object.keys(pages);

		if (names) {
			for (ix = 0; ix < names.length; ix++) {
				pagenames[names[ix].to] = names[ix].from;
			}
		}

		for (ix = 0; ix < pagelist.length; ix++) {
			if (pagenames[pages[pagelist[ix]].title]) {
				newpages[pagenames[pages[pagelist[ix]].title]] = pages[pagelist[ix]];
			}
			newpages[pages[pagelist[ix]].title] = pages[pagelist[ix]];
		}

		data.query.pages = newpages;
		data.query.imgns = this.ns;
		this._processListeners(null, data.query);
	} else if (data && data.error) {
		if (data.error.code === 'readapidenied') {
			error = new AccessDeniedError();
		} else {
			error = new Error('Something happened on the API side. Message: ' + data.error.code + ': ' + data.error.info);
		}
		this._processListeners(error, {});
	} else {
		this._processListeners(null, {});
	}
};

if (typeof module === "object") {
	module.exports.ConfigRequest = ConfigRequest;
	module.exports.TemplateRequest = TemplateRequest;
	module.exports.PreprocessorRequest = PreprocessorRequest;
	module.exports.PHPParseRequest = PHPParseRequest;
	module.exports.BatchRequest = BatchRequest;
	module.exports.ParsoidCacheRequest = ParsoidCacheRequest;
	module.exports.ImageInfoRequest = ImageInfoRequest;
	module.exports.DoesNotExistError = DoesNotExistError;
	module.exports.ParserError = ParserError;
}
