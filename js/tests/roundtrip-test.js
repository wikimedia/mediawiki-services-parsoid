( function () {
var fs = require( 'fs' ),
	path = require( 'path' ),
	colors = require( 'colors' ),
	http = require( 'http' ),
	jsDiff = require( 'diff' ),
	optimist = require( 'optimist' ),

	ParserPipelineFactory = require( '../lib/mediawiki.parser.js' ).ParserPipelineFactory,
	Util = require( '../lib/mediawiki.Util.js' ).Util,
	ParserEnv = require( '../lib/mediawiki.parser.environment.js').MWParserEnvironment,
	WikitextSerializer = require( '../lib/mediawiki.WikitextSerializer.js').WikitextSerializer,
	libtr = require( '../lib/mediawiki.ApiRequest.js'),
	TemplateRequest = libtr.TemplateRequest,

callback, argv = optimist.argv, title = argv._[0],

plainCallback = function ( err, results ) {
	var i, result;
	for ( i = 0; i < results.length; i++ ) {
		result = results[i];
		if ( result.type === 'fail' ) {
			console.log( ( new Array( 70 ) ).join( '=' ) );
			console.log( 'Wikitext diff:\n' );
			console.log( result.wtDiff );
			console.log( ( new Array( 70 ) ).join( '-' ) );
			console.log( 'HTML diff:\n' );
			console.log( result.htmlDiff );
		} else {
			console.log( ( new Array( 70 ) ).join( '=' ) );
			console.log( 'Insignificant wikitext diff:\n' );
			console.log( result.wtDiff );
		}
	}
},

xmlCallback = function ( err, results ) {
	var i, result;
	console.log( '<testsuite name="Roundtrip article ' + Util.encodeXml( title ) + '">' );

	for ( i = 0; i < results.length; i++ ) {
		result = results[i];

		console.log( '<testcase name="' + Util.encodeXml( title ) + ' character ' + result.offset[0].start + '>' );

		if ( result.type === 'fail' ) {
			console.log( '<failure type="significantHtmlDiff">' );

			console.log( '<diff class="wt">' );
			console.log( Util.encodeXml( result.wtDiff ) );
			console.log( '</diff>' );

			console.log( '<diff class="html">' );
			console.log( Util.encodeXml( result.htmlDiff ) );
			console.log( '</diff>' );

			console.log( '</failure>' );
		} else {
			console.log( '<skipped type="insignificantWikitextDiff"' );
			console.log( Util.encodeXml( result.wtDiff ) );
			console.log( '</skipped>' );
		}

		console.log( '</testcase>' );
	}

	console.log( '</testsuite>' );
},

getParserEnv = function () {
	var env = new ParserEnv( {
		// stay within the 'proxied' content, so that we can click around
		wgScriptPath: '/', //http://en.wikipedia.org/wiki',
		wgScriptExtension: '.php',
		// XXX: add options for this!
		wgUploadPath: 'http://upload.wikimedia.org/wikipedia/commons',
		fetchTemplates: true,
		// enable/disable debug output using this switch
		debug: false,
		trace: false,
		maxDepth: 40
	} );

	// add mediawiki.org
	env.setInterwiki( 'mw', 'http://www.mediawiki.org/w' );

	// add localhost default
	env.setInterwiki( 'localhost', 'http://localhost/w' );

	return env;
},

getParser = function ( env, type ) {
	return ( new ParserPipelineFactory( env ) ).makePipeline( type );
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


doubleRoundtripDiff = function ( offsets, src, body, out, cb ) {
	var parser, env, offset;

	if ( offsets.length > 0 ) {
		env = new ParserEnv( {
			fetchTemplates: true
		} );

		env.text = src;
		env.wgScript = env.interwikiMap.mw;

		parserPipeline = getParser( env, 'text/x-mediawiki/full' );

		parserPipeline.on( 'document', function ( document ) {
			var i, k, diff, origOut, newOut, origHTML, newHTML, origOrigHTML, origNewHTML, thisResult, results = [];
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
					thisResult.wtDiff = Util.diff( out.substring( offset[1].start, offset[1].end ),
						src.substring( offset[0].start, offset[0].end ), false, true, true );
					thisResult.htmlDiff = diff;
				} else {
					thisResult.type = 'skip';
					thisResult.wtDiff = Util.diff( out.substring( offset[1].start, offset[1].end ),
						src.substring( offset[0].start, offset[0].end ), false, true, true );
				}
				results.push( thisResult );
			}
			cb( null, results );
		} );

		parserPipeline.process( out );
	}
},

roundTripDiff = function ( src, document, cb ) {
	var out, curPair, patch, diff, env = getParserEnv();

	out = new WikitextSerializer( { env: env } ).serializeDOM( document.body );
	if ( out === undefined ) {
		out = 'An error occured in the WikitextSerializer, please check the log for information';
	} else {
		diff = Util.convertDiffToOffsetPairs( jsDiff.diffLines( out, src ) );

		if ( diff.length > 0 ) {
			doubleRoundtripDiff( diff, src, document.body, out, cb );
		}
	}
},

parse = function ( env, cb, err, src ) {
	if ( err !== null ) {
		if ( !err.code ) {
			err.code = 500;
		}
		console.log( err.toString(), err.code );
	} else {
		var parser = getParser( env, 'text/x-mediawiki/full' );
		parser.on( 'document', cb.bind( null, src ) );
		try {
			env.text = src;
			parser.process( src );
		} catch (e) {
			console.log( e );
		}
	}
},

fetch = function ( page, cb ) {
	cb = typeof cb === 'function' ? cb : function () {};

	var env = new ParserEnv( {
		fetchTemplates: true
	} );

	env.setInterwiki( 'mw', 'http://www.mediawiki.org/w' );
	env.wgScript = env.interwikiMap.en;
	env.setPageName( page );

	var target = env.resolveTitle( env.normalizeTitle( env.pageName ), '' );
	var tpr = new TemplateRequest( env, target, null );

	tpr.once( 'src', function ( err, src ) {
		parse( env, function ( src, out ) {
			roundTripDiff( src, out, cb );
		}, err, src );
	} );
};

if ( title ) {
	if ( argv.xml ) {
		callback = xmlCallback;
	} else {
		callback = plainCallback;
	}
	fetch( title, callback );
} else {
	console.log( 'Usage: node roundtrip-test.js PAGETITLE [--xml]' );
}

} )();
