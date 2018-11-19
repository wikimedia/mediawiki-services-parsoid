/**
 * This file exports the stuff required by external extensions.
 *
 * @module
 */

'use strict';

// Note that extension code gets core-upgrade when they load the extension API.
require('../../core-upgrade.js');

const semver = require('semver');
const parsoidJson = require('../../package.json');
const Promise = require('../utils/promise.js');
const { PipelineUtils } = require('../utils/PipelineUtils.js');
const { TokenUtils } = require('../utils/TokenUtils.js');
const { Util } = require('../utils/Util.js');
const { DOMUtils: DU } = require('../utils/DOMUtils.js');
const { Sanitizer, SanitizerConstants } = require('../wt2html/tt/Sanitizer.js');

const parseWikitextToDOM = Promise.async(function *(state, wikitext, srcOffsets, parseOpts) {
	const { manager } = state;
	let doc;
	if (!wikitext) {
		doc = DU.parseHTML('');
	} else {
		// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
		// The DOM will get unwrapped and integrated  when processing the top level document.
		const opts = {
			// Full pipeline for processing content
			pipelineType: 'text/x-mediawiki/full',
			pipelineOpts: {
				expandTemplates: true,
				extTag: parseOpts.extTag,
				extTagOpts: parseOpts.extTagOpts,
				inTemplate: parseOpts.inTemplate,
				inlineContext: parseOpts.inlineContext,
				// FIXME: Hack for backward compatibility
				// support for extensions that rely on this behavior.
				inPHPBlock: parseOpts.inPHPBlock,
			},
			srcOffsets: srcOffsets,
		};
		// Actual processing now
		doc = yield PipelineUtils.promiseToProcessContent(manager.env, manager.frame, wikitext, opts);
	}
	return doc;
});

// FIXME: state is only required for performance reasons so that
// we can overlap extension wikitext parsing with main pipeline.
// Otherwise, we can simply parse this sync in an independent pipeline
// without any state.
const parseTokenContentsToDOM = Promise.async(function *(state, extArgs, leadingWS, wikitext, parseOpts) {
	const dataAttribs = state.extToken.dataAttribs;
	const tsr = dataAttribs.tsr;
	const tagWidths = dataAttribs.tagWidths;
	const srcOffsets = [ tsr[0] + tagWidths[0] + leadingWS.length, tsr[1] - tagWidths[1] ];

	const doc = yield parseWikitextToDOM(state, wikitext, srcOffsets, parseOpts);

	// Create a wrapper and migrate content into the wrapper
	const wrapper = doc.createElement(parseOpts.wrapperTag);
	DU.migrateChildren(doc.body, wrapper);
	doc.body.appendChild(wrapper);

	// Sanitize argDict.attrs and set on the wrapper
	Sanitizer.applySanitizedArgs(state.manager.env, wrapper, extArgs);

	// Mark empty content DOMs
	if (!wikitext) {
		DU.getDataParsoid(wrapper).empty = true;
	}

	if (state.extToken.dataAttribs.selfClose) {
		DU.getDataParsoid(wrapper).selfClose = true;
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
			TokenUtils,
			Util,
			DOMUtils: DU,
			TemplateRequest: require('../mw/ApiRequest.js').TemplateRequest,
			JSUtils: require('../utils/jsutils.js').JSUtils,
			addMetaData: require('../wt2html/DOMPostProcessor.js').DOMPostProcessor.addMetaData,
			TokenTypes: require('../tokens/TokenTypes.js'),
			parseWikitextToDOM,
			parseTokenContentsToDOM,
			Sanitizer,
			SanitizerConstants,
		};
	},
};
