'use strict';
require('../../../core-upgrade.js');

var DU = require('../../utils/DOMUtils.js').DOMUtils;
var Promise = require('../../utils/promise.js');

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
