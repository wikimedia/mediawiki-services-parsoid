'use strict';

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.6.1');

var DU = ParsoidExtApi.DOMUtils;
var Util = ParsoidExtApi.Util;
var Promise = ParsoidExtApi.Promise;
var defines = ParsoidExtApi.defines;

var SelfclosingTagTk = defines.SelfclosingTagTk;

// Special case for <section> until LST is implemented natively.
var serialHandler = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		var env = state.env;
		var typeOf = node.getAttribute('typeof') || '';
		var dp = DU.getDataParsoid(node);
		var src;
		if (dp.src) {
			src = dp.src;
		} else if (typeOf.match('begin')) {
			src = '<section begin="' + node.getAttribute('content') + '" />';
		} else if (typeOf.match('end')) {
			src = '<section end="' + node.getAttribute('content') + '" />';
		} else {
			env.log('error', 'LST <section> without content in: ' + node.outerHTML);
			src = '<section />';
		}
		return src;
	}),
};

// TODO: Properly handle this.
// Special handling for wikisource: hide section tags for now.
// See https://www.mediawiki.org/wiki/Parsoid/HTML_based_LST
var tokenHandler = function(manager, pipelineOpts, extToken, cb) {
	var sectionAttribs = [];
	var sectionType = 'mw:Extension/LabeledSectionTransclusion';

	extToken.getAttribute('options').some(function(kv) {
		if (kv.k === 'begin' || kv.k === 'end') {
			sectionType += '/' + kv.k;
			sectionAttribs.push({ k: 'content', v: kv.v });
			return true;
		}
	});
	sectionAttribs.push({ k: 'typeof', v: sectionType });

	var token = new SelfclosingTagTk('meta', sectionAttribs, {
		src: extToken.getAttribute('source'),
		tsr: Util.clone(extToken.dataAttribs.tsr),
	});

	cb({ tokens: [token] });
};

// LST constructor
module.exports = function() {
	this.config = {
		tags: [
			{
				name: 'section',
				tokenHandler: tokenHandler,
			},
			{
				name: 'labeledsectiontransclusion',
				serialHandler: serialHandler,
			},
			{
				name: 'labeledsectiontransclusion/begin',
				serialHandler: serialHandler,
			},
			{
				name: 'labeledsectiontransclusion/end',
				serialHandler: serialHandler,
			},
		],
	};
};
