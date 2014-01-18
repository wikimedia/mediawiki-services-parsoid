"use strict";

require('./core-upgrade.js');

// many concurrent connections to the same host
require('http').globalAgent.maxSockets = 15;

var request = require('request'),
	qs = require('querystring'),
	events = require('events'),
	util = require('util');

// all revision properties which parsoid is interested in.
var PARSOID_RVPROP = ('content|ids|timestamp|user|userid|size|sha1|'+
					  'contentmodel|comment');

//var userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:9.0.1) ' +
//							'Gecko/20100101 Firefox/9.0.1 Parsoid/0.1';
var userAgent = 'Parsoid/0.1';

/**
 * @class
 * @extends Error
 */
function DoesNotExistError( message ) {
    this.name = "DoesNotExistError";
    this.message = message || "Something doesn't exist";
    this.code = 404;
}
DoesNotExistError.prototype = Error.prototype;

/**
 * @class
 * @extends Error
 */
function ParserError( message ) {
    this.name = "ParserError";
    this.message = message || "Generic parser error";
    this.code = 500;
}
ParserError.prototype = Error.prototype;

/**
 * @class
 * @extends Error
 */
function AccessDeniedError( message ) {
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
function ApiRequest ( env, title ) {
	// call the EventEmitter constructor
	events.EventEmitter.call(this);

	// Increase the number of maximum listeners a bit..
	this.setMaxListeners( 50000 );
	this.retries = 5;
	this.env = env;
	this.title = title;
	this.reqType = "Page Fetch";
}

// Inherit from EventEmitter
util.inherits(ApiRequest, events.EventEmitter);

ApiRequest.prototype.request = function( options, callback ) {
	// this is a good place to put debugging statements
	// if you want to watch network requests.
	//console.log('ApiRequest', options);
	return request( options, callback );
};

/**
 * @method
 * @private
 * @param {Error/null} error
 * @param {string} src The wikitext source of the page
 */
ApiRequest.prototype._processListeners = function ( error, src ) {
	// Process only a few callbacks in each event loop iteration to
	// reduce memory usage.
	var self = this;

	var processSome = function () {
			// listeners() returns a copy (slice) of the listeners array in
			// 0.10. Get a new copy including new additions before processing
			// each batch.
		var listeners = self.listeners( 'src' ),
			// XXX: experiment a bit with the number of callbacks per
			// iteration!
			maxIters = Math.min(1, listeners.length);
		for ( var it = 0; it < maxIters; it++ ) {
			var nextListener = listeners.shift();

			// We only retrieve text/x-mediawiki source currently.
			// We expect these listeners to remove themselves when being
			// called- always add them with once().
			nextListener.call( self, error || null, src, 'text/x-mediawiki' );
		}
		if ( listeners.length ) {
			setImmediate( processSome );
		}

	};

	setImmediate( processSome );
};

/**
 * @method
 * @private
 * @param {Error/null} error
 * @param {Object} response The API response object, with error code
 * @param {string} body The body of the response from the API
 */
ApiRequest.prototype._requestCB = function (error, response, body) {
	//console.warn( 'response for ' + title + ' :' + body + ':' );
	var self = this;

	if (error) {
		this.env.tp('WARNING: RETRY:', error, this.queueKey);
		if ( this.retries ) {
			this.retries--;
			this.env.tp( 'Retrying ' + this.reqType + ' request for ' + this.title + ', ' +
					this.retries + ' remaining' );
			// retry
			this.request( this.requestOptions, this._requestCB.bind(this) );
			return;
		} else {
			var dnee = new DoesNotExistError( this.reqType + ' failure for ' + this.title + ' : ' + error );
			//this.emit('src', dnee, dnee.toString(), 'text/x-mediawiki');
			this._handleBody( dnee, '{}' );
		}
	} else if (response.statusCode === 200) {
		this._handleBody( null, body );
	} else {
		if (response.statusCode === 412) {
			this.env.log("warning","Cache MISS:", this.uri);
		} else {
			this.env.log("warning", "non-200 response:", response.statusCode);
			console.log( body );
		}
		error = new DoesNotExistError( this.reqType + ' failure for ' + this.title);
		this._handleBody( error, '{}' );
	}

	// XXX: handle other status codes

	// Remove self from request queue
	//this.env.dp( 'trying to remove ', this.title, ' from requestQueue' );

	delete this.env.requestQueue[this.queueKey];
	//this.env.dp( 'after deletion:', this.env.requestQueue );
};

/**
 * Default body handler: parse to JSON and call _handleJSON.
 *
 * @method
 * @private
 * @param {Error/null} error
 * @param {Object} response The API response object, with error code
 * @param {string} body The body of the response from the API
 */
ApiRequest.prototype._handleBody = function (error, body) {
	if ( error ) {
		this._handleJSON( error, {} );
		return;
	}
	var data;
	try {
		//console.warn( 'body: ' + body );
		data = JSON.parse( body );
	} catch(e) {
		error = new ParserError( 'Failed to parse the JSON response for ' +
				this.reqType + " " + this.title );
	}
	this._handleJSON( error, data );
};


/**
 * @method _handleJSON
 * @template
 * @private
 * @param {Error} error
 * @param {Object} data The response from the server - parsed JSON object
 */

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
function TemplateRequest ( env, title, oldid ) {
	// Construct ApiRequest;
	ApiRequest.call(this, env, title);

	this.queueKey = title;
	this.reqType = "Template Fetch";

	var apiargs = {
		format: 'json',
		action: 'query',
		prop: 'revisions',
		rvprop: PARSOID_RVPROP,
		titles: title
	};
	if ( oldid ) {
		this.oldid = oldid;
		apiargs.revids = oldid;
		delete apiargs.titles;
	}
	var uri = env.conf.wiki.apiURI + '?' +
		qs.stringify( apiargs );
		//'?format=json&action=query&prop=revisions&rvprop=content&titles=' + title;

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		timeout: 40 * 1000, // 40 seconds
		proxy: env.conf.wiki.apiProxyURI,
		headers: {
			'User-Agent': userAgent,
			'Connection': 'close'
		}
	};
	if (env.cookie) {
		// Forward the cookie if set
		this.requestOptions.headers.Cookie = env.cookie;
	}

	// Start the request
	this.request( this.requestOptions, this._requestCB.bind(this) );
}

// Inherit from ApiRequest
util.inherits(TemplateRequest, ApiRequest);

/**
 * @inheritdoc ApiRequest#_handleJSON
 */
TemplateRequest.prototype._handleJSON = function ( error, data ) {
	var regex, title, err, location, iwstr, interwiki, src = '',
		self = this;
	var metadata = { title: self.title };

	if ( !error && !data.query ) {
		error = new Error( "API response is missing query for: " + this.title );
	}

	if ( error ) {
		this._processListeners( error, null );
		return;
	}

	if ( data.query.normalized && data.query.normalized.length ) {
		// update title (ie, "foo_Bar" -> "Foo Bar")
		metadata.title = data.query.normalized[0].to;
	}
	if ( !data.query.pages ) {
		if ( data.query.interwiki ) {
			// Essentially redirect, but don't actually redirect.
			interwiki = data.query.interwiki[0];
			title = interwiki.title;
			regex = new RegExp( '^' + interwiki.iw + ':' );
			title = title.replace( regex, '' );
			iwstr = this.env.conf.wiki.interwikiMap[interwiki.iw].url ||
				this.env.conf.parsoid.interwikiMap[interwiki.iw].url || '/' + interwiki.iw + '/' + '$1';
			location = iwstr.replace( '$1', title );
			err = new DoesNotExistError( 'The page at ' +
					self.title +
					' can be found at a different location: ' +
					location );
			this._processListeners( err, null );
			return;
		}
		console.log( data );
		error = new DoesNotExistError(
			'No pages were returned from the API request for ' +
			self.title
		);
	} else {
		try {
			Object.keys(data.query.pages).forEach(function(pageid) {
				var page = data.query.pages[pageid];
				if (page.revisions && page.revisions.length) {
					metadata.id = page.pageid;
					metadata.ns = page.ns;
					metadata.revision = page.revisions[0];
					src = metadata.revision['*']; // for redirect handling & cache
				} else {
					throw new DoesNotExistError( 'Did not find page revisions for ' + self.title );
				}
			});
		} catch ( e2 ) {
			if ( e2 instanceof DoesNotExistError ) {
				error = e2;
			} else {
				error = new DoesNotExistError(
						'Did not find page revisions in the returned body for ' +
						self.title );
			}
		}
	}

	//console.warn( 'Page ' + this.title + ': got ' + JSON.stringify(metadata) );
	this.env.tp( 'Retrieved ' + this.title, metadata );

	// Add the source to the cache
	// (both original title as well as possible redirected title)
	this.env.pageCache[this.queueKey] = this.env.pageCache[this.title] = src;

	this._processListeners( error, error ? null : metadata );
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
 */
function PreprocessorRequest ( env, title, text ) {
	ApiRequest.call(this, env, title);

	this.queueKey = text;

	// Temporary debugging hack for
	// https://bugzilla.wikimedia.org/show_bug.cgi?id=49411
	// Double-check the returned content language
	text += '|{{CONTENTLANGUAGE}}';

	this.text = text;

	this.reqType = "Template Expansion";

	var apiargs = {
		format: 'json',
		action: 'expandtemplates',
		title: title,
		text: text
	};
	var uri = env.conf.wiki.apiURI;

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: uri,
		timeout: 16 * 1000, // 16 seconds
		proxy: env.conf.wiki.apiProxyURI,
		headers: {
			'User-Agent': userAgent,
			'Connection': 'close'
		}
	};

	if (env.cookie) {
		// Forward the cookie if set
		this.requestOptions.headers.Cookie = env.cookie;
	}

	// Start the request
	this.request( this.requestOptions, this._requestCB.bind(this) );
}


// Inherit from ApiRequest
util.inherits( PreprocessorRequest, ApiRequest );

/**
 * @inheritdoc ApiRequest#_handleJSON
 */
PreprocessorRequest.prototype._handleJSON = function ( error, data ) {

	if ( error ) {
		this.env.log("error", error);

		this._processListeners( error, '' );
		return;
	}

	var src = '';
	try {
		src = data.expandtemplates['*'];


		// Split off the contentlang debugging hack and check the language
		// TODO: remove when
		// https://bugzilla.wikimedia.org/show_bug.cgi?id=49411 is fixed!
		var bits = src.match(/^([^]*)\|([a-z-]+)$/);
		if ( bits ) {
			src = bits[1];
			var lang = bits[2];

			if ( lang !== this.env.conf.wiki.lang ) {
				var conf = this.env.conf;

				var errors = ["Invalid expandtemplates API response!! "];
				errors.push( "parsoid.apiURI: " + conf.parsoid.apiURI );
				errors.push( "wiki.apiURI: " + conf.wiki.apiURI );
				errors.push( "returned lang: " + conf.wiki.lang );
				this.env.log( "error", errors.join("\n") );
			}
		}

		//console.warn( 'Page ' + title + ': got ' + src );
		this.env.tp( 'Expanded ', this.text, src );


		// Add the source to the cache
		this.env.pageCache[this.text] = src;
	} catch ( e2 ) {
		error = new DoesNotExistError( 'Did not find page revisions in the returned body for ' +
				this.title + e2 );
	}


	//console.log( this.listeners('src') );
	this._processListeners( error, src );
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
 * @param {string} title The title of the page to use as context
 * @param {string} text
 */
function PHPParseRequest ( env, title, text ) {
	ApiRequest.call(this, env, title);

	this.text = text;
	this.queueKey = text;
	this.reqType = "Extension Parse";

	var apiargs = {
		format: 'json',
		action: 'parse',
		text: text,
		disablepp: 'true'
	};
	var uri = env.conf.wiki.apiURI;

	this.requestOptions = {
		// Use POST since we are passing a bit of source, and GET has a very
		// limited length. You'll be greeted by "HTTP Error 414 Request URI
		// too long" otherwise ;)
		method: 'POST',
		form: apiargs, // The API arguments
		followRedirect: true,
		uri: uri,
		timeout: 16 * 1000, // 16 seconds
		proxy: env.conf.wiki.apiProxyURI,
		headers: {
			'User-Agent': userAgent,
			'Connection': 'close'
		}
	};

	if (env.cookie) {
		// Forward the cookie if set
		this.requestOptions.headers.Cookie = env.cookie;
	}

	// Start the request
	this.request( this.requestOptions, this._requestCB.bind(this) );
}

// Inherit from ApiRequest
util.inherits( PHPParseRequest, ApiRequest );

/**
 * @inheritdoc ApiRequest#_handleJSON
 */
PHPParseRequest.prototype._handleJSON = function ( error, data ) {
	if ( error ) {
		this._processListeners( error, '' );
		return;
	}

	var parsedHtml = '';
	try {
		// Strip paragraph wrapper from the html
		parsedHtml = data.parse.text['*'];
		// Strip two trailing newlines that action=parse adds after any
		// extension output
		parsedHtml = parsedHtml.replace(/\n\n$/, '');
		// Also strip a paragraph wrapper, if any
		parsedHtml = parsedHtml.replace(/(^<p>)|(<\/p>$)/g, '');
		this.env.tp( 'Expanded ', this.text, parsedHtml );

		// Add the source to the cache
		this.env.pageCache[this.text] = parsedHtml;
	} catch ( e2 ) {
		error = new DoesNotExistError( 'Could not expand extension content for ' +
				this.title + e2 );
	}

	//console.log( this.listeners('parsedHtml') );
	this._processListeners( error, parsedHtml );
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
function ParsoidCacheRequest ( env, title, oldid, options ) {
	ApiRequest.call(this, env, title);

	if (!options) {
		options = {};
	}

	this.oldid = oldid;
	this.queueKey = title + '?oldid=' + oldid;
	this.reqType = "Parsoid cache request";

	var apiargs = {
		oldid: oldid
	};
	var uri = env.conf.parsoid.parsoidCacheURI +
			env.conf.wiki.iwp + '/' + encodeURIComponent(title.replace(/ /g, '_')) +
			'?' + qs.stringify( apiargs );
	this.uri = uri;

	//console.warn('Cache request:', uri);


	this.retries = 0;
	this.requestOptions = {
		// Use GET so that our request is cacheable
		method: 'GET',
		followRedirect: false,
		uri: uri,
		timeout: 60 * 1000, // 60 seconds: less than 100s VE timeout so we still finish
		headers: {
			'User-Agent': userAgent,
			'Connection': 'close',
			'x-parsoid-request': 'cache'
		}
	};

	if (env.cookie) {
		// Forward the cookie if set
		this.requestOptions.headers.Cookie = env.cookie;
	}

	if (!options.evenIfNotCached) {
		// Request a reply only from cache.
		this.requestOptions.headers['Cache-control'] = 'only-if-cached';
	}


	// Start the request
	this.request( this.requestOptions, this._requestCB.bind(this) );
}

// Inherit from ApiRequest
util.inherits( ParsoidCacheRequest, ApiRequest );

/**
 * Handle the HTML body
 */
ParsoidCacheRequest.prototype._handleBody = function ( error, body ) {
	if ( error ) {
		this._processListeners( error, '' );
		return;
	}

	//console.log( this.listeners('parsedHtml') );
	this._processListeners( error, body );
};

/**
 * @class
 * @extends ApiRequest
 *
 * A request for the wiki's configuration variables.
 *
 * @constructor
 * @param {string} apiURI The API URI to use for fetching
 * @param {MWParserEnvironment} env
 * @param {string} apiProxyURI (optional) The proxy URI to use for the
 * ConfigRequest
 */
var ConfigRequest = function ( apiURI, env, apiProxyURI ) {
	ApiRequest.call( this, env, null );

	var metas = [
			'siteinfo'
		],

		siprops = [
			'namespaces',
			'namespacealiases',
			'magicwords',
			'functionhooks',
			'extensiontags',
			'general',
			'interwikimap',
			'languages',
			'protocols'
		],

		apiargs = {
			format: 'json',
			action: 'query',
			meta: metas.join( '|' ),
			siprop: siprops.join( '|' )
		};

	if ( !apiURI ) {
		this._requestCB( new Error( 'There was no base URI for the API we tried to use.' ) );
		return;
	}

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: apiURI + '?' + qs.stringify( apiargs ),
		timeout: 40 * 1000,
		proxy: apiProxyURI,
		headers: {
			'User-Agent': userAgent,
			'Connection': 'close'
		}
	};

	if (env.cookie) {
		// Forward the cookie if set
		this.requestOptions.headers.Cookie = env.cookie;
	}


	this.request( this.requestOptions, this._requestCB.bind( this ) );
};

util.inherits( ConfigRequest, ApiRequest );

/**
 * @inheritdoc ApiRequest#_handleJSON
 */
ConfigRequest.prototype._handleJSON = function ( error, data ) {
	if ( error ) {
		this._processListeners( error, {} );
		return;
	}

	if ( data && data.query ) {
		this._processListeners( null, data.query );
	} else if ( data && data.error ) {
		if ( data.error.code === 'readapidenied' ) {
			error = new AccessDeniedError();
		} else {
			error = new Error( 'Something happened on the API side. Message: ' + data.error.code + ': ' + data.error.info );
		}
		this._processListeners( error, {} );
	} else {
		this._processListeners( null, {} );
	}
};

/**
 * @class
 * @extends ApiRequest
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {string} filename
 * @param @optional {Object} dims
 * @param @optional {number} width
 * @param @optional {number} height
 */
function ImageInfoRequest( env, filename, dims ) {
	ApiRequest.call( this, env, null );
	this.env = env;
	this.queueKey = filename + JSON.stringify( dims );

	var ix,
		conf = env.conf.wiki,
		uri = conf.apiURI + '?',
		filenames = [ filename ],
		imgnsid = conf.canonicalNamespaces.image,
		imgns = conf.namespaceNames[imgnsid],
		props = [
			'size',
			'url'
		];

	this.ns = imgns;

	for ( ix = 0; ix < filenames.length; ix++ ) {
		filenames[ix] = imgns + ':' + filenames[ix];
	}

	var apiArgs = {
		action: 'query',
		format: 'json',
		prop: 'imageinfo',
		titles: filenames.join( '|' ),
		iiprop: props.join( '|' )
	};

	if ( dims ) {
		if ( dims.width ) {
			apiArgs.iiurlwidth = dims.width;
		}
		if ( dims.height ) {
			apiArgs.iiurlheight = dims.height;
		}
	}

	uri += qs.stringify( apiArgs );

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		uri: uri,
		timeout: 40 * 1000,
		proxy: env.conf.wiki.apiProxyURI,
		headers: {
			'User-Agent': userAgent,
			'Connection': 'close'
		}
	};
	if (env.cookie) {
		// Forward the cookie if set
		this.requestOptions.headers.Cookie = env.cookie;
	}

	this.request( this.requestOptions, this._requestCB.bind( this ) );
}

util.inherits( ImageInfoRequest, ApiRequest );

/**
 * @inheritdoc ApiRequest#_handleJSON
 */
ImageInfoRequest.prototype._handleJSON = function ( error, data ) {
	var pagenames, names, namelist, newpages, pages, pagelist, ix;

	if ( error ) {
		this._processListeners( error, { imgns: this.ns } );
		return;
	}

	if ( data && data.query ) {
		// The API indexes its response by page ID. That's stupid.
		newpages = {};
		pagenames = {};
		pages = data.query.pages;
		names = data.query.normalized;
		pagelist = Object.keys( pages );

		if ( names ) {
			for ( ix = 0; ix < names.length; ix++ ) {
				pagenames[names[ix].to] = names[ix].from;
			}
		}

		for ( ix = 0; ix < pagelist.length; ix++ ) {
			if ( pagenames[pages[pagelist[ix]].title] ) {
				newpages[pagenames[pages[pagelist[ix]].title]] = pages[pagelist[ix]];
			}
			newpages[pages[pagelist[ix]].title] = pages[pagelist[ix]];
		}

		data.query.pages = newpages;
		data.query.imgns = this.ns;
		this.env.pageCache[ this.queueKey ] = data.query;
		this._processListeners( null, data.query );
	} else if ( data && data.error ) {
		if ( data.error.code === 'readapidenied' ) {
			error = new AccessDeniedError();
		} else {
			error = new Error( 'Something happened on the API side. Message: ' + data.error.code + ': ' + data.error.info );
		}
		this._processListeners( error, {} );
	} else {
		this._processListeners( null, {} );
	}
};

if (typeof module === "object") {
	module.exports.ConfigRequest = ConfigRequest;
	module.exports.TemplateRequest = TemplateRequest;
	module.exports.PreprocessorRequest= PreprocessorRequest;
	module.exports.PHPParseRequest = PHPParseRequest;
	module.exports.ParsoidCacheRequest = ParsoidCacheRequest;
	module.exports.ImageInfoRequest = ImageInfoRequest;
	module.exports.DoesNotExistError = DoesNotExistError;
	module.exports.ParserError = ParserError;
}
