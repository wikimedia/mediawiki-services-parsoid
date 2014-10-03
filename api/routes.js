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

var MWParserEnv = require( mp + 'mediawiki.parser.environment.js' ).MWParserEnvironment,
	WikitextSerializer = require( mp + 'mediawiki.WikitextSerializer.js' ).WikitextSerializer,
	SelectiveSerializer = require( mp + 'mediawiki.SelectiveSerializer.js' ).SelectiveSerializer,
	LogData = require( mp + 'LogData.js' ).LogData,
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

var promiseTemplateReq = function( env, target, oldid ) {
	return new Promise(function( resolve, reject ) {
		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', function( err, src_and_metadata ) {
			if ( err ) {
				reject( err );
			} else {
				resolve( src_and_metadata );
			}
		});
	});
};

var errBack = function( env, req, res, logData, callback ) {
	if ( !env.responseSent) {
		return new Promise(function( resolve, reject ) {
			apiUtils.setHeader( res, env, 'Content-Type', 'text/plain; charset=UTF-8' );
			apiUtils.sendResponse( res, env, logData.fullMsg(), logData.code || 500 );
			res.on( 'finish', resolve );
		}).catch(function(e) {
			console.error( e.stack || e );
			res.end();
		}).nodify(callback);
	}
	return Promise.resolve().nodify(callback);
};

var roundTripDiff = function( env, req, res, selser, doc ) {
	var out = [];

	// Re-parse the HTML to uncover foster-parenting issues
	doc = domino.createDocument( doc.outerHTML );

	var Serializer = selser ? SelectiveSerializer : WikitextSerializer,
		serializer = new Serializer({ env: env });

	return Promise.promisify( serializer.serializeDOM, false, serializer )(
		doc.body, function( chunk ) { out.push(chunk); }, false
	).then(function() {
		var i;
		out = out.join('');

		// Strip selser trigger comment
		out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

		// Emit base href so all relative urls resolve properly
		var hNodes = doc.body.firstChild.childNodes;
		var headNodes = "";
		for (i = 0; i < hNodes.length; i++) {
			if (hNodes[i].nodeName.toLowerCase() === 'base') {
				headNodes += DU.serializeNode(hNodes[i]);
				break;
			}
		}

		var bNodes = doc.body.childNodes;
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
	}).catch(function( err ) {
		env.log("fatal/request", err);
	});
};

var parse = function( env, req, res, src_and_metadata ) {
	// Set the source
	env.setPageSrcInfo( src_and_metadata );

	// Now env.page.meta.title has the canonical title, and
	// env.page.meta.revision.parentid has the predecessor oldid
	var meta = env.page.meta;

	return new Promise(function( resolve, reject ) {
		// See if we can reuse transclusion or extension expansions.
		// And don't parse twice for recursive parsoid requests
		if ( env.conf.parsoid.parsoidCacheURI && !req.headers['x-parsoid-request'] ) {
			// Try to retrieve a cached copy of the content so that we can
			// recycle template and / or extension expansions.
			var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');

			// If we get a prevID passed in in X-Parsoid (from our PHP
			// extension), use that explicitly. Otherwise default to the
			// parentID.
			var cacheID = parsoidHeader.cacheID || meta.revision.parentid;

			var cacheRequest = new ParsoidCacheRequest( env, meta.title, cacheID );
			cacheRequest.once('src', function( err, src ) {
				// No luck with the cache request, just proceed as normal.
				resolve( err ? null : src );
			});
		} else {
			resolve( null );
		}
	}).then(function( cacheSrc ) {
		var expansions, pipeline = env.pipelineFactory;

		if ( cacheSrc ) {
			// Extract transclusion and extension content from the DOM
			expansions = DU.extractExpansions( DU.parseHTML(cacheSrc) );

			// Figure out what we can reuse
			var parsoidHeader = JSON.parse( req.headers['x-parsoid'] || '{}' );
			if ( parsoidHeader.cacheID ) {
				if ( parsoidHeader.mode === 'templates' ) {
					// Transclusions need to be updated, so don't reuse them.
					expansions.transclusions = {};
				} else if (parsoidHeader.mode === 'files') {
					// Files need to be updated, so don't reuse them.
					expansions.files = {};
				}
			}
		}

		return Promise.promisify( pipeline.parse, false, pipeline )(
			env, env.page.src, expansions
		);
	}).catch(function( err ) {
		env.log("fatal/request", err);
	});
};

var html2wt = function( req, res, html ) {
	var env = res.local('env');
	env.page.id = req.body.oldid || null;

	if ( env.conf.parsoid.allowCORS ) {
		// allow cross-domain requests (CORS) so that parsoid service
		// can be used by third-party sites
		apiUtils.setHeader(res, env, 'Access-Control-Allow-Origin',
					   env.conf.parsoid.allowCORS );
	}

	var out = [];
	return new Promise(function( resolve, reject ) {
		if ( !env.conf.parsoid.fetchWT ) {
			return resolve();
		}
		var target = env.resolveTitle( env.normalizeTitle(env.page.name), '' );
		var tpr = new TemplateRequest( env, target, env.page.id );
		tpr.once('src', function( err, src_and_metadata ) {
			if ( err ) {
				env.log("error", "There was an error fetching " +
						"the original wikitext for ", target, err);
			} else {
				env.setPageSrcInfo( src_and_metadata );
			}
			resolve();
		});
	}).then(function() {
		var doc = DU.parseHTML( html.replace(/\r/g, '') );
		var serializer = new Serializer({ env: env, oldid: env.page.id });
		return Promise.promisify( serializer.serializeDOM, false, serializer )(
			doc.body, function( chunk ) { out.push( chunk ); }, false
		);
	}).then(function() {
		apiUtils.setHeader(res, env, 'Content-Type', 'text/x-mediawiki; charset=UTF-8');
		apiUtils.setHeader(res, env, 'X-Parsoid-Performance', env.getPerformanceHeader());
		apiUtils.endResponse(res, env, out.join(''));
	}).catch(function( err ) {
		env.log("fatal/request", err);
	});
};

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
		apiUtils.setHeader( res, env, 'Access-Control-Allow-Origin',
							env.conf.parsoid.allowCORS );
	}

	function sendRes( doc ) {
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
	}

	function hasWt( wt ) {
		env.log('info', 'starting parsing');
		// Set the source
		env.setPageSrcInfo( wt );
		return new Promise(function( resolve, reject ) {
			var parser = env.pipelineFactory.getPipeline('text/x-mediawiki/full');
			parser.once('document', function( doc ) {
				// Don't cache requests when wt is set in case somebody uses
				// GET for wikitext parsing
				apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
				resolve( req.body.body ? doc.body : doc );
			});
			parser.processToplevelDoc( wt );
		}).then( sendRes );
	}

	function hasHtmlAndOldid( src_and_metadata ) {
		env.log('info', 'starting parsing');
		if ( !req.headers.cookie ) {
			apiUtils.setHeader(res, env, 'Cache-Control', 's-maxage=2592000');
		} else {
			// Don't cache requests with a session
			apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
		}
		// Indicate the MediaWiki revision in a header as well for
		// ease of extraction in clients.
		apiUtils.setHeader(res, env, 'content-revision-id', oldid);
		return parse( env, req, res, src_and_metadata ).then( sendRes );
	}

	function hasHtmlWithoutOldid( src_and_metadata ) {
		// Don't cache requests with no oldid
		apiUtils.setHeader(res, env, 'Cache-Control', 'private,no-cache,s-maxage=0');
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
		apiUtils.relativeRedirect({ "path": path, "res": res, "env": env });
		env.log("info", "redirected to revision", env.page.meta.revision.revid);
	}

	var p;
	if ( wt && (!res.local('pageName') || !oldid) ) {
		// clear default page name
		env.page.name = '';

		// don't fetch the page source
		p = Promise.resolve( wt.replace(/\r/g, '') );
	} else {
		p = promiseTemplateReq( env, target, oldid );
	}

	if ( wt ) {
		p = p.then( hasWt );
	} else if ( oldid ) {
		p = p.then( hasHtmlAndOldid );
	} else {
		p = p.then( hasHtmlWithoutOldid );
	}

	return p.catch(function( err ) {
		env.log("fatal/request", err);
	});
}

// Middlewares

routes.interParams = function( req, res, next ) {
	res.local('iwp', req.params[0] || parsoidConfig.defaultWiki || '');
	res.local('pageName', req.params[1] || '');
	res.local('oldid', req.query.oldid || null);
	next();
};

routes.parserEnvMw = function( req, res, next ) {
	Promise.promisify( MWParserEnv.getParserEnv, false, MWParserEnv )(
		parsoidConfig,
		null,
		res.local('iwp'),
		res.local('pageName'),
		req.headers.cookie
	).then(function( env ) {
		env.logger.registerBackend(/fatal(\/.*)?/, errBack.bind(this, env, req, res));
		res.local('env', env);
		next();
	}).catch(function( err ) {
		errBack( {}, req, res, new LogData(null, "error", err) );
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
routes.roundtripTesting = function( req, res ) {
	var env = res.local('env');
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	req.connection.setTimeout(300 * 1000);
	env.log('info', 'starting parsing');

	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}

	promiseTemplateReq( env, target, oldid ).then(
		parse.bind( null, env, req, res )
	).then(
		roundTripDiff.bind( null, env, req, res, false )
	).catch(function(err) {
		env.log("fatal/request", err);
	});
};

// Round-trip article testing with newline stripping for editor-created HTML
// simulation
routes.roundtripTestingNL = function( req, res ) {
	var env = res.local('env');
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	env.log('info', 'starting parsing');
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}

	promiseTemplateReq( env, target, oldid ).then(
		parse.bind( null, env, req, res )
	).then(function( doc ) {
		// strip newlines from the html
		var html = doc.innerHTML.replace(/[\r\n]/g, '');
		return roundTripDiff( env, req, res, false, DU.parseHTML(html) );
	}).catch(function(err) {
		env.log("fatal/request", err);
	});
};

// Round-trip article testing with selser over re-parsed HTML.
routes.roundtripSelser = function( req, res ) {
	var env = res.local('env');
	var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

	env.log('info', 'starting parsing');
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}

	promiseTemplateReq( env, target, oldid ).then(
		parse.bind( null, env, req, res )
	).then(function( doc ) {
		doc = DU.parseHTML( DU.serializeNode(doc) );
		var comment = doc.createComment('rtSelserEditTestComment');
		doc.body.appendChild(comment);
		return roundTripDiff( env, req, res, true, doc );
	}).catch(function(err) {
		env.log("fatal/request", err);
	});
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
	// we don't care about \r, and normalize everything to \n
	parse( env, req, res, {
		revision: { '*': req.body.content.replace(/\r/g, '') }
	}).then(
		roundTripDiff.bind( null, env, req, res, false )
	).catch(function(err) {
		env.log("fatal/request", err);
	});
};

routes.get_article = function( req, res ) {
	// Regular article parsing
	wt2html( req, res );
};

routes.post_article = function( req, res ) {
	var body = req.body;
	if ( req.body.wt ) {
		// Form-based article parsing
		wt2html( req, res, body.wt );
	} else {
		// Regular and form-based article serialization
		html2wt( req, res, body.html || body.content || '' );
	}
};


// v2 Routes


// Regular article parsing
routes.v2_wt2html = function( req, res ) {
	var v2 = { format: res.local("format") };
	if ( v2.format === "pagebundle" ) {
		res.local('env').conf.parsoid.storeDataParsoid = true;
	}
	wt2html( req, res, null, v2 );
};


return routes;

};
