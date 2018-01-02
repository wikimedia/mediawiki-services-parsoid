#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');

const colors = require('colors');
const fs = require('pn/fs');
const path = require('path');
const yargs = require('yargs');

const ApiRequest = require('../lib/mw/ApiRequest.js').ApiRequest;
const Diff = require('../lib/utils/Diff.js').Diff;
const DOMTraverser = require('../lib/utils/DOMTraverser.js').DOMTraverser;
const DU = require('../lib/utils/DOMUtils.js').DOMUtils;
const MWParserEnvironment = require('../lib/config/MWParserEnvironment.js').MWParserEnvironment;
const ParsoidConfig = require('../lib/config/ParsoidConfig.js').ParsoidConfig;
const Promise = require('../lib/utils/promise.js');
const TemplateRequest = require('../lib/mw/ApiRequest.js').TemplateRequest;
const Util = require('../lib/utils/Util.js').Util;

const jsonFormat = function(error, domain, title, lang, options, results) {
	if (error) { return { error: error.stack || error.toString() }; }
	const p = Diff.patchDiff(results.php, results.parsoid);
	return { patch: p };
};

const plainFormat = function(error, domain, title, lang, options, results) {
	if (error) { return error.stack || error.toString(); }
	const diff = Diff.colorDiff(results.php, results.parsoid, {
		context: 1,
		noColor: (colors.mode === 'none'),
		diffCount: true,
	});
	if (diff.count === 0) { return ''; }
	return `${diff.output}\n${diff.count} different words found.`;
};

const xmlFormat = function(error, domain, title, lang, options, results) {
	const article = Util.escapeHtml(`${domain} ${title} ${lang || ''}`);
	let output = '<testsuites>\n';
	output += `<testsuite name="Variant ${article}">\n`;
	output += `<testcase name="revision ${results.revid}">\n`;
	if (error) {
		output += '<error type="parserFailedToFinish">';
		output += Util.escapeHtml(error.stack || error.toString());
		output += '</error>';
	} else if (results.php !== results.parsoid) {
		output += '<failure type="diff">\n<diff class="html">\n';
		output += Diff.colorDiff(results.php, results.parsoid, {
			context: 1,
			html: true,
			separator: '</diff></failure>\n' +
				'<failure type="diff"><diff class="html">',
		});
		output += '\n</diff>\n</failure>\n';
	}
	output += '</testcase>\n';
	output += '</testsuite>\n';
	output += '</testsuites>\n';
	return output;
};

class PHPVariantRequest extends ApiRequest {
	constructor(env, title, variant, revid) {
		super(env, title);
		this.reqType = "Variant Parse";

		const apiargs = {
			format: 'json',
			action: 'parse',
			page: title,
			prop: 'text|revid|displaytitle',
			uselang: 'content',
			wrapoutputclass: '',
			disableeditsection: 'true',
			disabletoc: 'true',
			disablelimitreport: 'true'
		};
		if (revid) {
			// The parameters `page` and `oldid` can't be used together
			apiargs.page = undefined;
			apiargs.oldid = revid;
		}
		// This argument to the API is not documented!  Except in
		// https://phabricator.wikimedia.org/T44356#439479 and
		// https://phabricator.wikimedia.org/T34906#381101
		if (variant) { apiargs.variant = variant; }

		const uri = env.conf.wiki.apiURI;
		this.requestOptions = {
			uri,
			method: 'POST',
			form: apiargs, // The API arguments
			followRedirect: true,
			timeout: env.conf.parsoid.timeouts.mwApi.extParse,
		};

		this.request(this.requestOptions);
	}
	_handleJSON(error, data) {
		if (!error && !(data && data.parse)) {
			error = this._errorObj(data, this.text, 'Missing data.parse.');
		}

		if (error) {
			this.env.log("error", error);
			this._processListeners(error, '');
		} else {
			this._processListeners(error, data.parse);
		}
	}
}

const phpFetch = Promise.async(function *(env, title, revid) {
	const parse = yield new Promise((resolve, reject) => {
		const req = new PHPVariantRequest(
			env, title, env.variantLanguage, revid
		);
		req.once('src', (err, src) => {
			return err ? reject(err) : resolve(src);
		});
	});
	const document = DU.parseHTML(parse.text['*']);
	const displaytitle = parse.displaytitle;
	revid = parse.revid;
	return {
		document,
		revid,
		displaytitle
	};
});

const parsoidFetch = Promise.async(function *(env, title, options) {
	if (!options.useServer) {
		yield TemplateRequest.setPageSrcInfo(env, title, options.oldid);
		const revision = env.page.meta.revision;
		const handler = env.getContentHandler(revision.contentmodel);
		const document = yield handler.toHTML(env);
		return {
			document,
			revid: revision.revid,
			displaytitle: document.title,
		};
	}
	const domain = options.domain;
	let uri = options.uri;
	// Make sure the Parsoid URI ends with `/`
	if (!/\/$/.test(uri)) {
		uri += '/';
	}
	uri += `${domain}/v3/page/html/${encodeURIComponent(title)}`;
	if (options.oldid) {
		uri += `/${options.oldid}`;
	}
	const resp = yield Util.retryingHTTPRequest(10, {
		method: 'GET',
		uri,
		headers: {
			'User-Agent': env.userAgent,
			'Accept-Language': env.variantLanguage,
		}
	});
	// We may have been redirected to the latest revision. Record oldid.
	const res = resp[0];
	const body = resp[1];
	if (res.statusCode !== 200) {
		throw new Error(`Can\'t fetch Parsoid source: ${uri}`);
	}
	const oldid = res.request.path.replace(/^(.*)\//, '');
	const document = DU.parseHTML(body);
	return {
		document,
		revid: oldid,
		displaytitle: document.title,
	};
});

/**
 * Pull "just the text" from an HTML document, normalizing whitespace
 * differences and suppressing places where Parsoid and PHP output
 * deliberately differs.
 */
const extractText = function(env, document) {
	var dt = new DOMTraverser(env);
	var sep = '';
	var buf = '';
	/* We normalize all whitespace in text nodes to a single space. We
	 * do insert newlines in the output, but only to delimit block
	 * elements.  Even there, we are careful never to emit two newlines
	 * in a row, or whitespace before or after a newline. */
	const addSep = (s) => {
		if (s === '') { return; }
		if (/\n/.test(s)) { sep = '\n'; return; }
		if (sep === '\n') { return; }
		sep = ' ';
	};
	const emit = (s) => { if (s !== '') { buf += sep; buf += s; sep = ''; } };
	dt.addHandler('#text', (node, env, atTopLevel, tplInfo) => {
		const v = node.nodeValue.replace(/\s+/g, ' ');
		const m = /^(\s*)(.*?)(\s*)$/.exec(v);
		addSep(m[1]);
		emit(m[2]);
		addSep(m[3]);
		return true;
	});
	/* These are the block elements which we delimit with newlines (aka,
	 * we ensure they start on a line of their own). */
	var forceBreak = () => { addSep('\n'); return true; };
	for (const el of ['p','li','div','table','tr','h1','h2','h3','h4','h5','h6']) {
		dt.addHandler(el, forceBreak);
	}
	/* Separate table columns with spaces */
	dt.addHandler('td', () => { addSep(' '); return true; });
	/* Suppress reference numbers and linkback text */
	dt.addHandler('sup', (node) => {
		if (
			node.classList.contains('reference') /* PHP */ ||
			node.classList.contains('mw-ref') /* Parsoid */
		) {
			return node.nextSibling; // Skip contents of this node
		}
		return true;
	});
	dt.addHandler('span', (node) => {
		if (
			node.classList.contains('mw-cite-backlink') ||
			/\bmw:referencedBy\b/.test(node.getAttribute('rel') || '')
		) {
			return node.nextSibling; // Skip contents of this node
		}
		return true;
	});
	/* Show the targets of wikilinks, since the titles should be
	 * language-converted too. */
	dt.addHandler('a', (node) => {
		const rel = node.getAttribute('rel') || '';
		if (/\bmw:referencedBy\b/.test(rel)) {
			// skip reference linkback
			return node.nextSibling;
		}
		let href = node.getAttribute('href') || '';
		// Rewrite red links as normal links
		let m = /^\/w\/index\.php\?title=(.*?)&.*redlink=1$/.exec(href);
		if (m) {
			href = `/wiki/${m[1]}`;
		}
		// Local links to this page
		m = /^#/.test(href);
		if (m) {
			const title = encodeURIComponent(env.page.name);
			href = `/wiki/${title}${href}`;
		}
		// Now look for wiki links
		if (node.classList.contains('external')) {
			return true;
		}
		if (/^(\.|\/wiki)\//.test(href)) {
			const title = Util.decodeURI(href.replace(/^.*\//, ''));
			addSep(' ');
			emit(`[${title}]`);
			addSep(' ');
		}
		return true;
	});
	dt.traverse(document.body);
	return buf;
};

const runTest = Promise.async(function *(domain, title, lang, options, formatter) {
	// Step 0: Configuration & setup
	const parsoidOptions = {
		loadWMF: true,
	};
	const envOptions = {
		domain,
		pageName: title,
		userAgent: 'LangConvTest',
		variantLanguage: lang || null,
		logLevels: options.verbose ? undefined : ["fatal", "error", "warn"],
	};
	Util.setTemplatingAndProcessingFlags(parsoidOptions, options);
	Util.setDebuggingFlags(parsoidOptions, options);
	Util.setColorFlags(options);

	let nock, dir, nocksFile;
	if (options.record || options.replay) {
		dir = path.resolve(__dirname, '../nocks/');
		if (!(yield fs.exists(dir))) {
			yield fs.mkdir(dir);
		}
		dir = `${dir}/${domain}`;
		if (!(yield fs.exists(dir))) {
			yield fs.mkdir(dir);
		}
		nocksFile = `${dir}/lc-${encodeURIComponent(title)}.js`;
		if (options.record) {
			nock = require('nock');
			nock.recorder.rec({ dont_print: true });
		} else {
			require(nocksFile);
		}
	}

	const parsoidConfig = new ParsoidConfig(null, parsoidOptions);
	const env = yield MWParserEnvironment.getParserEnv(parsoidConfig, envOptions);

	// Step 1: Fetch page from PHP API
	const phpDoc = yield phpFetch(env, title, options.oldid);
	// Step 2: Fetch page from Parsoid API
	const parsoidDoc = yield parsoidFetch(env, title, {
		domain,
		uri: options.parsoidURL,
		oldid: options.oldid || phpDoc.revid,
		useServer: options.useServer,
	});
	// Step 3: Strip most markup (so we're comparing text, not markup)
	//  ...but eventually we'll leave <a href> since there's some title
	//    conversion that should be done.
	const normalize = out => `TITLE: ${out.displaytitle}\n\n` +
		extractText(env, out.document);
	const phpText = normalize(phpDoc);
	const parsoidText = normalize(parsoidDoc);
	// Step 4: Compare (and profit!)
	console.assert(+phpDoc.revid === +parsoidDoc.revid);
	const output = formatter(null, domain, title, lang, options, {
		php: phpText,
		parsoid: parsoidText,
		revid: phpDoc.revid,
	});
	const exitCode = (phpText === parsoidText) ? 0 : 1;

	if (options.record) {
		const nockCalls = nock.recorder.play();
		yield fs.writeFile(
			nocksFile,
			`'use strict';\nlet nock = require('nock');\n${nockCalls.join('\n')}`,
			'utf8'
		);
	}
	return {
		output,
		exitCode,
	};
});

if (require.main === module) {
	const standardOpts = Util.addStandardOptions({
		domain: {
			description: 'Which wiki to use; e.g. "sr.wikipedia.org" for' +
				' Serbian wikipedia',
			boolean: false,
			default: 'sr.wikipedia.org',
		},
		oldid: {
			description: 'Optional oldid of the given page. If not given,' +
				' will use the latest revision.',
			boolean: false,
			default: null,
		},
		parsoidURL: {
			description: 'The URL for the Parsoid API',
			boolean: false,
			default: '',
		},
		apiURL: {
			description: 'http path to remote API,' +
				' e.g. http://sr.wikipedia.org/w/api.php',
			boolean: false,
			default: '',
		},
		xml: {
			description: 'Use xml output format',
			boolean: true,
			default: false,
		},
		check: {
			description: 'Exit with non-zero exit code if differences found using selser',
			boolean: true,
			default: false,
			alias: 'c',
		},
		'record': {
			description: 'Record http requests for later replay',
			'boolean': true,
			'default': false,
		},
		'replay': {
			description: 'Replay recorded http requests for later replay',
			'boolean': true,
			'default': false,
		},
		'verbose': {
			description: 'Log at level "info" as well',
			'boolean': true,
			'default': false,
		},
		'useServer': {
			description: 'Use a parsoid server',
			'boolean': true,
			'default': false,
		},
	});

	Promise.async(function *() {
		const opts = yargs.usage(
			'Usage: $0 [options] <page-title> <variantLanguage>\n' +
			'The page title should be the "true title",' +
			'i.e., without any url encoding which might be necessary if it appeared in wikitext.' +
			'\n\n', standardOpts
		).strict();

		const argv = opts.argv;
		if (!argv._.length) {
			return opts.showHelp();
		}
		const title = String(argv._[0]);
		const lang = String(argv._[1]);
		let ret = null;
		if (argv.record || argv.replay) {
			// Don't fork a separate server if record/replay
			argv.useServer = false;
		}
		if (argv.useServer && !argv.parsoidURL) {
			// Start our own Parsoid server
			const serviceWrapper = require('../tests/serviceWrapper.js');
			const serverOpts = {
				logging: { level: 'info' },
			};
			if (argv.apiURL) {
				serverOpts.mockURL = argv.apiURL;
				argv.domain = 'customwiki';
			} else {
				serverOpts.skipMock = true;
			}
			ret = yield serviceWrapper.runServices(serverOpts);
			argv.parsoidURL = ret.parsoidURL;
		}
		const formatter = Util.booleanOption(argv.xml) ?
			xmlFormat : plainFormat;
		const domain = argv.domain || 'sr.wikipedia.org';
		let r;
		try {
			r = yield runTest(domain, title, lang, argv, formatter);
		} catch (e) {
			r = {
				error: true,
				output: formatter(e, domain, title, lang, argv),
				exitCode: 2,
			};
		}
		console.log(r.output);
		if (ret !== null) {
			yield ret.runner.stop();
		}
		if (argv.check || r.error) {
			process.exit(r.exitCode);
		}
	})().done();
} else if (typeof module === 'object') {
	module.exports.runTest = runTest;

	module.exports.jsonFormat = jsonFormat;
	module.exports.plainFormat = plainFormat;
	module.exports.xmlFormat = xmlFormat;
}
