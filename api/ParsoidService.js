/*
 * Simple Parsoid web service.
 */
"use strict";

/**
 * @class ParserServiceModule
 * @singleton
 * @private
 */

// global includes
var express = require('express'),
	domino = require('domino'),
	// memwatch = require('memwatch'),
	jsDiff = require('diff'),
	childProc = require('child_process'),
	cluster = require('cluster'),
	fs = require('fs'),
	path = require('path'),
	util = require('util'),
	pkg = require('../package.json');

// local includes
var mp = '../lib/';


function ParsoidService(options) {
	/**
	 * The name of this instance.
	 * @property {string}
	 */
	var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';

	console.log( ' - ' + instanceName + ' loading...' );

	var WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
		SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
		Util = require( mp + 'mediawiki.Util.js' ).Util,
		DU = require( mp + 'mediawiki.DOMUtils.js' ).DOMUtils,
		libtr = require(mp + 'mediawiki.ApiRequest.js'),
		ParsoidConfig = require( mp + 'mediawiki.ParsoidConfig' ).ParsoidConfig,
		MWParserEnvironment = require( mp + 'mediawiki.parser.environment.js' ).MWParserEnvironment,
		TemplateRequest = libtr.TemplateRequest;

	var interwikiRE;


/**
	 * Set header, but only if response hasn't been sent.
	 *
	 * @method
	 * @param {MWParserEnvironment} env
	 * @param {Response} res The response object from our routing function.
	 * @property {Function} Serializer
	 */
	function setHeader (res, env) {
		if (env.responseSent) {
			return;
		} else {
			res.setHeader.apply(res, Array.prototype.slice.call(arguments, 2));
		}
	}

	/**
	 * End response, but only if response hasn't been sent.
	 *
	 * @method
	 * @param {MWParserEnvironment} env
	 * @param {Response} res The response object from our routing function.
	 * @property {Function} Serializer
	 */
	function endResponse (res, env) {
		if (env.responseSent) {
			return;
		} else {
			env.responseSent = true;
			res.end.apply(res, Array.prototype.slice.call(arguments, 2));
		}
	}

	/**
	 * Send response, but only if response hasn't been sent.
	 *
	 * @method
	 * @param {MWParserEnvironment} env
	 * @param {Response} res The response object from our routing function.
	 * @property {Function} Serializer
	 */
	function sendResponse (res, env) {
		if (env.responseSent) {
			return;
		} else {
			env.responseSent = true;
			res.send.apply(res, Array.prototype.slice.call(arguments, 2));
		}
	}

	/**
	 * The global parsoid configuration object.
	 * @property {ParsoidConfig}
	 */
	var parsoidConfig = new ParsoidConfig( options, null );

	/**
	 * The serializer to use for the web requests.
	 * @property {Function} Serializer
	 */
	var Serializer = parsoidConfig.useSelser ? SelectiveSerializer : WikitextSerializer;

	/**
	 * Get the interwiki regexp.
	 *
	 * @method
	 * @returns {RegExp} The regular expression that matches to all interwikis accepted by the API.
	 */
	function getInterwikiRE() {
		// this RE won't change -- so, cache it
		if (!interwikiRE) {
			interwikiRE = parsoidConfig.interwikiRegexp;
		}
		return interwikiRE;
	}

	var htmlSpecialChars = function ( s ) {
		return s.replace(/&/g,'&amp;')
			.replace(/</g,'&lt;')
			.replace(/"/g,'&quot;')
			.replace(/'/g,'&#039;');
	};

	/**
	 * Send a form with a text area.
	 *
	 * @method
	 * @param {Response} res The response object from our routing function.
	 * @param {string} action Path to post
	 * @param {string} name Name of textarea
	 * @param {string} content The content we should put in the textarea
	 */
	var textarea = function ( res, action, name, content ) {
		res.write('<form method=POST action="' + action + '"><textarea name="' + name + '" cols=90 rows=9>');
		res.write( ( content && htmlSpecialChars( content) ) || '' );
		res.write('</textarea><br><input type="submit"></form>');
	};

	/**
	 * Perform word-based diff on a line-based diff. The word-based algorithm is
	 * practically unusable for inputs > 5k bytes, so we only perform it on the
	 * output of the more efficient line-based diff.
	 *
	 * @method
	 * @param {Array} diff The diff to refine
	 * @returns {Array} The refined diff
	 */
	var refineDiff = function ( diff ) {
		// Attempt to accumulate consecutive add-delete pairs
		// with short text separating them (short = 2 chars right now)
		//
		// This is equivalent to the <b><i> ... </i></b> minimization
		// to expand range of <b> and <i> tags, except there is no optimal
		// solution except as determined by heuristics ("short text" = <= 2 chars).
		function mergeConsecutiveSegments(wordDiffs) {
			var n = wordDiffs.length,
				currIns = null, currDel = null,
				newDiffs = [];
			for (var i = 0; i < n; i++) {
				var d = wordDiffs[i],
					dVal = d.value;
				if (d.added) {
					// Attempt to accumulate
					if (currIns === null) {
						currIns = d;
					} else {
						currIns.value = currIns.value + dVal;
					}
				} else if (d.removed) {
					// Attempt to accumulate
					if (currDel === null) {
						currDel = d;
					} else {
						currDel.value = currDel.value + dVal;
					}
				} else if (((dVal.length < 4) || !dVal.match(/\s/)) && currIns && currDel) {
					// Attempt to accumulate
					currIns.value = currIns.value + dVal;
					currDel.value = currDel.value + dVal;
				} else {
					// Accumulation ends. Purge!
					if (currIns !== null) {
						newDiffs.push(currIns);
						currIns = null;
					}
					if (currDel !== null) {
						newDiffs.push(currDel);
						currDel = null;
					}
					newDiffs.push(d);
				}
			}

			// Purge buffered diffs
			if (currIns !== null) {
				newDiffs.push(currIns);
			}
			if (currDel !== null) {
				newDiffs.push(currDel);
			}

			return newDiffs;
		}

		var added = null,
			out = [];
		for ( var i = 0, l = diff.length; i < l; i++ ) {
			var d = diff[i];
			if ( d.added ) {
				if ( added ) {
					out.push( added );
				}
				added = d;
			} else if ( d.removed ) {
				if ( added ) {
					var fineDiff = jsDiff.diffWords( d.value, added.value );
					fineDiff = mergeConsecutiveSegments(fineDiff);
					out.push.apply( out, fineDiff );
					added = null;
				} else {
					out.push( d );
				}
			} else {
				if ( added ) {
					out.push( added );
					added = null;
				}
				out.push(d);
			}
		}
		if ( added ) {
			out.push(added);
		}
		return out;
	};

	var roundTripDiff = function ( selser, req, res, env, document ) {
		var patch;
		var out = [];

		var finalCB =  function () {
			var i;
			// XXX TODO FIXME BBQ There should be an error callback in SelSer.
			out = out.join('');
			// Strip selser trigger comment
			out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');
			if ( out === undefined ) {
				env.log("fatal/request", "An error occured in the WikitextSerializer");
				return;
			}
			setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8' );
			res.write('<html><head>\n');
			res.write('<script type="text/javascript" src="/jquery.js"></script><script type="text/javascript" src="/scrolling.js"></script><style>ins { background: #ff9191; text-decoration: none; } del { background: #99ff7e; text-decoration: none }; </style>\n');
			// Emit base href so all relative urls resolve properly
			var headNodes = document.body.firstChild.childNodes;
			for (i = 0; i < headNodes.length; i++) {
				if (headNodes[i].nodeName.toLowerCase() === 'base') {
					res.write(DU.serializeNode(headNodes[i]));
					break;
				}
			}
			res.write('</head><body>\n');
			res.write( '<h2>Wikitext parsed to HTML DOM</h2><hr>\n' );
			var bodyNodes = document.body.childNodes;
			for (i = 0; i < bodyNodes.length; i++) {
				res.write(DU.serializeNode(bodyNodes[i]));
			}
			res.write('\n<hr>');
			res.write( '<h2>HTML DOM converted back to Wikitext</h2><hr>\n' );
			res.write('<pre>' + htmlSpecialChars( out ) + '</pre><hr>\n');
			res.write( '<h2>Diff between original Wikitext (green) and round-tripped wikitext (red)</h2><p>(use shift+alt+n and shift+alt+p to navigate forward and backward)<hr>\n' );
			var src = env.page.src.replace(/\n(?=\n)/g, '\n ');
			out = out.replace(/\n(?=\n)/g, '\n ');
			//console.log(JSON.stringify( jsDiff.diffLines( out, src ) ));
			patch = jsDiff.convertChangesToXML( jsDiff.diffLines( src, out ) );
			//patch = jsDiff.convertChangesToXML( refineDiff( jsDiff.diffLines( src, out ) ) );
			res.write( '<pre>\n' + patch + '\n</pre>');
			// Add a 'report issue' link
			res.write('<hr>\n<h2>'+
					'<a style="color: red" ' +
					'href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo' +
					'&amp;action=edit&amp;section=new&amp;preloadtitle=' +
					'Issue%20on%20http://parsoid.wmflabs.org' + req.url + '">' +
					'Report a parser issue in this page</a> at ' +
					'<a href="http://www.mediawiki.org/wiki/Talk:Parsoid/Todo">'+
					'[[:mw:Talk:Parsoid/Todo]]</a></h2>\n<hr>');
			endResponse(res, env, '\n</body></html>');
		};

		// Re-parse the HTML to uncover foster-parenting issues
		document = domino.createDocument(document.outerHTML);

		if ( selser ) {
			new SelectiveSerializer( {env: env}).serializeDOM( document.body,
				function ( chunk ) {
					out.push(chunk);
				}, finalCB );
		} else {
			new WikitextSerializer({env: env}).serializeDOM( document.body,
				function ( chunk ) {
					out.push(chunk);
				}, finalCB );
		}
	};

	function handleCacheRequest( env, req, res, cb, src, cacheErr, cacheSrc ) {
		var errorHandlingCB = function ( src, err, doc ) {
			if ( err ) {
				env.log("fatal/request", err);
				return;
			}
			cb( req, res, src, doc );
		};

		if ( cacheErr ) {
			// No luck with the cache request, just proceed as normal.
			Util.parse(env, errorHandlingCB, null, src);
			return;
		}
		// Extract transclusion and extension content from the DOM
		var expansions = DU.extractExpansions(DU.parseHTML(cacheSrc));

		// Figure out what we can reuse
		var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');
		if (parsoidHeader.cacheID) {
			if (parsoidHeader.mode === 'templates') {
				// Transclusions need to be updated, so don't reuse them.
				expansions.transclusions = {};
			} else if (parsoidHeader.mode === 'files') {
				// Files need to be updated, so don't reuse them.
				expansions.files = {};
			}
		}

		// pass those expansions into Util.parse to prime the caches.
		//console.log('expansions:', expansions);
		Util.parse(env, errorHandlingCB, null, src, expansions);
	}

	var parse = function ( env, req, res, cb, err, src_and_metadata ) {
		if ( err ) {
			env.log("fatal/request", err);
			return;
		}

		// Set the source
		env.setPageSrcInfo( src_and_metadata );

		// Now env.page.meta.title has the canonical title, and
		// env.page.meta.revision.parentid has the predecessor oldid

		// See if we can reuse transclusion or extension expansions.
		if (env.conf.parsoid.parsoidCacheURI &&
				// And don't parse twice for recursive parsoid requests
				! req.headers['x-parsoid-request'])
		{
			// Try to retrieve a cached copy of the content so that we can recycle
			// template and / or extension expansions.
			var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}'),
				// If we get a prevID passed in in X-Parsoid (from our PHP
				// extension), use that explicitly. Otherwise default to the
				// parentID.
				cacheID = parsoidHeader.cacheID ||
					env.page.meta.revision.parentid,
				cacheRequest = new libtr.ParsoidCacheRequest(env,
					env.page.meta.title, cacheID);
			cacheRequest.once('src',
					handleCacheRequest.bind(null, env, req, res, cb, env.page.src));
		} else {
			handleCacheRequest(env, req, res, cb, env.page.src, "Recursive request", null);
		}
	};


	/**
	 * Send a redirect response with optional code and a relative URL
	 *
	 * (Returns if a response has already been sent.)
	 * This is not strictly HTTP spec conformant, but works in most clients. More
	 * importantly, it works both behind proxies and on the internal network.
	 */
	function relativeRedirect(args) {
		if (!args.code) {
			args.code = 302; // moved temporarily
		}

		if (args.res && args.env && args.env.responseSent ) {
			return;
		} else {
			args.res.writeHead(args.code, {
				'Location': args.path
			});
			args.res.end();
		}
	}

	/* -------------------- web app access points below --------------------- */

	var app = express.createServer();

	// favicon
	app.use(express.favicon(path.join(__dirname, "favicon.ico")));

	// Increase the form field size limit from the 2M default.
	app.use(express.bodyParser({maxFieldsSize: 15 * 1024 * 1024}));

	// Support gzip / deflate transfer-encoding
	app.use(express.compress());

	app.get('/', function(req, res){
		res.write('<html><body>\n');
		res.write('<h3>Welcome to the <a href="https://www.mediawiki.org/wiki/Parsoid">Parsoid</a> web service.</h3>\n');
		res.write( '<p>See <a href="https://www.mediawiki.org/wiki/Parsoid#The_Parsoid_web_API">the API documentation on mediawiki.org</a>. ' );
		res.write('<p>There are also some convenient tools for experiments. These are <em>not</em> part of the public API.\n<ul>\n');
		res.write('<li>Round-trip test pages from the English Wikipedia: ' +
			'<strong><a href="/_rt/mediawikiwiki/Parsoid">/_rt/Parsoid</a></strong></li>\n');
		res.write('<li><strong><a href="/_rtform/">WikiText -&gt; HTML DOM -&gt; WikiText round-trip form</a></strong></li>\n');
		res.write('<li><strong><a href="/_wikitext/">WikiText -&gt; HTML DOM form</a></strong></li>\n');
		res.write('<li><strong><a href="/_html/">HTML DOM -&gt; WikiText form</a></strong></li>\n');
		res.write('</ul>\n');
		res.write('\n');
		res.end('</body></html>');
	});

	function interParams( req, res, next ) {
		res.local('iwp', req.params[0] || parsoidConfig.defaultWiki || '');
		res.local('pageName', req.params[1] || '');
		next();
	}

	function parserEnvMw( req, res, next ) {
		MWParserEnvironment.getParserEnv( parsoidConfig, null, res.local('iwp'), res.local('pageName'), req.headers.cookie, function ( err, env ) {

			function generateErrCBMessage (obj) {
				var messageString = "";
				if (obj.constructor.name === "Error") {
					messageString += obj.message;
					messageString += 'ERROR in ' + res.local('iwp') + ':' + res.local('pageName');
					messageString += "\n" + obj.stack;
				} else {
					if (obj.msg) {
						messageString += obj.msg;
					}
					if (obj.location) {
						messageString += "\n" + obj.location;
					}
					if (obj.stack) {
						messageString += "\n" + obj.stack;
					}
				}
				return messageString;
			}

			function errCB ( res, env, obj, callback ) {
				try {
					if (env.responseSent) {
						return;
					} else {
						var messageString = generateErrCBMessage(obj);
						setHeader(res, env, 'Content-Type', 'text/plain; charset=UTF-8' );
						sendResponse(res, env, messageString, obj.code || 500);
						res.on('finish', callback);
					}
				} catch (e) {
					return;
				}
			}

			if ( err ) {
				return errCB(res, null, err);
			}

			env.logger.registerBackend(/fatal(\/.*)?/, errCB.bind(this, res, env));
			res.local("env", env);
			next();
		});
	}

	// robots.txt: no indexing.
	app.get(/^\/robots.txt$/, function ( req, res ) {
		res.end("User-agent: *\nDisallow: /\n" );
	});

	// Redirects for old-style URL compatibility
	app.get( new RegExp( '^/((?:_rt|_rtve)/)?(' + getInterwikiRE() +
					'):(.*)$' ), function ( req, res ) {
		if ( req.params[0] ) {
			relativeRedirect({"path" : '/' + req.params[0] + req.params[1] + '/' + req.params[2], "res" : res, "code" : 301});
		} else {
			relativeRedirect({"path" : '/' + req.params[1] + '/' + req.params[2], "res" : res, "code": 301});
		}
		res.end();
	});

	function action( res ) {
		return [ "", res.local('iwp'), res.local('pageName') ].join( "/" );
	}

	// Form-based HTML DOM -> wikitext interface for manual testing
	app.get( new RegExp('/_html/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8' );
		res.write( "Your HTML DOM:" );
		textarea( res, action( res ), "html" );
		endResponse(res, env );
	});

	// Form-based wikitext -> HTML DOM interface for manual testing
	app.get( new RegExp('/_wikitext/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8' );
		res.write( "Your wikitext:" );
		textarea( res, action( res ), "wt" );
		endResponse(res, env );
	});

	// Round-trip article testing
	app.get( new RegExp('/_rt/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function(req, res) {
		var env = res.local('env');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		req.connection.setTimeout(300 * 1000);
		console.log('starting parsing of ' + target);

		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', parse.bind( tpr, env, req, res, roundTripDiff.bind( null, false ) ));
	});

	// Round-trip article testing with newline stripping for editor-created HTML
	// simulation
	app.get( new RegExp('/_rtve/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function(req, res) {
		var env = res.local('env');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		console.log('starting parsing of ' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid ),
			cb = function ( req, res, src, document ) {
				// strip newlines from the html
				var html = document.innerHTML.replace(/[\r\n]/g, ''),
					newDocument = DU.parseHTML(html);
				roundTripDiff( false, req, res, src, newDocument );
			};

		tpr.once('src', parse.bind( tpr, env, req, res, cb ));
	});

	// Round-trip article testing with selser over re-parsed HTML.
	app.get( new RegExp('/_rtselser/(' + getInterwikiRE() + ')/(.*)'), interParams, parserEnvMw, function (req, res) {
		var env = res.local('env');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		console.log( 'starting parsing of ' + target );
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid ),
			tprCb = function ( req, res, src, document ) {
				var newDocument = DU.parseHTML( DU.serializeNode(document) ),
					newNode = newDocument.createComment('rtSelserEditTestComment');
				newDocument.body.appendChild(newNode);
				roundTripDiff( true, req, res, src, newDocument );
			};

		tpr.once( 'src', parse.bind( tpr, env, req, res, tprCb ) );
	});

	// Form-based round-tripping for manual testing
	app.get( new RegExp('/_rtform/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your wikitext:" );
		textarea( res, "/_rtform/" + res.local('pageName') , "content" );
		endResponse(res, env );
	});

	app.post( new RegExp('/_rtform/(?:(' + getInterwikiRE() + ')/(.*))?'), interParams, parserEnvMw, function ( req, res ) {
		var env = res.local('env');
		setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8');
		// we don't care about \r, and normalize everything to \n
		parse( env, req, res, roundTripDiff.bind( null, false ), null, {
			revision: { '*': req.body.content.replace(/\r/g, '') }
		});
	});

	function html2wt( req, res, html ) {
		var env = res.local('env');
		env.page.id = req.body.oldid || null;

		if ( env.conf.parsoid.allowCORS ) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			setHeader(res, env, 'Access-Control-Allow-Origin',
						   env.conf.parsoid.allowCORS );
		}

		var html2wtCb = function () {
			var doc;
			try {
				doc = DU.parseHTML( html.replace( /\r/g, '' ) );
			} catch ( e ) {
				env.log("fatal", e, "There was an error in the HTML5 parser!");
				return;
			}

			try {
				var out = [];
				new Serializer( { env: env, oldid: env.page.id } ).serializeDOM(
					doc.body,
					function ( chunk ) {
						out.push( chunk );
					}, function () {
						setHeader(res, env, 'Content-Type', 'text/x-mediawiki; charset=UTF-8' );
						setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader() );
						endResponse(res, env,  out.join( '' ) );
					} );
			} catch ( e ) {
				env.log("fatal", e);
				return;
			}
		};

		if ( env.conf.parsoid.fetchWT ) {
			var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );
			var tpr = new TemplateRequest( env, target, env.page.id );
			tpr.once( 'src', function ( err, src_and_metadata ) {
				if ( err ) {
					env.log("error", "There was an error fetching the original wikitext for", target, err);
				} else {
					env.setPageSrcInfo( src_and_metadata );
				}
				html2wtCb();
			} );
		} else {
			html2wtCb();
		}
	}

	function wt2html( req, res, wt ) {

		var env = res.local('env');
		var prefix = res.local('iwp');
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		// Set the timeout to 600 seconds..
		req.connection.setTimeout( 600 * 1000 );

		console.log( 'starting parsing of ' + prefix + ':' + target );

		if ( env.conf.parsoid.allowCORS ) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			setHeader(res, env, 'Access-Control-Allow-Origin',
						   env.conf.parsoid.allowCORS );
		}

		var tmpCb,
			oldid = req.query.oldid || null;
		if ( wt ) {
			wt = wt.replace( /\r/g, '' );

			// clear default page name
			if ( !res.local('pageName') ) {
				env.page.name = '';
			}

			var parser = env.pipelineFactory.getPipeline('text/x-mediawiki/full');
			parser.once( 'document', function ( document ) {
				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
				sendRes( req.body.body ? document.body : document );
			});

			tmpCb = function ( err, src_and_metadata ) {
				if ( err ) {
					env.log("fatal/request", err);
					return;
				}

				// Set the source
				env.setPageSrcInfo( src_and_metadata );

				try {
					parser.processToplevelDoc( wt );
				} catch ( e ) {
					env.log("fatal", e);
					return;
				}
			};

			if ( !res.local('pageName') || !oldid ) {
				// no pageName supplied; don't fetch the page source
				tmpCb( null, wt );
				return;
			}

		} else {
			if ( oldid ) {
				if ( !req.headers.cookie ) {
					setHeader(res, env, 'Cache-Control', 's-maxage=2592000' );
				} else {
					// Don't cache requests with a session
					setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
				}
				tmpCb = parse.bind( null, env, req, res, function ( req, res, src, doc ) {
					sendRes( doc.documentElement );
				});
			} else {
				// Don't cache requests with no oldid
				setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
				tmpCb = function ( err, src_and_metadata ) {
					if ( err ) {
						env.log("fatal/request", err);
						return;
					}

					// Set the source
					env.setPageSrcInfo( src_and_metadata );
					var url = [ "", prefix,
								encodeURIComponent( target ) +
								"?oldid=" + env.page.meta.revision.revid
							].join( "/" );

					// Redirect to oldid
					relativeRedirect({"path" : url, "res" : res, "env" : env});
					env.log("trace/request", "redirected", prefix, ":", target, "to revision", env.page.meta.revision.revid);
				};
			}
		}

		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once( 'src', tmpCb );

		function sendRes( doc ) {
			var out = DU.serializeNode( doc );
			try {
				setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader() );
				setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8' );
				endResponse(res, env,  out );
				env.log("trace/request", "completed parsing of", prefix, ":", target, "in", env.performance.duration, "ms");
			} catch (e) {
				env.log("fatal/request", e);
			}
		}
	}

	// Regular article parsing
	app.get( new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), interParams, parserEnvMw, function(req, res) {
		wt2html( req, res );
	});

	// Regular article serialization using POST
	app.post( new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), interParams, parserEnvMw, function ( req, res ) {
		// parse html or wt
		if ( req.body.wt ) {
			wt2html( req, res, req.body.wt );
		} else {
			html2wt( req, res, req.body.html || req.body.content || '' );
		}
	});

	var version = {
		name: pkg.name,
		version: pkg.version
	};

	function gitVersion( cb ) {
		fs.exists( path.join( __dirname, '/../.git' ), function ( exists ) {
			if ( !exists ) {
				cb();
				return;
			}
			childProc.exec(
				'git rev-parse HEAD',
				function ( error, stdout, stderr ) {
					if ( !error ) {
						version.sha = stdout.slice(0, -1);
					}
					cb();
			});
		});
	}

	/**
	* Return Parsoid version based on package.json + git sha1 if available
	*/
	app.get( "/_version", function ( req, res ) {
		res.json( version );
	});
	
    app.use( express.static( __dirname + '/scripts' ) );
	app.use( express.limit( '15mb' ) );

	// Get host and port from the environment, if available
	// VCAP_APP_PORT is for appfog.com support
	var port = process.env.VCAP_APP_PORT || process.env.PORT || 8000;
	var host = process.env.INTERFACE;  // default bind all

	app.on( 'error', function( err ) {
		if ( err.errno === "EADDRINUSE" ) {
			console.error( "Port %d is already in use. Exiting.", port );
			cluster.worker.disconnect();
		} else {
			console.error( err.message );
		}
	});

	gitVersion( function () {
		app.listen( port, host );
		console.log( ' - ' + instanceName + ' ready' );
	});

}

module.exports = {
	ParsoidService: ParsoidService
};
