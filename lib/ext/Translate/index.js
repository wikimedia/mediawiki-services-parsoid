'use strict';

module.parent.require('./extapi.js').versionCheck('^0.8.1');

// Translate constructor
module.exports = function() {
	this.config = {
		tags: [
			{ name: 'translate' },
			{ name: 'tvar' },
		],
	};
};
