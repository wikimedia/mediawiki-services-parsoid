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
const { ContentUtils } = require('../utils/ContentUtils.js');
const { DOMDataUtils } = require('../utils/DOMDataUtils.js');
const { DOMUtils } = require('../utils/DOMUtils.js');
const { PipelineUtils } = require('../utils/PipelineUtils.js');
const { TokenUtils } = require('../utils/TokenUtils.js');
const { Util } = require('../utils/Util.js');
const { WTUtils } = require('../utils/WTUtils.js');
const { Sanitizer } = require('../wt2html/tt/Sanitizer.js');

/**
 * Create a parsing pipeline to parse wikitext.
 *
 * @param {Object} state
 * @param {Object} state.manager
 * @param {string} wikitext
 * @param {Array} srcOffsets
 * @param {Object} parseOpts
 * @param parseOpts.extTag
 * @param parseOpts.extTagOpts
 * @param parseOpts.inTemplate
 * @param parseOpts.inlineContext
 * @param parseOpts.inPHPBlock
 * @param {boolean} sol
 * @return {Document}
 */
const parseWikitextToDOM = Promise.async(function *(state, wikitext, parseOpts, sol) {
	let doc;
	if (!wikitext) {
		doc = state.env.createDocument();
	} else {
		// Parse content to DOM and pass DOM-fragment token back to the main pipeline.
		// The DOM will get unwrapped and integrated  when processing the top level document.
		const pipelineOpts = parseOpts.pipelineOpts || {};
		const opts = {
			// Full pipeline for processing content
			pipelineType: 'text/x-mediawiki/full',
			pipelineOpts: {
				expandTemplates: true,
				extTag: pipelineOpts.extTag,
				extTagOpts: pipelineOpts.extTagOpts,
				inTemplate: pipelineOpts.inTemplate,
				inlineContext: pipelineOpts.inlineContext,
				// FIXME: Hack for backward compatibility
				// support for extensions that rely on this behavior.
				inPHPBlock: pipelineOpts.inPHPBlock,
			},
			srcOffsets: parseOpts.srcOffsets,
			sol,
		};
		// Actual processing now
		doc = yield PipelineUtils.promiseToProcessContent(state.env, parseOpts.frame || state.frame, wikitext, opts);
	}
	return doc;
});

/**
 * FIXME: state is only required for performance reasons so that
 * we can overlap extension wikitext parsing with main pipeline.
 * Otherwise, we can simply parse this sync in an independent pipeline
 * without any state.
 *
 * @param {Object} state
 * @param {Array} extArgs
 * @param {string} leadingWS
 * @param {string} wikitext
 * @param {Object} parseOpts
 * @return {Document}
 */
const parseTokenContentsToDOM = Promise.async(function *(state, extArgs, leadingWS, wikitext, parseOpts) {
	const dataAttribs = state.extToken.dataAttribs;
	const extTagOffsets = dataAttribs.extTagOffsets;
	const srcOffsets = [
		extTagOffsets[0] + extTagOffsets[2] + leadingWS.length,
		extTagOffsets[1] - extTagOffsets[3]
	];

	const doc = yield parseWikitextToDOM(
		state,
		wikitext,
		Object.assign({ srcOffsets }, parseOpts),
		/* sol */true
	);

	// Create a wrapper and migrate content into the wrapper
	const wrapper = doc.createElement(parseOpts.wrapperTag);
	DOMUtils.migrateChildren(doc.body, wrapper);
	doc.body.appendChild(wrapper);

	// Sanitize argDict.attrs and set on the wrapper
	Sanitizer.applySanitizedArgs(state.env, wrapper, extArgs);

	// Mark empty content DOMs
	if (!wikitext) {
		DOMDataUtils.getDataParsoid(wrapper).empty = true;
	}

	if (state.extToken.dataAttribs.selfClose) {
		DOMDataUtils.getDataParsoid(wrapper).selfClose = true;
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
			// XXX we may wish to export a subset of Util/DOMUtils/defines
			// and explicitly mark the exported functions as "stable", ie
			// we need to bump Parsoid's major version if the exported
			// functions are changed.
			addMetaData: require('../wt2html/DOMPostProcessor.js').DOMPostProcessor.addMetaData,
			ContentUtils,
			DOMDataUtils,
			DOMUtils,
			JSUtils: require('../utils/jsutils.js').JSUtils,
			parseTokenContentsToDOM,
			parseWikitextToDOM,
			Promise: Promise,
			Sanitizer,
			TemplateRequest: require('../mw/ApiRequest.js').TemplateRequest,
			TokenTypes: require('../tokens/TokenTypes.js'),
			TokenUtils,
			Util,
			WTUtils,
		};
	},
};
