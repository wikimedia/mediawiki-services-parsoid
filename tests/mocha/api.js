/** Cases for testing the Parsoid API through HTTP */
'use strict';
/*global describe, it, before*/

var Util = require('../../lib/utils/Util.js').Util;
var apiServer = require('../apiServer.js');
var request = require('supertest');
var domino = require('domino');
var path = require('path');
var should = require('chai').should();

var configPath = path.resolve(__dirname, './apitest.localsettings.js');
var fakeConfig = {
	setMwApi: function() {},
	limits: { wt2html: {}, html2wt: {} },
	timeouts: { mwApi: {} },
};
require(configPath).setup(fakeConfig);  // Set limits.

describe('Parsoid API', function() {
	var api;
	var mockDomain = 'mock.domain';

	before(function() {
		var p = apiServer.startMockAPIServer({}).then(function(ret) {
			return apiServer.startParsoidServer({
				mockUrl: ret.url,
				serverArgv: [
					'--num-workers', '1',
					'--config', configPath,
				],
			});
		}).then(function(ret) {
			api = ret.url;
		});
		apiServer.exitOnProcessTerm();
		return p;
	});

	describe('formats', function() {

		it('should accept application/x-www-form-urlencoded', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
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
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
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
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.field('wikitext', '== h2 ==')
			.expect(200)
			.expect(function(res) {
				var doc = domino.createDocument(res.text);
				doc.body.firstChild.nodeName.should.equal('H2');
			})
			.end(done);
		});

	});  // formats

	describe('accepts', function() {
		var defaultContentVersion = '1.2.1';

		var acceptableHtmlResponse = function(contentVersion, expectFunc) {
			return function(res) {
				res.statusCode.should.equal(200);
				res.headers.should.have.property('content-type');
				res.headers['content-type'].should.equal(
					'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/' + contentVersion + '"'
				);
				res.text.should.not.equal('');
				if (expectFunc) {
					return expectFunc(res.text);
				}
			};
		};

		var acceptablePageBundleResponse = function(contentVersion, expectFunc) {
			return function(res) {
				res.statusCode.should.equal(200);
				res.headers.should.have.property('content-type');
				res.headers['content-type'].should.equal(
					'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/' + contentVersion + '"'
				);
				res.body.should.have.property('html');
				res.body.html.should.have.property('headers');
				res.body.html.headers.should.have.property('content-type');
				res.body.html.headers['content-type'].should.equal(
					'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/' + contentVersion + '"'
				);
				res.body.html.should.have.property('body');
				res.body.should.have.property('data-parsoid');
				res.body['data-parsoid'].should.have.property('headers');
				res.body['data-parsoid'].headers.should.have.property('content-type');
				// Some backwards compatibility for when the content version
				// wasn't applied uniformly.  See `apiUtils.dataParsoidContentType`
				var dpVersion = (contentVersion === '1.2.1') ? '0.0.2' : contentVersion;
				res.body['data-parsoid'].headers['content-type'].should.equal(
					'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/' + dpVersion + '"'
				);
				res.body['data-parsoid'].should.have.property('body');
				if (contentVersion !== '1.2.1') {
					res.body.should.have.property('data-mw');
					res.body['data-mw'].should.have.property('headers');
					res.body['data-mw'].headers.should.have.property('content-type');
					res.body['data-mw'].headers['content-type'].should.equal(
						'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-mw/' + contentVersion + '"'
					);
					res.body['data-mw'].should.have.property('body');
				}
				if (expectFunc) {
					return expectFunc(res.body.html.body);
				}
			};
		};

		it('should not accept requests for older content versions (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept', 'text/html; profile="https://www.mediawiki.org/wiki/Specs/HTML/0.0.0"')
			.send({ wikitext: '== h2 ==' })
			.expect(406)
			.end(done);
		});

		it('should not accept requests for older content versions (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept', 'application/json; profile="https://www.mediawiki.org/wiki/Specs/HTML/0.0.0"')
			.send({ wikitext: '== h2 ==' })
			.expect(406)
			.end(done);
		});

		it('should not accept requests for other profiles (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept', 'text/html; profile="something different"')
			.send({ wikitext: '== h2 ==' })
			.expect(406)
			.end(done);
		});

		it('should not accept requests for other profiles (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept', 'application/json; profile="something different"')
			.send({ wikitext: '== h2 ==' })
			.expect(406)
			.end(done);
		});

		it('should accept wildcards (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept', '*/*')
			.send({ wikitext: '== h2 ==' })
			.expect(200)
			.expect(acceptableHtmlResponse(defaultContentVersion))
			.end(done);
		});

		it('should accept wildcards (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept', '*/*')
			.send({ wikitext: '== h2 ==' })
			.expect(200)
			.expect(acceptablePageBundleResponse(defaultContentVersion))
			.end(done);
		});

		it('should prefer higher quality (html)', function(done) {
			var contentVersion = '2.0.0';
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept',
				'text/html; profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"; q=0.5,' +
				'text/html; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.0.0"; q=0.8')
			.send({ wikitext: '== h2 ==' })
			.expect(200)
			.expect(acceptableHtmlResponse(contentVersion))
			.end(done);
		});

		it('should prefer higher quality (pagebundle)', function(done) {
			var contentVersion = '2.0.0';
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept',
				'application/json; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/1.2.1"; q=0.5,' +
				'application/json; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/2.0.0"; q=0.8')
			.send({ wikitext: '== h2 ==' })
			.expect(200)
			.expect(acceptablePageBundleResponse(contentVersion))
			.end(done);
		});

		it('should accept requests for the latest content version (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({ wikitext: '== h2 ==' })
			.expect(200)
			.expect(acceptableHtmlResponse(defaultContentVersion))
			.end(done);
		});

		it('should accept requests for the latest content version (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send({ wikitext: '== h2 ==' })
			.expect(200)
			.expect(acceptablePageBundleResponse(defaultContentVersion))
			.end(done);
		});

		it('should accept requests for content version 1.2.0 (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept', 'text/html; profile="mediawiki.org/specs/html/1.2.0"')
			.send({ wikitext: '{{echo|hi}}' })
			.expect(200)
			.expect(acceptableHtmlResponse('1.2.1'))
			.end(done);
		});

		it('should accept requests for content version 1.2.0 (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept', 'text/html; profile="mediawiki.org/specs/html/1.2.0"')
			.send({ wikitext: '{{echo|hi}}' })
			.expect(200)
			.expect(acceptablePageBundleResponse('1.2.1'))
			.end(done);
		});

		it('should accept requests for content version 1.2.1 (html)', function(done) {
			var contentVersion = '1.2.1';
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept', 'text/html; profile="https://www.mediawiki.org/wiki/Specs/HTML/' + contentVersion + '"')
			.send({ wikitext: '{{echo|hi}}' })
			.expect(200)
			.expect(acceptableHtmlResponse(contentVersion))
			.end(done);
		});

		it('should accept requests for content version 1.2.1 (pagebundle)', function(done) {
			var contentVersion = '1.2.1';
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept', 'application/json; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/' + contentVersion + '"')
			.send({ wikitext: '{{echo|hi}}' })
			.expect(200)
			.expect(acceptablePageBundleResponse(contentVersion, function(html) {
				// In 1.2.1, data-mw is still inline.
				html.should.match(/data-mw/);
			}))
			.end(done);
		});

		it('should accept requests for content version 2.0.0 (html)', function(done) {
			var contentVersion = '2.0.0';
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.set('Accept', 'text/html; profile="https://www.mediawiki.org/wiki/Specs/HTML/' + contentVersion + '"')
			.send({ wikitext: '{{echo|hi}}' })
			.expect(200)
			.expect(acceptableHtmlResponse(contentVersion))
			.end(done);
		});

		it('should accept requests for content version 2.0.0 (pagebundle)', function(done) {
			var contentVersion = '2.0.0';
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.set('Accept', 'application/json; profile="https://www.mediawiki.org/wiki/Specs/pagebundle/' + contentVersion + '"')
			.send({ wikitext: '{{echo|hi}}' })
			.expect(200)
			.expect(acceptablePageBundleResponse(contentVersion, function(html) {
				// In 2.0.0, data-mw is in the pagebundle.
				html.should.not.match(/data-mw/);
			}))
			.end(done);
		});

	});  // accepts

	var validWikitextResponse = function(expected) {
		return function(res) {
			res.statusCode.should.equal(200);
			res.headers.should.have.property('content-type');
			res.headers['content-type'].should.equal(
				// note that express does some reordering
				'text/plain; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0"'
			);
			if (expected !== undefined) {
				res.text.should.equal(expected);
			} else {
				res.text.should.not.equal('');
			}
		};
	};

	var validHtmlResponse = function(expectFunc) {
		return function(res) {
			res.statusCode.should.equal(200);
			res.headers.should.have.property('content-type');
			res.headers['content-type'].should.equal(
				'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"'
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
				'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"'
			);
			res.body.html.should.have.property('body');
			res.body.should.have.property('data-parsoid');
			res.body['data-parsoid'].should.have.property('headers');
			res.body['data-parsoid'].headers.should.have.property('content-type');
			res.body['data-parsoid'].headers['content-type'].should.equal(
				'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/0.0.2"'
			);
			res.body['data-parsoid'].should.have.property('body');
			var doc = domino.createDocument(res.body.html.body);
			if (expectFunc) {
				return expectFunc(doc, res.body['data-parsoid'].body);
			}
		};
	};

	describe("wt2html", function() {

		it('should redirect title to latest revision (html)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/html/Main_Page')
			.expect(302)
			.expect(function(res) {
				res.headers.should.have.property('location');
				res.headers.location.should.equal('/' + mockDomain + '/v3/page/html/Main_Page/1');
			})
			.end(done);
		});

		it('should redirect title to latest revision (pagebundle)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/pagebundle/Main_Page')
			.expect(302)
			.expect(function(res) {
				res.headers.should.have.property('location');
				res.headers.location.should.equal('/' + mockDomain + '/v3/page/pagebundle/Main_Page/1');
			})
			.end(done);
		});

		it('should redirect title to latest revision (wikitext)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/wikitext/Main_Page')
			.expect(302)
			.expect(function(res) {
				res.headers.should.have.property('location');
				res.headers.location.should.equal('/' + mockDomain + '/v3/page/wikitext/Main_Page/1');
			})
			.end(done);
		});

		it("should preserve querystring params while redirecting", function(done) {
			request(api)
			.get(mockDomain + '/v3/page/html/Main_Page?test=123')
			.expect(302)
			.expect(function(res) {
				res.headers.should.have.property('location');
				res.headers.location.should.equal('/' + mockDomain + '/v3/page/html/Main_Page/1?test=123');
			})
			.end(done);
		});

		it('should get from a title and revision (html)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/html/Main_Page/1')
			.expect(validHtmlResponse(function(doc) {
				doc.body.firstChild.textContent.should.equal('MediaWiki has been successfully installed.');
			}))
			.end(done);
		});

		it('should get from a title and revision (pagebundle)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/pagebundle/Main_Page/1')
			.expect(validPageBundleResponse())
			.end(done);
		});

		it('should get from a title and revision (wikitext)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/wikitext/Main_Page/1')
			.expect(validWikitextResponse())
			.end(done);
		});

		it('should accept wikitext as a string for html', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
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
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
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
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				wikitext: {
					headers: {
						'content-type': 'text/plain;profile="https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0"',
					},
					body: "== h2 ==",
				},
			})
			.expect(validHtmlResponse(function(doc) {
				doc.body.firstChild.nodeName.should.equal('H2');
			}))
			.end(done);
		});

		it('should require a title when no wikitext is provided (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send()
			.expect(400)
			.end(done);
		});

		it('should require a title when no wikitext is provided (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send()
			.expect(400)
			.end(done);
		});

		it('should accept an original title (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				original: {
					title: 'Main_Page',
				},
			})
			.expect(302)  // no revid or wikitext source provided
			.expect(function(res) {
				res.headers.should.have.property('location');
				res.headers.location.should.equal('/' + mockDomain + '/v3/page/html/Main_Page/1');
			})
			.end(done);
		});

		it('should accept an original title (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send({
				original: {
					title: 'Main_Page',
				},
			})
			.expect(302)  // no revid or wikitext source provided
			.expect(function(res) {
				res.headers.should.have.property('location');
				res.headers.location.should.equal('/' + mockDomain + '/v3/page/pagebundle/Main_Page/1');
			})
			.end(done);
		});

		it('should not require a title when empty wikitext is provided (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				wikitext: '',
			})
			.expect(validHtmlResponse(function(doc) {
				doc.body.children.length.should.equal(0);
			}))
			.end(done);
		});

		it('should not require a title when empty wikitext is provided (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send({
				wikitext: '',
			})
			.expect(validPageBundleResponse())
			.end(done);
		});

		it('should not require a title when wikitext is provided', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				wikitext: "== h2 ==",
			})
			.expect(validHtmlResponse(function(doc) {
				doc.body.firstChild.nodeName.should.equal('H2');
			}))
			.end(done);
		});

		it('should not require a rev id when wikitext and a title is provided', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/Main_Page')
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
			.post(mockDomain + '/v3/transform/wikitext/to/html/Main_Page/1')
			.send({
				original: {
					wikitext: {
						headers: {
							'content-type': 'text/plain;profile="https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0"',
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

		it('should accept the wikitext source as original without a title or revision', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				original: {
					wikitext: {
						headers: {
							'content-type': 'text/plain;profile="https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0"',
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

		it("should respect body parameter in wikitext->html (body_only)", function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				wikitext: "''foo''",
				body_only: 1,
			})
			.expect(validHtmlResponse())
			.expect(function(res) {
				// v3 only returns children of <body>
				res.text.should.not.match(/<body/);
				res.text.should.match(/<p/);
			})
			.end(done);
		});

		it("should respect body parameter in wikitext->pagebundle requests (body_only)", function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send({
				wikitext: "''foo''",
				body_only: 1,
			})
			.expect(validPageBundleResponse())
			.expect(function(res) {
				// v3 only returns children of <body>
				res.body.html.body.should.not.match(/<body/);
				res.body.html.body.should.match(/<p/);
			})
			.end(done);
		});

		it("should respect body parameter - b/c test for bodyOnly", function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
			.send({
				wikitext: "''foo''",
				bodyOnly: 1,
			})
			.expect(validHtmlResponse())
			.expect(function(res) {
				// v3 only returns children of <body>
				res.text.should.not.match(/<body/);
				res.text.should.match(/<p/);
			})
			.end(done);
		});

		it('should include captured offsets', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/pagebundle/Main_Page/1')
			.expect(validPageBundleResponse(function(doc, dp) {
				dp.should.have.property('sectionOffsets');
			}))
			.end(done);
		});

		it("should implement subst - simple", function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
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
			.post(mockDomain + '/v3/transform/wikitext/to/html/')
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
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send({wikitext: "{{echo|foo}}", subst: 'true'})
			.expect(501)
			.end(done);
		});

		it('should return a request too large error (post wt)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/wikitext/to/pagebundle/')
			.send({
				original: {
					title: 'Large_Page',
				},
				wikitext: "a".repeat(fakeConfig.limits.wt2html.maxWikitextSize + 1),
			})
			.expect(413)
			.end(done);
		});

		it('should return a request too large error (get page)', function(done) {
			request(api)
			.get(mockDomain + '/v3/page/html/Large_Page/3')
			.expect(413)
			.end(done);
		});

	}); // end wt2html

	describe("html2wt", function() {

		it('should require html when serializing', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send()
			.expect(400)
			.end(done);
		});

		it('should accept html as a string', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
			})
			.expect(validWikitextResponse())
			.end(done);
		});

		it('should accept html with headers', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: {
					headers: {
						'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"',
					},
					body: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
				},
			})
			.expect(validWikitextResponse())
			.end(done);
		});

		it('should allow a title in the url', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/Main_Page')
			.send({
				html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
			})
			.expect(validWikitextResponse())
			.end(done);
		});

		it('should allow a title in the original data', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/Main_Page/1')
			.send({
				html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
			})
			.expect(validWikitextResponse())
			.end(done);
		});

		it('should allow a revision id in the original data', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
				original: {
					wikitext: {
						headers: {
							'content-type': 'text/plain;profile="https://www.mediawiki.org/wiki/Specs/wikitext/1.0.0"',
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<!DOCTYPE html>\n<html prefix="dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/" about="http://localhost/index.php/Special:Redirect/revision/1"><head prefix="mwr: http://localhost/index.php/Special:Redirect/"><meta property="mw:articleNamespace" content="0"/><link rel="dc:replaces" resource="mwr:revision/0"/><meta property="dc:modified" content="2014-09-12T22:46:59.000Z"/><meta about="mwr:user/0" property="dc:title" content="MediaWiki default"/><link rel="dc:contributor" resource="mwr:user/0"/><meta property="mw:revisionSHA1" content="8e0aa2f2a7829587801db67d0424d9b447e09867"/><meta property="dc:description" content=""/><meta property="mw:parsoidVersion" content="0"/><link rel="dc:isVersionOf" href="http://localhost/index.php/Main_Page"/><title>Main_Page</title><base href="http://localhost/index.php/"/><link rel="stylesheet" href="//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector"/></head><body data-parsoid=\'{"dsr":[0,592,0,0]}\' lang="en" class="mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki" dir="ltr"><p data-parsoid=\'{"dsr":[0,59,0,0]}\'><strong data-parsoid=\'{"stx":"html","dsr":[0,59,8,9]}\'>MediaWiki has been successfully installed.</strong></p>\n\n<p data-parsoid=\'{"dsr":[61,171,0,0]}\'>Consult the <a rel="mw:ExtLink" href="//meta.wikimedia.org/wiki/Help:Contents" data-parsoid=\'{"targetOff":114,"contentOffsets":[114,126],"dsr":[73,127,41,1]}\'>User\'s Guide</a> for information on using the wiki software.</p>\n\n<h2 data-parsoid=\'{"dsr":[173,194,2,2]}\'> Getting started </h2>\n<ul data-parsoid=\'{"dsr":[195,592,0,0]}\'><li data-parsoid=\'{"dsr":[195,300,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings" data-parsoid=\'{"targetOff":272,"contentOffsets":[272,299],"dsr":[197,300,75,1]}\'>Configuration settings list</a></li>\n<li data-parsoid=\'{"dsr":[301,373,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ" data-parsoid=\'{"targetOff":359,"contentOffsets":[359,372],"dsr":[303,373,56,1]}\'>MediaWiki FAQ</a></li>\n<li data-parsoid=\'{"dsr":[374,472,1,0]}\'> <a rel="mw:ExtLink" href="https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce" data-parsoid=\'{"targetOff":441,"contentOffsets":[441,471],"dsr":[376,472,65,1]}\'>MediaWiki release mailing list</a></li>\n<li data-parsoid=\'{"dsr":[473,592,1,0]}\'> <a rel="mw:ExtLink" href="//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources" data-parsoid=\'{"targetOff":555,"contentOffsets":[555,591],"dsr":[475,592,80,1]}\'>Localise MediaWiki for your language</a></li></ul></body></html>',
				original: {
					html: {
						headers: {
							'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"',
						},
						body: "<!DOCTYPE html>\n<html prefix=\"dc: http://purl.org/dc/terms/ mw: http://mediawiki.org/rdf/\" about=\"http://localhost/index.php/Special:Redirect/revision/1\"><head prefix=\"mwr: http://localhost/index.php/Special:Redirect/\"><meta property=\"mw:articleNamespace\" content=\"0\"/><link rel=\"dc:replaces\" resource=\"mwr:revision/0\"/><meta property=\"dc:modified\" content=\"2014-09-12T22:46:59.000Z\"/><meta about=\"mwr:user/0\" property=\"dc:title\" content=\"MediaWiki default\"/><link rel=\"dc:contributor\" resource=\"mwr:user/0\"/><meta property=\"mw:revisionSHA1\" content=\"8e0aa2f2a7829587801db67d0424d9b447e09867\"/><meta property=\"dc:description\" content=\"\"/><meta property=\"mw:parsoidVersion\" content=\"0\"/><link rel=\"dc:isVersionOf\" href=\"http://localhost/index.php/Main_Page\"/><title>Main_Page</title><base href=\"http://localhost/index.php/\"/><link rel=\"stylesheet\" href=\"//localhost/load.php?modules=mediawiki.legacy.commonPrint,shared|mediawiki.skinning.elements|mediawiki.skinning.content|mediawiki.skinning.interface|skins.vector.styles|site|mediawiki.skinning.content.parsoid&amp;only=styles&amp;debug=true&amp;skin=vector\"/></head><body id=\"mwAA\" lang=\"en\" class=\"mw-content-ltr sitedir-ltr ltr mw-body mw-body-content mediawiki\" dir=\"ltr\"><p id=\"mwAQ\"><strong id=\"mwAg\">MediaWiki has been successfully installed.</strong></p>\n\n<p id=\"mwAw\">Consult the <a rel=\"mw:ExtLink\" href=\"//meta.wikimedia.org/wiki/Help:Contents\" id=\"mwBA\">User's Guide</a> for information on using the wiki software.</p>\n\n<h2 id=\"mwBQ\"> Getting started </h2>\n<ul id=\"mwBg\"><li id=\"mwBw\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings\" id=\"mwCA\">Configuration settings list</a></li>\n<li id=\"mwCQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ\" id=\"mwCg\">MediaWiki FAQ</a></li>\n<li id=\"mwCw\"> <a rel=\"mw:ExtLink\" href=\"https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce\" id=\"mwDA\">MediaWiki release mailing list</a></li>\n<li id=\"mwDQ\"> <a rel=\"mw:ExtLink\" href=\"//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources\" id=\"mwDg\">Localise MediaWiki for your language</a></li></ul></body></html>",
					},
					"data-parsoid": {
						headers: {
							'content-type': 'application/json;profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/0.0.2"',
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<html><head></head><body><p>hi</p></body></html>',
				original: {
					html: {
						headers: {
							'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"',
						},
						body: '<html><head></head><body><p>ho</p></body></html>',
					},
					'data-parsoid': {
						headers: {
							'content-type': 'application/json;profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/0.0.2"',
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<html><head></head><body><p>hi</p></body></html>',
				original: {
					html: {
						headers: {
							'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"',
						},
						body: '<html><head></head><body><p>ho</p></body></html>',
					},
					'data-parsoid': {
						headers: {
							'content-type': 'application/json;profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/0.0.2"',
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/Junk_Page/1234')
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
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

		it('should return a 400 for missing data-mw', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: {
					headers: {
						'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/2.0.0"',
					},
					body: '<p about="#mwt1" typeof="mw:Transclusion" id="mwAQ">hi</p>',
				},
				original: {
					title: 'Doesnotexist',
					'data-parsoid': {
						body: {
							ids: { "mwAQ": { "pi": [[{ "k": "1" }]] } },
						},
					},
				},
			})
			.expect(400)
			.end(done);
		});

		it('should apply supplied data-mw', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: {
					headers: {
						'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/2.0.0"',
					},
					body: '<p about="#mwt1" typeof="mw:Transclusion" id="mwAQ">hi</p>',
				},
				original: {
					title: 'Doesnotexist',
					'data-parsoid': {
						body: {
							ids: { "mwAQ": { "pi": [[{ "k": "1" }]] } },
						},
					},
					'data-mw': {
						body: {
							ids: { "mwAQ": { "parts": [{ "template": { "target": { "wt": "1x", "href": "./Template:1x" }, "params": { "1": { "wt": "hi" } }, "i": 0 } }] } },
						},
					},
				},
			})
			.expect(validWikitextResponse('{{1x|hi}}'))
			.end(done);
		});

		it('should apply extra normalizations (scrub_wikitext)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<h2></h2>',
				scrub_wikitext: true,
				original: { title: 'Doesnotexist' },
			})
			.expect(validWikitextResponse(
				''
			))
			.end(done);
		});

		it('should apply extra normalizations (scrubWikitext)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
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
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				html: '<h2></h2>',
				original: { title: 'Doesnotexist' },
			})
			.expect(validWikitextResponse(
				'==<nowiki/>==\n'
			))
			.end(done);
		});

		it('should return a request too large error', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/wikitext/')
			.send({
				original: {
					title: 'Large_Page',
				},
				html: "a".repeat(fakeConfig.limits.html2wt.maxHTMLSize + 1),
			})
			.expect(413)
			.end(done);
		});

	}); // end html2wt

	describe('html2html', function() {

		var previousRevHTML = {
			revid: 99,
			html: {
				headers: {
					'content-type': 'text/html;profile="https://www.mediawiki.org/wiki/Specs/HTML/1.2.1"',
				},
				body: '<p about="#mwt1" typeof="mw:Transclusion" data-mw=\'{"parts":[{"template":{"target":{"wt":"colours of the rainbow","href":"./Template:Colours_of_the_rainbow"},"params":{},"i":0}}]}\' id="mwAg">pink</p>',
			},
			"data-parsoid": {
				headers: {
					'content-type': 'application/json;profile="https://www.mediawiki.org/wiki/Specs/data-parsoid/0.0.2"',
				},
				body: {
					'counter': 2,
					'ids': {
						'mwAg': { 'pi': [[]], 'src': '{{colours of the rainbow}}' },  // artificially added src
					},
				},
			},
		};

		it('should accept the previous revision to reuse expansions (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/html/Reuse_Page/100')
			.send({
				previous: previousRevHTML,
			})
			.expect(validHtmlResponse(function(doc) {
				doc.body.firstChild.textContent.should.match(/pink/);
			}))
			.end(done);
		});

		it('should accept the previous revision to reuse expansions (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/pagebundle/Reuse_Page/100')
			.send({
				previous: previousRevHTML,
			})
			.expect(validPageBundleResponse(function(doc) {
				doc.body.firstChild.textContent.should.match(/pink/);
			}))
			.end(done);
		});

		var origHTML = Util.clone(previousRevHTML);
		origHTML.revid = 100;

		it('should accept the original and reuse certain expansions (html)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/html/Reuse_Page/100')
			.send({
				updates: {
					transclusions: true,
				},
				original: origHTML,
			})
			.expect(validHtmlResponse(function(doc) {
				doc.body.firstChild.textContent.should.match(/purple/);
			}))
			.end(done);
		});

		it('should accept the original and reuse certain expansions (pagebundle)', function(done) {
			request(api)
			.post(mockDomain + '/v3/transform/html/to/pagebundle/Reuse_Page/100')
			.send({
				updates: {
					transclusions: true,
				},
				original: origHTML,
			})
			.expect(validPageBundleResponse(function(doc) {
				doc.body.firstChild.textContent.should.match(/purple/);
			}))
			.end(done);
		});

	});  // end html2html

});
