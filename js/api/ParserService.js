/*
 * A very basic parser / serializer web service.
 *
 * Local configuration:
 *
 * To configure locally, add localsettings.js to this directory and export a setup function.
 *
 * example:
 *	exports.setup = function( config, env ) {
 *		env.setInterwiki( 'localhost', 'http://localhost/wiki' );
 *	};
 */

/**
 * @class ParserServiceModule
 * @singleton
 * @private
 */

// global includes
var express = require('express'),
	jsDiff = require('diff'),
	childProc = require('child_process'),
	spawn = childProc.spawn,
	cluster = require('cluster'),
	fs = require('fs');

// local includes
var mp = '../lib/';

var lsp, localSettings;

try {
	lsp = __dirname + '/localsettings.js';
	localSettings = require( lsp );
} catch ( e ) {
	// Build a skeleton localSettings to prevent errors later.
	localSettings = {
		setup: function ( pconf ) {}
	};
}

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
 * The global parsoid configuration object.
 * @property {ParsoidConfig}
 */
var parsoidConfig = new ParsoidConfig( localSettings, null );

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
 * @param {string} content The content we should put in the textarea
 */
var textarea = function ( res, content ) {
	res.write('<form method=POST><textarea name="content" cols=90 rows=9>');
	res.write( ( content &&
					htmlSpecialChars( content) ) ||
			'');
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

var roundTripDiff = function ( req, res, env, document ) {
	var patch;
	var out = [];

	var finalCB =  function () {
		var i;
		// XXX TODO FIXME BBQ There should be an error callback in SelSer.
		out = out.join('');
		if ( out === undefined ) {
			console.log( 'Serializer error!' );
			out = "An error occured in the WikitextSerializer, please check the log for information";
			res.send( out, 500 );
			return;
		}
		res.write('<html><head>\n');
		res.write('<script type="text/javascript" src="/jquery.js"></script><script type="text/javascript" src="/scrolling.js"></script><style>ins { background: #ff9191; text-decoration: none; } del { background: #99ff7e; text-decoration: none }; </style>\n');
		// Emit base href so all relative urls resolve properly
		var headNodes = document.firstChild.firstChild.childNodes;
		for (i = 0; i < headNodes.length; i++) {
			if (headNodes[i].nodeName.toLowerCase() === 'base') {
				res.write(Util.serializeNode(headNodes[i]));
				break;
			}
		}
		res.write('</head><body>\n');
		res.write( '<h2>Wikitext parsed to HTML DOM</h2><hr>\n' );
		var bodyNodes = document.body.childNodes;
		for (i = 0; i < bodyNodes.length; i++) {
			res.write(Util.serializeNode(bodyNodes[i]));
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
		res.end('\n</body></html>');
	};

	// Always use the regular serializer for round-trip diff tests
	// since these will never have any edits for selser to do any work.
	new WikitextSerializer({env: env}).serializeDOM( document.body,
				function ( chunk ) {
					out.push(chunk);
				}, finalCB );
};

function handleCacheRequest (env, req, cb, err, src, cacheErr, cacheSrc) {
	if (cacheErr) {
		// No luck with the cache request, just proceed as normal.
		Util.parse(env, cb, err, src);
		return;
	}
	// Extract transclusion and extension content from the DOM
	var expansions = DU.extractExpansions(Util.parseHTML(cacheSrc));

	// Figure out what we can reuse
	var parsoidHeader = JSON.parse(req.headers['x-parsoid'] || '{}');
	if (parsoidHeader.cacheID) {
		if (parsoidHeader.mode === 'templatelinks') {
			// Transclusions need to be updated, so don't reuse them.
			expansions.transclusions = undefined;
		} /*else if (parsoidHeader.mode === 'files') {
			// Files need to be refreshed
			// TODO: actually handle files
		} */
	}

	// pass those expansions into Util.parse to prime the caches.
	//console.log('expansions:', expansions);
	Util.parse(env, cb, null, src, expansions);
}

var parse = function ( env, req, res, cb, err, src_and_metadata ) {
	var newCb = function ( src, err, doc ) {
		if ( err !== null ) {
			if ( !err.code ) {
				err.code = 500;
			}
			console.error( err.stack || err.toString() );
			res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
			res.send( err.stack || err.toString(), err.code );
			return;
		} else {
			res.setHeader('Content-Type', 'text/html; charset=UTF-8');
			cb( req, res, src, doc );
		}
	};

	// Set the source
	env.setPageSrcInfo( src_and_metadata );

	// Now env.page.meta.title has the canonical title, and
	// env.page.meta.revision.parentid has the predecessor oldid

	// See if we can reuse transclusion or extension expansions.
	if (!err && env.conf.parsoid.parsoidCacheURI &&
			// Don't enter an infinite request loop.
			! /only-if-cached/.test(req.headers['cache-control']))
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
				handleCacheRequest.bind(null, env, req, newCb, err, env.page.src));
	} else {
		handleCacheRequest(env, req, newCb, err, env.page.src, "Recursive request", null);
	}
};

/* -------------------- web app access points below --------------------- */

var app = express.createServer();
// Increase the form field size limit from the 2M default.
app.use(express.bodyParser({maxFieldsSize: 15 * 1024 * 1024}));

app.get('/', function(req, res){
	res.write('<html><body>\n');
	res.write('<h3>Welcome to the alpha test web service for the ' +
		'<a href="http://www.mediawiki.org/wiki/Parsoid">Parsoid project</a>.</h3>\n');
	res.write( '<p>Usage: <ul><li>GET /title for the DOM. ' +
		'Example: <strong><a href="/en/Main_Page">Main Page</a></strong></li>\n');
	res.write('<li>POST a DOM as parameter "content" to /title for the wikitext</li>\n');
	res.write('</ul>\n');
	res.write('<p>There are also some tools for experiments:\n<ul>\n');
	res.write('<li>Round-trip test pages from the English Wikipedia: ' +
		'<strong><a href="/_rt/en/Help:Magic">/_rt/Help:Magic</a></strong></li>\n');
	res.write('<li><strong><a href="/_rtform/">WikiText -&gt; HTML DOM -&gt; WikiText round-trip form</a></strong></li>\n');
	res.write('<li><strong><a href="/_wikitext/">WikiText -&gt; HTML DOM form</a></strong></li>\n');
	res.write('<li><strong><a href="/_html/">HTML DOM -&gt; WikiText form</a></strong></li>\n');
	res.write('</ul>\n');
	res.write('<p>We are currently focusing on round-tripping of basic formatting like inline/bold, headings, lists, tables and links. Templates, citations and thumbnails are not expected to round-trip properly yet. <strong>Please report issues you see at <a href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo&action=edit&section=new">:mw:Talk:Parsoid/Todo</a>. Thanks!</strong></p>\n');
	res.end('</body></html>');
});


var getParserServiceEnv = function ( res, iwp, pageName, cb ) {
	MWParserEnvironment.getParserEnv( parsoidConfig, null, iwp || '', pageName, function ( err, env ) {
		env.errCB = function ( e ) {
			var errmsg = e.stack || e.toString();
			var code = e.code || 500;
			console.error( 'ERROR in ' + pageName + ':\n' + e.message);
			console.error("Stack trace: " + errmsg);
			res.send( errmsg, code );
			// Force a clean restart of this worker
			process.exit(1);
		};
		if ( err === null ) {
			cb( env );
		} else {
			env.errCB( err );
		}
	} );
};

// robots.txt: no indexing.
app.get(/^\/robots.txt$/, function ( req, res ) {
	res.end( "User-agent: *\nDisallow: /\n" );
});

// Redirects for old-style URL compatibility
app.get( new RegExp( '^/((?:_rt|_rtve)/)?(' + getInterwikiRE() +
				'):(.*)$' ), function ( req, res ) {
	if ( req.params[0] ) {
		res.redirect(  '/' + req.params[0] + req.params[1] + '/' + req.params[2]);
	} else {
		res.redirect( '/' + req.params[1] + '/' + req.params[2]);
	}
	res.end( );
});

// Bug report posts
app.post( /^\/_bugs\//, function ( req, res ) {
	console.log( '_bugs', req.body.data );
	try {
		var data = JSON.parse( req.body.data ),
			filename = '/mnt/bugs/' +
				new Date().toISOString() +
				'-' + encodeURIComponent(data.title);
		console.log( filename, data );
		fs.writeFile(filename, req.body.data, function(err) {
			if(err) {
				console.error(err);
			} else {
				console.log("The file " + filename + " was saved!");
			}
		});
	} catch ( e ) {
	}
	res.end( );
});


// Form-based HTML DOM -> wikitext interface for manual testing
app.get(/\/_html\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your HTML DOM:" );
		textarea( res );
		res.end('');
	};

	getParserServiceEnv( res, null, req.params[0], cb );
} );

app.post(/\/_html\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		var doc = Util.parseHTML(req.body.content.replace(/\r/g, ''));
		res.write('<pre style="background-color: #efefef">');
		// Always use the non-selective serializer for this mode
		new WikitextSerializer({env: env}).serializeDOM(
			doc.body,
			function( c ) {
				res.write( htmlSpecialChars( c ) );
			},
			function() {
				res.write('</pre>');
				res.write( "<hr>Your HTML DOM:" );
				textarea( res, req.body.content.replace(/\r/g, '') );
				res.end('');
			}
			);
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
} );

// Form-based wikitext -> HTML DOM interface for manual testing
app.get(/\/_wikitext\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your wikitext:" );
		textarea( res );
		res.end('');
	};

	getParserServiceEnv( res, null, req.params[0], cb );
} );

app.post(/\/_wikitext\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		var parser = Util.getParserPipeline(env, 'text/x-mediawiki/full'),
			src = req.body.content.replace(/\r/g, '');
		parser.on('document', function ( document ) {
			if (req.body.format==='html') {
				res.write(Util.serializeNode(document));
			} else {
				res.write('<pre style="white-space: pre-wrap; white-space: -moz-pre-wrap; white-space: -pre-wrap; white-space: -o-pre-wrap; word-wrap: break-word;">');
				res.write(htmlSpecialChars(document.body.innerHTML));
				res.write('</pre>');
				res.write('<hr/>');
				res.write(document.body.innerHTML);
				res.write('<hr style="clear:both;"/>Your wikitext:');
				textarea( res, src );
			}
			res.end('');
		});
		if (env.conf.parsoid.allowCORS) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			res.setHeader('Access-Control-Allow-Origin',
						  env.conf.parsoid.allowCORS);
		}
		try {
			console.log('starting parsing of ' + req.params[0]);
			// FIXME: This does not handle includes or templates correctly
			env.setPageSrcInfo( src );
			parser.processToplevelDoc( src );
		} catch (e) {
			res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
			console.error( e.stack || e.toString() );
			res.send( e.stack || e.toString(), 500 );
		}
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
} );

// Round-trip article testing
app.get( new RegExp('/_rt/(' + getInterwikiRE() + ')/(.*)'), function(req, res) {
	var cb = function ( env ) {
		req.connection.setTimeout(300 * 1000);

		if ( env.page.name === 'favicon.ico' ) {
			res.send( 'no favicon yet..', 404 );
			return;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		console.log('starting parsing of ' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', parse.bind( tpr, env, req, res, roundTripDiff ));
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
} );

// Round-trip article testing with newline stripping for editor-created HTML
// simulation
app.get( new RegExp('/_rtve/(' + getInterwikiRE() + ')/(.*)') , function(req, res) {
	var cb = function ( env ) {
		if ( env.page.name === 'favicon.ico' ) {
			res.send( 'no favicon yet..', 404 );
			return;
		}

		var target = env.page.title;

		console.log('starting parsing of ' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
		}
		var tpr = new TemplateRequest( env, target, oldid ),
			cb = function ( req, res, src, document ) {
				// strip newlines from the html
				var html = document.innerHTML.replace(/[\r\n]/g, ''),
					newDocument = Util.parseHTML(html);
				roundTripDiff( req, res, src, newDocument );
			};

		tpr.once('src', parse.bind( tpr, env, req, res, cb ));
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
});

// Form-based round-tripping for manual testing
app.get(/\/_rtform\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.write( "Your wikitext:" );
		textarea( res );
		res.end('');
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
});

app.post(/\/_rtform\/(.*)/, function ( req, res ) {
	var cb = function ( env ) {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		// we don't care about \r, and normalize everything to \n
		parse( env, req, res, roundTripDiff, null, {
			revision: { '*': req.body.content.replace(/\r/g, '') }
		});
	};

	getParserServiceEnv( res, parsoidConfig.defaultWiki, req.params[0], cb );
} );

// Regular article parsing
app.get(new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), function(req, res) {
	// TODO gwicke: re-enable this when actually using Varnish
	//if (/only-if-cached/.test(req.headers['cache-control'])) {
	//	res.send( 'Clearly not cached since this request reached Parsoid. Please fix Varnish.',
	//		404 );
	//	return;
	//}

	var cb = function ( env ) {
		if ( env.page.name === 'favicon.ico' ) {
			res.send( 'no favicon yet..', 404 );
			return;
		}
		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );

		// Set the timeout to 900 seconds..
		req.connection.setTimeout(900 * 1000);

		var st = new Date();
		console.log('starting parsing of ' + prefix + ':' + target);
		var oldid = null;
		if ( req.query.oldid ) {
			oldid = req.query.oldid;
			res.setHeader('Cache-Control', 's-maxage=2592000');
		}
		if (env.conf.parsoid.allowCORS) {
			// allow cross-domain requests (CORS) so that parsoid service
			// can be used by third-party sites
			res.setHeader('Access-Control-Allow-Origin',
						  env.conf.parsoid.allowCORS);
		}

		var tpr = new TemplateRequest( env, target, oldid );
		tpr.once('src', parse.bind( null, env, req, res, function ( req, res, src, doc ) {
			res.end(Util.serializeNode(doc.documentElement));
			var et = new Date();
			console.warn("completed parsing of " + prefix +
				':' + target + " in " + (et - st) + " ms");
		}));
	};

	var prefix = req.params[0];
	getParserServiceEnv( res, prefix, req.params[1], cb );
} );

// Regular article serialization using POST
app.post( new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), function ( req, res ) {
	var cb = function ( env ) {
		var doc, oldid = req.body.oldid || null;
		env.page.id = oldid;

		res.setHeader('Content-Type', 'text/x-mediawiki; charset=UTF-8');

		try {
			doc = Util.parseHTML(req.body.content);
		} catch ( e ) {
			console.log( 'There was an error in the HTML5 parser! Sending it back to the editor.' );
			env.errCB(e);
			return;
		}

		try {
			var out = [];
			new Serializer( { env: env, oldid: env.page.id } ).serializeDOM(
				doc.body,
				function ( chunk ) {
					out.push(chunk);
				}, function () {
					res.write( out.join('') );
					res.end('');
				} );
		} catch ( e ) {
			env.errCB( e );
		}
	};

	getParserServiceEnv( res, req.params[0], req.params[1], cb );
} );

/**
 * Continuous integration end points
 *
 * No longer used currently, as our testing now happens on the central Jenkins
 * server.
 */
app.get( /\/_ci\/refs\/changes\/(\d+)\/(\d+)\/(\d+)/, function ( req, res ) {
	var gerritChange = 'refs/changes/' + req.params[0] + '/' + req.params[1] + '/' + req.params[2];
	var testSh = spawn( './testGerritChange.sh', [ gerritChange ], {
		cwd: '.'
	} );

	res.setHeader('Content-Type', 'text/xml; charset=UTF-8');

	testSh.stdout.on( 'data', function ( data ) {
		res.write( data );
	} );

	testSh.on( 'exit', function () {
		res.end( '' );
	} );
} );

app.get( /\/_ci\/master/, function ( req, res ) {
	var testSh = spawn( './testGerritMaster.sh', [], {
		cwd: '.'
	} );

	res.setHeader('Content-Type', 'text/xml; charset=UTF-8');

	testSh.stdout.on( 'data', function ( data ) {
		res.write( data );
	} );

	testSh.on( 'exit', function () {
		res.end( '' );
	} );
} );

app.use( express.static( __dirname + '/scripts' ) );
app.use( express.limit( '15mb' ) );

console.log( ' - ' + instanceName + ' ready' );

module.exports = app;

