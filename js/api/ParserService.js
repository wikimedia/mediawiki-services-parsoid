/**
 * A very basic parser / serializer web service.
 *
 * Local configuration:
 *
 * To configure locally, add localsettings.js to this directory and export a setup function.
 *
 * @example
 *    exports.setup = function( config, env ) {
 *        env.setInterwiki( 'localhost', 'http://localhost/wiki' );
 *    };
 */

/**
 * Config section
 *
 * Could move this to a separate file later.
 */

var config = {};

/**
 * End config section
 */

// global includes
var express = require('express'),
	jsDiff = require('diff'),
	childProc = require('child_process'),
	spawn = childProc.spawn,
	fork = childProc.fork,
	html5 = require('html5'),
	path = require('path'),
	cluster = require('cluster');

// local includes
var mp = '../lib/',
	lsp = __dirname + '/localsettings.js',
	localSettings = require( lsp );

var instanceName = cluster.isWorker ? 'worker(' + process.pid + ')' : 'master';

console.log( ' - ' + instanceName + ' loading...' );

var WikitextSerializer = require(mp + 'mediawiki.WikitextSerializer.js').WikitextSerializer,
	Util = require( mp + 'mediawiki.Util.js' ).Util,
	libtr = require(mp + 'mediawiki.ApiRequest.js'),
	DoesNotExistError = libtr.DoesNotExistError,
	ParserError = libtr.ParserError,
	TemplateRequest = libtr.TemplateRequest;

var interwikiRE;
function getInterwikiRE() {
	// this RE won't change -- so, cache it
	if (!interwikiRE) {
		interwikiRE = Util.getParserEnv( localSettings, config ).interwikiRegexp;
	}
	return interwikiRE;
}

/**
 * Set up environment defaults for the default wiki
 */
function setDefaultWiki ( config, env ) {
	var interwiki = 'en';
	if ( config && config.defaultInterwiki ) {
		interwiki = config.defaultInterwiki;
	}
	env.wgScript = env.interwikiMap[interwiki];
}

/**
 * Perform word-based diff on a line-based diff. The word-based algorithm is
 * practically unusable for inputs > 5k bytes, so we only perform it on the
 * output of the more efficient line-based diff.
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

var roundTripDiff = function ( req, res, src, document ) {
	var env = Util.getParserEnv( localSettings );
	var out, patch;
	res.write('<html><head><script type="text/javascript" src="/jquery.js"></script><script type="text/javascript" src="/scrolling.js"></script><style>ins { background: #ff9191; text-decoration: none; } del { background: #99ff7e; text-decoration: none }; </style></head><body>');
	res.write( '<h2>Wikitext parsed to HTML DOM</h2><hr>\n' );
	res.write(document.body.innerHTML + '\n<hr>');
	res.write( '<h2>HTML DOM converted back to Wikitext</h2><hr>\n' );
	out = new WikitextSerializer({env: env}).serializeDOM( document.body );
	if ( out === undefined ) {
		out = "An error occured in the WikitextSerializer, please check the log for information";
		res.send( out, 500 );
		return;
	}
	res.write('<pre>' + htmlSpecialChars( out ) + '</pre><hr>\n');
	res.write( '<h2>Diff between original Wikitext (green) and round-tripped wikitext (red)</h2><p>(use shift+alt+n and shift+alt+p to navigate forward and backward)<hr>\n' );
	src = src.replace(/\n(?=\n)/g, '\n ');
	out = out.replace(/\n(?=\n)/g, '\n ');
	//console.log(JSON.stringify( jsDiff.diffLines( out, src ) ));
	patch = jsDiff.convertChangesToXML( jsDiff.diffLines( src, out ) );
	//patch = jsDiff.convertChangesToXML( refineDiff( jsDiff.diffLines( src, out ) ) );
	res.write( '<pre>' + patch);
	// Add a 'report issue' link
	res.end('<hr><h2>'+
			'<a style="color: red" ' +
			'href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo' +
			'&action=edit&section=new&preloadtitle=' +
			'Issue%20on%20http://parsoid.wmflabs.org' + req.url + '">' +
			'Report a parser issue in this page</a> at ' +
			'<a href="http://www.mediawiki.org/wiki/Talk:Parsoid/Todo">'+
			'[[:mw:Talk:Parsoid/Todo]]</a></h2><hr>');
};

var parse = function ( env, req, res, cb, err, src ) {
	var newCb = function ( src, err, doc ) {
		if ( err !== null ) {
			if ( !err.code ) {
				err.code = 500;
			}
			res.send( err.toString(), err.code );
		} else {
			res.setHeader('Content-Type', 'text/html; charset=UTF-8');
			cb( req, res, src, doc );
		};
	};

	Util.parse( env, newCb, err, src );
};

var htmlSpecialChars = function ( s ) {
	return s.replace(/&/g,'&amp;')
		.replace(/</g,'&lt;')
		.replace(/"/g,'&quot;')
		.replace(/'/g,'&#039;');
};

var textarea = function ( res, content ) {
	res.write('<form method=POST><textarea name="content" cols=90 rows=9>');
	res.write( ( content &&
					htmlSpecialChars( content) ) ||
			'');
	res.write('</textarea><br><input type="submit"></form>');
};

/* -------------------- web app access points below --------------------- */

var app = express.createServer();
app.use(express.bodyParser());

app.get('/', function(req, res){
	res.write('<body><h3>Welcome to the alpha test web service for the ' +
		'<a href="http://www.mediawiki.org/wiki/Parsoid">Parsoid project<a>.</h3>');
	res.write( '<p>Usage: <ul><li>GET /title for the DOM. ' +
		'Example: <strong><a href="/en/Main_Page">Main Page</a></strong>');
	res.write('<li>POST a DOM as parameter "content" to /title for the wikitext</ul>');
	res.write('<p>There are also some tools for experiments:<ul>');
	res.write('<li>Round-trip test pages from the English Wikipedia: ' +
		'<strong><a href="/_rt/en/Help:Magic">/_rt/Help:Magic</a></strong></li>');
	res.write('<li><strong><a href="/_rtform/">WikiText -&gt; HTML DOM -&gt; WikiText round-trip form</a></strong></li>');
	res.write('<li><strong><a href="/_wikitext/">WikiText -&gt; HTML DOM form</a></strong></li>' +
			'<li><strong><a href="/_html/">HTML DOM -&gt; WikiText form</a></strong></li>');
	res.write('</ul>');
	res.end('<p>We are currently focusing on round-tripping of basic formatting like inline/bold, headings, lists, tables and links. Templates, citations and thumbnails are not expected to round-trip properly yet. <strong>Please report issues you see at <a href="http://www.mediawiki.org/w/index.php?title=Talk:Parsoid/Todo&action=edit&section=new">:mw:Talk:Parsoid/Todo</a>. Thanks!</strong></p>');
});


var getParserEnv = function ( options, res ) {
	var env = Util.getParserEnv( localSettings );
	env.errCB = function ( e ) {
		console.log( e );
		res.send( e.toString(), 500 );
		// Force a clean restart of this worker
		process.exit(1);
	};
	return env;
};


/**
 * robots.txt: no indexing.
 */
app.get(/^\/robots.txt$/, function ( req, res ) {
	res.end( "User-agent: *\nDisallow: /\n" );
});

/**
 * Redirects for old-style URL compatibility
 */
app.get( new RegExp( '^/((?:_rt|_rtve)/)?(' + getInterwikiRE() +
				'):(.*)$' ), function ( req, res ) {
	if ( req.params[0] ) {
		res.redirect(  '/' + req.params[0] + req.params[1] + '/' + req.params[2]);
	} else {
		res.redirect( '/' + req.params[1] + '/' + req.params[2]);
	}
	res.end( );
});


/**
 * Form-based HTML DOM -> wikitext interface for manual testing
 */
app.get(/\/_html\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[0] );
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write( "Your HTML DOM:" );
	textarea( res );
	res.end('');
});

app.post(/\/_html\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[0] );
	setDefaultWiki( config, env );
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	var p = new html5.Parser();
	p.parse( '<html><body>' + req.body.content.replace(/\r/g, '') + '</body></html>' );
	res.write('<pre style="background-color: #efefef">');
	new WikitextSerializer({env: env}).serializeDOM(
		p.tree.document.childNodes[0].childNodes[1],
		function( c ) {
			res.write( htmlSpecialChars( c ) );
		});
	res.write('</pre>');
	res.write( "<hr>Your HTML DOM:" );
	textarea( res, req.body.content.replace(/\r/g, '') );
	res.end('');
});

/**
 * Form-based wikitext -> HTML DOM interface for manual testing
 */
app.get(/\/_wikitext\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[0] );
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write( "Your wikitext:" );
	textarea( res );
	res.end('');
});
app.post(/\/_wikitext\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[0] );
	setDefaultWiki( config, env );
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	var parser = Util.getParser(env, 'text/x-mediawiki/full');
	parser.on('document', function ( document ) {
		res.write(document.body.innerHTML);
		//res.write('<form method=POST><input name="content"></form>');
		//res.end("hello world\n" + req.method + ' ' + req.params.title);
		res.write( "<hr>Your wikitext:" );
		textarea( res, req.body.content.replace(/\r/g, '') );
		res.end('');
	});
	try {
		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		console.log('starting parsing of ' + req.params[0]);
		// FIXME: This does not handle includes or templates correctly
		env.text = req.body.content;
		parser.process( req.body.content.replace(/\r/g, '') );
	} catch (e) {
		env.errCB(e);
	}
});

/**
 * Round-trip article testing
 */
app.get( new RegExp('/_rt/(' + getInterwikiRE() + ')/(.*)'), function(req, res) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[1] );
	env.wgScriptPath = '/_rt/' + req.params[0] + '/';
	env.wgScript = env.interwikiMap[req.params[0]];

	if ( env.pageName === 'favicon.ico' ) {
		res.send( 'no favicon yet..', 404 );
		return;
	}

	var target = env.resolveTitle( env.normalizeTitle( env.pageName ), '' );

	console.log('starting parsing of ' + target);
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid );
	tpr.once('src', parse.bind( null, env, req, res, roundTripDiff ));
});

/**
 * Round-trip article testing with newline stripping for editor-created HTML
 * simulation
 */
app.get( new RegExp('/_rtve/(' + getInterwikiRE() + ')/(.*)') , function(req, res) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[1] );
	env.wgScriptPath = '/_rtve/' + req.params[0] + '/';
	env.wgScript = env.interwikiMap[req.params[0]];

	if ( env.pageName === 'favicon.ico' ) {
		res.send( 'no favicon yet..', 404 );
		return;
	}

	var target = env.resolveTitle( env.normalizeTitle( env.pageName ), '' );

	console.log('starting parsing of ' + target);
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid ),
		cb = function ( req, res, src, document ) {
			// strip newlines from the html
			var html = document.innerHTML.replace(/[\r\n]/g, ''),
				p = new html5.Parser();
			p.parse( html );
			var newDocument = p.tree.document;
			// monkey-patch document.body reference for now..
			newDocument.body = newDocument.childNodes[0].childNodes[1];
			roundTripDiff( req, res, src, newDocument );
		};

	tpr.once('src', parse.bind( null, env, req, res, cb ));
});

/**
 * Form-based round-tripping for manual testing
 */
app.get(/\/_rtform\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[0] );
	setDefaultWiki( config, env );
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write( "Your wikitext:" );
	textarea( res );
	res.end('');
});

app.post(/\/_rtform\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName ( req.params[0] );
	setDefaultWiki( config, env );
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	// we don't care about \r, and normalize everything to \n
	parse( env, req, res, roundTripDiff, null, req.body.content.replace(/\r/g, ''));
});

/**
 * Regular article parsing
 */
app.get(new RegExp( '/(' + getInterwikiRE() + ')/(.*)' ), function(req, res) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[1] );
	env.wgScriptPath = '/' + req.params[0] + '/';
	env.wgScript = env.interwikiMap[req.params[0]];
	if ( env.pageName === 'favicon.ico' ) {
		res.send( 'no favicon yet..', 404 );
		return;
	}
	var target = env.resolveTitle( env.normalizeTitle( env.pageName ), '' );

	var st = new Date();
	console.log('starting parsing of ' + target);
	var oldid = null;
	if ( req.query.oldid ) {
		oldid = req.query.oldid;
	}
	var tpr = new TemplateRequest( env, target, oldid );
	tpr.once('src', parse.bind( null, env, req, res, function ( req, res, src, document ) {
		res.end(document.body.innerHTML);
		var et = new Date();
		console.warn("completed parsing of " + target + " in " + (et - st) + " ms");
	}));
});

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

/**
 * Regular article serialization using POST
 */
app.post(/\/(.*)/, function ( req, res ) {
	var env = getParserEnv( localSettings, res );
	env.setPageName( req.params[0] );
	env.wgScriptPath = '/';
	setDefaultWiki( config, env );
	res.setHeader('Content-Type', 'text/x-mediawiki; charset=UTF-8');
	var p = new html5.Parser();
	p.parse( req.body.content );
	new WikitextSerializer({env: env}).serializeDOM(
		p.tree.document.childNodes[0].childNodes[1],
		res.write.bind( res ) );
	res.end('');
});

app.use( express.static( __dirname + '/scripts' ) );

console.log( ' - ' + instanceName + ' ready' );

module.exports = app;
