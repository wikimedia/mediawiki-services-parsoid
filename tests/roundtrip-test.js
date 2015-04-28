#!/usr/bin/env node
'use strict';
require('../lib/core-upgrade.js');

var request = require('request');
var yargs = require('yargs');
var domino = require('domino');
var url = require('url');
var zlib = require('zlib');
var JSUtils = require('../lib/jsutils.js').JSUtils;
var Util = require('../lib/mediawiki.Util.js').Util;
var DU = require('../lib/mediawiki.DOMUtils.js').DOMUtils;
var TemplateRequest = require('../lib/mediawiki.ApiRequest.js').TemplateRequest;
var ParsoidConfig = require('../lib/mediawiki.ParsoidConfig').ParsoidConfig;
var MWParserEnvironment = require('../lib/mediawiki.parser.environment.js').MWParserEnvironment;
var Diff = require('../lib/mediawiki.Diff.js').Diff;


function displayDiff(type, count) {
	var pad = (10 - type.length);  // Be positive!
	type = type[0].toUpperCase() + type.substr(1);
	return type + ' differences' + ' '.repeat(pad) + ': ' + count + '\n';
}

var plainFormat = function(err, prefix, title, results, profile) {
	var testDivider = '='.repeat(70) + '\n';
	var diffDivider = '-'.repeat(70) + '\n';
	var output = '';

	if (err) {
		output += 'Parser failure!\n\n';
		output += diffDivider;
		output += err;
		if (err.stack) {
			output += '\nStack trace: ' + err.stack;
		}
	} else {
		var diffs = {
			html2wt: {
				semantic: 0,
				syntactic: 0,
			},
			selser: {
				semantic: 0,
				syntactic: 0,
			},
		};
		var semanticDiffs = 0;
		var syntacticDiffs = 0;
		for (var i = 0; i < results.length; i++) {
			var result = results[i];
			output += testDivider;
			if (result.type === 'fail') {
				output += 'Semantic difference' +
					(result.selser ? ' (selser)' : '') + ':\n\n';
				output += result.wtDiff + '\n';
				output += diffDivider + 'HTML diff:\n\n' +
					result.htmlDiff + '\n';
				diffs[result.selser ? 'selser' : 'html2wt'].semantic++;
			} else {
				output += 'Syntactic difference' +
					(result.selser ? ' (selser)' : '') + ':\n\n';
				output += result.wtDiff + '\n';
				diffs[result.selser ? 'selser' : 'html2wt'].syntactic++;
			}
		}
		output += testDivider;
		output += testDivider;
		output += 'SUMMARY:\n';
		output += diffDivider;
		var total = 0;
		Object.keys(diffs).forEach(function(diff) {
			output += diff + '\n';
			output += diffDivider;
			Object.keys(diffs[diff]).forEach(function(type) {
				var count = diffs[diff][type];
				total += count;
				output += displayDiff(type, count);
			});
			output += diffDivider;
		});
		output += displayDiff('all', total);
		output += testDivider;
		output += testDivider;
	}

	return output;
};

function encodeXmlEntities(str) {
	return str.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
}

function encodeAttribute(str) {
	return encodeXmlEntities(str).replace(/"/g, '&quot;');
}

var xmlFormat = function(err, prefix, title, results, profile) {
	var i, result;
	var article = encodeAttribute(prefix + ':' + title);
	var output = '<testsuites>\n';
	var outputTestSuite = function(selser) {
			output += '<testsuite name="Roundtrip article ' + article;
			if (selser) {
				output += ' (selser)';
			}
			output += '">\n';
	};

	if (err) {
		outputTestSuite(false);
		output += '<testcase name="entire article">';
		output += '<error type="parserFailedToFinish">';
		output += encodeXmlEntities(err.stack || err.toString());
		output += '</error></testcase>';
	} else if (!results.length) {
		outputTestSuite(false);
	} else {
		var currentSelser = results[0].selser;
		outputTestSuite(currentSelser);
		for (i = 0; i < results.length; i++) {
			result = results[i];

			// When going from normal to selser results, switch to a new
			// test suite.
			if (currentSelser !== result.selser) {
				output += '</testsuite>\n';
				currentSelser = result.selser;
				outputTestSuite(currentSelser);
			}

			output += '<testcase name="' + article;
			output += ' character ' + result.offset[0].start + '">\n';

			if (result.type === 'fail') {
				output += '<failure type="significantHtmlDiff">\n';

				output += '<diff class="wt">\n';
				output += encodeXmlEntities(result.wtDiff);
				output += '\n</diff>\n';

				output += '<diff class="html">\n';
				output += encodeXmlEntities(result.htmlDiff);
				output += '\n</diff>\n';

				output += '</failure>\n';
			} else {
				output += '<skipped type="insignificantWikitextDiff">\n';
				output += encodeXmlEntities(result.wtDiff);
				output += '\n</skipped>\n';
			}

			output += '</testcase>\n';
		}
	}
	output += '</testsuite>\n';

	// Output the profiling data
	if (profile) {
		// Delete the start time to avoid serializing it
		if (profile.time && profile.time.start) {
			delete(profile.time.start);
		}
		output += '<perfstats>\n';
		Object.keys(profile).forEach(function(type) {
			Object.keys(profile[type]).forEach(function(prop) {
				output += '<perfstat type="' + DU.encodeXml(type) + ':';
				output += DU.encodeXml(prop);
				output += '">';
				output += DU.encodeXml(profile[type][prop].toString());
				output += '</perfstat>\n';
			});
		});
		output += '</perfstats>\n';
	}
	output += '</testsuites>';

	return output;
};

var findMatchingNodes = function(root, targetRange, sourceLen) {
	var isZeroLength = (targetRange.start === targetRange.end);
	var currentOffset = null;
	var wasWaiting = false;
	var waitingForEndMatch = false;

	function walkDOM(element) {
		var dp = DU.getDataParsoid(element);

		// NOTE: We are not using Util.isValidDSR(dp.dsr)
		// since we want to use partially valid info as well.
		//
		// SSS FIXME: Is partially valid info an issue anymore now?
		if (dp.dsr && dp.dsr.length) {
			var start = dp.dsr[0] || 0;
			var end = dp.dsr[1] || sourceLen - 1;

			// For zero-length ranges, find the smallest node
			// that includes the start/end value. So, use a more
			// restrictive check to decide if this subtree can be
			// skipped or not.
			if (isZeroLength) {
				if (targetRange.start > end || targetRange.end < start) {
					return null;
				}
			} else {
				if (targetRange.start >= end || targetRange.end <= start) {
					return null;
				}
			}

			if (waitingForEndMatch) {
				if (end >= targetRange.end) {
					waitingForEndMatch = false;
				}
				return { done: true, nodes: [element] };
			}

			if (dp.dsr[0] !== null &&
				targetRange.start === start &&
				end === targetRange.end) {
				return { done: true, nodes: [element] };
			} else if (targetRange.start === start) {
				waitingForEndMatch = true;
				if (end < targetRange.end) {
					// No need to examine children since
					// the subtree range is smaller than
					// what we want.
					return { done: false, nodes: [element] };
				}
			} else if (start >= targetRange.start && end <= targetRange.end) {
				// No need to examine children since
				// the subtree range is smaller than
				// what we want.
				return { done: false, nodes: [element] };
			}
		}

		// We cannot walk the subtree of this element
		// if it encapsulates generaed content (templates, extensions)
		if (DU.isFirstEncapsulationWrapperNode(element)) {
			if (dp.dsr && dp.dsr.length) {
				return { done: false, nodes: [element] };
			} else {
				return null;
			}
		}

		// We have to find the smallest range in element's subtree
		var elements = [];
		var precedingNodes = [];
		var c = element.firstChild;
		var childDP;
		while (c) {
			wasWaiting = waitingForEndMatch;
			if (DU.isElt(c)) {
				var res = walkDOM(c);
				var matchedChildren = res ? res.nodes : null;
				if (matchedChildren) {
					if (!currentOffset && dp.dsr && dp.dsr[0] !== null) {
						var elesOnOffset = [];
						currentOffset = dp.dsr[0];
						// Walk the preceding nodes without dsr values and
						// prefix matchedChildren till we get the desired
						// matching start value.
						var diff = currentOffset - targetRange.start;
						while (precedingNodes.length > 0 && diff > 0) {
							var n = precedingNodes.pop();
							var len = DU.isComment(n) ?
								DU.decodedCommentLength(n) :
								n.nodeValue.length;
							if (len > diff) {
								break;
							}
							diff -= len;
							elesOnOffset.push(n);
						}
						elesOnOffset.reverse();
						matchedChildren = elesOnOffset.concat(matchedChildren);
					}

					// Check if there's only one child,
					// and make sure it's a node with getAttribute.
					if (matchedChildren.length === 1 && DU.isElt(matchedChildren[0])) {
						childDP = DU.getDataParsoid(matchedChildren[0]);
						if (childDP) {
							if (childDP.dsr && typeof (childDP.dsr[1]) === 'number') {
								if (childDP.dsr[1] >= targetRange.end) {
									res.done = true;
								} else {
									currentOffset = childDP.dsr[1];
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
			} else if (c.nodeType === c.TEXT_NODE || c.nodeType === c.COMMENT_NODE) {
				if (currentOffset && (currentOffset < targetRange.end)) {
					if (DU.isComment(c)) {
						currentOffset += DU.decodedCommentLength(c);
					} else {
						currentOffset += c.nodeValue.length;
					}
					if (currentOffset >= targetRange.end) {
						waitingForEndMatch = false;
					}
				}

				if (wasWaiting || waitingForEndMatch) {
					// Part of target range
					elements.push(c);
				} else if (!currentOffset) {
					// Accumulate nodes without dsr
					precedingNodes.push(c);
				}
			}

			if (wasWaiting && !waitingForEndMatch) {
				break;
			}

			// Skip over encapsulated content
			var typeOf = DU.isElt(c) ? c.getAttribute('typeof') || '' : '';
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
		} else if (numElements < numChildren) {
			return { done: !waitingForEndMatch, nodes: elements } ;
		} else { /* numElements === numChildren */
			return { done: !waitingForEndMatch, nodes: [element] } ;
		}
	}

	return walkDOM(root);
};

var normalizeWikitext = function(str) {
	// Ignore leading tabs vs. leading spaces
	str = str.replace(/^\t/, ' ');
	str = str.replace(/\n\t/g, '\n ');
	// Normalize multiple spaces to single space
	str = str.replace(/ +/g, ' ');
	// Eliminate spaces around wikitext chars
	// gwicke: disabled for now- too aggressive IMO
	// str = str.replace(/([<"'!#\*:;+-=|{}\[\]\/]) /g, "$1");
	// Ignore capitalization of tags and void tag indications
	str = str.replace(/<(\/?)([^ >\/]+)((?:[^>\/]|\/(?!>))*)\/?>/g,
			function(match, close, name, remaining) {
		return '<' + close + name.toLowerCase() +
			remaining.replace(/ $/, '') + '>';
	});
	// Ignore whitespace in table cell attributes
	str = str.replace(/(^|\n|\|(?=\|)|!(?=!))(\{\||\|[\-+]*|!) *([^|\n]*?) *(?=[|\n]|$)/g, '$1$2$3');
	// Ignore trailing semicolons and spaces in style attributes
	str = str.replace(/style\s*=\s*"[^"]+"/g, function(match) {
		return match.replace(/\s|;(?=")/g, '');
	});
	// Strip double-quotes
	str = str.replace(/"([^"]*?)"/g, '$1');
	// Ignore implicit </small> and </center> in table cells or the end
	// of the string for now
	str = str.replace(/(^|\n)<\/(?:small|center)>(?=\n[|!]|\n?$)/g, '');
	str = str.replace(/([|!].*?)<\/(?:small|center)>(?=\n[|!]|\n?$)/gi, '$1');
	return str;
};

var normalizeWS = function(html) {
	return html.replace(/<p>\s*<br\s*\/?>\s*/g, '<p>').replace(/<p><\/p>/g, '').replace(/^\s+$/g, '');
};

// Get diff substrings from offsets
var formatDiff = function(oldWt, newWt, offset, context) {
	return [
		'----',
		oldWt.substring(offset[0].start - context, offset[0].end + context),
		'++++',
		newWt.substring(offset[1].start - context, offset[1].end + context),
	].join('\n');
};

var checkIfSignificant = function(offsets, data) {
	var oldWt = data.oldWt;
	var newWt = data.newWt;

	var oldBody = domino.createDocument(data.oldHTML.body).body;
	var newBody = domino.createDocument(data.newHTML.body).body;

	// Merge data-parsoid so that HTML nodes can be compared and diff'ed.
	DU.applyDataParsoid(oldBody.ownerDocument, data.oldDp.body);
	DU.applyDataParsoid(newBody.ownerDocument, data.newDp.body);

	var i, k, diff, offset;
	var results = [];
	// Use the full tests for fostered content.
	// Fostered content => semantic diffs.
	if (!/("|&quot;)fostered("|&quot;)\s*:\s*true\b/.test(oldBody.outerHTML)) {
		// Quick test for no semantic diffs
		// If parsoid-normalized HTML for old and new wikitext is identical,
		// the wt-diffs are purely syntactic.
		var normalizedOld = DU.normalizeOut(oldBody, true);
		var normalizedNew = DU.normalizeOut(newBody, true);
		if (normalizedOld === normalizedNew) {
			for (i = 0; i < offsets.length; i++) {
				offset = offsets[i];
				results.push({
					type: 'skip',
					offset: offset,
					wtDiff: formatDiff(oldWt, newWt, offset, 0),
				});
			}
			return results;
		}
	}

	var origOut, newOut, origHTML, newHTML;
	// Now, proceed with full blown diffs
	for (i = 0; i < offsets.length; i++) {
		offset = offsets[i];
		var origOrigHTML = '';
		var origNewHTML = '';
		var thisResult = { offset: offset };

		var implicitlyClosed = (offset[0].start === offset[0].end &&
				newWt.substr(offset[1].start, offset[1].end - offset[1].start)
					.match(/^\n?<\/[^>]+>\n?$/));
		if (implicitlyClosed) {
			// An element was implicitly closed. Fudge the orig offset
			// slightly so it finds the corresponding elements which have the
			// original (unclosed) DSR.
			offset[0].start--;
		}

		var res = findMatchingNodes(oldBody, offset[0] || {}, oldWt.length);
		origOut = res ? res.nodes : [];
		for (k = 0; k < origOut.length; k++) {
			// node need not be an element always!
			origOrigHTML += DU.serializeNode(origOut[k], { smartQuote: false });
		}
		// Normalize away <br/>'s added by Parsoid because of newlines in wikitext
		origHTML = normalizeWS(DU.formatHTML(DU.normalizeOut(origOrigHTML)));

		res = findMatchingNodes(newBody, offset[1] || {}, newWt.length);
		newOut = res ? res.nodes : [];
		for (k = 0; k < newOut.length; k++) {
			// node need not be an element always!
			origNewHTML += DU.serializeNode(newOut[k], { smartQuote: false });
		}
		// Normalize away <br/>'s added by Parsoid because of newlines in wikitext
		newHTML = normalizeWS(DU.formatHTML(DU.normalizeOut(origNewHTML)));

		// compute wt diffs
		var wt1 = oldWt.substring(offset[0].start, offset[0].end);
		var wt2 = newWt.substring(offset[1].start, offset[1].end);
		// thisResult.wtDiff = Util.contextDiff(wt1, wt2, false, true, true);

		diff = Diff.htmlDiff(origHTML, newHTML, false, true, true);
		if (diff.length > 2000) {
			diff = diff.substring(0, 2000) + "-- TRUNCATED TO 2000 chars --";
		}

		// No context by default
		thisResult.wtDiff = formatDiff(oldWt, newWt, offset, 0);

		// Normalize wts to check if we really have a semantic diff
		thisResult.type = 'skip';
		if (diff.length > 0) {
			var normWT1 = normalizeWikitext(wt1);
			var normWT2 = normalizeWikitext(wt2);
			if (normWT1 !== normWT2) {
				thisResult.htmlDiff = diff;
				thisResult.type = 'fail';
				// Provide context for semantic diffs
				thisResult.wtDiff = formatDiff(oldWt, newWt, offset, 25);
			}
		}
		results.push(thisResult);
	}
	return results;
};

function parsoidPost(env, options, cb) {
	var title = encodeURIComponent(options.title);

	var httpOptions = {
		method: 'POST',
		json: true,
		body: options.data,
	};

	var uri = options.uri;
	// make sure the Parsoid URI ends on /
	if (!/\/$/.test(uri)) {
		uri += '/';
	}
	uri += 'v2/' + options.domain + '/';
	if (options.html2wt) {
		uri += 'wt/' + title + '/' + options.oldid;
		httpOptions.body.scrubWikitext = true;
	} else {  // wt2html
		uri += 'pagebundle/' + title;
	}
	httpOptions.uri = uri;

	if (options.useSelser) {
		httpOptions.body._rtSelser = true;
	}

	return new Promise(function(resolve, reject) {
		// TODO: convert Util.retryingHTTPRequest to a promise returning func
		Util.retryingHTTPRequest(10, httpOptions, function(err, res, body) {
			if (!err && res.statusCode !== 200) {
				err = new Error('Got status code: ' + res.statusCode);
			}
			if (err) { return reject(err); }

			// FIXME: Parse time was removed from profiling when we stopped
			// sending the x-parsoid-performance header.
			if (options.recordSizes) {
				var prefix = '';
				if (options.profilePrefix) {
					prefix += options.profilePrefix + ':';
				}
				var str;
				if (options.html2wt) {
					prefix += 'html:';
					str = body.wikitext.body;
				} else {
					prefix += 'wt:';
					str = body.html.body;
				}
				env.profile.size[prefix + 'raw'] = str.length;
				// Compress to record the gzipped size
				zlib.gzip(str, function(err, gzippedbuf) {
					if (err) { return reject(err); }
					env.profile.size[prefix + 'gzip'] = gzippedbuf.length;
					resolve(body);
				});
			} else {
				resolve(body);
			}
		});
	}).nodify(cb);
}

function roundTripDiff(env, parsoidOptions, data) {
	var diff = Diff.diffLines(data.newWt, data.oldWt);
	var offsets = Diff.convertDiffToOffsetPairs(diff);
	if (!diff.length || !offsets.length) { return []; }

	var options = Object.assign({
		wt2html: true,
		data: { wikitext: data.newWt },
	}, parsoidOptions);
	return parsoidPost(env, options).then(function(body) {
		data.newHTML = body.html;
		data.newDp = body['data-parsoid'];
		return checkIfSignificant(offsets, data);
	});
}

// Returns a Promise for a formatted string.  `cb` is optional.
function runTests(title, options, formatter, cb) {
	var setup = function(parsoidConfig) {
		// options are ParsoidConfig options if module.parent, otherwise they
		// are CLI options (so use the Util.set* helpers to process them)
		if (module.parent) {
			if (options && options.setup) {
				options.setup(parsoidConfig);
			}
		} else {
			Util.setTemplatingAndProcessingFlags(parsoidConfig, options);
			Util.setDebuggingFlags(parsoidConfig, options);
		}
	};
	var parsoidConfig = new ParsoidConfig({ setup: setup });
	var err, domain, prefix;
	if (options.prefix) {
		// If prefix is present, use that.
		prefix = options.prefix;
		// Get the domain from the interwiki map.
		var apiURL = parsoidConfig.interwikiMap.get(prefix);
		if (!apiURL) {
			err = new Error('Couldn\'t find the domain for prefix ' + prefix);
		}
		domain = url.parse(apiURL).hostname;
	} else if (options.domain) {
		domain = options.domain;
		prefix = parsoidConfig.reverseIWMap.get(domain);
	} else {
		err = new Error('No domain or prefix provided.');
	}
	var env;
	var closeFormatter = function(err, results) {
		return formatter(err, prefix, title, results, env && env.profile);
	};
	var parsoidOptions = {
		uri: options.parsoidURL,
		domain: domain,
		title: title,
	};
	var data = {};
	return Promise[err ? 'reject' : 'resolve'](err).then(function() {
		return MWParserEnvironment.getParserEnv(
			parsoidConfig, null, { prefix: prefix, pageName: title }
		);
	}).then(function(_env) {
		env = _env;
		env.profile = { time: { total: 0, start: Date.now() }, size: {} };
		var target = env.resolveTitle(env.normalizeTitle(env.page.name), '');
		return TemplateRequest.setPageSrcInfo(env, target, null);
	}).then(function() {
		data.oldWt = env.page.src;
		// First, fetch the HTML for the requested page's wikitext
		var options = Object.assign({
			wt2html: true,
			recordSizes: true,
			data: { wikitext: data.oldWt },
		}, parsoidOptions);
		return parsoidPost(env, options);
	}).then(function(body) {
		data.oldHTML = body.html;
		data.oldDp = body['data-parsoid'];
		// Now, request the wikitext for the obtained HTML
		var options = Object.assign({
			html2wt: true,
			recordSizes: true,
			oldid: env.page.meta.revision.revid,
			data: {
				html: data.oldHTML,
				original: {
					'data-parsoid': data.oldDp,
					wikitext: { body: data.oldWt },
				},
			},
		}, parsoidOptions);
		return parsoidPost(env, options);
	}).then(function(body) {
		data.newWt = body.wikitext.body;
		return roundTripDiff(env, parsoidOptions, data);
	}).then(function(results) {
		data.diffs = results;
		// Once we have the diffs between the round-tripped wt,
		// to test rt selser we need to modify the HTML and request
		// the wt again to compare with selser, and then concat the
		// resulting diffs to the ones we got from basic rt
		var newDocument = DU.parseHTML(data.oldHTML.body);
		var newNode = newDocument.createComment('rtSelserEditTestComment');
		newDocument.body.appendChild(newNode);
		var options = Object.assign({
			html2wt: true,
			useSelser: true,
			oldid: env.page.meta.revision.revid,
			data: {
				html: newDocument.outerHTML,
				original: {
					'data-parsoid': data.oldDp,
					wikitext: { body: data.oldWt },
					html: data.oldHTML,
				},
			},
			profilePrefix: 'selser',
		}, parsoidOptions);
		return parsoidPost(env, options);
	}).then(function(body) {
		var out = body.wikitext.body;

		// Finish the total time now
		// FIXME: Is the right place to end it?
		if (env.profile && env.profile.time) {
			env.profile.time.total = Date.now() - env.profile.time.start;
		}

		// Remove the selser trigger comment
		data.newWt = out.replace(/<!--rtSelserEditTestComment-->\n*$/, '');

		return roundTripDiff(env, parsoidOptions, data);
	}).then(function(selserDiffs) {
		selserDiffs.forEach(function(diff) {
			diff.selser = true;
		});
		if (selserDiffs.length) {
			data.diffs = data.diffs.concat(selserDiffs);
		}
		return data.diffs;
	}).then(
		closeFormatter.bind(null, null),
		closeFormatter
	).nodify(cb);
}


if (require.main === module) {
	var options = Util.addStandardOptions({
		xml: {
			description: 'Use xml callback',
			boolean: true,
			default: false,
		},
		prefix: {
			description: 'Which wiki prefix to use; e.g. "enwiki" for ' +
				'English wikipedia, "eswiki" for Spanish, "mediawikiwiki" ' +
				'for mediawiki.org',
			default: '',
		},
		domain: {
			description: 'Which wiki to use; e.g. "en.wikipedia.org" for' +
				' English wikipedia',
			default: 'en.wikipedia.org',
		},
		parsoidURL: {
			description: 'The URL for the Parsoid API',
		},
	}, {
		// defaults for standard options
		rtTestMode: true,  // suppress noise by default
	});

	var opts = yargs.usage(
		'Usage: $0 [options] <page-title> \n\n', options
	).check(Util.checkUnknownArgs.bind(null, options));

	var argv = opts.argv;
	var title = argv._[0];

	if (!title) {
		return opts.showHelp();
	}

	Promise.resolve().then(function() {
		if (argv.parsoidURL) { return; }

		// Start our own Parsoid server
		// TODO: This will not be necessary once we have a top-level testing
		// script that takes care of setting everything up.
		var apiServer = require('./apiServer.js');
		var parsoidOptions = { quiet: true };
		if (opts.apiURL) {
			parsoidOptions.mockUrl = opts.apiURL;
		}
		apiServer.exitOnProcessTerm();
		return apiServer.startParsoidServer(parsoidOptions).then(function(ret) {
			argv.parsoidURL = ret.url;
		});
	}).then(function() {
		var formatter = Util.booleanOption(argv.xml) ? xmlFormat : plainFormat;
		return runTests(title, argv, formatter);
	}).then(function(output) {
		console.log(output);
		process.exit(0);
	}).done();
} else if (typeof module === 'object') {
	module.exports.runTests = runTests;
	module.exports.xmlFormat = xmlFormat;
}
