#!/usr/bin/env node
"use strict";

var	request = require( 'request' ),
	optimist = require( 'optimist' ),
	domino = require( 'domino' ),
	url = require( 'url' ),
	zlib = require( 'zlib' ),

	Util = require( '../lib/mediawiki.Util.js' ).Util,
	DU = require( '../lib/mediawiki.DOMUtils.js' ).DOMUtils,
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

var encodeXmlEntities = function( str ) {
	return str.replace( /&/g, '&amp;' )
			  .replace( /</g, '&lt;' )
			  .replace( />/g, '&gt;' );
};

function encodeAttribute (str) {
	return encodeXmlEntities(str)
		.replace(/"/g, '&quot;');
}


var xmlCallback = function ( env, err, results ) {
	var i, result;
	var prefix = ( env && env.conf && env.conf.wiki && env.conf.wiki.iwp ) || '';
	var title = ( env && env.page && env.page.name ) || '';

	var output = '<testsuite name="Roundtrip article ' + encodeAttribute( prefix + ':' + title ) + '">';

	if ( err ) {
		output += '<testcase name="entire article"><error type="parserFailedToFinish">';
		output += encodeXmlEntities( err.stack || err.toString() );
		output += '</error></testcase>';
	} else {

		for ( i = 0; i < results.length; i++ ) {
			result = results[i];

			output += '<testcase name="' + encodeAttribute( prefix + ':' + title ) + ' character ' + result.offset[0].start + '">';

			if ( result.type === 'fail' ) {
				output += '<failure type="significantHtmlDiff">\n';

				output += '<diff class="wt">\n';
				output += encodeXmlEntities( result.wtDiff );
				output += '\n</diff>\n';

				output += '<diff class="html">\n';
				output += encodeXmlEntities( result.htmlDiff );
				output += '\n</diff>\n';

				output += '</failure>\n';
			} else {
				output += '<skipped type="insignificantWikitextDiff">\n';
				output += encodeXmlEntities( result.wtDiff );
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
				output += '<perfstat type="' + DU.encodeXml( type ) + ':';
				output += DU.encodeXml( prop );
				output += '">';
				output += DU.encodeXml( env.profile[ type ][ prop ].toString() );
				output += '</perfstat>\n';
			}
		}
		output += '</perfstats>\n';
	}

	output += '</testsuite>\n';

	return output;
};

var findMatchingNodes = function (root, targetRange, sourceLen) {
	var currentOffset = null, wasWaiting = false, waitingForEndMatch = false;

	function walkDOM(element) {
		var elements = [],
			precedingNodes = [],
			attribs = DU.getJSONAttribute(element, 'data-parsoid');

		if ( attribs.dsr && attribs.dsr.length ) {
			var start = attribs.dsr[0] || 0,
				end = attribs.dsr[1] || sourceLen - 1;

			if ( (targetRange.end - 1) < start  || targetRange.start > (end - 1) ) {
				return null;
			}

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
				if (end < targetRange.end) {
					// No need to walk children
					return { done: false, nodes: [element] };
				}
			} else if (start > targetRange.start && end < targetRange.end) {
				// No need to walk children
				return { done: false, nodes: [element] };
			}
		}

		var c = element.firstChild;
		while (c) {

			wasWaiting = waitingForEndMatch;
			if ( DU.isElt(c) ) {
				var res = walkDOM(c);
				var matchedChildren = res ? res.nodes : null;
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
					if ( matchedChildren.length === 1 && DU.isElt(matchedChildren[0]) ) {
						var childAttribs = matchedChildren[0].getAttribute( 'data-parsoid' );
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

			// Skip over encapsulated content
			var typeOf = DU.isElt(c) ? c.getAttribute( 'typeof' ) || '' : '';
			if (/\bmw:(?:Transclusion\b|Param\b|Extension\/[^\s]+)/.test(typeOf)) {
				c = DU.skipOverEncapsulatedContent(c);
			} else {
				c = c.nextSibling;
			}
		}

		var numElements = elements.length;
		var numChildren = element.childNodes.length;
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
		var res = findMatchingNodes( body, offset[0] || {}, src.length);
		origOut = res ? res.nodes : [];
		for ( k = 0; k < origOut.length; k++ ) {
			// node need not be an element always!
			origOrigHTML += DU.serializeNode(origOut[k], {smartQuote: false});
		}
		origHTML = DU.formatHTML( DU.normalizeOut( origOrigHTML ) );
		// console.warn("# nodes: " + origOut.length);
		// console.warn("html: " + origHTML);

		// console.warn("--new--");
		res = findMatchingNodes( document.body, offset[1] || {}, out.length);
		newOut = res ? res.nodes : [];
		for ( k = 0; k < newOut.length; k++ ) {
			// node need not be an element always!
			origNewHTML += DU.serializeNode(newOut[k], {smartQuote: false});
		}
		newHTML = DU.formatHTML( DU.normalizeOut( origNewHTML ) );
		// console.warn("# nodes: " + newOut.length);
		// console.warn("html: " + newHTML);

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

		var parserPipeline = env.pipelineFactory.getPipeline('text/x-mediawiki/full');
		parserPipeline.once( 'document', checkIfSignificant.bind( null, env, offsets, src, body, out, cb ) );
		parserPipeline.processToplevelDoc( out );

	} else {
		cb( null, env, [] );
	}
};

var parsoidPost = function ( env, parsoidURL, prefix, title, text, oldid, cb ) {
	var data = {};
	if ( oldid ) {
		data.oldid = oldid;
		data.html = text;
	} else {
		data.wt = text;
	}

	var options = {
		uri: parsoidURL + '/' + prefix + '/' + encodeURI(title),
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		encoding: 'utf8',
		form: data
	};

	Util.retryingHTTPRequest( 10, options, function( err, res, body ) {
		if (err) {
			cb( err, null );
		} else if (res.statusCode !== 200) {
			cb(res.body, null);
		} else {
			if ( env.profile ) {
				// Record the time it's taken to parse
				var timePrefix = oldid ? 'html2wt' : 'wt2html';
				if ( res.headers[ 'x-parsoid-performance' ] ) {
					env.profile.time[ timePrefix ] =
						parseInt( res.headers[ 'x-parsoid-performance' ].
							match( /duration=((\d)+);/ )[1], 10 );
				}
				// Record the sizes
				var sizePrefix = oldid ? 'wt' : 'html';
				env.profile.size[ sizePrefix + 'raw' ] =
					body.length;
				// Compress to record the gzipped size
				zlib.gzip( res.body, function( err, gzippedbuf ) {
					if ( !err ) {
						env.profile.size[ sizePrefix + 'gzip' ] =
							gzippedbuf.length;
					}
					cb( null, body );
				} );
			} else {
				cb( null, body );
			}
		}
	} );
};

var roundTripDiff = function ( env, html, out, cb ) {
	var diff, offsetPairs;

	try {
		diff = Util.diffLines(out, env.page.src);
		offsetPairs = Util.convertDiffToOffsetPairs( diff );

		if ( diff.length > 0 ) {
			var body = domino.createDocument( html ).body;
			doubleRoundtripDiff( env, offsetPairs, body, out, cb );
		} else {
			cb( null, env, [] );
		}
	} catch ( e ) {
		cb( e, env, [] );
	}
};

var fetch = function ( page, cb, options ) {
	cb = typeof cb === 'function' ? cb : function () {};
	var prefix = options.prefix || 'enwiki';

	if ( options.apiURL ) {
		prefix = 'customwiki';
	}

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
				// First, fetch the HTML for the requested page's wikitext
				parsoidPost( env, options.parsoidURL, prefix, page,
					env.page.src, null, function ( err, htmlBody ) {
						if ( err ) {
							cb( err, env, [] );
						} else {
							// And now, request the wikitext for the obtained HTML
							parsoidPost( env, options.parsoidURL, prefix, page,
								htmlBody, src_and_metadata.revision.revid, function ( err, wtBody ) {
									if ( err ) {
										cb( err, env, [] );
									} else {
										// Finish the total time now
										if ( env.profile && env.profile.time ) {
											env.profile.time.total += new Date() - env.profile.time.total_timer;
											delete( env.profile.time.total_timer );
										}
										roundTripDiff( env, htmlBody, wtBody, cb );
									}
								} );
						}
				} );
			}
		} );
	};

	// options are ParsoidConfig options if module.parent, otherwise they
	// are CLI options (so use the Util.set* helpers to process them)
	var parsoidConfig = new ParsoidConfig( module.parent ? options : null, { defaultWiki: prefix } );
	if (!module.parent) {
		// only process CLI flags if we're running as a CLI program.
		Util.setTemplatingAndProcessingFlags( parsoidConfig, options );
		Util.setDebuggingFlags( parsoidConfig, options );
	}

	MWParserEnvironment.getParserEnv( parsoidConfig, null, prefix, page, null, envCb );
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
		process.exit( 0 );
	}
};

if ( typeof module === 'object' ) {
	module.exports.fetch = fetch;
	module.exports.plainFormat = plainCallback;
	module.exports.xmlFormat = xmlCallback;
	module.exports.cbCombinator = cbCombinator;
}

if ( !module.parent ) {
	var opts = optimist.usage( 'Usage: $0 [options] <page-title> \n\n', Util.addStandardOptions({
		'xml': {
			description: 'Use xml callback',
			'boolean': true,
			'default': false
		},
		'prefix': {
			description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
			'default': ''
		},
		'parsoidURL': {
			description: 'The URL for the Parsoid API',
		}
	}, {
		// defaults for standard options
		editMode: false // suppress noise by default
	}));

	var callback;
	var argv = opts.argv;
	var title = argv._[0];

	if ( title ) {
		callback = cbCombinator.bind( null,
		                              Util.booleanOption( argv.xml ) ?
		                              xmlCallback : plainCallback, consoleOut );
		if ( !argv.parsoidURL ) {
			// Start our own Parsoid server
			// TODO: This will not be necessary once we have a top-level testing
			// script that takes care of setting everything up.
			var apiServer = require( './apiServer.js' );
			apiServer.startParsoidServer({quiet: true}, function( url ) {
				argv.parsoidURL = url;
				fetch( title, callback, argv );
			} );
		} else {
			// make sure parsoidURL ends on /
			if (!/\/$/.test(argv.parsoidURL)) {
				argv.parsoidURL += '/';
			}
			fetch( title, callback, argv );
		}
	} else {
		opts.showHelp();
	}

}
