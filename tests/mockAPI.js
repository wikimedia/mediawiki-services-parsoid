// This file is used to run a stub API that mimics the MediaWiki interface
// for the purposes of testing extension expansion.

'use strict';

require('../core-upgrade.js');

var fs = require('fs');
var yaml = require('js-yaml');
var path = require('path');
var express = require('express');
var bodyParser = require('body-parser');
var crypto = require('crypto');

var Promise = require('../lib/utils/promise.js');

// Get Parsoid limits.
var optionsPath = path.resolve(__dirname, './mocha/test.config.yaml');
var optionsYaml = fs.readFileSync(optionsPath, 'utf8');
var parsoidOptions = yaml.load(optionsYaml).services[0].conf;

// configuration to match PHP parserTests
var IMAGE_BASE_URL = 'http://example.com/images';
var IMAGE_DESC_URL = IMAGE_BASE_URL;
// IMAGE_BASE_URL='http://upload.wikimedia.org/wikipedia/commons';
// IMAGE_DESC_URL='http://commons.wikimedia.org/wiki';
var FILE_PROPS = {
	'Foobar.jpg': {
		size: 7881,
		width: 1941,
		height: 220,
		bits: 8,
		mime: 'image/jpeg',
	},
	'Thumb.png': {
		size: 22589,
		width: 135,
		height: 135,
		bits: 8,
		mime: 'image/png',
	},
	'Foobar.svg': {
		size: 12345,
		width: 240,
		height: 180,
		bits: 24,
		mime: 'image/svg+xml',
	},
	'LoremIpsum.djvu': {
		size: 3249,
		width: 2480,
		height: 3508,
		bits: 8,
		mime: 'image/vnd.djvu',
	},
	'Video.ogv': {
		size: 12345,
		width: 320,
		height: 240,
		bits: 0,
		duration: 160.733333333333,
		mime: 'application/ogg',
		mediatype: 'VIDEO',
	},
	'Audio.oga': {
		size: 12345,
		width: 0,
		height: 0,
		bits: 0,
		duration: 160.733333333333,
		mime: 'application/ogg',
		mediatype: 'AUDIO',
	},
};

/* -------------------- web app access points below --------------------- */

var app = express();
app.use(bodyParser.urlencoded({ extended: false }));

var mainPage = {
	query: {
		pages: {
			'1': {
				pageid: 1,
				ns: 0,
				title: 'Main Page',
				revisions: [
					{
						revid: 1,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '<strong>MediaWiki has been successfully installed.</strong>\n\nConsult the [//meta.wikimedia.org/wiki/Help:Contents User\'s Guide] for information on using the wiki software.\n\n== Getting started ==\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Manual:Configuration_settings Configuration settings list]\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Manual:FAQ MediaWiki FAQ]\n* [https://lists.wikimedia.org/mailman/listinfo/mediawiki-announce MediaWiki release mailing list]\n* [//www.mediawiki.org/wiki/Special:MyLanguage/Localisation#Translation_resources Localise MediaWiki for your language]',
					},
				],
			},
		},
	},
};

var junkPage = {
	query: {
		pages: {
			'2': {
				pageid: 2,
				ns: 0,
				title: "Junk Page",
				revisions: [
					{
						revid: 2,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '2. This is just some junk. See the comment above.',
					},
				],
			},
		},
	},
};

var largePage = {
	query: {
		pages: {
			'3': {
				pageid: 3,
				ns: 0,
				title: 'Large_Page',
				revisions: [
					{
						revid: 3,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': 'a'.repeat(parsoidOptions.limits.wt2html.maxWikitextSize + 1),
					},
				],
			},
		},
	},
};

var reusePage = {
	query: {
		pages: {
			'100': {
				pageid: 100,
				ns: 0,
				title: 'Reuse_Page',
				revisions: [
					{
						revid: 100,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '{{colours of the rainbow}}',
					},
				],
			},
		},
	},
};

var jsonPage = {
	query: {
		pages: {
			'101': {
				pageid: 101,
				ns: 0,
				title: 'JSON_Page',
				revisions: [
					{
						revid: 101,
						parentid: 0,
						contentmodel: 'json',
						contentformat: 'text/json',
						'*': '[1]',
					},
				],
			},
		},
	},
};

var lintPage = {
	query: {
		pages: {
			'102': {
				pageid: 102,
				ns: 0,
				title: "Lint Page",
				revisions: [
					{
						revid: 102,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '{|\nhi\n|ho\n|}',
					},
				],
			},
		},
	},
};

var redlinksPage = {
	query: {
		pages: {
			'103': {
				pageid: 103,
				ns: 0,
				title: "Redlinks Page",
				revisions: [
					{
						revid: 103,
						parentid: 0,
						contentmodel: 'wikitext',
						contentformat: 'text/x-wiki',
						'*': '[[Special:Version]] [[Doesnotexist]] [[Redirected]]',
					},
				],
			},
		},
	},
};

var fnames = {
	'Image:Foobar.jpg': 'Foobar.jpg',
	'File:Foobar.jpg': 'Foobar.jpg',
	'Image:Foobar.svg': 'Foobar.svg',
	'File:Foobar.svg': 'Foobar.svg',
	'Image:Thumb.png': 'Thumb.png',
	'File:Thumb.png': 'Thumb.png',
	'File:LoremIpsum.djvu': 'LoremIpsum.djvu',
	'File:Video.ogv': 'Video.ogv',
	'File:Audio.oga': 'Audio.oga',
};

var pnames = {
	'Image:Foobar.jpg': 'File:Foobar.jpg',
	'Image:Foobar.svg': 'File:Foobar.svg',
	'Image:Thumb.png': 'File:Thumb.png',
};

// This templatedata description only provides a subset of fields
// that mediawiki API returns. Parsoid only uses the format and
// paramOrder fields at this point, so keeping these lean.
var templateData = {
	'Template:NoFormatWithParamOrder': {
		'paramOrder': ['unused1', 'f1', 'unused2', 'f2', 'unused3'],
	},
	'Template:InlineTplNoParamOrder': {
		'format': 'inline',
	},
	'Template:BlockTplNoParamOrder': {
		'format': 'block',
	},
	'Template:InlineTplWithParamOrder': {
		'format': 'inline',
		'paramOrder': ['f1','f2'],
	},
	'Template:BlockTplWithParamOrder': {
		'format': 'block',
		'paramOrder': ['f1','f2'],
	},
};

var formatters = {
	json: function(data) {
		return JSON.stringify(data);
	},
	jsonfm: function(data) {
		return JSON.stringify(data, null, 2);
	},
};

var preProcess = function(text) {
	var match = text.match(/{{echo\|(.*?)}}/);
	if (match) {
		return { wikitext: match[1] };
	} else if (text === '{{colours of the rainbow}}') {
		return { wikitext: 'purple' };
	} else {
		return null;
	}
};

var imageInfo = function(filename, twidth, theight, useBatchAPI) {
	var normPagename = pnames[filename] || filename;
	var normFilename = fnames[filename] || filename;
	if (!(normFilename in FILE_PROPS)) {
		return null;
	}
	var props = FILE_PROPS[normFilename] || Object.create(null);
	var md5 = crypto.createHash('md5').update(normFilename).digest('hex');
	var md5prefix = md5[0] + '/' + md5[0] + md5[1] + '/';
	var baseurl = IMAGE_BASE_URL + '/' + md5prefix + normFilename;
	var height = props.hasOwnProperty('height') ? props.height : 220;
	var width = props.hasOwnProperty('width') ? props.width : 1941;
	var turl = IMAGE_BASE_URL + '/thumb/' + md5prefix + normFilename;
	var durl = IMAGE_DESC_URL + '/' + normFilename;
	var mediatype = props.mediatype ||
			(props.mime === 'image/svg+xml' ? 'DRAWING' : 'BITMAP');
	var result = {
		size: props.size || 12345,
		height: height,
		width: width,
		url: baseurl,
		descriptionurl: durl,
		mediatype: mediatype,
		mime: props.mime,
	};
	if (props.hasOwnProperty('duration')) {
		result.duration = props.duration;
	}
	if (twidth || theight) {
		if (twidth && (theight === undefined || theight === null)) {
			// File::scaleHeight in PHP
			theight = Math.round(height * twidth / width);
		} else if (theight && (twidth === undefined || twidth === null)) {
			// MediaHandler::fitBoxWidth in PHP
			// This is crazy!
			var idealWidth = width * theight / height;
			var roundedUp = Math.ceil(idealWidth);
			if (Math.round(roundedUp * height / width) > theight) {
				twidth = Math.floor(idealWidth);
			} else {
				twidth = roundedUp;
			}
		} else {
			if (Math.round(height * twidth / width) > theight) {
				twidth = Math.ceil(width * theight / height);
			} else {
				theight = Math.round(height * twidth / width);
			}
		}
		var urlWidth = twidth;
		if (twidth >= width || theight >= height) {
			// The PHP api won't enlarge an image ... but the batch api will.
			if (!useBatchAPI) {
				twidth = width;
				theight = height;
			}
			urlWidth = width;  // That right?
		}
		turl += '/' + urlWidth + 'px-' + normFilename;
		result.thumbwidth = twidth;
		result.thumbheight = theight;
		result.thumburl = turl;
	}
	return {
		result: result,
		normPagename: normPagename,
	};
};

var querySiteinfo = function(body, cb) {
	// TODO: Read which language should we use from somewhere.
	cb(null, require('../lib/config/baseconfig/enwiki.json'));
};

var parse = function(text, onlypst) {
	var html = onlypst ? text.replace(/\{\{subst:echo\|([^}]+)\}\}/, "$1") : '\n';
	return { text: html };
};

var missingTitles = new Set([
	'Doesnotexist',
]);

var specialTitles = new Set([
	'Special:Version',
]);

var redirectTitles = new Set([
	'Redirected',
]);

var pageProps = function(titles) {
	if (!Array.isArray(titles)) { return null; }
	return titles.map(function(t) {
		var props = { title: t };
		if (missingTitles.has(t)) { props.missing = ''; }
		if (specialTitles.has(t)) { props.special = ''; }
		if (redirectTitles.has(t)) { props.redirect = ''; }
		return props;
	});
};

var availableActions = {
	parse: function(body, cb) {
		var result = parse(body.text, body.onlypst);
		cb(null, { parse: { text: { '*': result.text } } });
	},

	query: function(body, cb) {
		if (body.meta === 'siteinfo') {
			return querySiteinfo(body, cb);
		}
		if (body.prop === "info|revisions") {
			if (body.revids === "1" || body.titles === "Main_Page") {
				return cb(null , mainPage);
			} else if (body.revids === "2" || body.titles === "Junk_Page") {
				return cb(null , junkPage);
			} else if (body.revids === '3' || body.titles === 'Large_Page') {
				return cb(null , largePage);
			} else if (body.revids === '100' || body.titles === 'Reuse_Page') {
				return cb(null , reusePage);
			} else if (body.revids === '101' || body.titles === 'JSON_Page') {
				return cb(null , jsonPage);
			} else if (body.revids === '102' || body.titles === 'Lint_Page') {
				return cb(null , lintPage);
			} else if (body.revids === '103' || body.titles === 'Redlinks_Page') {
				return cb(null , redlinksPage);
			} else {
				return cb(null, { query: { pages: {
					'-1': {
						ns: 6,
						title: body.titles,
						missing: '',
						imagerepository: '',
					},
				} } });
			}
		}
		if (body.prop === 'imageinfo') {
			var response = { query: { pages: {} } };
			var filename = body.titles;
			var ii = imageInfo(filename, body.iiurlwidth, body.iiurlheight, false);
			if (ii === null) {
				response.query.pages['-1'] = {
					ns: 6,
					title: filename,
					missing: '',
					imagerepository: '',
				};
			} else {
				response.query.normalized = [{ from: filename, to: ii.normPagename }];
				response.query.pages['1'] = {
					pageid: 1,
					ns: 6,
					title: ii.normPagename,
					imageinfo: [ii.result],
				};
			}
			return cb(null, response);
		}
		return cb(new Error('Uh oh!'));
	},

	expandtemplates: function(body, cb) {
		var res = preProcess(body.text);
		if (res === null) {
			cb(new Error('Sorry!'));
		} else {
			cb(null, { expandtemplates: res });
		}
	},

	'parsoid-batch': function(body, cb) {
		var batch;
		try {
			batch = JSON.parse(body.batch);
			console.assert(Array.isArray(batch));
		} catch (e) {
			return cb(e);
		}
		var errs = [];
		var results = batch.map(function(b) {
			var res = null;
			switch (b.action) {
				case 'preprocess':
					res = preProcess(b.text);
					break;
				case 'imageinfo':
					var txopts = b.txopts || {};
					var ii = imageInfo('File:' + b.filename, txopts.width, txopts.height, true);
					// NOTE: Return early here since a null is acceptable.
					return (ii !== null) ? ii.result : null;
				case 'parse':
					res = parse(b.text);
					break;
				case 'pageprops':
					res = pageProps(b.titles);
					break;
			}
			if (res === null) { errs.push(b); }
			return res;
		});
		var err = (errs.length > 0) ? new Error(JSON.stringify(errs)) : null;
		cb(err, { 'parsoid-batch': results });
	},

	// Return a dummy response
	templatedata: function(body, cb) {
		cb(null, {
			// FIXME: Assumes that body.titles is a single title
			// (which is how Parsoid uses this endpoint right now).
			'pages': {
				'1': templateData[body.titles] || {},
			},
		});
	},

	paraminfo: function(body, cb) {
		cb(null, { /* Just don't 400 for now. */ });
	},
};

var actionDefinitions = {
	parse: {
		parameters: {
			text: 'text',
			title: 'text',
			onlypst: 'boolean',
		},
	},
	query: {
		parameters: {
			titles: 'text',
			prop: 'text',
			iiprop: 'text',
			iiurlwidth: 'text',
			iiurlheight: 'text',
		},
	},
};

var actionRegex = Object.keys(availableActions).join('|');

function buildOptions(options) {
	var optStr = '';
	for (var i = 0; i < options.length; i++) {
		optStr += '<option value="' + options[i] + '">' + options[i] + '</option>';
	}
	return optStr;
}

function buildActionList() {
	var actions = Object.keys(availableActions);
	var setStr = '';
	for (var i = 0; i < actions.length; i++) {
		var action = actions[i];
		var title = 'action=' + action;
		setStr += '<li id="' + title + '">';
		setStr += '<a href="/' + action + '">' + title + '</a></li>';
	}
	return setStr;
}

function buildForm(action) {
	var formStr = '';
	var actionDef = actionDefinitions[action];
	var params = actionDef.parameters;
	var paramList = Object.keys(params);

	for (var i = 0; i < paramList.length; i++) {
		var param = paramList[i];
		if (typeof params[param] === 'string') {
			formStr += '<input type="' + params[param] + '" name="' + param + '" />';
		} else if (params[param].length) {
			formStr += '<select name="' + param + '">';
			formStr += buildOptions(params[param]);
			formStr += '</select>';
		}
	}
	return formStr;
}

// GET request to root....should probably just tell the client how to use the service
app.get('/', function(req, res) {
	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write(
		'<html><body>' +
			'<ul id="list-of-actions">' +
				buildActionList() +
			'</ul>' +
		'</body></html>');
	res.end();
});

// GET requests for any possible actions....tell the client how to use the action
app.get(new RegExp('^/(' + actionRegex + ')'), function(req, res) {
	var formats = buildOptions(Object.keys(formatters));
	var action = req.params[0];
	var returnHtml =
			'<form id="service-form" method="GET" action="api.php">' +
				'<h2>GET form</h2>' +
				'<input name="action" type="hidden" value="' + action + '" />' +
				'<select name="format">' +
					formats +
				'</select>' +
				buildForm(action) +
				'<input type="submit" />' +
			'</form>' +
			'<form id="service-form" method="POST" action="api.php">' +
				'<h2>POST form</h2>' +
				'<input name="action" type="hidden" value="' + action + '" />' +
				'<select name="format">' +
					formats +
				'</select>' +
				buildForm(action) +
				'<input type="submit" />' +
			'</form>';

	res.setHeader('Content-Type', 'text/html; charset=UTF-8');
	res.write(returnHtml);
	res.end();
});

function handleApiRequest(body, res) {
	var format = body.format;
	var action = body.action;
	var formatter = formatters[format || "json"];

	if (!availableActions.hasOwnProperty(action)) {
		return res.status(400).end("Unknown action.");
	}

	availableActions[action](body, function(err, data) {
		if (err === null) {
			res.setHeader('Content-Type', 'application/json');
			res.write(formatter(data));
			res.end();
		} else {
			res.setHeader('Content-Type', 'text/plain');
			res.status(err.httpStatus || 500);
			res.write(err.stack || err.toString());
			res.end();
		}
	});
}

// GET request to api.php....actually perform an API request
app.get('/api.php', function(req, res) {
	handleApiRequest(req.query, res);
});

// POST request to api.php....actually perform an API request
app.post('/api.php', function(req, res) {
	handleApiRequest(req.body, res);
});

module.exports = function(options) {
	var logger = options.logger;
	var server;
	return new Promise(function(resolve, reject) {
		app.on('error', function(err) {
			logger.log('error', err);
			reject(err);
		});
		server = app.listen(options.config.port, options.config.iface, resolve);
	}).then(function() {
		var port = server.address().port;
		logger.log('info', 'Mock MediaWiki API: Started on ' + port);
		return {
			close: function() {
				return Promise.promisify(server.close, false, server)();
			},
			port: port,
		};
	});
};
