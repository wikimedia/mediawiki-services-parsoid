"use strict";

require('es6-shim');
require('prfun');

var path = require('path'),
	fs = require('fs'),
	url = require('url'),
	util = require('util'),
	childProc = require('child_process'),
	domino = require('domino'),
	pkg = require('../package.json'),
	apiUtils = require('./utils');


// relative includes
var mp = '../lib/';

var MWParserEnvironment = require( mp + 'mediawiki.parser.environment.js' ).MWParserEnvironment,
	WikitextSerializer = require( mp + 'mediawiki.WikitextSerializer.js' ).WikitextSerializer,
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	LogData = require( mp + 'LogData.js' ).LogData,
	Util = require( mp + 'mediawiki.Util.js' ).Util,
	DU = require( mp + 'mediawiki.DOMUtils.js' ).DOMUtils,
	ApiRequest = require( mp + 'mediawiki.ApiRequest.js' ),
	Diff = require( mp + 'mediawiki.Diff.js' ).Diff;

var ParsoidCacheRequest = ApiRequest.ParsoidCacheRequest,
	TemplateRequest = ApiRequest.TemplateRequest;

module.exports = function( parsoidConfig ) {

var routes = {};


// Helpers

var Serializer = parsoidConfig.useSelser ? SelectiveSerializer : WikitextSerializer;

var supportedFormats = new Set([ "pagebundle", "html" ]);

function action( res ) {
	return [ "", res.local('iwp'), res.local('pageName') ].join( "/" );
}

var roundTripDiff = function( selser, req, res, env, document ) {
	var out = [];

	var finalCB =  function () {
		var i;
		out = out.join('');

		// Strip selser trigger comment
		out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

		// Emit base href so all relative urls resolve properly
		var hNodes = document.body.firstChild.childNodes;
		var headNodes = "";
		for (i = 0; i < hNodes.length; i++) {
			if (hNodes[i].nodeName.toLowerCase() === 'base') {
				headNodes += DU.serializeNode(hNodes[i]);
				break;
			}
		}

		var bNodes = document.body.childNodes;
		var bodyNodes = "";
		for (i = 0; i < bNodes.length; i++) {
			bodyNodes += DU.serializeNode(bNodes[i]);
		}

		var htmlSpeChars = apiUtils.htmlSpecialChars(out);

		var src = env.page.src.replace(/\n(?=\n)/g, '\n ');
		out = out.replace(/\n(?=\n)/g, '\n ');

		var patch = Diff.convertChangesToXML( Diff.diffLines(src, out) );

		apiUtils.setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader());

		apiUtils.renderResponse(res, env, "roundtrip", {
			headers: headNodes,
			bodyNodes: bodyNodes,
			htmlSpeChars: htmlSpeChars,
			patch: patch,
			reqUrl: req.url
		});

		env.log("info", "completed parsing in", env.performance.duration, "ms");
	};

	// Re-parse the HTML to uncover foster-parenting issues
	document = domino.createDocument(document.outerHTML);

	var Serializer = selser ? SelectiveSerializer : WikitextSerializer;
	new Serializer({ env: env }).serializeDOM(
		document.body,
		function( chunk ) { out.push(chunk); },
		finalCB
	);
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
			cacheRequest = new ParsoidCacheRequest(env,
				env.page.meta.title, cacheID);
		cacheRequest.once('src',
				handleCacheRequest.bind(null, env, req, res, cb, env.page.src));
	} else {
		handleCacheRequest(env, req, res, cb, env.page.src, "Recursive request", null);
	}
};

function html2wt( req, res, html ) {
	var env = res.local('env');
	env.page.id = req.body.oldid || null;

	if ( env.conf.parsoid.allowCORS ) {
		// allow cross-domain requests (CORS) so that parsoid service
		// can be used by third-party sites
		apiUtils.setHeader(res, env, 'Access-Control-Allow-Origin',
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
					apiUtils.setHeader(res, env, 'Content-Type', 'text/x-mediawiki; charset=UTF-8' );
					apiUtils.setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader() );
					apiUtils.endResponse(res, env,  out.join( '' ) );
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

function wt2html( req, res, wt, v2 ) {
	var env = res.local('env'),
		prefix = res.local('iwp'),
		oldid = res.local('oldid'),
		target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	// Set the timeout to 600 seconds..
	req.connection.setTimeout( 600 * 1000 );

	if ( env.conf.parsoid.allowCORS ) {
		// allow cross-domain requests (CORS) so that parsoid service
		// can be used by third-party sites
		apiUtils.setHeader( res, env, 'Access-Control-Allow-Origin', env.conf.parsoid.allowCORS );
	}

	var tmpCb;
	if ( wt ) {
		wt = wt.replace( /\r/g, '' );
		env.log('info', 'starting parsing');

		// clear default page name
		if ( !res.local('pageName') ) {
			env.page.name = '';
		}

		var parser = env.pipelineFactory.getPipeline('text/x-mediawiki/full');
		parser.once( 'document', function ( document ) {
			// Don't cache requests when wt is set in case somebody uses
			// GET for wikitext parsing
			apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
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
			env.log('info', 'starting parsing');

			if ( !req.headers.cookie ) {
				apiUtils.setHeader(res, env, 'Cache-Control', 's-maxage=2592000' );
			} else {
				// Don't cache requests with a session
				apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
			}

			// Indicate the MediaWiki revision in a header as well for
			// ease of extraction in clients.
			apiUtils.setHeader(res, env, 'content-revision-id', oldid);

			tmpCb = parse.bind( null, env, req, res, function ( req, res, src, doc ) {
				sendRes( doc.documentElement );
			});
		} else {
			// Don't cache requests with no oldid
			apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0' );
			tmpCb = function ( err, src_and_metadata ) {
				if ( err ) {
					env.log("fatal/request", err);
					return;
				}

				// Set the source
				env.setPageSrcInfo( src_and_metadata );
				oldid = env.page.meta.revision.revid;

				var path = "/";
				if ( v2 ) {
					path += [
						"v2",
						url.parse( env.conf.parsoid.interwikiMap.get( prefix ) ).host,
						encodeURIComponent( target ),
						v2.format,
						oldid
					].join("/");
				} else {
					path += [
						prefix,
						encodeURIComponent( target ) + "?oldid=" + oldid
					].join("/");
				}

				// Redirect to oldid
				apiUtils.relativeRedirect({
					"path": path,
					"res": res,
					"env": env
				});
				env.log("info", "redirected to revision", env.page.meta.revision.revid);
			};
		}
	}

	var tpr = new TemplateRequest( env, target, oldid );
	tpr.once( 'src', tmpCb );

	function sendRes( doc ) {
		try {
			apiUtils.setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader());
			if ( v2 && v2.format === "pagebundle" ) {
				var dp = doc.ownerDocument.getElementById('mw-data-parsoid');
				dp.parentNode.removeChild(dp);
				apiUtils.jsonResponse(res, env, {
					html: DU.serializeNode( doc ),
					"data-parsoid": JSON.parse(dp.text)
				});
			} else {
				apiUtils.setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8');
				apiUtils.endResponse(res, env,  DU.serializeNode( doc ));
			}
			env.log("info", "completed parsing in", env.performance.duration, "ms");
		} catch (e) {
			env.log("fatal/request", e);
		}
	}
}

// Middlewares

routes.interParams = function( req, res, next ) {
	res.local('iwp', req.params[0] || parsoidConfig.defaultWiki || '');
	res.local('pageName', req.params[1] || '');
	res.local('oldid', req.query.oldid || null);
	next();
};

routes.parserEnvMw = function( req, res, next ) {
	MWParserEnvironment.getParserEnv( parsoidConfig, null, res.local('iwp'), res.local('pageName'), req.headers.cookie, function ( err, env ) {
		function errCB( res, env, logData, callback ) {
			try {
				if ( !env.responseSent ) {
					apiUtils.setHeader(res, env, 'Content-Type', 'text/plain; charset=UTF-8' );
					apiUtils.sendResponse(res, env, logData.fullMsg(), logData.code || 500);
					if ( typeof callback === 'function' ) {
						res.on('finish', callback);
					}
					return;
				}
			} catch (e) {
				console.log( e.stack || e );
				res.end();
			}
			if ( typeof callback === 'function' ) {
				callback();
			}
		}

		if ( err ) {
			return errCB(res, {}, new LogData(null, "error", err));
		}

		env.logger.registerBackend(/fatal(\/.*)?/, errCB.bind(this, res, env));
		res.local("env", env);
		next();
	});
};

routes.v2Middle = function( req, res, next ) {
	function errOut(err) {
		// FIXME: provide more consistent error handling.
		apiUtils.sendResponse( res, {}, err, 404 );
	}

	var iwp = parsoidConfig.reverseIWMap.get( req.params.domain );
	if ( !iwp ) {
		return errOut("Invalid domain.");
	}
	res.local('iwp', iwp);

	res.local('format', req.params.format || "html");
	if ( !supportedFormats.has( res.local('format') ) ) {
		return errOut("Invalid format.");
	}

	res.local('pageName', req.params.title);
	res.local('oldid', req.params.revision || null);
	next();
};

// Routes

routes.home = function( req, res ){
	res.render('home');
};

// robots.txt: no indexing.
routes.robots = function ( req, res ) {
	res.end("User-agent: *\nDisallow: /\n");
};

// Return Parsoid version based on package.json + git sha1 if available
var versionCache;
routes.version = function( req, res ) {
	if ( versionCache ) {
		return res.json( versionCache );
	}
	versionCache = {
		name: pkg.name,
		version: pkg.version
	};
	Promise.promisify(
		childProc.exec, false, childProc
	)( 'git rev-parse HEAD' ).then(function( stdout ) {
		versionCache.sha = stdout.slice(0, -1);
	}).finally(function() {
		res.json( versionCache );
	});
};

// Redirects for old-style URL compatibility
routes.redirectOldStyle = function( req, res ) {
	if ( req.params[0] ) {
		apiUtils.relativeRedirect({
			"path" : '/' + req.params[0] + req.params[1] + '/' + req.params[2],
			"res" : res,
			"code" : 301
		});
	} else {
		apiUtils.relativeRedirect({
			"path" : '/' + req.params[1] + '/' + req.params[2],
			"res" : res,
			"code": 301
		});
	}
	res.end();
};

// Form-based HTML DOM -> wikitext interface for manual testing
routes.html2wtForm = function( req, res ) {
	var env = res.local('env');
	apiUtils.renderResponse(res, env, "form", {
		title: "Your HTML DOM:",
		action: action(res),
		name: "html"
	});
};

// Form-based wikitext -> HTML DOM interface for manual testing
routes.wt2htmlForm = function( req, res ) {
	var env = res.local('env');
	apiUtils.renderResponse(res, env, "form", {
		title: "Your wikitext:",
		action: action(res),
		name: "wt"
	});
};

// Round-trip article testing
routes.roundtripTesting = function(req, res) {
	var env = res.local('env');
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	req.connection.setTimeout(300 * 1000);
	env.log('info', 'starting parsing');

	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid );
	tpr.once('src', parse.bind( tpr, env, req, res, roundTripDiff.bind( null, false ) ));
};

// Round-trip article testing with newline stripping for editor-created HTML
// simulation
routes.roundtripTestingNL = function(req, res) {
	var env = res.local('env');
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	env.log('info', 'starting parsing');
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
};

// Round-trip article testing with selser over re-parsed HTML.
routes.roundtripSelser = function(req, res) {
	var env = res.local('env');
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	env.log('info', 'starting parsing');
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
};

// Form-based round-tripping for manual testing
routes.get_rtForm = function( req, res ) {
	var env = res.local('env');
	apiUtils.renderResponse(res, env, "form", {
		title: "Your wikitext:",
		action: "/_rtform/" + res.local('pageName'),
		name: "content"
	});
};

// Form-based round-tripping for manual testing
routes.post_rtForm = function( req, res ) {
	var env = res.local('env');
	apiUtils.setHeader(res, env, 'Content-Type', 'text/html; charset=UTF-8');
	// we don't care about \r, and normalize everything to \n
	parse( env, req, res, roundTripDiff.bind( null, false ), null, {
		revision: { '*': req.body.content.replace(/\r/g, '') }
	});
};

// Regular article parsing
routes.wt2html = function(req, res) {
	wt2html( req, res );
};

// Regular article serialization using POST
routes.html2wt = function(req, res) {
	// parse html or wt
	if ( req.body.wt ) {
		wt2html( req, res, req.body.wt );
	} else {
		html2wt( req, res, req.body.html || req.body.content || '' );
	}
};


// v2 Routes


// Regular article parsing
routes.v2_wt2html = function(req, res) {
	var v2 = { format: res.local("format") };
	if ( v2.format === "pagebundle" ) {
		res.local('env').conf.parsoid.storeDataParsoid = true;
	}
	wt2html( req, res, null, v2 );
};


return routes;

};
