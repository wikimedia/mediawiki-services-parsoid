/** @module ext/LST */

'use strict';

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.11.0');

var DOMDataUtils = ParsoidExtApi.DOMDataUtils;
var Promise = ParsoidExtApi.Promise;

// TODO: We're keeping this serial handler around to remain backwards
// compatible with stored content version 1.3.0 and below.  Remove it
// when those versions are no longer supported.
var serialHandler = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		var env = state.env;
		var typeOf = node.getAttribute('typeof') || '';
		var dp = DOMDataUtils.getDataParsoid(node);
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

module.exports = function() {
	this.config = {
		// FIXME: This is registering <labeledsectiontransclusion> as an ext
		// tag.  All the more reason to get rid of this file altogether.
		tags: [
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
