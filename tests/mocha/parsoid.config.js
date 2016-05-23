/** Test cases for the linter */
'use strict';
require('../../core-upgrade.js');
/*global describe, it*/

var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;

describe('Parsoid Config setup ', function() {
	it('should sanitize unnacceptable config values to defaults', function() {
		var ls = {
			setup: function(pc) {
				pc.timeouts.cpu = "boo!";
				pc.timeouts.mwApi = 1;
			},
		};

		var pc = new ParsoidConfig(ls);
		pc.timeouts.request.should.equal(4 * 60 * 1000);
		pc.timeouts.mwApi.configInfo.should.equal(40 * 1000);
	});
	it('should only sanitize unnacceptable config values', function() {
		var ls = {
			setup: function(pc) {
				pc.timeouts.request = "boo!";
			},
		};

		var pc = new ParsoidConfig(ls);
		pc.timeouts.request.should.equal(4 * 60 * 1000);
	});
});
