#!/usr/bin/env node
"use strict";

var jsDiff = require( 'diff' ),
	optimist = require( 'optimist' ),
	zlib = require( 'zlib' ),

	Util = require( '../lib/mediawiki.Util.js' ).Util,
	WikitextSerializer = require( '../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	TemplateRequest = require( '../lib/mediawiki.ApiRequest.js' ).TemplateRequest,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig' ).ParsoidConfig,
	MWParserEnvironment = require( '../lib/mediawiki.parser.environment.js' ).MWParserEnvironment;

var plainCallback = function ( env, err, results ) {
	var i, result, output = '',
		semanticDiffs = 0, syntacticDiffs = 0,
		testDivider = ( new Array( 70 ) ).join( '=' ) + '\n',
		diffDivider = ( new Array( 70 ) ).join( '-' ) + '\n';

	if ( err ) {
		output += 'Parser failure!\n\n';
		output += diffDivider;
		output += err;
	} else {
		for ( i = 0; i < results.length; i++ ) {
			result = results[i];

			output += testDivider;
			if ( result.type === 'fail' ) {
				output += 'Semantic difference:\n\n';
				output += result.wtDiff + '\n';
				output += diffDivider;
				output += 'HTML diff:\n\n';
				output += result.htmlDiff + '\n';
				semanticDiffs++;
			} else {
				output += 'Syntactic difference:\n\n';
				output += result.wtDiff + '\n';
				syntacticDiffs++;
			}
		}


		output += testDivider;
		output += testDivider;
		output += "SUMMARY:\n";
		output += "Semantic differences : " + semanticDiffs + "\n";
		output += "Syntactic differences: " + syntacticDiffs + "\n";
		output += diffDivider;
		output += "ALL differences      : " + (semanticDiffs + syntacticDiffs) + "\n";
		output += testDivider;
		output += testDivider;
	}

	return output;
};

var xmlCallback = function ( env, err, results ) {
	var i, result;
	var prefix = ( env && env.wiki && env.wiki.iwp ) || '';
	var title = ( env && env.page && env.page.name ) || '';

	var output = '<testsuite name="Roundtrip article ' + Util.encodeXml( prefix + ':' + title ) + '">';

	if ( err ) {
		output += '<testcase name="entire article"><error type="parserFailedToFinish">';
		output += Util.encodeXml( err.stack || err.toString() );
		output += '</error></testcase>';
	} else {

		for ( i = 0; i < results.length; i++ ) {
			result = results[i];

			output += '<testcase name="' + Util.encodeXml( prefix + ':' + title ) + ' character ' + result.offset[0].start + '">';

			if ( result.type === 'fail' ) {
				output += '<failure type="significantHtmlDiff">\n';

				output += '<diff class="wt">\n';
				output += Util.encodeXml( result.wtDiff );
				output += '\n</diff>\n';

				output += '<diff class="html">\n';
				output += Util.encodeXml( result.htmlDiff );
				output += '\n</diff>\n';

				output += '</failure>\n';
			} else {
				output += '<skipped type="insignificantWikitextDiff">\n';
				output += Util.encodeXml( result.wtDiff );
				output += '\n</skipped>\n';
			}

			output += '</testcase>\n';
		}
	}

	// Output the profiling data
	if ( env.profile ) {
		output += '<perfstats>\n';
		for ( var type in env.profile ) {
			for ( var prop in env.profile[ type ] ) {
				output += '<perfstat type="' + Util.encodeXml( type ) + ':';
				output += Util.encodeXml( prop );
				output += '">';
				output += Util.encodeXml( env.profile[ type ][ prop ].toString() );
				output += '</perfstat>\n';
			}
		}
		output += '</perfstats>\n';
	}

	output += '</testsuite>\n';

	return output;
};

var findDsr = function (root, targetRange, sourceLen) {
	var currentOffset = null, wasWaiting = false, waitingForEndMatch = false;

	function walkDOM(element) {
		var j, matchedChildren, childAttribs, attribs, start, end,
			elements = [], precedingNodes = [];

		attribs = element.getAttribute( 'data-parsoid' );
		if ( attribs ) {
			attribs = JSON.parse( attribs );
		} else {
			attribs = {};
		}

		if ( attribs.dsr && attribs.dsr.length ) {
			start = attribs.dsr[0] || 0;
			end = attribs.dsr[1] || sourceLen - 1;

			if ( waitingForEndMatch ) {
				if ( end >= targetRange.end ) {
					waitingForEndMatch = false;
				}
				return { done: true, nodes: [element] };
			}

			if ( attribs.dsr[0] !== null && targetRange.start === start && end === targetRange.end ) {
				return { done: true, nodes: [element] };
			} else if ( targetRange.start === start ) {
				waitingForEndMatch = true;
			}

			if ( (targetRange.end - 1) < start ) {
				return null;
			} else if ( targetRange.start > (end - 1) ) {
				return null;
			}
		}

		var children = element.childNodes;
		for ( j = 0; j < children.length; j++ ) {
			var c = children[j];

			wasWaiting = waitingForEndMatch;
			if ( c.nodeType === c.ELEMENT_NODE ) {
				var res = walkDOM(c);
				matchedChildren = res ? res.nodes : null;
				if ( matchedChildren ) {
					if ( !currentOffset && attribs.dsr && (attribs.dsr[0] !== null) ) {
						var elesOnOffset = [];
						currentOffset = attribs.dsr[0];
						// Walk the preceding nodes without dsr values and prefix matchedChildren
						// till we get the desired matching start value.
						var diff = currentOffset - targetRange.start;
						while ( precedingNodes.length > 0 && diff > 0 ) {
							var n = precedingNodes.pop();
							var len = n.nodeValue.length + (n.nodeType === c.COMMENT_NODE ? 7 : 0);
							if ( len > diff ) {
								break;
							}
							diff -= len;
							elesOnOffset.push( n );
						}
						elesOnOffset.reverse();
						matchedChildren = elesOnOffset.concat( matchedChildren );
					}

					// Check if there's only one child, and make sure it's a node with getAttribute
					if ( matchedChildren.length === 1 && matchedChildren[0].nodeType === c.ELEMENT_NODE ) {
						childAttribs = matchedChildren[0].getAttribute( 'data-parsoid' );
						if ( childAttribs ) {
							childAttribs = JSON.parse( childAttribs );
							if ( childAttribs.dsr && childAttribs.dsr[1]) {
								if ( childAttribs.dsr[1] >= targetRange.end ) {
									res.done = true;
								} else {
									currentOffset = childAttribs.dsr[1];
								}
							}
						}
					}

					if (res.done) {
						res.nodes = matchedChildren;
						return res;
					} else {
						elements = matchedChildren;
					}
				} else if (wasWaiting || waitingForEndMatch) {
					elements.push(c);
				}

				// Clear out when an element node is encountered.
				precedingNodes = [];
			} else if ( c.nodeType === c.TEXT_NODE || c.nodeType === c.COMMENT_NODE ) {
				if ( currentOffset && ( currentOffset < targetRange.end ) ) {
					currentOffset += c.nodeValue.length;
					if ( c.nodeType === c.COMMENT_NODE ) {
						// Add the length of the '<!--' and '--> bits
						currentOffset += 7;
					}
					if ( currentOffset >= targetRange.end ) {
						waitingForEndMatch = false;
					}
				}

				if (wasWaiting || waitingForEndMatch) {
					// Part of target range
					elements.push(c);
				} else if ( !currentOffset ) {
					// Accumulate nodes without dsr
					precedingNodes.push( c );
				}
			}

			if ( wasWaiting && !waitingForEndMatch ) {
				break;
			}
		}

		var numElements = elements.length;
		var numChildren = children.length;
		if (numElements === 0) {
			return null;
		} else if ( numElements < numChildren ) {
			return { done: !waitingForEndMatch, nodes: elements } ;
		} else { /* numElements === numChildren */
			return { done: !waitingForEndMatch, nodes: [element] } ;
		}
	}

	return walkDOM(root);
};

var checkIfSignificant = function ( env, offsets, src, body, out, cb, document ) {


	var normalizeWikitext = function ( str ) {

		// Ignore leading tabs vs. leading spaces
		str = str.replace(/^\t/, ' ');
		str = str.replace(/\n\t/g, '\n ');
		// Normalize multiple spaces to single space
		str = str.replace(/ +/g, " ");
		// Eliminate spaces around wikitext chars
		// gwicke: disabled for now- too aggressive IMO
		//str = str.replace(/([<"'!#\*:;+-=|{}\[\]\/]) /g, "$1");
		// Ignore capitalization of tags and void tag indications
		str = str.replace(/<(\/?)([^ >\/]+)((?:[^>\/]|\/(?!>))*)\/?>/g, function(match, close, name, remaining) {
			return '<' + close + name.toLowerCase() + remaining.replace(/ $/, '') + '>';
		} );
		// Ignore whitespace in table cell attributes
		str = str.replace(/(^|\n|\|(?=\|)|!(?=!))(\{\||\|[\-+]*|!) *([^|\n]*?) *(?=[|\n]|$)/g, '$1$2$3');
		// Ignore trailing semicolons and spaces in style attributes
		str = str.replace(/style\s*=\s*"[^"]+"/g, function(match) {
			return match.replace(/\s|;(?=")/g, '');
		});
		// Strip double-quotes
		str = str.replace(/"([^"]*?)"/g, "$1");

		// Ignore implicit </small> and </center> in table cells or the end
		// of the string for now
		str = str.replace(/(^|\n)<\/(?:small|center)>(?=\n[|!]|\n?$)/g, '');
		str = str.replace(/([|!].*?)<\/(?:small|center)>(?=\n[|!]|\n?$)/gi, '$1');

		return str;
	};

	var i, k, diff, offset, origOut, newOut, origHTML, newHTML, origOrigHTML, origNewHTML, thisResult, results = [];
	for ( i = 0; i < offsets.length; i++ ) {
		thisResult = {};
		origOrigHTML = '';
		origNewHTML = '';

		offset = offsets[i];

		thisResult.offset = offset;
		// console.warn("--processing: " + JSON.stringify(offset));

		if ( offset[0].start === offset[0].end &&
				out.substr(offset[1].start, offset[1].end - offset[1].start)
					.match(/^\n?<\/[^>]+>\n?$/) )
		{
			// An element was implicitly closed. Fudge the orig offset
			// slightly so it finds the corresponding elements which have the
			// original (unclosed) DSR.
			offset[0].start--;
		}
		// console.warn("--orig--");
		var res = findDsr( body, offset[0] || {}, src.length);
		origOut = res ? res.nodes : [];
		for ( k = 0; k < origOut.length; k++ ) {
			origOrigHTML += origOut[k].outerHTML;
		}
		origHTML = Util.formatHTML( Util.normalizeOut( origOrigHTML ) );

		// console.warn("--new--");
		res = findDsr( document.firstChild.childNodes[1], offset[1] || {}, out.length);
		newOut = res ? res.nodes : [];
		for ( k = 0; k < newOut.length; k++ ) {
			origNewHTML += newOut[k].outerHTML;
		}
		newHTML = Util.formatHTML( Util.normalizeOut( origNewHTML ) );

		// compute wt diffs
		var wt1 = src.substring( offset[0].start, offset[0].end );
		var wt2 = out.substring( offset[1].start, offset[1].end );
		//thisResult.wtDiff = Util.contextDiff(wt1, wt2, false, true, true);

		// Get diff substrings from offsets
		/* jshint loopfunc: true */ // this function doesn't use loop variables
		var formatDiff = function ( offset, context ) {
			return [
			'----',
			src.substring(offset[0].start - context, offset[0].end + context),
			'++++',
			out.substring(offset[1].start - context, offset[1].end + context)
			].join('\n');
		}.bind( this, offset );

		diff = Util.diff( origHTML, newHTML, false, true, true );


		// No context by default
		thisResult.wtDiff = formatDiff(0);

		// Normalize wts to check if we really have a semantic diff
		thisResult.type = 'skip';
		if (diff.length > 0) {
			var normWT1 = normalizeWikitext(wt1),
				normWT2 = normalizeWikitext(wt2);

			if ( normWT1 !== normWT2 ) {
				//console.log( 'normDiff: =======\n' + normWT1 + '\n--------\n' + normWT2);
				thisResult.htmlDiff = diff;
				thisResult.type = 'fail';
				// Provide context for semantic diffs
				thisResult.wtDiff = formatDiff(25);
			}
		}
		results.push( thisResult );
	}
	cb( null, env, results );
};

var doubleRoundtripDiff = function ( env, offsets, body, out, cb ) {
	var src = env.page.src;

	if ( offsets.length > 0 ) {
		env.setPageSrcInfo( out );
		env.errCB = function ( error ) {
			cb( error, env, [] );
			process.exit( 1 );
		};

		var parserPipeline = Util.getParserPipeline( env, 'text/x-mediawiki/full' );
		parserPipeline.on( 'document', checkIfSignificant.bind( null, env, offsets, src, body, out, cb ) );
		parserPipeline.processToplevelDoc( out );

	} else {
		cb( null, env, [] );
	}
};

var roundTripDiff = function ( env, document, cb ) {
	var out, diff, offsetPairs;

	try {
		env.profile.time.serialize = new Date();
		out = new WikitextSerializer( { env: env } ).serializeDOM(document.body);
		env.profile.time.serialize = new Date() - env.profile.time.serialize;
		env.profile.size.domserialized = out.length;

		// Finish the total time now
		if ( env.profile && env.profile.time ) {
			env.profile.time.total += new Date() - env.profile.time.total_timer;
		}

		diff = jsDiff.diffLines( out, env.page.src );
		offsetPairs = Util.convertDiffToOffsetPairs( diff );

		if ( diff.length > 0 ) {
			doubleRoundtripDiff( env, offsetPairs, document.body, out, cb );
		} else {
			cb( null, env, [] );
		}
	} catch ( e ) {
		cb( e, env, [] );
	}
};

var fetch = function ( page, cb, options ) {
	cb = typeof cb === 'function' ? cb : function () {};

	var envCb = function ( err, env ) {
		env.errCB = function ( error ) {
			cb( error, env, [] );
		};
		if ( err !== null ) {
			env.errCB( err );
			return;
		}

		env.profile = { time: { total: 0, total_timer: new Date() }, size: {} };

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );
		var tpr = new TemplateRequest( env, target, null );

		tpr.once( 'src', function ( err, src_and_metadata ) {
			if ( err ) {
				cb( err, env, [] );
			} else {
				env.setPageSrcInfo( src_and_metadata );
				env.profile.time.parse = new Date();
				Util.parse( env, function ( src, err, doc ) {
					env.profile.time.parse = new Date() - env.profile.time.parse;

					if ( err ) {
						cb( err, env, [] );
					} else {
						// Pause the total time while we compute these sizes
						env.profile.time.total += new Date() - env.profile.time.total_timer;
						env.profile.size.htmlraw = doc.outerHTML.length;
						zlib.gzip( doc.outerHTML, function( err, buf ) {
							if ( !err ) {
								env.profile.size.htmlgzip = buf.length;
							}
						});
						env.profile.time.total_timer = new Date();
						roundTripDiff( env, doc, cb );
					}
				}, err, env.page.src );
			}
		} );
	};

	var prefix = options.prefix || 'en';

	if ( options.apiURL ) {
		prefix = 'customwiki';
	}

	var parsoidConfig = new ParsoidConfig( options, { defaultWiki: prefix } );

	if ( options.apiURL ) {
		parsoidConfig.setInterwiki( 'customwiki', options.apiURL );
	}
	parsoidConfig.editMode = Util.booleanOption( options.editMode );

	MWParserEnvironment.getParserEnv( parsoidConfig, null, prefix, page, envCb );
};

var cbCombinator = function ( formatter, cb, err, env, text ) {
	cb( err, formatter( env, err, text ) );
};

var consoleOut = function ( err, output ) {
	if ( err ) {
		console.log( 'ERROR: ' + err);
		if (err.stack) {
			console.log( 'Stack trace: ' + err.stack);
		}
		process.exit( 1 );
	} else {
		console.log( output );
	}
};

if ( typeof module === 'object' ) {
	module.exports.fetch = fetch;
	module.exports.plainFormat = plainCallback;
	module.exports.xmlFormat = xmlCallback;
	module.exports.cbCombinator = cbCombinator;
}

if ( !module.parent ) {
	var opts = optimist.usage( 'Usage: $0 [options] <page-title> \n\n', {
		'xml': {
			description: 'Use xml callback',
			'boolean': true,
			'default': false
		},
		'prefix': {
			description: 'Which wiki prefix to use; e.g. "en" for English wikipedia, "es" for Spanish, "mw" for mediawiki.org',
			'boolean': false,
			'default': ''
		},
		'apiURL': {
			description: 'http path to remote API, e.g. http://en.wikipedia.org/w/api.php',
			'boolean': false,
			'default': null
		},
		'help': {
			description: 'Show this message',
			'boolean': true,
			'default': false
		},
		'editMode': {
			description: 'Test in edit-mode (changes some parse & serialization strategies)',
			'default': false, // suppress noise by default
			'boolean': true
		},
		'debug': {
			description: 'Debug mode',
			'boolean': true,
			'default': false
		},
		'trace [optional-flags]': {
			description: 'Trace tokens (see below for supported trace options)',
			'boolean': true,
			'default': false
		},
		'dump <flags>': {
			description: 'Dump state (see below for supported dump flags)',
			'boolean': false,
			'default': ""
		}
	});

	var callback;
	var argv = opts.argv;
	var title = argv._[0];

	if ( title ) {
		callback = cbCombinator.bind( null,
		                              Util.booleanOption( argv.xml ) ?
		                              xmlCallback : plainCallback, consoleOut );
		fetch( title, callback, argv );
	} else {
		opts.showHelp();
		console.error( 'Run "node parse --help" for supported trace and dump flags');
	}

}
