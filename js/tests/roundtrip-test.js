#!/usr/bin/env node
var fs = require( 'fs' ),
	path = require( 'path' ),
	colors = require( 'colors' ),
	http = require( 'http' ),
	jsDiff = require( 'diff' ),
	optimist = require( 'optimist' ),

	Util = require( '../lib/mediawiki.Util.js' ).Util,
	WikitextSerializer = require( '../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	TemplateRequest = require( '../lib/mediawiki.ApiRequest.js' ).TemplateRequest,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig' ).ParsoidConfig,
	MWParserEnvironment = require( '../lib/mediawiki.parser.environment.js' ).MWParserEnvironment,

callback, argv, title,

plainCallback = function ( env, err, results ) {
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
},

xmlCallback = function ( env, err, results ) {
	var i, result,

	output = '<testsuite name="Roundtrip article ' + Util.encodeXml( env.page.name || '' ) + '">';

	if ( err ) {
		output += '<testcase name="entire article"><error type="parserFailedToFinish">';
		output += Util.encodeXml( err.stack || err.toString() );
		output += '</error></testcase>';
	} else {

		for ( i = 0; i < results.length; i++ ) {
			result = results[i];

			output += '<testcase name="' + Util.encodeXml( env.page.name ) + ' character ' + result.offset[0].start + '">';

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

	output += '</testsuite>\n';

	return output;
},

findDsr = function (root, targetRange, sourceLen) {
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
},

checkIfSignificant = function ( env, offsets, src, body, out, cb, document ) {


	function normalizeWikitext(str) {
		var orig = str;

		// Ignore leading tabs vs. leading spaces
		str = str.replace(/^\t/, ' ');
		str = str.replace(/\n\t/g, '\n ');
		// Normalize multiple spaces to single space
		str = str.replace(/ +/g, " ");
		// Eliminate spaces around wikitext chars
		// gwicke: disabled for now- too aggressive IMO
		//str = str.replace(/([<"'!#\*:;+-=|{}\[\]\/]) /g, "$1");
		// Ignore capitalization of tags and void tag indications
		str = str.replace(/<(\/?)([^ >\/]+)((?:[^>/]|\/(?!>))*)\/?>/g, function(match, close, name, remaining) {
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
	}

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
		function formatDiff (context) {
			return [
			'----',
			src.substring(offset[0].start - context, offset[0].end + context),
			'++++',
			out.substring(offset[1].start - context, offset[1].end + context)
			].join('\n');
		}

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
},

doubleRoundtripDiff = function ( env, offsets, body, out, cb ) {
	var src = env.page.src;

	if ( offsets.length > 0 ) {
		env.setPageSrcInfo( out );
		env.errCB = function ( error ) {
			cb( error, env, [] );
			process.exit( 1 );
		};

		var parserPipeline = Util.getParser( env, 'text/x-mediawiki/full' );

		parserPipeline.on( 'document', checkIfSignificant.bind( null, env, offsets, src, body, out, cb ) );

		parserPipeline.process( out );

	} else {
		cb( null, env, [] );
	}
},

roundTripDiff = function ( env, document, cb ) {
	var curPair, out, patch, diff, offsetPairs;

	try {
		out = new WikitextSerializer( { env: env } ).serializeDOM(document.body);
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
},

fetch = function ( page, cb, options ) {
	cb = typeof cb === 'function' ? cb : function () {};

	var envCb = function ( err, env ) {
		env.errCB = function ( error ) {
			cb( error, env, [] );
		};
		if ( err !== null ) {
			env.errCB( err );
			return;
		}

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );
		var tpr = new TemplateRequest( env, target, null );

		tpr.once( 'src', function ( err, src_and_metadata ) {
			if ( err ) {
				cb( err, env, [] );
			} else {
				env.setPageSrcInfo( src_and_metadata );
				Util.parse( env, function ( src, err, out ) {
					if ( err ) {
						cb( err, env, [] );
					} else {
						roundTripDiff( env, out, cb );
					}
				}, err, env.page.src );
			}
		} );
	};

	var parsoidConfig = new ParsoidConfig( options, null );
	MWParserEnvironment.getParserEnv( parsoidConfig, null, options.wiki, page, envCb );
},

cbCombinator = function ( formatter, cb, err, env, text ) {
	cb( err, formatter( env, err, text ) );
},

consoleOut = function ( err, output ) {
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
		'wiki': {
			description: 'code of wiki to use (default: en)',
			'boolean': false,
			'default': 'en'
		},
		'help': {
			description: 'Show this message',
			'boolean': true,
			'default': false
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

	argv = opts.argv;
	title = argv._[0];

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
