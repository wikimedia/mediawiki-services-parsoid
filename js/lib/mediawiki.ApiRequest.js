"use strict";

var request = require('request'),
	$ = require( 'jquery' ),
	qs = require('querystring'),
	events = require('events'),
	util = require('util');

function DoesNotExistError( message ) {
    this.name = "DoesNotExistError";
    this.message = message || "Something doesn't exist";
    this.code = 404;
}
DoesNotExistError.prototype = Error.prototype;

function ParserError( message ) {
    this.name = "ParserError";
    this.message = message || "Generic parser error";
    this.code = 500;
}
ParserError.prototype = Error.prototype;

/**
 * Abstract API request base class constructor
 */
function ApiRequest ( env, title ) {
	// call the EventEmitter constructor
	events.EventEmitter.call(this);

	// Increase the number of maximum listeners a bit..
	this.setMaxListeners( 50000 );
	this.retries = 5;
	this.env = env;
	this.title = title;
}

// Inherit from EventEmitter
util.inherits(ApiRequest, events.EventEmitter);

ApiRequest.prototype.processListeners = function ( error, src ) {
	// Process only a few callbacks in each event loop iteration to
	// reduce memory usage.
	var listeners = this.listeners( 'src' );

	var processSome = function () {
		// XXX: experiment a bit with the number of callbacks per
		// iteration!
		var maxIters = Math.min(1, listeners.length);
		for ( var it = 0; it < maxIters; it++ ) {
			var nextListener = listeners.shift();
			// We only retrieve text/x-mediawiki source currently.
			nextListener( error || null, src, 'text/x-mediawiki' );
		}
		if ( listeners.length ) {
			process.nextTick( processSome );
		}
	};

	process.nextTick( processSome );
};

ApiRequest.prototype.requestCB = function (error, response, body) {
	//console.warn( 'response for ' + title + ' :' + body + ':' );
	var self = this;

	if(error) {
		this.env.tp('WARNING: RETRY:', error, this.queueKey);
		if ( this.retries ) {
			this.retries--;
			this.env.tp( 'Retrying template request for ' + this.title + ', ' +
					this.retries + ' remaining' );
			// retry
			request( this.requestOptions, this.requestCB.bind(this) );
			return;
		} else {
			var dnee = new DoesNotExistError( 'Page/template fetch failure for title ' + this.title );
			//this.emit('src', dnee, dnee.toString(), 'text/x-mediawiki');
			this.handleJSON( dnee, {} );
		}
	} else if(response.statusCode ===  200) {
		var src = '', data;
		try {
			//console.warn( 'body: ' + body );
			data = JSON.parse( body );
		} catch(e) {
			error = new ParserError( 'Failed to parse the JSON response for the template ' + self.title );
		}
		this.handleJSON( error, data );
	} else {
		console.warn( 'non-200 response: ' + response.statusCode );
		error = new DoesNotExistError( 'Page/template fetch failure for title ' + this.title );
		this.handleJSON( error, {} );
	}

	// XXX: handle other status codes

	// Remove self from request queue
	//this.env.dp( 'trying to remove ', this.title, ' from requestQueue' );
	delete this.env.requestQueue[this.queueKey];
	//this.env.dp( 'after deletion:', this.env.requestQueue );
};


/***************** Template fetch request helper class ********/

function TemplateRequest ( env, title, oldid ) {
	// Construct ApiRequest;
	ApiRequest.call(this, env, title);
	this.queueKey = title;

	var apiargs = {
		format: 'json',
		action: 'query',
		prop: 'revisions',
		rvprop: 'content',
		titles: title
	};
	if ( oldid ) {
		apiargs.revids = oldid;
		delete apiargs.titles;
	}
	var url = env.wgScript + '/api' +
		env.wgScriptExtension +
		'?' +
		qs.stringify( apiargs );
		//'?format=json&action=query&prop=revisions&rvprop=content&titles=' + title;

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		url: url,
		timeout: 40 * 1000, // 40 seconds
		headers: {
			'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:9.0.1) ' +
							'Gecko/20100101 Firefox/9.0.1 Iceweasel/9.0.1',
			'Connection': 'close'

		}
	};

	// Start the request
	request( this.requestOptions, this.requestCB.bind(this) );
}

// Inherit from ApiRequest
util.inherits(TemplateRequest, ApiRequest);

// The TemplateRequest-specific JSON handler
TemplateRequest.prototype.handleJSON = function ( error, data ) {
	var src = '',
		self = this;
	try {
		$.each( data.query.pages, function(i, page) {
			if (page.revisions && page.revisions.length) {
				src = page.revisions[0]['*'];
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

	// check for #REDIRECT
	var redirMatch = src.match( /[\r\n\s]*#\s*redirect\s*\[\[([^\]]+)\]\]/i );
	if ( redirMatch ) {
		var title = redirMatch[1],
			url = this.env.wgScript + '/api' +
				this.env.wgScriptExtension +
				'?' +
				qs.stringify( {
					format: 'json',
				action: 'query',
				prop: 'revisions',
				rvprop: 'content',
				titles: title
				} );
		//'?format=json&action=query&prop=revisions&rvprop=content&titles=' + title;
		this.requestOptions.url = url;
		request( this.requestOptions, this.requestCB.bind(this) );
		return;
	}

	//console.warn( 'Page ' + title + ': got ' + src );
	this.env.tp( 'Retrieved ' + this.title, src );

	// Add the source to the cache
	this.env.pageCache[this.title] = src;

	this.processListeners( error, src );
};

/******************* PreprocessorRequest *****************************/

/**
 * Passes the source of a single preprocessor construct including its
 * parameters to action=expandtemplates, and behaves otherwise just like a
 * TemplateRequest
 */
function PreprocessorRequest ( env, title, text ) {
	ApiRequest.call(this, env, title);

	this.text = text;
	this.queueKey = text;

	var apiargs = {
		format: 'json',
		action: 'expandtemplates',
		title: title,
		text: text
	};
	var url = env.wgScript + '/api' +
		env.wgScriptExtension +
		'?' +
		qs.stringify( apiargs );

	this.requestOptions = {
		method: 'GET',
		followRedirect: true,
		url: url,
		timeout: 12 * 1000, // 12 seconds
		headers: {
			'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:9.0.1) ' +
							'Gecko/20100101 Firefox/9.0.1 Iceweasel/9.0.1',
			'Connection': 'close'
		}
	};

	// Start the request
	request( this.requestOptions, this.requestCB.bind(this) );
}


// Inherit from ApiRequest
//PreprocessorRequest.prototype = new ApiRequest();
//PreprocessorRequest.prototype.constructor = PreprocessorRequest;
util.inherits( PreprocessorRequest, ApiRequest );

// The TemplateRequest-specific JSON handler
PreprocessorRequest.prototype.handleJSON = function ( error, data ) {
	var src = '';
	try {
		src = data.expandtemplates['*'];

		//console.warn( 'Page ' + title + ': got ' + src );
		this.env.tp( 'Expanded ', this.text, src );

		// Add the source to the cache
		this.env.pageCache[this.text] = src;
	} catch ( e2 ) {
		error = new DoesNotExistError( 'Did not find page revisions in the returned body for ' +
				this.title + e2 );
	}


	//console.log( this.listeners('src') );
	this.processListeners( error, src );
};

if (typeof module === "object") {
	module.exports.TemplateRequest = TemplateRequest;
	module.exports.PreprocessorRequest = PreprocessorRequest;
	module.exports.DoesNotExistError = DoesNotExistError;
	module.exports.ParserError = ParserError;
}
