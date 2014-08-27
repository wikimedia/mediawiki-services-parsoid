/** Test cases for lib/mediawiki.Util.js */
'use strict';
/*global describe, it, Promise*/
require("es6-shim");
var should = require("chai").should();

var MWParserEnvironment = require('../../lib/mediawiki.parser.environment.js' ).MWParserEnvironment,
	Util = require('../../lib/mediawiki.Util.js').Util,
	ParsoidConfig = require('../../lib/mediawiki.ParsoidConfig' ).ParsoidConfig;

describe( 'mediawiki.Util', function() {
	var parsoidConfig = new ParsoidConfig( null,	{ defaultWiki: 'enwiki' } );

	describe( 'parse()', function() {

		var parse = function(src, expansions) {
			return new Promise(function(resolve, reject) {
				MWParserEnvironment.getParserEnv( parsoidConfig, null, 'enwiki', 'Main_Page', null, function ( err, env ) {
					if (err) { return reject(err); }
					env.setPageSrcInfo(src);
					Util.parse(env, function(src, err, doc) {
						if (err) { return reject(err); }
						resolve(doc);
					}, null, src, expansions);
				});
			});
		};

		it('should create a sane document from an empty string', function() {
			return parse('foo').then(function(doc) {
				doc.should.have.property('nodeName', '#document');
				doc.outerHTML.startsWith('<!DOCTYPE html><html').should.equal(true);
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
			});
		});
	});
});
