/** Test cases for lib/mediawiki.Util.js */
'use strict';
/*global describe, it, Promise*/

require("es6-shim");
require("prfun");

var should = require("chai").should();

var url = require('url');

var MWParserEnvironment = require('../../lib/mediawiki.parser.environment.js' ).MWParserEnvironment,
	Util = require('../../lib/mediawiki.Util.js').Util,
	ParsoidConfig = require('../../lib/mediawiki.ParsoidConfig' ).ParsoidConfig;

describe( 'ParserPipelineFactory', function() {
	var parsoidConfig = new ParsoidConfig( null, { defaultWiki: 'enwiki' } );

	describe( 'parse()', function() {

		var parse = function(src, page_name, expansions) {
			return new Promise(function(resolve, reject) {
				MWParserEnvironment.getParserEnv( parsoidConfig, null, 'enwiki', page_name || 'Main_Page', null, function ( err, env ) {
					if (err) { return reject(err); }
					env.setPageSrcInfo(src);
					var pipeline = env.pipelineFactory;
					Promise.promisify( pipeline.parse, false, pipeline )(
						env, env.page.src, expansions
					).then( resolve, reject );
				});
			});
		};

		it('should create a sane document from a short string', function() {
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

		it('should handle page titles with embedded ?', function() {
			return parse('[[Foo?/Bar]] [[File:Foo.jpg]]', 'A/B?/C').then(function(doc) {
				var els;
				els = doc.querySelectorAll('HEAD > BASE[href]');
				els.length.should.equal(1);
				var basehref = els[0].getAttribute('href');
				// ensure base is a prototocol-relative url
				basehref = basehref.replace(/^https?:/, '');

				// check wikilink
				els = doc.querySelectorAll('A[rel="mw:WikiLink"][href]');
				els.length.should.equal(1);
				var ahref1 = els[0].getAttribute('href');
				url.resolve(basehref, ahref1).should.equal(
					'//en.wikipedia.org/wiki/Foo%3F/Bar'
				);

				// check image link
				els = doc.querySelectorAll('*[typeof="mw:Image"] > A[href]');
				els.length.should.equal(1);
				var ahref2 = els[0].getAttribute('href');
				url.resolve(basehref, ahref2).should.equal(
					'//en.wikipedia.org/wiki/File:Foo.jpg'
				);

				// check image resource
				els = doc.querySelectorAll('*[typeof="mw:Image"] IMG[resource]');
				els.length.should.equal(1);
				var ahref3 = els[0].getAttribute('resource');
				url.resolve(basehref, ahref3).should.equal(
					'//en.wikipedia.org/wiki/File:Foo.jpg'
				);
			});
		});
	});
});
