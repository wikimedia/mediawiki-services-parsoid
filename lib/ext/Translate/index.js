'use strict';

/* exported ParsoidExtApi */ // suppress 'unused variable' warning
var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.5.3');

// Translate constructor
module.exports = function() {
	this.config = {
		tags: [
			{ name: 'translate' },
			{ name: 'tvar' },
		],
	};
};
