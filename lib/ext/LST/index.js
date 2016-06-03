'use strict';

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.5.1');

var DU = ParsoidExtApi.DOMUtils;
var Promise = ParsoidExtApi.Promise;

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

// LST constructor
module.exports = function() {
	this.config = {
		tags: [
			{
				name: 'labeledSectiontransclusion/begin',
				serialHandler: serialHandler,
			}, {
				name: 'labeledSectiontransclusion/end',
				serialHandler: serialHandler,
			},
		],
	};
};
