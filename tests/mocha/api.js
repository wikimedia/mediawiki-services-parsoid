/** Cases for testing the Parsoid API through HTTP */
'use strict';
/*global describe, it, before*/

var apiServer = require('../apiServer.js');
var request = require('supertest');
var domino = require('domino');
var url = require('url');
var path = require('path');
var should = require('chai').should();

describe('Parsoid API', function() {
	var api;
	var mockPrefix = 'mock.prefix';
	var mockDomain = 'mock.domain';
	before(function() {
		var p = apiServer.startMockAPIServer({}).then(function(ret) {
			return apiServer.startParsoidServer({
				mockUrl: ret.url,
				serverArgv: [
					'--num-workers', '1',
					'--config', path.resolve(__dirname, './apitest.localsettings.js'),
				],
			});
		}).then(function(ret) {
			api = ret.url;
		});
		apiServer.exitOnProcessTerm();
		return p;
	});

	it("converts simple wikitext to HTML", function(done) {
		request(api)
		.post(mockPrefix + '/Main_Page')
		.send({ wt: 'foo' })
		.expect(200)
		.expect(function(res) {
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

	it("converts simple HTML to wikitext", function(done) {
		request(api)
		.post(mockPrefix + '/Main_Page')
		.send({ html: "<i>foo</i>" })
		.expect(200)
		.expect("''foo''", done);
	});

	it("respects body parameter", function(done) {
		request(api)
		.post(mockPrefix + '/Main_Page')
		.send({ wt: "''foo''", body: 1 })
		.expect(200)
		.expect(/^<body/, done);
	});

	it("implements subst", function(done) {
		request(api)
		.post(mockPrefix + '/Main_Page')
		.send({ wt: "{{echo|foo}}", subst: 'true' })
		.expect(200)
		.expect(function(res) {
			var body = domino.createDocument(res.text).body;
			// <body> should have one child, <p>
			body.childElementCount.should.equal(1);
			body.firstElementChild.nodeName.should.equal('P');
			var p = body.firstElementChild;
			p.innerHTML.should.equal('foo');
			// The <p> shouldn't be a template expansion, just a plain ol' one
			should.not.exist(p.getAttribute('typeof'));
			// and it shouldn't have any data-parsoid in it
			should.not.exist(p.getAttribute('data-parsoid'));
		})
		.end(done);
	});

	var testRoutes = function(version) {

		describe('formats', function() {

			it('should accept application/x-www-form-urlencoded', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.type('form')
				.send({
					wikitext: '== h2 ==',
				})
				.expect(200)
				.expect(function(res) {
					var doc = domino.createDocument(res.text);
					doc.body.firstChild.nodeName.should.equal('H2');
				})
				.end(done);
			});

			it('should accept application/json', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.type('json')
				.send({
					wikitext: '== h2 ==',
				})
				.expect(200)
				.expect(function(res) {
					var doc = domino.createDocument(res.text);
					doc.body.firstChild.nodeName.should.equal('H2');
				})
				.end(done);
			});

			it('should accept multipart/form-data', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.field('wikitext', '== h2 ==')
				.expect(200)
				.expect(function(res) {
					var doc = domino.createDocument(res.text);
					doc.body.firstChild.nodeName.should.equal('H2');
				})
				.end(done);
			});

		});  // formats

		describe("wt2html", function() {
			var validHtmlResponse = function(expectFunc) {
				return function(res) {
					res.statusCode.should.equal(200);
					res.headers.should.have.property('content-type');
					res.headers['content-type'].should.equal(
						'text/html;profile="mediawiki.org/specs/html/1.1.0";charset=utf-8'
					);
					var doc = domino.createDocument(res.text);
					if (expectFunc) {
						return expectFunc(doc);
					} else {
						res.text.should.not.equal('');
					}
				};
			};
			var validPageBundleResponse = function(expectFunc) {
				return function(res) {
					res.statusCode.should.equal(200);
					res.body.should.have.property('html');
					res.body.html.should.have.property('headers');
					res.body.html.headers.should.have.property('content-type');
					res.body.html.headers['content-type'].should.equal(
						'text/html;profile="mediawiki.org/specs/html/1.1.0";charset=utf-8'
					);
					res.body.html.should.have.property('body');
					res.body.should.have.property('data-parsoid');
					res.body['data-parsoid'].should.have.property('headers');
					res.body['data-parsoid'].headers.should.have.property('content-type');
					res.body['data-parsoid'].headers['content-type'].should.equal(
						'application/json;profile="mediawiki.org/specs/data-parsoid/0.0.1"'
					);
					res.body['data-parsoid'].should.have.property('body');
					var doc = domino.createDocument(res.body.html.body);
					if (expectFunc) {
						return expectFunc(doc, res.body['data-parsoid'].body);
					}
				};
			};

			it("should redirect title to latest revision", function(done) {
				request(api)
				.get(version === 3 ?
					mockDomain + '/v3/page/html/Main_Page' :
					'v2/' + mockDomain + '/html/Main_Page')
				.expect(302)
				.expect(function(res) {
					res.headers.should.have.property('location');
					if (version === 3) {
						res.headers.location.should.equal('/' + mockDomain + '/v3/page/html/Main_Page/1');
					} else {
						res.headers.location.should.equal('/v2/' + mockDomain + '/html/Main_Page/1');
					}
				})
				.end(done);
			});

			it("should preserve querystring params while redirecting", function(done) {
				request(api)
				.get(version === 3 ?
					mockDomain + '/v3/page/html/Main_Page?test=123' :
					'v2/' + mockDomain + '/html/Main_Page?test=123')
				.expect(302)
				.expect(function(res) {
					res.headers.should.have.property('location');
					if (version === 3) {
						res.headers.location.should.equal('/' + mockDomain + '/v3/page/html/Main_Page/1?test=123');
					} else {
						res.headers.location.should.equal('/v2/' + mockDomain + '/html/Main_Page/1?test=123');
					}
				})
				.end(done);
			});

			it("should get html from a title and revision", function(done) {
				request(api)
				.get(version === 3 ?
					mockDomain + '/v3/page/html/Main_Page/1' :
					'v2/' + mockDomain + '/html/Main_Page/1')
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.textContent.should.equal("MediaWiki has been successfully installed.");
				}))
				.end(done);
			});

			it('should return a pagebundle', function(done) {
				request(api)
				.get(version === 3 ?
					mockDomain + '/v3/page/pagebundle/Main_Page/1' :
					'v2/' + mockDomain + '/pagebundle/Main_Page/1')
				.expect(validPageBundleResponse())
				.end(done);
			});

			it('should accept the previous revision to reuse expansions', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/Main_Page/1' :
					'v2/' + mockDomain + '/html/Main_Page/1')
				.send({
					previous: {
						revid: 0,
						html: {
							headers: {
								'content-type': 'text/html;profile="mediawiki.org/specs/html/1.0.0"',
							},
							body: "<!DOCTYPE html>\n<html prefix=\"dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/\" about=\"http://localhost/index.php/Special:Redirect/revision/1\"><head prefix=\"mwr: http://localhost/index.php/Special:Redirect/\"><meta property=\"mw:articleNamespace\" content=\"0\"/><link rel=\"dc:replaces\" resource=\"mwr:revision/0\"/><meta property=\"dc:modified\" content=\"2014-09-12T22:46:59.000Z\"/><meta about=\"mwr:user/0\" property=\"dc:title\" content=\"MediaWiki default\"/><link rel=\"dc:contributor\" resource=\"mwr:user/0\"/><meta property=\"mw:revisionSHA1\" content=\"8e0aa2f2a7829587801db67d0424d9b447e09867\"/><meta property=\"dc:description\" content=\"\"/><meta property=\"mw:parsoidVersion\" content=\"0\"/><link rel=\"dc:isVersionOf\" href=\"http://localhost/index.php/Main_Page\"/><title>Main_Page</title><base href=\"http://localhost/index.php/\"/><link rel=\"stylesheet\" href=\"//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector\"/></head><body id=\"mwAA\" lang=\"en\" class=\"mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki\" dir=\"ltr\"><p id=\"mwAQ\"><strong id=\"mwAg\">MediaWiki has been successfully installed.</strong></p>\n\n<p id=\"mwAw\">Consult the <a rel=\"mw:ExtLink\" href=\"//meta.wikimedia.org/wiki/Help:Contents\" id=\"mwBA\">User's Guide</a> for information on using the wiki software.</p>\n\n<h2 id=\"mwBQ\"> Getting started </h2>\n<ul id=\"mwBg\"><li id=\"mwBw\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings\" id=\"mwCA\">Configuration settings list</a></li>\n<li id=\"mwCQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ\" id=\"mwCg\">MediaWiki FAQ</a></li>\n<li id=\"mwCw\"> <a rel=\"mw:ExtLink\" href=\"https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce\" id=\"mwDA\">MediaWiki release mailing list</a></li>\n<li id=\"mwDQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources\" id=\"mwDg\">Localise MediaWiki for your language</a></li></ul></body></html>",
						},
						"data-parsoid": {
							headers: {
								'content-type': 'application/json;profile="mediawiki.org/specs/data-parsoid/0.0.1"',
							},
							body: {
								"counter": 14,
								"ids": {
									"mwAA": {"dsr": [0, 592, 0, 0]}, "mwAQ": {"dsr": [0, 59, 0, 0]}, "mwAg": {"stx": "html", "dsr": [0, 59, 8, 9]}, "mwAw": {"dsr": [61, 171, 0, 0]}, "mwBA": {"targetOff": 114, "contentOffsets": [114, 126], "dsr": [73, 127, 41, 1]}, "mwBQ": {"dsr": [173, 194, 2, 2]}, "mwBg": {"dsr": [195, 592, 0, 0]}, "mwBw": {"dsr": [195, 300, 1, 0]}, "mwCA": {"targetOff": 272, "contentOffsets": [272, 299], "dsr": [197, 300, 75, 1]}, "mwCQ": {"dsr": [301, 373, 1, 0]}, "mwCg": {"targetOff": 359, "contentOffsets": [359, 372], "dsr": [303, 373, 56, 1]}, "mwCw": {"dsr": [374, 472, 1, 0]}, "mwDA": {"targetOff": 441, "contentOffsets": [441, 471], "dsr": [376, 472, 65, 1]}, "mwDQ": {"dsr": [473, 592, 1, 0]}, "mwDg": {"targetOff": 555, "contentOffsets": [555, 591], "dsr": [475, 592, 80, 1] },
								},
							},
						},
					},
				})
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.textContent.should.equal("MediaWiki has been successfully installed.");
				}))
				.end(done);
			});

			it('should accept the original and reuse certain expansions', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/Main_Page/1' :
					'v2/' + mockDomain + '/html/Main_Page/1')
				.send({
					update: {
						templates: true,
					},
					original: {
						revid: 1,
						html: {
							headers: {
								'content-type': 'text/html;profile="mediawiki.org/specs/html/1.0.0"',
							},
							body: "<!DOCTYPE html>\n<html prefix=\"dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/\" about=\"http://localhost/index.php/Special:Redirect/revision/1\"><head prefix=\"mwr: http://localhost/index.php/Special:Redirect/\"><meta property=\"mw:articleNamespace\" content=\"0\"/><link rel=\"dc:replaces\" resource=\"mwr:revision/0\"/><meta property=\"dc:modified\" content=\"2014-09-12T22:46:59.000Z\"/><meta about=\"mwr:user/0\" property=\"dc:title\" content=\"MediaWiki default\"/><link rel=\"dc:contributor\" resource=\"mwr:user/0\"/><meta property=\"mw:revisionSHA1\" content=\"8e0aa2f2a7829587801db67d0424d9b447e09867\"/><meta property=\"dc:description\" content=\"\"/><meta property=\"mw:parsoidVersion\" content=\"0\"/><link rel=\"dc:isVersionOf\" href=\"http://localhost/index.php/Main_Page\"/><title>Main_Page</title><base href=\"http://localhost/index.php/\"/><link rel=\"stylesheet\" href=\"//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector\"/></head><body id=\"mwAA\" lang=\"en\" class=\"mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki\" dir=\"ltr\"><p id=\"mwAQ\"><strong id=\"mwAg\">MediaWiki has been successfully installed.</strong></p>\n\n<p id=\"mwAw\">Consult the <a rel=\"mw:ExtLink\" href=\"//meta.wikimedia.org/wiki/Help:Contents\" id=\"mwBA\">User's Guide</a> for information on using the wiki software.</p>\n\n<h2 id=\"mwBQ\"> Getting started </h2>\n<ul id=\"mwBg\"><li id=\"mwBw\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings\" id=\"mwCA\">Configuration settings list</a></li>\n<li id=\"mwCQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ\" id=\"mwCg\">MediaWiki FAQ</a></li>\n<li id=\"mwCw\"> <a rel=\"mw:ExtLink\" href=\"https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce\" id=\"mwDA\">MediaWiki release mailing list</a></li>\n<li id=\"mwDQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources\" id=\"mwDg\">Localise MediaWiki for your language</a></li></ul></body></html>",
						},
						"data-parsoid": {
							headers: {
								'content-type': 'application/json;profile="mediawiki.org/specs/data-parsoid/0.0.1"',
							},
							body: {
								"counter": 14,
								"ids": {
									"mwAA": {"dsr": [0, 592, 0, 0]}, "mwAQ": {"dsr": [0, 59, 0, 0]}, "mwAg": {"stx": "html", "dsr": [0, 59, 8, 9]}, "mwAw": {"dsr": [61, 171, 0, 0]}, "mwBA": {"targetOff": 114, "contentOffsets": [114, 126], "dsr": [73, 127, 41, 1]}, "mwBQ": {"dsr": [173, 194, 2, 2]}, "mwBg": {"dsr": [195, 592, 0, 0]}, "mwBw": {"dsr": [195, 300, 1, 0]}, "mwCA": {"targetOff": 272, "contentOffsets": [272, 299], "dsr": [197, 300, 75, 1]}, "mwCQ": {"dsr": [301, 373, 1, 0]}, "mwCg": {"targetOff": 359, "contentOffsets": [359, 372], "dsr": [303, 373, 56, 1]}, "mwCw": {"dsr": [374, 472, 1, 0]}, "mwDA": {"targetOff": 441, "contentOffsets": [441, 471], "dsr": [376, 472, 65, 1]}, "mwDQ": {"dsr": [473, 592, 1, 0]}, "mwDg": {"targetOff": 555, "contentOffsets": [555, 591], "dsr": [475, 592, 80, 1] },
								},
							},
						},
					},
				})
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.textContent.should.equal("MediaWiki has been successfully installed.");
				}))
				.end(done);
			});

			it('should accept wikitext as a string for html', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send({
					wikitext: "== h2 ==",
				})
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.nodeName.should.equal('H2');
				}))
				.end(done);
			});

			it('should accept wikitext as a string for pagebundle', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/pagebundle/' :
					'v2/' + mockDomain + '/pagebundle/')
				.send({
					wikitext: "== h2 ==",
				})
				.expect(validPageBundleResponse(function(doc) {
					doc.body.firstChild.nodeName.should.equal('H2');
				}))
				.end(done);
			});

			it('should accept wikitext with headers', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send({
					wikitext: {
						headers: {
							'content-type': 'text/plain;profile="mediawiki.org/specs/wikitext/1.0.0"',
						},
						body: "== h2 ==",
					},
				})
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.nodeName.should.equal('H2');
				}))
				.end(done);
			});

			it('should require a title when no wikitext is provided', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send()
				.expect(400)
				.end(done);
			});

			it('should not require a title when wikitext is provided', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send({
					wikitext: "== h2 ==",
				})
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.nodeName.should.equal('H2');
				}))
				.end(done);
			});

			it('should accept the wikitext source as original data', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/Main_Page/1' :
					'v2/' + mockDomain + '/html/Main_Page/1')
				.send({
					original: {
						wikitext: {
							headers: {
								'content-type': 'text/plain;profile="mediawiki.org/specs/wikitext/1.0.0"',
							},
							body: "== h2 ==",
						},
					},
				})
				.expect(validHtmlResponse(function(doc) {
					doc.body.firstChild.nodeName.should.equal('H2');
				}))
				.end(done);
			});

			it("should respect body parameter", function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send(version === 3 ? {
					wikitext: "''foo''",
					bodyOnly: 1,
				} : {
					wikitext: "''foo''",
					body: 1,
				})
				.expect(validHtmlResponse())
				.expect(function(res) {
					if (version === 3) {
						// v3 only returns children of <body>
						res.text.should.not.match(/<body/);
						res.text.should.match(/<p/);
					} else {
						// v2 returns body and children
						res.text.should.match(/^<body/);
					}
				})
				.end(done);
			});

			it('should include captured offsets', function(done) {
				request(api)
				.get(version === 3 ?
					mockDomain + '/v3/page/pagebundle/Main_Page/1' :
					'v2/' + mockDomain + '/pagebundle/Main_Page/1')
				.expect(validPageBundleResponse(function(doc, dp) {
					dp.should.have.property('sectionOffsets');
				}))
				.end(done);
			});

			it("should implement subst - simple", function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send({wikitext: "{{echo|foo}}", subst: 'true'})
				.expect(validHtmlResponse(function(doc) {
					var body = doc.body;
					// <body> should have one child, <p>
					body.childElementCount.should.equal(1);
					body.firstElementChild.nodeName.should.equal('P');
					var p = body.firstElementChild;
					p.innerHTML.should.equal('foo');
					// The <p> shouldn't be a template expansion, just a plain ol' one
					should.not.exist(p.getAttribute('typeof'));
					// and it shouldn't have any data-parsoid in it
					should.not.exist(p.getAttribute('data-parsoid'));
				}))
				.end(done);
			});

			it("should implement subst - internal tranclusion", function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/html/' :
					'v2/' + mockDomain + '/html/')
				.send({wikitext: "{{echo|foo {{echo|bar}} baz}}", subst: 'true'})
				.expect(validHtmlResponse(function(doc) {
					var body = doc.body;
					// <body> should have one child, <p>
					body.childElementCount.should.equal(1);
					body.firstElementChild.nodeName.should.equal('P');
					var p = body.firstElementChild;
					// The <p> shouldn't be a template expansion, just a plain ol' one
					should.not.exist(p.getAttribute('typeof'));
					// and it shouldn't have any data-parsoid in it
					should.not.exist(p.getAttribute('data-parsoid'));
					// The internal tranclusion should be presented as such
					var tplp = p.childNodes[1];
					tplp.nodeName.should.equal('SPAN');
					tplp.getAttribute('typeof').should.equal('mw:Transclusion');
					// And not have data-parsoid, so it's used as new content
					should.not.exist(tplp.getAttribute('data-parsoid'));
				}))
				.end(done);
			});

			it('should not allow subst with pagebundle', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/wikitext/to/pagebundle/' :
					'v2/' + mockDomain + '/pagebundle/')
				.send({wikitext: "{{echo|foo}}", subst: 'true'})
				.expect(501)
				.end(done);
			});

		}); // end wt2html

		describe("html2wt", function() {

			var validWikitextResponse = function(expected) {
				return function(res) {
					res.statusCode.should.equal(200);
					res.headers.should.have.property('content-type');
					if (version === 3) {
						res.headers['content-type'].should.equal(
							// note that express does some reordering
							'text/plain; charset=utf-8; profile="mediawiki.org/specs/wikitext/1.0.0"'
						);
						if (expected !== undefined) {
							res.text.should.equal(expected);
						} else {
							res.text.should.not.equal('');
						}
					} else {
						res.headers['content-type'].should.equal('application/json; charset=utf-8');
						res.body.should.have.property('wikitext');
						res.body.wikitext.should.have.property('body');
						if (expected !== undefined) {
							res.body.wikitext.body.should.equal(expected);
						}
					}
				};
			};

			it('should require html when serializing', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send()
				.expect(400)
				.end(done);
			});

			it('should accept html as a string', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should accept html with headers', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: {
						headers: {
							'content-type': 'text/html;profile="mediawiki.org/specs/html/1.0.0"',
						},
						body: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
					},
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should allow a title in the url', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/Main_Page' :
					'v2/' + mockDomain + '/wt/Main_Page')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should allow a title in the original data', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
					original: {
						title: "Main_Page",
					},
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should allow a revision id in the url', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/Main_Page/1' :
					'v2/' + mockDomain + '/wt/Main_Page/1')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should allow a revision id in the original data', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
					original: {
						revid: 1,
					},
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should accept original wikitext as src', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
					original: {
						wikitext: {
							headers: {
								'content-type': 'text/plain;profile="mediawiki.org/specs/wikitext/1.0.0"',
							},
							body: '<strong>MediaWiki has been successfully installed.</strong>\n\nConsult the [//meta.wikimedia.org/wiki/Help:Contents User\'s Guide] for information on using the wiki software.\n\n== Getting started ==\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings Configuration settings list]\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ MediaWiki FAQ]\n* [https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce MediaWiki release mailing list]\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources Localise MediaWiki for your language]\n',
						},
					},
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should accept original html for selser', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
					original: {
						html: {
							headers: {
								'content-type': 'text/html;profile="mediawiki.org/specs/html/1.0.0"',
							},
							body: "<!DOCTYPE html>\n<html prefix=\"dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/\" about=\"http://localhost/index.php/Special:Redirect/revision/1\"><head prefix=\"mwr: http://localhost/index.php/Special:Redirect/\"><meta property=\"mw:articleNamespace\" content=\"0\"/><link rel=\"dc:replaces\" resource=\"mwr:revision/0\"/><meta property=\"dc:modified\" content=\"2014-09-12T22:46:59.000Z\"/><meta about=\"mwr:user/0\" property=\"dc:title\" content=\"MediaWiki default\"/><link rel=\"dc:contributor\" resource=\"mwr:user/0\"/><meta property=\"mw:revisionSHA1\" content=\"8e0aa2f2a7829587801db67d0424d9b447e09867\"/><meta property=\"dc:description\" content=\"\"/><meta property=\"mw:parsoidVersion\" content=\"0\"/><link rel=\"dc:isVersionOf\" href=\"http://localhost/index.php/Main_Page\"/><title>Main_Page</title><base href=\"http://localhost/index.php/\"/><link rel=\"stylesheet\" href=\"//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector\"/></head><body id=\"mwAA\" lang=\"en\" class=\"mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki\" dir=\"ltr\"><p id=\"mwAQ\"><strong id=\"mwAg\">MediaWiki has been successfully installed.</strong></p>\n\n<p id=\"mwAw\">Consult the <a rel=\"mw:ExtLink\" href=\"//meta.wikimedia.org/wiki/Help:Contents\" id=\"mwBA\">User's Guide</a> for information on using the wiki software.</p>\n\n<h2 id=\"mwBQ\"> Getting started </h2>\n<ul id=\"mwBg\"><li id=\"mwBw\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings\" id=\"mwCA\">Configuration settings list</a></li>\n<li id=\"mwCQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ\" id=\"mwCg\">MediaWiki FAQ</a></li>\n<li id=\"mwCw\"> <a rel=\"mw:ExtLink\" href=\"https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce\" id=\"mwDA\">MediaWiki release mailing list</a></li>\n<li id=\"mwDQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources\" id=\"mwDg\">Localise MediaWiki for your language</a></li></ul></body></html>",
						},
						"data-parsoid": {
							headers: {
								'content-type': 'application/json;profile="mediawiki.org/specs/data-parsoid/0.0.1"',
							},
							body: {
								"counter": 14,
								"ids": {
									"mwAA": {"dsr": [0, 592, 0, 0]}, "mwAQ": {"dsr": [0, 59, 0, 0]}, "mwAg": {"stx": "html", "dsr": [0, 59, 8, 9]}, "mwAw": {"dsr": [61, 171, 0, 0]}, "mwBA": {"targetOff": 114, "contentOffsets": [114, 126], "dsr": [73, 127, 41, 1]}, "mwBQ": {"dsr": [173, 194, 2, 2]}, "mwBg": {"dsr": [195, 592, 0, 0]}, "mwBw": {"dsr": [195, 300, 1, 0]}, "mwCA": {"targetOff": 272, "contentOffsets": [272, 299], "dsr": [197, 300, 75, 1]}, "mwCQ": {"dsr": [301, 373, 1, 0]}, "mwCg": {"targetOff": 359, "contentOffsets": [359, 372], "dsr": [303, 373, 56, 1]}, "mwCw": {"dsr": [374, 472, 1, 0]}, "mwDA": {"targetOff": 441, "contentOffsets": [441, 471], "dsr": [376, 472, 65, 1]}, "mwDQ": {"dsr": [473, 592, 1, 0]}, "mwDg": {"targetOff": 555, "contentOffsets": [555, 591], "dsr": [475, 592, 80, 1] },
								},
							},
						},
					},
				})
				.expect(validWikitextResponse())
				.end(done);
			});

			it('should return http 400 if supplied data-parsoid is empty', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<html><head></head><body><p>hi</p></body></html>',
					original: {
						html: {
							headers: {
								'content-type': 'text/html;profile="mediawiki.org/specs/html/1.0.0"',
							},
							body: '<html><head></head><body><p>ho</p></body></html>',
						},
						'data-parsoid': {
							headers: {
								'content-type': 'application/json;profile="mediawiki.org/specs/data-parsoid/0.0.1"',
							},
							body: {},
						},
					},
				})
				.expect(400)
				.end(done);
			});

			it('should return http 400 if supplied data-parsoid is a string', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<html><head></head><body><p>hi</p></body></html>',
					original: {
						html: {
							headers: {
								'content-type': 'text/html;profile="mediawiki.org/specs/html/1.0.0"',
							},
							body: '<html><head></head><body><p>ho</p></body></html>',
						},
						'data-parsoid': {
							headers: {
								'content-type': 'application/json;profile="mediawiki.org/specs/data-parsoid/0.0.1"',
							},
							body: 'Garbled text from RESTBase.',
						},
					},
				})
				.expect(400)
				.end(done);
			});

			// The following three tests should all serialize as:
			//   "<div>Selser test"
			// However, we're deliberately setting the original wikitext in
			// the first two to garbage so that when selser doesn't detect any
			// difference between the new and old html, it'll just reuse that
			// string and we have a reliable way of determining that selser
			// was used.

			it('should use selser with supplied wikitext', function(done) {
				// New and old html are identical, which should produce no diffs
				// and reuse the original wikitext.
				request(api)
				// Need to provide an oldid so that selser mode is enabled
				// Without an oldid, serialization falls back to non-selser wts.
				// The oldid is used to fetch wikitext, but if wikitext is provided
				// (as in this test), it is not used. So, for testing purposes,
				// we can use any old random id, as long as something is present.
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/Junk_Page/1234' :
					'v2/' + mockDomain + '/wt/Junk_Page/1234')
				.send({
					html: "<html><body id=\"mwAA\"><div id=\"mwBB\">Selser test</div></body></html>",
					original: {
						title: "Junk Page",
						wikitext: {
							body: "1. This is just some junk. See the comment above.",
						},
						html: {
							body: "<html><body id=\"mwAA\"><div id=\"mwBB\">Selser test</div></body></html>",
						},
						"data-parsoid": {
							body: {
								"ids": {
									mwAA: {},
									mwBB: { "autoInsertedEnd": true, "stx": "html" },
								},
							},
						},
					},
				})
				.expect(validWikitextResponse(
					"1. This is just some junk. See the comment above."
				))
				.end(done);
			});

			it('should use selser with wikitext fetched from the mw api', function(done) {
				// New and old html are identical, which should produce no diffs
				// and reuse the original wikitext.
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: "<html><body id=\"mwAA\"><div id=\"mwBB\">Selser test</div></body></html>",
					original: {
						revid: 2,
						title: "Junk Page",
						html: {
							body: "<html><body id=\"mwAA\"><div id=\"mwBB\">Selser test</div></body></html>",
						},
						"data-parsoid": {
							body: {
								"ids": {
									mwAA: {},
									mwBB: { "autoInsertedEnd": true, "stx": "html" },
								},
							},
						},
					},
				})
				.expect(validWikitextResponse(
					"2. This is just some junk. See the comment above."
				))
				.end(done);
			});

			it('should fallback to non-selective serialization', function(done) {
				// Without the original wikitext and an unavailable
				// TemplateFetch for the source (no revision id provided),
				// it should fallback to non-selective serialization.
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: "<html><body id=\"mwAA\"><div id=\"mwBB\">Selser test</div></body></html>",
					original: {
						title: "Junk Page",
						html: {
							body: "<html><body id=\"mwAA\"><div id=\"mwBB\">Selser test</div></body></html>",
						},
						"data-parsoid": {
							body: {
								"ids": {
									mwAA: {},
									mwBB: { "autoInsertedEnd": true, "stx": "html" },
								},
							},
						},
					},
				})
				.expect(validWikitextResponse(
					"<div>Selser test"
				))
				.end(done);
			});

			it('should apply data-parsoid to duplicated ids', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: "<html><body id=\"mwAA\"><div id=\"mwBB\">data-parsoid test</div><div id=\"mwBB\">data-parsoid test</div></body></html>",
					original: {
						title: "Doesnotexist",
						html: {
							body: "<html><body id=\"mwAA\"><div id=\"mwBB\">data-parsoid test</div></body></html>",
						},
						"data-parsoid": {
							body: {
								"ids": {
									mwAA: {},
									mwBB: { "autoInsertedEnd": true, "stx": "html" },
								},
							},
						},
					},
				})
				.expect(validWikitextResponse(
					"<div>data-parsoid test<div>data-parsoid test"
				))
				.end(done);
			});

			it('should apply extra normalizations', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<h2></h2>',
					scrubWikitext: true,
					original: { title: 'Doesnotexist' },
				})
				.expect(validWikitextResponse(
					''
				))
				.end(done);
			});

			it('should suppress extra normalizations', function(done) {
				request(api)
				.post(version === 3 ?
					mockDomain + '/v3/transform/html/to/wikitext/' :
					'v2/' + mockDomain + '/wt/')
				.send({
					html: '<h2></h2>',
					original: { title: 'Doesnotexist' },
				})
				.expect(validWikitextResponse(
					'==<nowiki/>==\n'
				))
				.end(done);
			});

		}); // end html2wt

	};

	describe("v2 Routes", function() { testRoutes(2); });
	describe("v3 Routes", function() { testRoutes(3); });

});
