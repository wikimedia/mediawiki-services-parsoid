var request = require('request'),
	qs = require('querystring'),
	events = require('events');

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

/***************** Template fetch request helper class ********/

function TemplateRequest ( env, title, oldid ) {
	// Increase the number of maximum listeners a bit..
	this.setMaxListeners( 50000 );
	this.retries = 5;
	this.env = env;
	this.title = title;
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
		headers: {
			'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:9.0.1) ' +
							'Gecko/20100101 Firefox/9.0.1 Iceweasel/9.0.1',
			'Connection': 'close'

		}
	};

	// Start the request
	request( this.requestOptions, this._handler.bind(this) );
}

// Inherit from EventEmitter
TemplateRequest.prototype = new events.EventEmitter();
TemplateRequest.prototype.constructor = TemplateRequest;

TemplateRequest.prototype._handler = function (error, response, body) {
	//console.warn( 'response for ' + title + ' :' + body + ':' );
	var self = this;

	if(error) {
		this.env.dp(error);
		if ( this.retries ) {
			this.retries--;
			this.env.tp( 'Retrying template request for ' + this.title );
			// retry
			request( this.requestOptions, this._handler.bind(this) );
		} else {
			var dnee = new DoesNotExistError( 'Page/template fetch failure for title ' + this.title );
			this.emit('src', dnee, dnee.toString(), 'text/x-mediawiki');
		}
	} else if(response.statusCode ===  200) {
		var src = '',
			data,
			normalizedTitle;
		try {
			//console.warn( 'body: ' + body );
			data = JSON.parse( body );
		} catch(e) {
			error = new ParserError( 'Failed to parse the JSON response for the template ' + self.title );
		}
		try {
			$.each( data.query.pages, function(i, page) {
				if (page.revisions && page.revisions.length) {
					src = page.revisions[0]['*'];
					normalizeTitle = page.title;
				} else {
					var normalName = self.env.normalizeTitle(
						self.env.pageName );
					throw new DoesNotExistError( 'Did not find page revisions for ' + self.title );
					if ( this.title === normalName ) {
						src = 'No revisions for ' + self.title;
					}
				}
			});
		} catch ( e2 ) {
			if ( e2 instanceof DoesNotExistError ) {
				error = e2;
			} else {
				error = DoesNotExistError( 'Did not find page revisions in the returned body:' + body + e2 );
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
			request( this.requestOptions, this._handler.bind(this) );
			return;
		}

		//console.warn( 'Page ' + title + ': got ' + src );
		this.env.tp( 'Retrieved ' + this.title, src );

		// Add the source to the cache
		this.env.pageCache[this.title] = src;

		// Process only a few callbacks in each event loop iteration to
		// reduce memory usage.
		//
		//
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
		//processSome();

		//self.emit( 'src', src, title );
	}
	// XXX: handle other status codes

	// Remove self from request queue
	//this.env.dp( 'trying to remove ', this.title, ' from requestQueue' );
	delete this.env.requestQueue[this.title];
	//this.env.dp( 'after deletion:', this.env.requestQueue );
};

		/*
		* XXX: The jQuery version does not quite work with node, but we keep
		* it around for now.
		$.ajax({
			url: url,
			data: {
				format: 'json',
				action: 'query',
				prop: 'revisions',
				rvprop: 'content',
				titles: title
			},
			success: function(data, statusString, xhr) {
				console.warn( 'Page ' + title + ' success ' + JSON.stringify( data ) );
				var src = null, title = null;
				$.each(data.query.pages, function(i, page) {
					if (page.revisions && page.revisions.length) {
						src = page.revisions[0]['*'];
						title = page.title;
					}
				});
				if (typeof src !== 'string') {
					console.warn( 'Page ' + title + 'not found! Got ' + src );
					callback( 'Page ' + title + ' not found' );
				} else {
					// Add to cache
					console.warn( 'Page ' + title + ': got ' + src );
					this.env.pageCache[title] = src;
					callback(src, title);
				}
			},
			error: function(xhr, msg, err) {
				console.warn( 'Page/template fetch failure for title ' +
						title + ', url=' + url + JSON.stringify(xhr) + ', err=' + err );
				callback('Page/template fetch failure for title ' + title);
			},
			dataType: 'json',
			cache: false, // @fixme caching, versions etc?
			crossDomain: true
		});
		*/

if (typeof module === "object") {
	module.exports.TemplateRequest = TemplateRequest;
	module.exports.DoesNotExistError = DoesNotExistError;
	module.exports.ParserError = ParserError;
}
