/**
 * This file exports the stuff required by external extensions.
 *
 * @module
 */

'use strict';

// Note that extension code gets core-upgrade when they load the extension API.
require('../../core-upgrade.js');
var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var Sanitizer = require('../wt2html/tt/Sanitizer.js').Sanitizer;

var semver = require('semver');
var parsoidJson = require('../../package.json');

// FIXME: state is only required for performance reasons so that
// we can overlap extension wikitext parsing with main pipeline.
// Otherwise, we can simply parse this sync in an independent pipeline
// without any state.
var parseWikitextToDOM = Promise.async(function *(state, extArgs, leadingWS, wikitext, parseOpts) {
	var manager = state.manager;
	var cb = state.cb;

	// Pass an async signal since the ext-content won't be processed synchronously
	cb({ async: true });

	var doc;
	if (!wikitext) {
		doc = DU.parseHTML('');
	} else {
		// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
		// The DOM will get unwrapped and integrated  when processing the top level document.
		var dataAttribs = state.extToken.dataAttribs;
		var tsr = dataAttribs.tsr;
		var tagWidths = dataAttribs.tagWidths;
		var opts = {
			// Full pipeline for processing content
			pipelineType: 'text/x-mediawiki/full',
			pipelineOpts: {
				wrapTemplates: true,
				extTag: parseOpts.extTag,
				inTemplate: parseOpts.inTemplate,
				allowNestedRef: parseOpts.allowNestedRef, // FIXME: LEAKY
				noPre: parseOpts.noPre, // FIXME: LEAKY
				noPWrapping: parseOpts.noPWrapping, // FIXME: LEAKY
			},
			srcOffsets: [ tsr[0] + tagWidths[0] + leadingWS.length, tsr[1] - tagWidths[1] ],
		};

		// Actual processing now
		doc = yield Util.promiseToProcessContent(manager.env, manager.frame, wikitext, opts);
	}

	// Create a wrapper and migrate content into the wrapper
	var wrapper = doc.createElement(parseOpts.wrapperTag);
	DU.migrateChildren(doc.body, wrapper);
	doc.body.appendChild(wrapper);

	// Sanitize argDict.attrs and set on the wrapper
	// FIXME: Sanitizer is expecting lower case tag names.
	var sanitizedAttrs = Sanitizer.sanitizeTagAttrs(manager.env, wrapper.nodeName.toLowerCase(), null, extArgs);
	Object.keys(sanitizedAttrs).forEach(function(k) {
		if (sanitizedAttrs[k][0]) {
			wrapper.setAttribute(k, sanitizedAttrs[k][0]);
		}
	});

	// Mark empty content DOMs
	if (!wikitext) {
		DU.getDataParsoid(wrapper).empty = true;
	}

	return doc;
});

module.exports = {
	versionCheck: function(requestedVersion) {
		// Throw exception if the supplied major/minor version is
		// incompatible with the currently running Parsoid.
		if (!semver.satisfies(parsoidJson.version, requestedVersion)) {
			throw new Error(
				"Parsoid version " + parsoidJson.version + " is inconsistent " +
				"with required version " + requestedVersion
			);
		}

		// Return the exports to support chaining.  We could also elect
		// to return a slightly different version of the exports here if
		// we wanted to support multiple API versions.
		return {
			Promise: Promise,
			// XXX we may wish to export a subset of Util/DOMUtils/defines
			// and explicitly mark the exported functions as "stable", ie
			// we need to bump Parsoid's major version if the exported
			// functions are changed.
			Util: Util,
			DOMUtils: DU,
			TemplateRequest: require('../mw/ApiRequest.js').TemplateRequest,
			JSUtils: require('../utils/jsutils.js').JSUtils,
			addMetaData: require('../wt2html/DOMPostProcessor.js').DOMPostProcessor.addMetaData,
			defines: require('../wt2html/parser.defines.js'),
			parseWikitextToDOM: parseWikitextToDOM,
		};
	},
};
