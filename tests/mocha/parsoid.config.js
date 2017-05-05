/** Test cases for the linter */

'use strict';

/* global describe, it */
require('../../core-upgrade.js');
require('chai').should();

var path = require('path');

var ParsoidConfig = require('../../lib/config/ParsoidConfig.js').ParsoidConfig;

describe('Parsoid Config setup ', function() {
	it('should sanitize unnacceptable config values to defaults', function() {
		var ls = {
			setup: function(parsoidConfig) {
				parsoidConfig.timeouts.cpu = "boo!";
				parsoidConfig.timeouts.mwApi = 1;
			},
		};
		var pc = new ParsoidConfig(ls);
		pc.timeouts.request.should.equal(4 * 60 * 1000);
		pc.timeouts.mwApi.configInfo.should.equal(40 * 1000);
	});
	it('should only sanitize unnacceptable config values', function() {
		var ls = {
			setup: function(parsoidConfig) {
				parsoidConfig.timeouts.request = "boo!";
			},
		};
		var pc = new ParsoidConfig(ls);
		pc.timeouts.request.should.equal(4 * 60 * 1000);
	});
	it('should', function() {
		var ls = path.resolve(__dirname, './test.localsettings.js');
		var pc = new ParsoidConfig(null, { localsettings: ls });
		pc.somethingWacky.should.equal(true);
	});
});
