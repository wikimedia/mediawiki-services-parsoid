/** Cases for testing the Pasoid API through HTTP */
'use strict';
/*global describe, it, before*/

var apiServer = require('../apiServer.js'),
	request = require('supertest'),
	domino = require('domino'),
	should = require('chai').should();

describe('Parsoid API', function () {
	var api;

	before(function (done) {
		new Promise(function (resolve, reject) {
			// Start a mock MediaWiki API server
			console.log("Starting mock api");
			apiServer.startMockAPIServer({}, resolve);
		}).then(function (mockUrl) {
			console.log("starting parsoid");
			apiServer.startParsoidServer({ mockUrl: mockUrl }, function (url) {
					api = url;
					done();
				});
		});
		apiServer.exitOnProcessTerm();
	});

	it("converts simple wikitext to HTML", function (done) {
		request(api)
		.post('/localhost/Main_Page')
		.send({wt: "foo"})
		.expect(200)
		.expect(function (res) {
			var doc = domino.createDocument(res.text);
			doc.should.have.property('nodeName', '#document');
			doc.outerHTML.startsWith('<!DOCTYPE html>').should.equal(true);
			doc.outerHTML.endsWith('</body></html>').should.equal(true);
			// verify that body has only one <html> tag, one <body> tag, etc.
			doc.childNodes.length.should.equal(2);// <!DOCTYPE> and <html>
			doc.firstChild.nodeName.should.equal('html');
			doc.lastChild.nodeName.should.equal('HTML');
			// <html> children should be <head> and <body>
			var html = doc.documentElement;
			html.childNodes.length.should.equal(2);
			html.firstChild.nodeName.should.equal('HEAD');
			html.lastChild.nodeName.should.equal('BODY');
			// <body> should have one child, <p>
			var body = doc.body;
			body.childElementCount.should.equal(1);
			body.firstElementChild.nodeName.should.equal('P');
			var p = doc.body.firstElementChild;
			p.innerHTML.should.equal('foo');
		})
		.end(done);
	});

	it("converts simple HTML to wikitext", function (done) {
		request(api)
		.post('/localhost/Main_Page')
		.send({html: "<i>foo</i>"})
		.expect(200)
		.expect("''foo''", done);
	});

	it("respects body parameter", function (done) {
		request(api)
		.post('/localhost/Main_Page')
		.send({wt: "''foo''", body: 1})
		.expect(200)
		.expect(/^<body/, done);
	});
});
