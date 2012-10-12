( function () {
var fs = require( 'fs' ),
	path = require( 'path' ),
	colors = require( 'colors' ),
	http = require( 'http' ),
	jsDiff = require( 'diff' ),
	optimist = require( 'optimist' ),

	Util = require( '../lib/mediawiki.Util.js' ).Util,
	WikitextSerializer = require( '../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	TemplateRequest = require( '../lib/mediawiki.ApiRequest.js' ).TemplateRequest,

callback, argv, title,

plainCallback = function ( outputcb, err, results ) {
	var i, result, output = '';
	for ( i = 0; i < results.length; i++ ) {
		result = results[i];

		if ( result.type === 'fail' ) {
			output += ( new Array( 70 ) ).join( '=' ) + '\n';
			output += 'Wikitext diff:\n\n';
			output += result.wtDiff + '\n';
			output += ( new Array( 70 ) ).join( '-' ) + '\n';
			output += 'HTML diff:\n\n';
			output += result.htmlDiff + '\n';
		} else {
			output += ( new Array( 70 ) ).join( '=' ) + '\n';
			output += 'Insignificant wikitext diff:\n\n';
			output += result.wtDiff + '\n';
		}
	}

	outputcb( err, output );
},

xmlCallback = function ( outputcb, err, results ) {
	var i, result,

	output = '<testsuite name="Roundtrip article ' + Util.encodeXml( title ) + '">';

	for ( i = 0; i < results.length; i++ ) {
		result = results[i];

		output += '<testcase name="' + Util.encodeXml( title ) + ' character ' + result.offset[0].start + '>';

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

	output += '</testsuite>\n';

	outputcb( err, output );
},

findDsr = function () {
var currentOffset, wasWaiting = false, waitingForEndMatch = false;
return function ( element, targetRange, sourceLen, resetCurrentOffset ) {
	var j, childNode, childAttribs, attribs, elesOnOffset, currentPreText, start, end,
		elements = [], preText = [];

	if ( resetCurrentOffset ) {
		currentOffset = null;
		wasWaiting = false;
		waitingForEndMatch = false;
	}

	if ( element ) {
		attribs = element.getAttribute( 'data-parsoid' );
		if ( attribs ) {
			attribs = JSON.parse( attribs );
		}
	}

	if ( attribs && attribs.dsr && attribs.dsr.length ) {
		start = attribs.dsr[0] || 0;
		end = attribs.dsr[1] || sourceLen - 1;

		if ( waitingForEndMatch ) {
			if ( end >= targetRange.end ) {
				waitingForEndMatch = false;
			}
			return [ element ];
		}

		if ( attribs.dsr[0] && targetRange.start === start && end === targetRange.end ) {
			return [ element ];
		} else if ( targetRange.start === start ) {
			waitingForEndMatch = true;
		}

		if ( targetRange.end < start || targetRange.start > end ) {
			return null;
		}
	}

	for ( j = 0; j < element.childNodes.length; j++ ) {
		wasWaiting = waitingForEndMatch;
		if ( element.childNodes[j] && element.childNodes[j].outerHTML ) {
			childNode = findDsr( element.childNodes[j], targetRange, sourceLen );
			if ( childNode ) {
				elesOnOffset = [];

				if ( !currentOffset && attribs.dsr[0] ) {
					currentOffset = attribs.dsr[0];
					while ( preText.length > 0 && currentOffset >= targetRange.start ) {
						currentPreText = preText.pop();
						if ( currentPreText.__nodeValue.length > currentOffset - targetRange.start ) {
							break;
						}
						currentOffset -= currentPreText.__nodeValue.length;
						elesOnOffset.push( currentPreText );
					}
					elesOnOffset.reverse();
					childNode = elesOnOffset.concat( childNode );
				}

				// Check if there's only one child, and make sure it's a node with getAttribute
				if ( childNode.length === 1 && childNode[0].getAttribute ) {
					childAttribs = childNode[0].getAttribute( 'data-parsoid' );
					if ( childAttribs ) {
						childAttribs = JSON.parse( childAttribs );
						if ( childAttribs.dsr && childAttribs.dsr[1] >= targetRange.end ) {
							currentOffset = null;
							preText = [];
						} else if ( childAttribs.dsr ) {
							currentOffset = childAttribs.dsr[1] || currentOffset;
						}
					}
				}

				elements = elements.concat( childNode );
			}
		} else if ( element.childNodes[j] && element.childNodes[j]._nodeName === '#text' ) {
			if ( currentOffset && ( currentOffset < targetRange.end ) ) {
				currentOffset += element.childNodes[j].__nodeValue.length;
				elements = elements.concat( [ element.childNodes[j] ] );
				if ( wasWaiting && currentOffset >= targetRange.end ) {
					waitingForEndMatch = false;
				}
			} else if ( !currentOffset ) {
				preText.push( element.childNodes[j] );
			}
		}

		if ( wasWaiting && !waitingForEndMatch ) {
			break;
		}
	}

	if ( elements.length > 0 && elements.length < element.childNodes.length ) {
		return elements;
/*	} else if ( attribs && attribs.dsr && attribs.dsr.length ) {
		return [ element ]; */
	} else if ( element.childNodes.length > 0 && elements.length === element.childNodes.length ) {
		return [ element ];
	} else {
		return null;
	}
};
}(),


checkIfSignificant = function ( offsets, src, body, out, cb, document ) {
	var i, k, diff, offset, origOut, newOut, origHTML, newHTML, origOrigHTML, origNewHTML, thisResult, results = [];
	for ( i = 0; i < offsets.length; i++ ) {
		thisResult = {};
		origOrigHTML = '';
		origNewHTML = '';

		offset = offsets[i];

		thisResult.offset = offset;

		origOut = findDsr( body, offset[0] || {}, src.length, true ) || [];
		newOut = findDsr( document.firstChild.childNodes[1], offset[1] || {}, out.length, true ) || [];

		for ( k = 0; k < origOut.length; k++ ) {
			origOrigHTML += origOut[k].outerHTML || origOut[k].__nodeValue;
		}

		for ( k = 0; k < newOut.length; k++ ) {
			origNewHTML += newOut[k].outerHTML || newOut[k].__nodeValue;
		}

		origHTML = Util.formatHTML( Util.normalizeOut( origOrigHTML ) );
		newHTML = Util.formatHTML( Util.normalizeOut( origNewHTML ) );

		diff = Util.diff( origHTML, newHTML, false, true, true );

		if ( diff.length > 0 ) {
			thisResult.type = 'fail';
			thisResult.wtDiff = Util.diff( src.substring( offset[0].start, offset[0].end,
				out.substring( offset[1].start, offset[1].end ) ), false, true, true );
			thisResult.htmlDiff = diff;
		} else {
			thisResult.type = 'skip';
			thisResult.wtDiff = Util.diff( out.substring( offset[1].start, offset[1].end ),
				src.substring( offset[0].start, offset[0].end ), false, true, true );
		}
		results.push( thisResult );
	}
	cb( null, results );
},

doubleRoundtripDiff = function ( offsets, src, body, out, cb, wiki ) {
	var parser, env;

	if ( offsets.length > 0 ) {
		env = Util.getParserEnv();
		env.text = src;
		env.wgScript = env.interwikiMap[wiki];

		parserPipeline = Util.getParser( env, 'text/x-mediawiki/full' );

		parserPipeline.on( 'document', checkIfSignificant.bind( null, offsets, src, body, out, cb ) );

		parserPipeline.process( out );
	}
},

roundTripDiff = function ( src, document, cb, wiki ) {
	var out, curPair, patch, diff, env = Util.getParserEnv();

	out = new WikitextSerializer( { env: env } ).serializeDOM( document.body );
	if ( out === undefined ) {
		out = 'An error occured in the WikitextSerializer, please check the log for information';
	} else {
		diff = Util.convertDiffToOffsetPairs( jsDiff.diffLines( out, src ) );

		if ( diff.length > 0 ) {
			doubleRoundtripDiff( diff, src, document.body, out, cb, wiki );
		}
	}
},

fetch = function ( page, cb, wiki ) {
	cb = typeof cb === 'function' ? cb : function () {};

	var env = Util.getParserEnv();
	env.wgScript = env.interwikiMap[wiki || 'en'];
	env.setPageName( page );

	var target = env.resolveTitle( env.normalizeTitle( env.pageName ), '' );
	var tpr = new TemplateRequest( env, target, null );

	tpr.once( 'src', function ( err, src ) {
		Util.parse( env, function ( src, err, out ) {
			if ( err ) {
				console.log( err );
			} else {
				roundTripDiff( src, out, cb, wiki || 'en' );
			}
		}, err, src );
	} );
},

consoleOut = function ( err, output ) {
	if ( err ) {
		console.error( err );
	} else {
		console.log( output );
	}
};

if ( typeof module === 'object' ) {
	module.exports.fetch = fetch;
}

if ( !module.parent ) {
	argv = optimist.argv;
	title = argv._[0];

	if ( title ) {
		if ( argv.xml ) {
			callback = xmlCallback;
		} else {
			callback = plainCallback;
		}

		callback = callback.bind( null, consoleOut );

		fetch( title, callback, argv.wiki );
	} else {
		console.log( 'Usage: node roundtrip-test.js PAGETITLE [--xml] [--wiki CODE]' );
	}
}

} )();
