'use strict';

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.5.1');
var Util = ParsoidExtApi.Util;
var DU = ParsoidExtApi.DOMUtils;

/**
 * See tests/parser/parserTestsParserHook.php in core.
 */

var myLittleHelper = function(env, extToken, argDict, html, cb) {
	var tsr = extToken.dataAttribs.tsr;

	if (!extToken.dataAttribs.tagWidths[1]) {
		argDict.body = null;  // Serialize to self-closing.
	}

	var addWrapperAttrs = function(firstNode) {
		firstNode.setAttribute('typeof', 'mw:Extension/' + argDict.name);
		DU.setDataMw(firstNode, argDict);
		DU.setDataParsoid(firstNode, {
			tsr: Util.clone(tsr),
			src: extToken.dataAttribs.src,
		});
	};

	var tokens = DU.buildDOMFragmentTokens(
		env, extToken, html, addWrapperAttrs,
		{ setDSR: true, isForeignContent: true }
	);

	cb({ tokens: tokens });
};

var dumpHook = function(manager, pipelineOpts, extToken, cb) {
	// All the interesting info is in data-mw.
	var html = '<pre />';
	var argDict = Util.getArgInfo(extToken).dict;
	myLittleHelper(manager.env, extToken, argDict, html, cb);
};

// Async processing means this isn't guaranteed to be in the right order.
// Plus, parserTests reuses the environment so state is bound to clash.
var staticTagHook = function(manager, pipelineOpts, extToken, cb) {
	var argDict = Util.getArgInfo(extToken).dict;
	var html;
	if (argDict.attrs.action === 'flush') {
		html = '<p>' + this.state.buf + '</p>';
		this.state.buf = '';  // Reset.
	} else {
		// FIXME: Choose a better DOM representation that doesn't mess with
		// newline constraints.
		html = '<span />';
		this.state.buf += argDict.body.extsrc;
	}
	myLittleHelper(manager.env, extToken, argDict, html, cb);
};

// Tag constructor
module.exports = function() {
	this.state = { buf: '' };  // Ughs
	this.config = {
		tags: [
			{ name: 'tag', tokenHandler: dumpHook },
			{ name: 'tåg', tokenHandler: dumpHook },
			{ name: 'statictag', tokenHandler: staticTagHook.bind(this) },
		],
	};
};
