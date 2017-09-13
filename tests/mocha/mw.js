/* global describe, it, before, after */

'use strict';

var fs = require('fs');
var yaml = require('js-yaml');
var request = require('supertest');
var path = require('path');
var domino = require('domino');

require('chai').should();

var serviceWrapper = require('../serviceWrapper.js');

var optionsPath = path.resolve(__dirname, './test.config.yaml');
var optionsYaml = fs.readFileSync(optionsPath, 'utf8');
var parsoidOptions = yaml.load(optionsYaml).services[0].conf;

parsoidOptions.useBatchAPI = true;

describe('MW API', function() {
	var api, runner;
	var mockDomain = 'customwiki';

	before(function() {
		return serviceWrapper.runServices({
			parsoidOptions: parsoidOptions,
		})
		.then(function(ret) {
			api = ret.parsoidURL;
			runner = ret.runner;
		});
	});

	describe('Batching', function() {
		it('should render revision id', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/html/Revision_ID/63')
			.expect(200)
			.expect(function(res) {
				var doc = domino.createDocument(res.text);
				var p = doc.querySelector('*[typeof="mw:Transclusion"]');
				var dataMw = JSON.parse(p.getAttribute('data-mw'));
				dataMw.parts[0].template.target.function.should.equal('revisionid');
				p.innerHTML.should.equal('63');
			})
			.end(done);
		});
	});

	after(function() {
		return runner.stop();
	});

});
