/** Test cases for the linter */
'use strict';
require('../../lib/core-upgrade.js');
/*global describe, it, Promise*/

var should = require("chai").should();

var ParsoidConfig = require('../../lib/mediawiki.ParsoidConfig').ParsoidConfig;

describe('Parsoid Config setup ', function() {
	it('should sanitize unnacceptable config values to defaults', function() {
		var ls = {
			setup: function(pc) {
				pc.timeouts.cpu = "boo!";
				pc.timeouts.mwApi = 1;
			},
		};

		var pc = new ParsoidConfig(ls);
		pc.timeouts.cpu.should.equal(5 * 60 * 1000);
		pc.timeouts.mwApi.configInfo.should.equal(40 * 1000);
	});
	it('should only sanitize unnacceptable config values', function() {
		var ls = {
			setup: function(pc) {
				pc.timeouts.cpu = "boo!";
				pc.timeouts.request = 5;
			},
		};

		var pc = new ParsoidConfig(ls);
		pc.timeouts.cpu.should.equal(5 * 60 * 1000);
		pc.timeouts.request.should.equal(5);
	});
});
