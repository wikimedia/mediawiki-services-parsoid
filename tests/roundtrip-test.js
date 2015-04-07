#!/usr/bin/env node
"use strict";
require( '../lib/core-upgrade.js' );

var	request = require( 'request' ),
	yargs = require( 'yargs' ),
	domino = require( 'domino' ),
	url = require( 'url' ),
	zlib = require( 'zlib' ),
	JSUtils = require( '../lib/jsutils.js' ).JSUtils,
	Util = require( '../lib/mediawiki.Util.js' ).Util,
	DU = require( '../lib/mediawiki.DOMUtils.js' ).DOMUtils,
	TemplateRequest = require( '../lib/mediawiki.ApiRequest.js' ).TemplateRequest,
	ParsoidConfig = require( '../lib/mediawiki.ParsoidConfig' ).ParsoidConfig,
	MWParserEnvironment = require( '../lib/mediawiki.parser.environment.js' ).MWParserEnvironment,
	Diff = require('../lib/mediawiki.Diff.js').Diff;

var plainCallback = function( env, err, results ) {
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
				output += 'Semantic difference' + (result.selser ? ' (selser)' : '') + ':\n\n';
				output += result.wtDiff + '\n';
				output += diffDivider + 'HTML diff:\n\n' + result.htmlDiff + '\n';
				semanticDiffs++;
			} else {
				output += 'Syntactic difference' + (result.selser ? ' (selser)' : '') + ':\n\n';
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

function encodeAttribute(str) {
	return encodeXmlEntities(str)
		.replace(/"/g, '&quot;');
}


var xmlCallback = function( env, err, results ) {
	var i, result;
	var prefix = ( env && env.conf && env.conf.wiki && env.conf.wiki.iwp ) || '';
	var title = ( env && env.page && env.page.name ) || '';

	var output = '<testsuites>\n';
	var outputTestSuite = function(selser) {
			output += '<testsuite name="Roundtrip article ' + encodeAttribute( prefix + ':' + title );
			if (selser) {
				output += ' (selser)';
			}
			output += '">\n';
	};

	if ( err ) {
		outputTestSuite(false);
		output += '<testcase name="entire article"><error type="parserFailedToFinish">';
		output += encodeXmlEntities( err.stack || err.toString() );
		output += '</error></testcase>';
	} else if (!results.length) {
		outputTestSuite(false);
	} else {
		var currentSelser = results[0].selser;
		outputTestSuite(currentSelser);
		for ( i = 0; i < results.length; i++ ) {
			result = results[i];

			// When going from normal to selser results, switch to a new
			// test suite.
			if (currentSelser !== result.selser) {
				output += '</testsuite>\n';
				currentSelser = result.selser;
				outputTestSuite(currentSelser);
			}

			output += '<testcase name="' + encodeAttribute( prefix + ':' + title );
			output += ' character ' + result.offset[0].start + '">\n';

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
	output += '</testsuite>\n';

	// Output the profiling data
	if ( env.profile ) {

		// Delete the total timer to avoid serializing it
		if (env.profile.time && env.profile.time.total_timer) {
			delete( env.profile.time.total_timer );
		}

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
	output += '</testsuites>';

	return output;
};

var findMatchingNodes = function(root, targetRange, sourceLen) {
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
							var len = DU.isComment(n) ?
								DU.decodedCommentLength(n) :
								n.nodeValue.length;
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
					if (DU.isComment(c)) {
						currentOffset += DU.decodedCommentLength(c);
					} else {
						currentOffset += c.nodeValue.length;
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

var checkIfSignificant = function(env, offsets, oldWt, oldBody, oldDp, newWt, cb, err, html, dp) {
	if (err) {
		cb(err, null, []);
		return;
	}

	var normalizeWikitext = function(str) {
		// Ignore leading tabs vs. leading spaces
		str = str.replace(/^\t/, ' ');
		str = str.replace(/\n\t/g, '\n ');
		// Normalize multiple spaces to single space
		str = str.replace(/ +/g, " ");
		// Eliminate spaces around wikitext chars
		// gwicke: disabled for now- too aggressive IMO
		// str = str.replace(/([<"'!#\*:;+-=|{}\[\]\/]) /g, "$1");
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

	// Get diff substrings from offsets
	var formatDiff = function(offset, context) {
		return [
			'----',
			oldWt.substring(offset[0].start - context, offset[0].end + context),
			'++++',
			newWt.substring(offset[1].start - context, offset[1].end + context)
		].join('\n');
	};

	var newDOC = domino.createDocument(html);

	// Merge data-parsoid so that HTML nodes can be compared and diff'ed.
	DU.applyDataParsoid(oldBody.ownerDocument, oldDp.body);
	DU.applyDataParsoid(newDOC, dp.body);
	// console.warn("\nnewDOC:", newDOC)

	var i, k, diff, offset;
	var thisResult;
	var results = [];

	// Use the full tests for fostered content.
	// Fostered content => semantic diffs.
	if (!/("|&quot;)fostered("|&quot;)\s*:\s*true\b/.test(oldBody.outerHTML)) {
		// Quick test for no semantic diffs
		// If parsoid-normalized HTML for old and new wikitext is identical,
		// the wt-diffs are purely syntactic.
		var normalizedOld = DU.normalizeOut(oldBody, true);
		var normalizedNew = DU.normalizeOut(newDOC.body, true);
		if (normalizedOld === normalizedNew) {
			for (i = 0; i < offsets.length; i++) {
				offset = offsets[i];
				results.push({
					type: 'skip',
					offset: offset,
					wtDiff: formatDiff(offset, 0),
				});
			}
			cb( null, env, results );
			return;
		}
	}

	var origOut, newOut, origHTML, newHTML, origOrigHTML, origNewHTML;
	// Now, proceed with full blown diffs
	for (i = 0; i < offsets.length; i++) {
		thisResult = {};
		origOrigHTML = '';
		origNewHTML = '';

		offset = offsets[i];

		thisResult.offset = offset;
		// console.warn("--processing: " + JSON.stringify(offset));

		if (offset[0].start === offset[0].end &&
				newWt.substr(offset[1].start, offset[1].end - offset[1].start)
					.match(/^\n?<\/[^>]+>\n?$/)) {
			// An element was implicitly closed. Fudge the orig offset
			// slightly so it finds the corresponding elements which have the
			// original (unclosed) DSR.
			offset[0].start--;
		}
		// console.warn("--orig--");
		var res = findMatchingNodes(oldBody, offset[0] || {}, oldWt.length);
		origOut = res ? res.nodes : [];
		for (k = 0; k < origOut.length; k++) {
			// node need not be an element always!
			origOrigHTML += DU.serializeNode(origOut[k], {smartQuote: false});
		}
		origHTML = DU.formatHTML(DU.normalizeOut(origOrigHTML));
		// console.warn("# nodes: " + origOut.length);
		// console.warn("html: " + origHTML);

		// console.warn("--new--");
		res = findMatchingNodes(newDOC.body, offset[1] || {}, newWt.length);
		newOut = res ? res.nodes : [];
		for (k = 0; k < newOut.length; k++) {
			// node need not be an element always!
			origNewHTML += DU.serializeNode(newOut[k], {smartQuote: false});
		}
		newHTML = DU.formatHTML(DU.normalizeOut(origNewHTML));
		// console.warn("# nodes: " + newOut.length);
		// console.warn("html: " + newHTML);

		// compute wt diffs
		var wt1 = oldWt.substring(offset[0].start, offset[0].end);
		var wt2 = newWt.substring(offset[1].start, offset[1].end);
		// thisResult.wtDiff = Util.contextDiff(wt1, wt2, false, true, true);

		diff = Diff.htmlDiff(origHTML, newHTML, false, true, true);

		// No context by default
		thisResult.wtDiff = formatDiff(offset, 0);

		// Normalize wts to check if we really have a semantic diff
		thisResult.type = 'skip';
		if (diff.length > 0) {
			var normWT1 = normalizeWikitext(wt1),
				normWT2 = normalizeWikitext(wt2);

			if (normWT1 !== normWT2) {
				// console.log( 'normDiff: =======\n' + normWT1 + '\n--------\n' + normWT2);
				thisResult.htmlDiff = diff;
				thisResult.type = 'fail';
				// Provide context for semantic diffs
				thisResult.wtDiff = formatDiff(offset, 25);
			}
		}
		results.push(thisResult);
	}
	cb(null, env, results);
};

var parsoidPost = function(env, uri, domain, title, text, dp, oldid,
					recordSizes, profilePrefix, cb) {
	var data = {};
	// make sure the Parsoid URI ends on /
	if ( !/\/$/.test(uri) ) {
		uri += '/';
	}
	uri += 'v2/' + domain + '/';
	title = encodeURIComponent(title);

	if ( oldid ) {
		// We want html2wt
		uri += 'wt/' + title + '/' + oldid;
		data.html = {
			body: text
		};
		data.original = {
			'data-parsoid': dp
		};
	} else {
		// We want wt2html
		uri += 'pagebundle/' + title;
		data.wikitext = text;
	}

	var options = {
		uri: uri,
		method: 'POST',
		json: true,
		body: data
	};

	Util.retryingHTTPRequest( 10, options, function( err, res, body ) {
		if (err) {
			cb( err, null );
		} else if (res.statusCode !== 200) {
			cb(res.body, null);
		} else {
			var resBody, resDP;
			if (oldid) {
				// Extract the wikitext from the response
				resBody = body.wikitext.body;
			} else {
				resBody = body.html.body;
				resDP = body['data-parsoid'];
			}
			if ( env.profile ) {
				if (!profilePrefix) {
					profilePrefix = '';
				}
				// FIXME: Parse time was removed from profiling when we stopped
				// sending the x-parsoid-performance header.
				if (recordSizes) {
					// Record the sizes
					var sizePrefix = profilePrefix + (oldid ? 'wt' : 'html');
					env.profile.size[ sizePrefix + 'raw' ] =
						resBody.length;
					// Compress to record the gzipped size
					zlib.gzip( resBody, function( err, gzippedbuf ) {
						if ( !err ) {
							env.profile.size[ sizePrefix + 'gzip' ] =
								gzippedbuf.length;
						}
						cb( null, resBody, resDP );
					} );
				} else {
					cb(null, resBody, resDP);
				}
			} else {
				cb( null, resBody, resDP );
			}
		}
	} );
};

var doubleRoundtripDiff = function(env, uri, domain, title, offsets, src, body, dp, out, cb) {
	if ( offsets.length > 0 ) {
		env.setPageSrcInfo( out );
		env.errCB = function( error ) {
			cb( error, env, [] );
			process.exit( 1 );
		};

		parsoidPost(env, uri, domain, title, out, null, null, false, null,
			checkIfSignificant.bind(null, env, offsets, src, body, dp, out, cb));

	} else {
		cb( null, env, [] );
	}
};

var roundTripDiff = function( env, uri, domain, title, src, html, dp, out, cb ) {
	var diff, offsetPairs;

	try {
		diff = Diff.diffLines(out, src);
		offsetPairs = Diff.convertDiffToOffsetPairs(diff);

		if ( diff.length > 0 ) {
			var body = domino.createDocument( html ).body;
			doubleRoundtripDiff( env, uri, domain, title, offsetPairs, src, body, dp, out, cb );
		} else {
			cb( null, env, [] );
		}
	} catch ( e ) {
		cb( e, env, [] );
	}
};

var selserRoundTripDiff = function(env, uri, domain, title, html, dp, out, diffs, cb) {
	var selserDiff, offsetPairs,
		src = env.page.src.replace(/\n(?=\n)/g, '\n ');
	// Remove the selser trigger comment
	out = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');
	out = out.replace(/\n(?=\n)/g, '\n ');

	roundTripDiff(env, uri, domain, title, src, html, dp, out, function(err, env, selserDiffs) {
		if (err) {
			cb(err, env, diffs);
		} else {
			for (var sD in selserDiffs) {
				selserDiffs[sD].selser = true;
			}
			if (selserDiffs.length) {
				diffs = diffs.concat(selserDiffs);
			}
			cb(null, env, diffs);
		}
	});
};

// Returns a Promise for an { env, rtDiffs } object.  `cb` is optional.
var fetch = function( page, options, cb ) {
	cb = JSUtils.mkPromised( cb, [ 'env', 'rtDiffs' ] );
	var domain, prefix, apiURL,
		// options are ParsoidConfig options if module.parent, otherwise they
		// are CLI options (so use the Util.set* helpers to process them)
		parsoidConfig = new ParsoidConfig( module.parent ? options : null );
	if (!module.parent) {
		// only process CLI flags if we're running as a CLI program.
		Util.setTemplatingAndProcessingFlags( parsoidConfig, options );
		Util.setDebuggingFlags( parsoidConfig, options );
	}

	if ( options.apiURL ) {
		parsoidConfig.setInterwiki(options.prefix || 'localhost', options.apiURL);
	}
	if (options.prefix) {
		// If prefix is present, use that.
		prefix = options.prefix;
		// Get the domain from the interwiki map.
		apiURL = parsoidConfig.interwikiMap.get(prefix);
		if (!apiURL) {
			cb("Couldn't find the domain for prefix " + prefix, null, []);
		}
		domain = url.parse(apiURL).hostname;
	} else if (options.domain) {
		domain = options.domain;
		prefix = parsoidConfig.reverseIWMap.get(domain);
	}

	var envCb = function( err, env ) {
		env.errCB = function( error ) {
			cb( error, env, [] );
		};
		if ( err !== null ) {
			env.errCB( err );
			return;
		}
		env.profile = { time: { total: 0, total_timer: new Date() }, size: {} };

		var target = env.resolveTitle( env.normalizeTitle( env.page.name ), '' );
		var tpr = new TemplateRequest( env, target, null );

		tpr.once( 'src', function( err, src_and_metadata ) {
			if ( err ) {
				cb( err, env, [] );
			} else {
				// Shortcut for calling parsoidPost with common options
				var parsoidPostShort = function(postBody, postDp, postOldId,
						postRecordSizes, postProfilePrefix, postCb) {
					parsoidPost(env, options.parsoidURL, domain, page,
						postBody, postDp, postOldId, postRecordSizes, postProfilePrefix,
						function(err, postResult, postResultDp) {
							if (err) {
								cb(err, env, []);
							} else {
								postCb(postResult, postResultDp);
							}
						});
					};

				// Once we have the diffs between the round-tripped wt,
				// to test rt selser we need to modify the HTML and request
				// the wt again to compare with selser, and then concat the
				// resulting diffs to the ones we got from basic rt
				var rtSelserTest = function(origHTMLBody, origDp, err, env, rtDiffs) {
					if (err) {
						cb(err, env, rtDiffs);
					} else {
						var newDocument = DU.parseHTML(origHTMLBody),
							newNode = newDocument.createComment('rtSelserEditTestComment');
						newDocument.body.appendChild(newNode);
						parsoidPostShort(newDocument.outerHTML, origDp,
							src_and_metadata.revision.revid, false, 'selser',
							function(wtSelserBody) {
								// Finish the total time now
								if ( env.profile && env.profile.time ) {
									env.profile.time.total += new Date() - env.profile.time.total_timer;
								}

								selserRoundTripDiff(env, options.parsoidURL,
									domain, page, origHTMLBody, origDp, wtSelserBody,
									rtDiffs, cb);
							});
					}
				};

				env.setPageSrcInfo(src_and_metadata);
				// First, fetch the HTML for the requested page's wikitext
				parsoidPostShort(env.page.src, null, null, true, null, function(htmlBody, htmlDp) {
					// Now, request the wikitext for the obtained HTML
					// (without sending data-parsoid, as we don't want selser yet).
					parsoidPostShort(htmlBody, htmlDp,
						src_and_metadata.revision.revid, true, null,
						function(wtBody) {
							roundTripDiff(env, options.parsoidURL, domain, page,
								env.page.src, htmlBody, htmlDp, wtBody,
								rtSelserTest.bind(null, htmlBody, htmlDp));
						});
				});
			}
		} );
	};

	MWParserEnvironment.getParserEnv( parsoidConfig, null, { prefix: prefix, pageName: page }, envCb );
	return cb.promise;
};

var cbCombinator = function( formatter, cb, err, env, text ) {
	cb( err, formatter( env, err, text ) );
};

var consoleOut = function( err, output ) {
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
	var standardOpts = Util.addStandardOptions({
		'xml': {
			description: 'Use xml callback',
			'boolean': true,
			'default': false
		},
		'prefix': {
			description: 'Which wiki prefix to use; e.g. "enwiki" for English wikipedia, "eswiki" for Spanish, "mediawikiwiki" for mediawiki.org',
			'default': ''
		},
		'domain': {
			description: 'Which wiki to use; e.g. "en.wikipedia.org" for English wikipedia',
			'default': 'en.wikipedia.org'
		},
		'parsoidURL': {
			description: 'The URL for the Parsoid API',
		}
	}, {
		// defaults for standard options
		rtTestMode: true // suppress noise by default
	});

	var opts = yargs.usage(
		'Usage: $0 [options] <page-title> \n\n',
		standardOpts
	).check(Util.checkUnknownArgs.bind(null, standardOpts));

	var callback;
	var argv = opts.argv;
	var title = argv._[0];

	if ( title ) {
		callback = cbCombinator.bind( null,
			Util.booleanOption( argv.xml ) ?
				xmlCallback : plainCallback, consoleOut
		);
		if ( !argv.parsoidURL ) {
			// Start our own Parsoid server
			// TODO: This will not be necessary once we have a top-level testing
			// script that takes care of setting everything up.
			var apiServer = require( './apiServer.js' ),
				parsoidOptions = {quiet: true};
			if (opts.apiURL) {
				parsoidOptions.mockUrl = opts.apiURL;
			}
			apiServer.startParsoidServer(parsoidOptions).then(function( ret ) {
				argv.parsoidURL = ret.url;
				fetch( title, argv, callback );
			} ).done();
			apiServer.exitOnProcessTerm();
		} else {
			fetch( title, argv, callback );
		}
	} else {
		opts.showHelp();
	}

}
