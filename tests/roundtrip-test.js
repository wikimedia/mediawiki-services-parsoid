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

// Find the subset of leaf/non-leaf nodes whose DSR ranges
// span the wikitext range provided as input.
var findMatchingNodes = function(env, node, range) {
	console.assert(DU.isElt(node));

	// Skip subtrees that are outside our target range
	var dp = DU.getDataParsoid(node);
	if (!Util.isValidDSR(dp.dsr) || dp.dsr[0] > range.end || dp.dsr[1] < range.start) {
		return [];
	}

	// If target range subsumes the node, we are done.
	if (dp.dsr[0] >= range.start && dp.dsr[1] <= range.end) {
		return [node];
	}

	// Cannot inspect template content subtree at a finer grained level
	if (DU.isFirstEncapsulationWrapperNode(node)) {
		return [node];
	}

	// Cannot inspect image subtree at a finer grained level
	var typeOf = node.getAttribute('typeof') || '';
	if (/\bmw:Image(\/|\s|$)/.test(typeOf) && /^(FIGURE|SPAN)$/.test(node.nodeName)) {
		return [node];
	}

	// We are in the target range -- examine children.
	// 1. Walk past nodes that are before our desired range.
	// 2. Collect nodes within our desired range.
	// 3. Stop walking once you move beyond the desired range.
	var elts = [];
	var offset = dp.dsr[0];
	var c = node.firstChild;
	while (c) {
		if (DU.isElt(c)) {
			dp = DU.getDataParsoid(c);
			var dsr = dp.dsr;
			if (Util.isValidDSR(dsr)) {
				if (dsr[1] >= range.start) {
					// We have an overlap!
					elts = elts.concat(findMatchingNodes(env, c, range));
				}
				offset = dp.dsr[1];
			} else {
				// SSS FIXME: This is defensive coding here.
				//
				// This should not happen really anymore.
				// DSR computation is fairly solid now and
				// shouldn't be leaving holes.
				//
				// If we see no errors in rt-testing runs,
				// I am going to rip this out.

				env.log("error/diff", "Bad dsr for " + c.nodeName + ": "
					+ c.outerHTML.substr(0, 50));

				if (dp.dsr && typeof (dsr[1]) === 'number') {
					// We can cope in this case
					if (dsr[1] >= range.start) {
						// Update dsr[0]
						dp.dsr[0] = offset;

						// We have an overlap!
						elts = elts.concat(findMatchingNodes(env, c, range));
					}
					offset = dp.dsr[1];
				} else if (offset >= range.start) {
					// Swallow it wholesale rather than try
					// to find finer-grained matches in the subtree
					elts.push(c);

					// offset will now be out-of-sync till we hit
					// another element with a valid DSR[1] value.
				}
			}
		} else {
			var len = DU.isText(c) ? c.nodeValue.length : DU.decodedCommentLength(c);
			if (offset + len >= range.start) {
				// We have an overlap!
				elts.push(c);
			}
			offset += len;
		}

		// All done!
		if (offset > range.end) {
			break;
		}

		// Skip over encapsulated content
		if (DU.isFirstEncapsulationWrapperNode(c)) {
			c = DU.skipOverEncapsulatedContent(c);
		} else {
			c = c.nextSibling;
		}
	}

	return elts;
};

var getMatchingHTML = function(env, body, offsetRange, nlDiffs) {
	// If the diff context straddles a template boundary (*) and if
	// the HTML context includes the template content in only one
	// the new/old DOMs, we can falsely flag this as a semantic
	// diff. To improve the possibility of including the template
	// content in both DOMs, expand range at both ends by 1 char.
	//
	// (*) This happens because our P-wrapping code occasionally
	//     swallows newlines into template context.
	// See https://phabricator.wikimedia.org/T89628
	if (nlDiffs) {
		offsetRange.start = offsetRange.start - 1;
		offsetRange.end = offsetRange.end + 1;
	}

	var html = '';
	var out = findMatchingNodes(env, body, offsetRange);
	for (var i = 0; i < out.length; i++) {
		// node need not be an element always!
		html += DU.serializeNode(out[i], { smartQuote: false }).str;
	}
	html = DU.normalizeOut(html);

	// Normalize away <br/>'s added by Parsoid because of newlines in wikitext.
	// Do this always, not just when nlDiffs is true, because newline diffs
	// can show up at extremities of other wt diffs.
	return html.replace(/<p>\s*<br\s*\/?>\s*/g, '<p>').replace(/<p><\/p>/g, '').replace(/(^\s+|\s+$)/g, '');
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

// Get diff substrings from offsets
var formatDiff = function(oldWt, newWt, offset, context) {
	return [
		'----',
		oldWt.substring(offset[0].start - context, offset[0].end + context),
		'++++',
		newWt.substring(offset[1].start - context, offset[1].end + context),
	].join('\n');
};

function stripElementIds(node) {
	while (node) {
		if (DU.isElt(node)) {
			var id = node.getAttribute('id');
			if (/^mw[\w-]{2,}$/.test(id)) {
				node.removeAttribute('id');
			}
			if (node.firstChild) {
				stripElementIds(node.firstChild);
			}
		}
		node = node.nextSibling;
	}
}

var checkIfSignificant = function(env, offsets, data) {
	var oldWt = data.oldWt;
	var newWt = data.newWt;

	var oldBody = domino.createDocument(data.oldHTML.body).body;
	var newBody = domino.createDocument(data.newHTML.body).body;

	// Merge data-parsoid so that HTML nodes can be compared and diff'ed.
	DU.applyDataParsoid(oldBody.ownerDocument, data.oldDp.body);
	DU.applyDataParsoid(newBody.ownerDocument, data.newDp.body);

	// Strip 'mw..' ids from the DOMs. This matters for 2 scenarios:
	// * reduces noise in visual diffs
	// * all other things being equal after normalization, we don't
	//   assume DOMs are different simply because ids are different
	stripElementIds(oldBody.ownerDocument.body);
	stripElementIds(newBody.ownerDocument.body);

	var i, offset;
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

	// Now, proceed with full blown diffs
	for (i = 0; i < offsets.length; i++) {
		offset = offsets[i];
		var thisResult = { offset: offset };

		// Default: syntactic diff + no diff context
		thisResult.type = 'skip';
		thisResult.wtDiff = formatDiff(oldWt, newWt, offset, 0);

		// Is this a newline separator diff?
		var oldStr = oldWt.substring(offset[0].start, offset[0].end);
		var newStr = newWt.substring(offset[1].start, offset[1].end);
		var nlDiffs = /^\s*$/.test(oldStr) && /^\s*$/.test(newStr)
			&& (/\n/.test(oldStr) || /\n/.test(newStr));

		// Check if this is really a semantic diff
		var oldHTML = getMatchingHTML(env, oldBody, offset[0], nlDiffs);
		var newHTML = getMatchingHTML(env, newBody, offset[1], nlDiffs);
		var diff = Diff.htmlDiff(oldHTML, newHTML, false, true, true);
		if (diff.length > 0) {
			// Normalize wts to check if we really have a semantic diff
			var wt1 = normalizeWikitext(oldWt.substring(offset[0].start, offset[0].end));
			var wt2 = normalizeWikitext(newWt.substring(offset[1].start, offset[1].end));
			if (wt1 !== wt2) {
				// Syntatic diff + provide context for semantic diffs
				thisResult.type = 'fail';
				thisResult.wtDiff = formatDiff(oldWt, newWt, offset, 25);

				// Don't clog the rt-test server db with humongous diffs
				if (diff.length > 2000) {
					diff = diff.substring(0, 2000) + "-- TRUNCATED TO 2000 chars --";
				}
				thisResult.htmlDiff = diff;
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
		uri += 'wt/' + title;
		if (options.oldid) {
			uri += '/' + options.oldid;
		}
		httpOptions.body.scrubWikitext = true;
	} else {  // wt2html
		uri += 'pagebundle/' + title;
	}
	httpOptions.uri = uri;

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
		return checkIfSignificant(env, offsets, data);
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
		// Get the domain from the mw api map.
		if (parsoidConfig.mwApiMap.has(prefix)) {
			domain = parsoidConfig.mwApiMap.get(prefix).domain;
		} else {
			err = new Error('Couldn\'t find the domain for prefix: ' + prefix);
		}
	} else if (options.domain) {
		domain = options.domain;
		prefix = parsoidConfig.reverseMwApiMap.get(domain);
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
			data: {
				html: data.oldHTML,
				original: {
					'data-parsoid': data.oldDp,
					wikitext: { body: data.oldWt, },
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
	if (!argv._.length) {
		return opts.showHelp();
	}
	var title = String(argv._[0]);

	Promise.resolve().then(function() {
		if (argv.parsoidURL) { return; }

		// Start our own Parsoid server
		// TODO: This will not be necessary once we have a top-level testing
		// script that takes care of setting everything up.
		var apiServer = require('./apiServer.js');
		var parsoidOptions = { quiet: true };
		if (argv.apiURL) {
			parsoidOptions.mockUrl = argv.apiURL;
			argv.prefix = 'customwiki';
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
