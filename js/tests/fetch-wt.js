#!/usr/bin/env node
"use strict";

/** Fetch the wikitext for a page, given title or revision id.
 *
 *  This is very useful for extracting test cases which can then be passed
 *  to tests/parse.js
 */

var fs = require( 'fs' ),
	optimist = require( 'optimist' ),
	TemplateRequest = require( '../lib/mediawiki.ApiRequest.js' ).TemplateRequest,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig' ).ParsoidConfig,
	MWParserEnvironment = require( '../lib/mediawiki.parser.environment.js' ).MWParserEnvironment;


var fetch = function ( page, revid, cb, options ) {
	cb = typeof cb === 'function' ? cb : function () {};

	var envCb = function ( err, env ) {
		env.errCB = function ( error ) {
			cb( error, env, [] );
		};
		if ( err !== null ) {
			env.errCB( err );
			return;
		}

		var target = page ? env.resolveTitle( env.normalizeTitle( env.page.name ), '' ) : null;
		var tpr = new TemplateRequest( env, target, revid );

		tpr.once( 'src', function ( err, src_and_metadata ) {
			if ( err ) {
				cb( err, env, [] );
			} else {
				env.setPageSrcInfo( src_and_metadata );

				// ok, got it
				if ( options.output ) {
					fs.writeFileSync( options.output, env.page.src, 'utf8');
				} else {
					console.log( env.page.src );
				}
			}
		} );
	};

	var prefix = options.prefix || null;

	if ( options.apiURL ) {
		prefix = 'customwiki';
	}

	var parsoidConfig = new ParsoidConfig( options, { defaultWiki: prefix } );

	if ( options.apiURL ) {
		parsoidConfig.setInterwiki( 'customwiki', options.apiURL );
	}

	MWParserEnvironment.getParserEnv( parsoidConfig, null, prefix, page, null, envCb );
};

var usage = 'Usage: $0 [options] <page-title or rev-id>\n' +
	'If first argument is numeric, it is used as a rev id; otherwise it is\n' +
	'used as a title.  Use the --title option for a numeric title.';
var opts = optimist.usage( usage, {
	'output': {
		description: "Write page to given file"
	},
	'prefix': {
		description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
		'boolean': false,
		'default': 'enwiki'
	},
	'revid': {
		description: 'Page revision to fetch',
		'boolean': false
	},
	'title': {
		description: 'Page title to fetch (only if revid is not present)',
		'boolean': false
	},
	'help': {
		description: 'Show this message',
		'boolean': true,
		'default': false
	}
});

var argv = opts.argv;
var title = null, revid = null;
var error;
if (argv.title && argv.revid) {
	error = "Can't specify title and revid at the same time.";
} else if (argv.title) {
	title = '' + argv.title; // convert, in case it's numeric.
} else if (argv.revid) {
	revid = +argv.revid;
} else if (typeof(argv._[0]) === 'number') {
	revid = argv._[0];
} else if (argv._[0]) {
	title = argv._[0];
} else {
	error = "Must specify a title or revision id.";
}

if (argv.help || error) {
	if (error) {
		// Make the error standout in the output
		var buf = ["-------"];
		for (var i = 0; i < error.length; i++) {
			buf.push("-");
		}
		buf = buf.join('');
		console.error(buf);
		console.error('ERROR:', error);
		console.error(buf);
	}
	optimist.showHelp();
	return;
}

fetch(title, revid, null, argv);
