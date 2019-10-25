/**
 * This file contains general utilities for scripts in
 * the bin/, tools/, tests/ directories. This file should
 * not contain any helpers that are needed by code in the
 * lib/ directory.
 *
 * @module
 */

'use strict';

require('../core-upgrade.js');

var Promise = require('../lib/utils/promise.js');
var request = Promise.promisify(require('request'), true);
var Util = require('../lib/utils/Util.js').Util;

var ScriptUtils = {
	/**
	 * Split a tracing / debugging flag string into individual flags
	 * and return them.
	 *
	 * @param {Object} origFlag The original flag string.
	 * @return {Array}
	 */
	splitFlags: function(origFlag) {
		var objFlags = origFlag.split(",");
		if (objFlags.indexOf("selser") !== -1 && objFlags.indexOf("wts") === -1) {
			objFlags.push("wts");
		}
		return objFlags;
	},

	/**
	 * Set debugging flags on an object, based on an options object.
	 *
	 * @param {Object} parsoidOptions Object to be assigned to the ParsoidConfig.
	 * @param {Object} cliOpts The options object to use for setting the debug flags.
	 * @return {Object} The modified object.
	 */
	setDebuggingFlags: function(parsoidOptions, cliOpts) {
		// Handle the --help options
		var exit = false;
		if (cliOpts.trace === 'help') {
			console.error(ScriptUtils.traceUsageHelp());
			exit = true;
		}
		if (cliOpts.dump === 'help') {
			console.error(ScriptUtils.dumpUsageHelp());
			exit = true;
		}
		if (cliOpts.debug === 'help') {
			console.error(ScriptUtils.debugUsageHelp());
			exit = true;
		}
		if (exit) {
			process.exit(1);
		}

		// Ok, no help requested: process the options.
		if (cliOpts.debug !== undefined) {
			// Continue to support generic debugging.
			if (cliOpts.debug === true) {
				console.warn("Warning: Generic debugging, not handler-specific.");
				parsoidOptions.debug = ScriptUtils.booleanOption(cliOpts.debug);
			} else {
				// Setting --debug automatically enables --trace
				parsoidOptions.debugFlags = ScriptUtils.splitFlags(cliOpts.debug);
				parsoidOptions.traceFlags = parsoidOptions.debugFlags;
			}
		}

		if (cliOpts.trace !== undefined) {
			if (cliOpts.trace === true) {
				console.warn("Warning: Generic tracing is no longer supported. Ignoring --trace flag. Please provide handler-specific tracing flags, e.g. '--trace pre,html5', to turn it on.");
			} else {
				// Add any new trace flags to the list of existing trace flags (if
				// any were inherited from debug); otherwise, create a new list.
				parsoidOptions.traceFlags = (parsoidOptions.traceFlags || []).concat(ScriptUtils.splitFlags(cliOpts.trace));
			}
		}

		if (cliOpts.dump !== undefined) {
			if (cliOpts.dump === true) {
				console.warn("Warning: Generic dumping not enabled. Please set a flag.");
			} else {
				parsoidOptions.dumpFlags = ScriptUtils.splitFlags(cliOpts.dump);
			}
		}

		return parsoidOptions;
	},

	/**
	 * Returns a help message for the tracing flags.
	 */
	traceUsageHelp: function() {
		return [
			"Tracing",
			"-------",
			"- With one or more comma-separated flags, traces those specific phases",
			"- Supported flags:",
			"  * pre-peg   : shows input to tokenizer",
			"  * peg       : shows tokens emitted by tokenizer",
			"  * sync:1    : shows tokens flowing through the post-tokenizer Sync Token Transform Manager",
			"  * async:2   : shows tokens flowing through the Async Token Transform Manager",
			"  * sync:3    : shows tokens flowing through the post-expansion Sync Token Transform Manager",
			"  * tsp       : shows tokens flowing through the TokenStreamPatcher (useful to see in-order token stream)",
			"  * list      : shows actions of the list handler",
			"  * sanitizer : shows actions of the sanitizer",
			"  * pre       : shows actions of the pre handler",
			"  * p-wrap    : shows actions of the paragraph wrapper",
			"  * html      : shows tokens that are sent to the HTML tree builder",
			"  * dsr       : shows dsr computation on the DOM",
			"  * tplwrap   : traces template wrapping code (currently only range overlap/nest/merge code)",
			"  * wts       : trace actions of the regular wikitext serializer",
			"  * selser    : trace actions of the selective serializer",
			"  * domdiff   : trace actions of the DOM diffing code",
			"  * wt-escape : debug wikitext-escaping",
			"  * batcher   : trace API batch aggregation and dispatch",
			"  * apirequest: trace all API requests",
			"  * time      : trace times for various phases (right now, limited to DOMPP passes)",
			"  * time/dompp: trace times for DOM Post processing passes",
			"",
			"--debug enables tracing of all the above phases except Token Transform Managers",
			"",
			"Examples:",
			"$ node parse --trace pre,p-wrap,html < foo",
			"$ node parse --trace sync:3,dsr < foo",
		].join('\n');
	},

	/**
	 * Returns a help message for the dump flags.
	 */
	dumpUsageHelp: function() {
		return [
			"Dumping state",
			"-------------",
			"- Dumps state at different points of execution",
			"- DOM dumps are always doc.outerHTML",
			"- Supported flags:",
			"",
			"  * tplsrc            : dumps preprocessed template source that will be tokenized (via ?action=expandtemplates)",
			"  * extoutput         : dumps HTML output form extensions (via ?action=parse)",
			"",
			"  --- Dump flags for wt2html DOM passes ---",
			"  * dom:pre-XXX       : dumps DOM before pass XXX runs",
			"  * dom:post-XXX      : dumps DOM after pass XXX runs",
			"",
			"    Available passes (in the order they run):",
			"",
			"      dpload, fostered, tb-fixups, normalize, pwrap, ",
			"      migrate-metas, pres, migrate-nls, dsr, tplwrap, ",
			"      dom-unpack, tag:EXT (replace EXT with extension: cite, poem, etc)",
			"      sections, heading-ids, lang-converter, linter, ",
			"      strip-metas, linkclasses, redlinks, downgrade",
			"",
			"  --- Dump flags for html2wt ---",
			"  * dom:post-dom-diff : in selective serialization, dumps DOM after running dom diff",
			"  * dom:post-normal   : in serialization, dumps DOM after normalization",
			"  * wt2html:limits    : dumps used resources (along with configured limits)\n",
			"--debug dumps state at these different stages\n",
			"Examples:",
			"$ node parse --dump dom:pre-dpload,dom:pre-dsr,dom:pre-tplwrap < foo",
			"$ node parse --trace html --dump dom:pre-tplwrap < foo",
			"\n",
		].join('\n');
	},

	/**
	 * Returns a help message for the debug flags.
	 */
	debugUsageHelp: function() {
		return [
			"Debugging",
			"---------",
			"- With one or more comma-separated flags, provides more verbose tracing than the equivalent trace flag",
			"- Supported flags:",
			"  * pre       : shows actions of the pre handler",
			"  * wts       : trace actions of the regular wikitext serializer",
			"  * selser    : trace actions of the selective serializer",
		].join('\n');
	},

	/**
	 * Sets templating and processing flags on an object,
	 * based on an options object.
	 *
	 * @param {Object} parsoidOptions Object to be assigned to the ParsoidConfig.
	 * @param {Object} cliOpts The options object to use for setting the debug flags.
	 * @return {Object} The modified object.
	 */
	setTemplatingAndProcessingFlags: function(parsoidOptions, cliOpts) {
		[
			'fetchConfig',
			'fetchTemplates',
			'fetchImageInfo',
			'expandExtensions',
			'rtTestMode',
			'addHTMLTemplateParameters',
		].forEach(function(c) {
			if (cliOpts[c] !== undefined) {
				parsoidOptions[c] = ScriptUtils.booleanOption(cliOpts[c]);
			}
		});
		if (cliOpts.usePHPPreProcessor !== undefined) {
			parsoidOptions.usePHPPreProcessor = parsoidOptions.fetchTemplates &&
				ScriptUtils.booleanOption(cliOpts.usePHPPreProcessor);
		}
		if (cliOpts.maxDepth !== undefined) {
			parsoidOptions.maxDepth = typeof (cliOpts.maxdepth) === 'number' ?
				cliOpts.maxdepth : parsoidOptions.maxDepth;
		}
		if (cliOpts.apiURL) {
			if (!Array.isArray(parsoidOptions.mwApis)) {
				parsoidOptions.mwApis = [];
			}
			parsoidOptions.mwApis.push({ prefix: 'customwiki', uri: cliOpts.apiURL });
		}
		if (cliOpts.addHTMLTemplateParameters !== undefined) {
			parsoidOptions.addHTMLTemplateParameters =
				ScriptUtils.booleanOption(cliOpts.addHTMLTemplateParameters);
		}
		if (cliOpts.lint) {
			parsoidOptions.linting = true;
			if (!parsoidOptions.linter) {
				parsoidOptions.linter = {};
			}
			parsoidOptions.linter.sendAPI = false;
		}
		if (cliOpts.useBatchAPI !== undefined) {
			parsoidOptions.useBatchAPI = cliOpts.useBatchAPI;
		}

		return parsoidOptions;
	},

	/**
	 * Parse a boolean option returned by the yargs package.
	 * The strings 'false' and 'no' are also treated as false values.
	 * This allows `--debug=no` and `--debug=false` to mean the same as
	 * `--no-debug`.
	 *
	 * @param {boolean|string} val
	 *   a boolean, or a string naming a boolean value.
	 * @return {boolean}
	 */
	booleanOption: function(val) {
		if (!val) { return false; }
		if ((typeof val) === 'string' && /^(no|false)$/i.test(val)) {
			return false;
		}
		return true;
	},

	/**
	 * Set the color flags, based on an options object.
	 *
	 * @param {Object} options
	 *   The options object to use for setting the mode of the 'color' package.
	 * @param {string|boolean} options.color
	 *   Whether to use color.  Passing 'auto' will enable color only if
	 *   stdout is a TTY device.
	 */
	setColorFlags: function(options) {
		var colors = require('colors');
		if (options.color === 'auto') {
			if (!process.stdout.isTTY) {
				colors.mode = 'none';
			}
		} else if (!ScriptUtils.booleanOption(options.color)) {
			colors.mode = 'none';
		}
	},

	/**
	 * Add standard options to an yargs options hash.
	 * This handles options parsed by `setDebuggingFlags`,
	 * `setTemplatingAndProcessingFlags`, `setColorFlags`,
	 * and standard --help options.
	 *
	 * The `defaults` option is optional, and lets you override
	 * the defaults for the standard options.
	 */
	addStandardOptions: function(opts, defaults) {
		var standardOpts = {
			// standard CLI options
			'help': {
				description: 'Show this help message',
				'boolean': true,
				'default': false,
				alias: 'h',
			},
			// handled by `setDebuggingFlags`
			'debug': {
				description: 'Provide optional flags. Use --debug=help for supported options',
			},
			'trace': {
				description: 'Use --trace=help for supported options',
			},
			'dump': {
				description: 'Dump state. Use --dump=help for supported options',
			},
			// handled by `setTemplatingAndProcessingFlags`
			'fetchConfig': {
				description: 'Whether to fetch the wiki config from the server or use our local copy',
				'boolean': true,
				'default': true,
			},
			'fetchTemplates': {
				description: 'Whether to fetch included templates recursively',
				'boolean': true,
				'default': true,
			},
			'fetchImageInfo': {
				description: 'Whether to fetch image info via the API',
				'boolean': true,
				'default': true,
			},
			'expandExtensions': {
				description: 'Whether we should request extension tag expansions from a wiki',
				'boolean': true,
				'default': true,
			},
			'usePHPPreProcessor': {
				description: 'Whether to use the PHP preprocessor to expand templates',
				'boolean': true,
				'default': true,
			},
			'addHTMLTemplateParameters': {
				description: 'Parse template parameters to HTML and add them to template data',
				'boolean': true,
				'default': false,
			},
			'maxdepth': {
				description: 'Maximum expansion depth',
				'default': 40,
			},
			'apiURL': {
				description: 'http path to remote API, e.g. http://en.wikipedia.org/w/api.php',
				'default': null,
			},
			'rtTestMode': {
				description: 'Test in rt test mode (changes some parse & serialization strategies)',
				'boolean': true,
				'default': false,
			},
			'useBatchAPI': {
				description: 'Turn on/off the API batching system',
				'boolean': false,
			},
			// handled by `setColorFlags`
			'color': {
				description: 'Enable color output Ex: --no-color',
				'default': 'auto',
			},
		};
		// allow overriding defaults
		Object.keys(defaults || {}).forEach(function(name) {
			if (standardOpts[name]) {
				standardOpts[name].default = defaults[name];
			}
		});
		return Util.extendProps(opts, standardOpts);
	},
};

/**
 * Perform a HTTP request using the 'request' package, and retry on failures.
 * Only use on idempotent HTTP end points.
 *
 * @param {number} retries The number of retries to attempt.
 * @param {Object} requestOptions Request options.
 * @param {number} [delay] Exponential back-off.
 * @return {Promise}
 */
ScriptUtils.retryingHTTPRequest = function(retries, requestOptions, delay) {
	delay = delay || 100;  // start with 100ms
	return request(requestOptions)
	.catch(function(error) {
		if (retries--) {
			console.error('HTTP ' + requestOptions.method + ' to \n' +
					(requestOptions.uri || requestOptions.url) + ' failed: ' + error +
					'\nRetrying in ' + (delay / 1000) + ' seconds.');
			return Promise.delay(delay).then(function() {
				return ScriptUtils.retryingHTTPRequest(retries, requestOptions, delay * 2);
			});
		} else {
			return Promise.reject(error);
		}
	})
	.spread(function(res, body) {
		if (res.statusCode !== 200) {
			throw new Error('Got status code: ' + res.statusCode +
				'; body: ' + JSON.stringify(body).substr(0, 500));
		}
		return Array.from(arguments);
	});
};

if (typeof module === "object") {
	module.exports.ScriptUtils = ScriptUtils;
}
