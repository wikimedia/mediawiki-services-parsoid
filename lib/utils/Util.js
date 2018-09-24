/**
 * This file contains general utilities for token transforms.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var crypto = require('crypto');
var entities = require('entities');
var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var JSUtils = require('./jsutils.js').JSUtils;
var Promise = require('./promise.js');

var request = Promise.promisify(require('request'), true);
var lastItem = JSUtils.lastItem;

// This is a circular dependency.  Don't use anything from defines at module
// evaluation time.  (For example, we can't define the usual local variable
// shortcuts here.)
var pd = require('../wt2html/parser.defines.js');
var DU;

/**
 * @namespace
 */
var Util = {

	// Non-global and global versions of regexp for use everywhere
	COMMENT_REGEXP: /<!--(?:[^-]|-(?!->))*-->/,
	COMMENT_REGEXP_G: /<!--(?:[^-]|-(?!->))*-->/g,

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
			console.error(Util.traceUsageHelp());
			exit = true;
		}
		if (cliOpts.dump === 'help') {
			console.error(Util.dumpUsageHelp());
			exit = true;
		}
		if (cliOpts.debug === 'help') {
			console.error(Util.debugUsageHelp());
			exit = true;
		}
		if (cliOpts.genTest === 'help') {
			console.error(Util.genTestUsageHelp());
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
				parsoidOptions.debug = Util.booleanOption(cliOpts.debug);
			} else {
				// Setting --debug automatically enables --trace
				parsoidOptions.debugFlags = this.splitFlags(cliOpts.debug);
				parsoidOptions.traceFlags = parsoidOptions.debugFlags;
			}
		}

		if (cliOpts.trace !== undefined) {
			if (cliOpts.trace === true) {
				console.warn("Warning: Generic tracing is no longer supported. Ignoring --trace flag. Please provide handler-specific tracing flags, e.g. '--trace pre,html5', to turn it on.");
			} else {
				// Add any new trace flags to the list of existing trace flags (if
				// any were inherited from debug); otherwise, create a new list.
				parsoidOptions.traceFlags = (parsoidOptions.traceFlags || []).concat(this.splitFlags(cliOpts.trace));
			}
		}

		if (cliOpts.dump !== undefined) {
			if (cliOpts.dump === true) {
				console.warn("Warning: Generic dumping not enabled. Please set a flag.");
			} else {
				parsoidOptions.dumpFlags = this.splitFlags(cliOpts.dump);
			}
		}

		if (cliOpts.genTest !== undefined) {
			if (cliOpts.genTest === true) {
				console.warn("Warning: Generic test generation is not supported. Ignoring --genTest flag. Please provide handler-specific tracing flags, e.g. '--genTest ListHandler,TestFileName', to turn it on.");
			} else {
				var parameters = this.splitFlags(cliOpts.genTest);
				if (parameters.length === 2) {
					parsoidOptions.generateFlags = { "handler": parameters[0], "fileName": parameters[1] };
					var handlers = new Set(['QuoteTransformer', 'ListHandler', 'ParagraphWrapper',
						'TokenStreamPatcher', 'BehaviorSwitchHandler', 'SanitizerHandler']);
					console.assert(handlers.has(parsoidOptions.generateFlags.handler),
						'No matching token handler named ' + parameters[0] + ' found, exiting.');
				} else {
					console.assert(false, 'Incorrect number of parameters for --getTest specified, exiting.');
				}
			}
		}

		return parsoidOptions;
	},


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
	 * Returns a help message for the tracing flags.
	 */
	traceUsageHelp: function() {
		return [
			"Tracing",
			"-------",
			"- With one or more comma-separated flags, traces those specific phases",
			"- Supported flags:",
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
			"  * tplsrc            : dumps preprocessed template source that will be tokenized (via ?action=expandtemplates)",
			"  * extoutput         : dumps HTML output form extensions (via ?action=parse)",
			"  * dom:post-builder  : dumps DOM returned by HTML builder",
			"  * dom:pre-dsr       : dumps DOM prior to computing DSR",
			"  * dom:post-dsr      : dumps DOM after computing DSR",
			"  * dom:pre-encap     : dumps DOM before template encapsulation",
			"  * dom:post-encap    : dumps DOM after template encapsulation",
			"  * dom:pre-pwrap     : dumps DOM before paragraph wrapping",
			"  * dom:post-pwrap    : dumps DOM after paragraph wrapping",
			"  * dom:pre-sections  : dumps DOM before section wrapping",
			"  * dom:pre-linting   : dumps DOM before linting",
			"  * dom:post-dom-diff : in selective serialization, dumps DOM after running dom diff",
			"  * dom:post-normal   : in serialization, dumps DOM after normalization",
			"  * wt2html:limits    : dumps used resources (along with configured limits)\n",
			"--debug dumps state at these different stages\n",
			"Examples:",
			"$ node parse --dump dom:post-builder,dom:pre-dsr,dom:pre-encap < foo",
			"$ node parse --trace html --dump dom:pre-encap < foo",
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
	 * Returns a help message for the generate flags.
	 */
	genTestUsageHelp: function() {
		return [
			"Generate Test Files",
			"-------------------",
			"- Generates transformTest.js compatible output files",
			"- example: --genTest ListHandler,listTestFile.txt",
			"- Supported transformers/handlers:",
			"  * QuoteTransformer  : records quote transforms",
			"  * ListHandler       : records list transforms",
			"  * ParagraphWrapper  : records paragraph transforms",
			"  * TokenStreamPatcher : records token stream patch transforms",
			"  * BehaviorSwitchHandler : records behavior switch transforms",
			"  * SanitizerHandler  : records sanitizer transforms"
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
				parsoidOptions[c] = Util.booleanOption(cliOpts[c]);
			}
		});
		if (cliOpts.usePHPPreProcessor !== undefined) {
			parsoidOptions.usePHPPreProcessor = parsoidOptions.fetchTemplates &&
				Util.booleanOption(cliOpts.usePHPPreProcessor);
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
				Util.booleanOption(cliOpts.addHTMLTemplateParameters);
		}
		if (cliOpts.lint) {
			parsoidOptions.linting = true;
			if (!parsoidOptions.linter) {
				parsoidOptions.linter = {};
			}
			parsoidOptions.linter.sendAPI = false;
		}
		if (cliOpts.useBatchAPI !== null) {
			parsoidOptions.useBatchAPI = Util.booleanOption(cliOpts.useBatchAPI);
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
		} else if (!Util.booleanOption(options.color)) {
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
			'genTest': {
				description: 'Generates token transformer tests. Use --genTest=help for supported options',
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

	/**
	 * Update only those properties that are undefined or null in the target.
	 *
	 * @param {Object} tgt The object to modify.
	 * @param {...Object} subject The object to extend tgt with. Add more arguments to the function call to chain more extensions.
	 * @return {Object} The modified object.
	 */
	extendProps: function(tgt, subject /* FIXME: use spread operator */) {
		function internalExtend(target, obj) {
			var allKeys = [].concat(Object.keys(target), Object.keys(obj));
			for (var i = 0, numKeys = allKeys.length; i < numKeys; i++) {
				var k = allKeys[i];
				if (target[k] === undefined || target[k] === null) {
					target[k] = obj[k];
				}
			}
			return target;
		}
		var n = arguments.length;
		for (var j = 1; j < n; j++) {
			internalExtend(tgt, arguments[j]);
		}
		return tgt;
	},

	stripParsoidIdPrefix: function(aboutId) {
		// 'mwt' is the prefix used for new ids in mediawiki.parser.environment#newObjectId
		return aboutId.replace(/^#?mwt/, '');
	},

	isParsoidObjectId: function(aboutId) {
		// 'mwt' is the prefix used for new ids in mediawiki.parser.environment#newObjectId
		return aboutId.match(/^#mwt/);
	},

	/**
	 * Determine if a tag is block-level or not.
	 *
	 * `<video>` is removed from block tags, since it can be phrasing content.
	 * This is necessary for it to render inline.
	 */
	isBlockTag: function(name) {
		name = name.toUpperCase();
		return name !== 'VIDEO' && Consts.HTML.HTML4BlockTags.has(name);
	},

	/**
	 * In the PHP parser, these block tags open block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 */
	tagOpensBlockScope: function(name) {
		return Consts.BlockScopeOpenTags.has(name.toUpperCase());
	},

	/**
	 * In the PHP parser, these block tags close block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 */
	tagClosesBlockScope: function(name) {
		return Consts.BlockScopeCloseTags.has(name.toUpperCase());
	},

	/**
	 * Determine if the named tag is void (can not have content).
	 */
	isVoidElement: function(name) {
		return Consts.HTML.VoidTags.has(name.toUpperCase());
	},

	/**
	 * Determine if a token is block-level or not.
	 */
	isBlockToken: function(token) {
		if (token.constructor === pd.TagTk ||
				token.constructor === pd.EndTagTk ||
				token.constructor === pd.SelfclosingTagTk) {
			return Util.isBlockTag(token.name);
		} else {
			return false;
		}
	},

	isTemplateToken: function(token) {
		return token && token.constructor === pd.SelfclosingTagTk && token.name === 'template';
	},

	/**
	 * Regep for checking marker metas typeofs representing
	 * transclusion markup or template param markup.
	 * @property {RegExp}
	 */
	TPL_META_TYPE_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param)(?:\/End)?)(?=$|\s)/,

	isTemplateMeta: function(t) {
		return t.name === 'meta' && Util.TPL_META_TYPE_REGEXP.test(t.getAttribute('typeof'));
	},

	isDOMFragmentType: function(typeOf) {
		return /(?:^|\s)mw:DOMFragment(\/sealed\/\w+)?(?=$|\s)/.test(typeOf);
	},

	isTableTag: function(token) {
		var tc = token.constructor;
		return (tc === pd.TagTk || tc === pd.EndTagTk) &&
			Consts.HTML.TableTags.has(token.name.toUpperCase());
	},

	hasParsoidTypeOf: function(typeOf) {
		return (/(^|\s)mw:[^\s]+/).test(typeOf);
	},

	/** @property {RegExp} */
	solTransparentLinkRegexp: /(?:^|\s)mw:PageProp\/(?:Category|redirect|Language)(?=$|\s)/,

	isSolTransparentLinkTag: function(token) {
		var tc = token.constructor;
		return (tc === pd.SelfclosingTagTk || tc === pd.TagTk || tc === pd.EndTagTk) &&
			token.name === 'link' &&
			this.solTransparentLinkRegexp.test(token.getAttribute('rel'));
	},

	isBehaviorSwitch: function(env, token) {
		return token.constructor === pd.SelfclosingTagTk && (
			// Before BehaviorSwitchHandler (ie. PreHandler, etc.)
			token.name === 'behavior-switch' ||
			// After BehaviorSwitchHandler
			// (ie. ListHandler, ParagraphWrapper, etc.)
			(token.name === 'meta' &&
				env.conf.wiki.bswPagePropRegexp.test(token.getAttribute('property')))
		);
	},

	/**
	 * This should come close to matching
	 * {@link DOMUtils.emitsSolTransparentSingleLineWT},
	 * without the single line caveat.
	 */
	isSolTransparent: function(env, token) {
		var tc = token.constructor;
		if (tc === String) {
			return token.match(/^\s*$/);
		} else if (this.isSolTransparentLinkTag(token)) {
			return true;
		} else if (tc === pd.CommentTk) {
			return true;
		} else if (this.isBehaviorSwitch(env, token)) {
			return true;
		} else if (tc !== pd.SelfclosingTagTk || token.name !== 'meta') {
			return false;
		} else {  // only metas left
			return token.dataAttribs.stx !== 'html';
		}
	},

	isEmptyLineMetaToken: function(token) {
		return token.constructor === pd.SelfclosingTagTk &&
			token.name === "meta" &&
			token.getAttribute("typeof") === "mw:EmptyLine";
	},

	/**
	 * Transform `"\n"` and `"\r\n"` in the input string to {@link NlTk} tokens.
	 */
	newlinesToNlTks: function(str, tsr0) {
		var toks = str.split(/\n|\r\n/);
		var ret = [];
		var tsr = tsr0;
		var i = 0;
		// Add one NlTk between each pair, hence toks.length-1
		for (var n = toks.length - 1; i < n; i++) {
			ret.push(toks[i]);
			var nlTk = new pd.NlTk();
			if (tsr !== undefined) {
				tsr += toks[i].length;
				nlTk.dataAttribs = { tsr: [tsr, tsr + 1] };
			}
			ret.push(nlTk);
		}
		ret.push(toks[i]);
		return ret;
	},

	shiftTokenTSR: function(tokens, offset, clearIfUnknownOffset) {
		// Bail early if we can
		if (offset === 0) {
			return;
		}

		// offset should either be a valid number or null
		if (offset === undefined) {
			if (clearIfUnknownOffset) {
				offset = null;
			} else {
				return;
			}
		}

		// update/clear tsr
		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i];
			switch (t && t.constructor) {
				case pd.TagTk:
				case pd.SelfclosingTagTk:
				case pd.NlTk:
				case pd.CommentTk:
				case pd.EndTagTk:
					var da = tokens[i].dataAttribs;
					var tsr = da.tsr;
					if (tsr) {
						if (offset !== null) {
							da.tsr = [tsr[0] + offset, tsr[1] + offset];
						} else {
							da.tsr = null;
						}
					}

					// SSS FIXME: offset will always be available in
					// chunky-tokenizer mode in which case we wont have
					// buggy offsets below.  The null scenario is only
					// for when the token-stream-patcher attempts to
					// reparse a string -- it is likely to only patch up
					// small string fragments and the complicated use cases
					// below should not materialize.

					// target offset
					if (offset && da.targetOff) {
						da.targetOff += offset;
					}

					// content offsets for ext-links
					if (offset && da.contentOffsets) {
						da.contentOffsets[0] += offset;
						da.contentOffsets[1] += offset;
					}

					// end offset for pre-tag
					if (offset && da.endpos) {
						da.endpos += offset;
					}

					//  Process attributes
					if (t.attribs) {
						for (var j = 0, m = t.attribs.length; j < m; j++) {
							var a = t.attribs[j];
							if (Array.isArray(a.k)) {
								this.shiftTokenTSR(a.k, offset, clearIfUnknownOffset);
							}
							if (Array.isArray(a.v)) {
								this.shiftTokenTSR(a.v, offset, clearIfUnknownOffset);
							}

							// src offsets used to set mw:TemplateParams
							if (offset === null) {
								a.srcOffsets = null;
							} else if (a.srcOffsets) {
								for (var k = 0; k < a.srcOffsets.length; k++) {
									a.srcOffsets[k] += offset;
								}
							}
						}
					}
					break;

				default:
					break;
			}
		}
	},

	isEntitySpanToken: function(token) {
		return token.constructor === pd.TagTk && token.name === 'span' &&
			token.getAttribute('typeof') === 'mw:Entity';
	},

	/**
	 * Strip include tags, and the contents of includeonly tags as well.
	 */
	stripIncludeTokens: function(tokens) {
		var toks = [];
		var includeOnly = false;
		for (var i = 0; i < tokens.length; i++) {
			var tok = tokens[i];
			switch (tok.constructor) {
				case pd.TagTk:
				case pd.EndTagTk:
				case pd.SelfclosingTagTk:
					if (['noinclude', 'onlyinclude'].includes(tok.name)) {
						continue;
					} else if (tok.name === 'includeonly') {
						includeOnly = (tok.constructor === pd.TagTk);
						continue;
					}
				// Fall through
				default:
					if (!includeOnly) {
						toks.push(tok);
					}
			}
		}
		return toks;
	},

	tokensToString: function(tokens, strict, opts) {
		var out = '';
		if (!opts) {
			opts = {};
		}
		// XXX: quick hack, track down non-array sources later!
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		for (var i = 0, l = tokens.length; i < l; i++) {
			var token = tokens[i];
			if (!token) {
				continue;
			} else if (token.constructor === String) {
				out += token;
			} else if (token.constructor === pd.CommentTk ||
					(!opts.retainNLs && token.constructor === pd.NlTk)) {
				// strip comments and newlines
			} else if (opts.stripEmptyLineMeta && this.isEmptyLineMetaToken(token)) {
				// If requested, strip empty line meta tokens too.
			} else if (opts.includeEntities && this.isEntitySpanToken(token)) {
				out += token.dataAttribs.src;
				i += 2;  // Skip child and end tag.
			} else if (strict) {
				// If strict, return accumulated string on encountering first non-text token
				return [out, tokens.slice(i)];
			} else if (Array.isArray(token)) {
				out += this.tokensToString(token, strict, opts);
			}
		}
		return out;
	},

	flattenAndAppendToks: function(array, prefix, t) {
		if (Array.isArray(t) || t.constructor === String) {
			if (t.length > 0) {
				if (prefix) {
					array.push(prefix);
				}
				array = array.concat(t);
			}
		} else {
			if (prefix) {
				array.push(prefix);
			}
			array.push(t);
		}

		return array;
	},

	// deep clones by default.
	clone: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		if (Array.isArray(obj)) {
			if (deepClone) {
				return obj.map(function(el) {
					return Util.clone(el, true);
				});
			} else {
				return obj.slice();
			}
		} else if (obj instanceof Object && // only "plain objects"
					Object.getPrototypeOf(obj) === Object.prototype) {
			/* This definition of "plain object" comes from jquery,
			 * via zepto.js.  But this is really a big hack; we should
			 * probably put a console.assert() here and more precisely
			 * delimit what we think is legit to clone. (Hint: not
			 * tokens or DOM trees.) */
			if (deepClone) {
				return Object.keys(obj).reduce(function(nobj, key) {
					nobj[key] = Util.clone(obj[key], true);
					return nobj;
				}, {});
			} else {
				return Object.assign({}, obj);
			}
		} else {
			return obj;
		}
	},

	// Just a copy `Util.clone` used in *testing* to reverse the effects of
	// freezing an object.  Works with more that just "plain objects"
	unFreeze: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		if (Array.isArray(obj)) {
			if (deepClone) {
				return obj.map(function(el) {
					return Util.unFreeze(el, true);
				});
			} else {
				return obj.slice();
			}
		} else if (obj instanceof Object) {
			if (deepClone) {
				return Object.keys(obj).reduce(function(nobj, key) {
					nobj[key] = Util.unFreeze(obj[key], true);
					return nobj;
				}, new obj.constructor());
			} else {
				return Object.assign({}, obj);
			}
		} else {
			return obj;
		}
	},

	// 'cb' can only be called once after "everything" is done.
	// But, we need something that can be used in async context where it is
	// called repeatedly till we are done.
	//
	// Primarily needed in the context of async.map calls that requires a 1-shot callback.
	//
	// Use with caution!  If the async stream that we are accumulating into the buffer
	// is a firehose of tokens, the buffer will become huge.
	buildAsyncOutputBufferCB: function(cb) {
		function AsyncOutputBufferCB(cb2) {
			this.accum = [];
			this.targetCB = cb2;
		}

		AsyncOutputBufferCB.prototype.processAsyncOutput = function(res) {
			// * Ignore switch-to-async mode calls since
			//   we are actually collapsing async calls.
			// * Accumulate async call results in an array
			//   till we get the signal that we are all done
			// * Once we are done, pass everything to the target cb.
			if (res.async !== true) {
				// There are 3 kinds of callbacks:
				// 1. cb({tokens: .. })
				// 2. cb({}) ==> toks can be undefined
				// 3. cb(foo) -- which means in some cases foo can
				//    be one of the two cases above, or it can also be a simple string.
				//
				// Version 1. is the general case.
				// Versions 2. and 3. are optimized scenarios to eliminate
				// additional processing of tokens.
				//
				// In the C++ version, this is handled more cleanly.
				var toks = res.tokens;
				if (!toks && res.constructor === String) {
					toks = res;
				}

				if (toks) {
					if (Array.isArray(toks)) {
						for (var i = 0, l = toks.length; i < l; i++) {
							this.accum.push(toks[i]);
						}
						// this.accum = this.accum.concat(toks);
					} else {
						this.accum.push(toks);
					}
				}

				if (!res.async) {
					// we are done!
					this.targetCB(this.accum);
				}
			}
		};

		var r = new AsyncOutputBufferCB(cb);
		return r.processAsyncOutput.bind(r);
	},

	lookupKV: function(kvs, key) {
		if (!kvs) {
			return null;
		}
		var kv;
		for (var i = 0, l = kvs.length; i < l; i++) {
			kv = kvs[i];
			if (kv.k.constructor === String && kv.k.trim() === key) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	lookup: function(kvs, key) {
		var kv = this.lookupKV(kvs, key);
		return kv === null ? null : kv.v;
	},

	lookupValue: function(kvs, key) {
		if (!kvs) {
			return null;
		}
		var kv;
		for (var i = 0, l = kvs.length; i < l; i++) {
			kv = kvs[i];
			if (kv.v === key) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	/**
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	 */
	kvToHash: function(kvs, convertValuesToString, useSrc) {
		if (!kvs) {
			console.warn("Invalid kvs!: " + JSON.stringify(kvs, null, 2));
			return Object.create(null);
		}
		var res = Object.create(null);
		for (var i = 0, l = kvs.length; i < l; i++) {
			var kv = kvs[i];
			var key = this.tokensToString(kv.k).trim();
			// SSS FIXME: Temporary fix to handle extensions which use
			// entities in attribute values. We need more robust handling
			// of non-string template attribute values in general.
			var val = (useSrc && kv.vsrc !== undefined) ? kv.vsrc :
				convertValuesToString ? this.tokensToString(kv.v) : kv.v;
			res[key.toLowerCase()] = this.tokenTrim(val);
		}
		return res;
	},

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 */
	tokenTrim: function(tokens) {
		if (!Array.isArray(tokens)) {
			return tokens;
		}

		// Since the tokens array might be frozen,
		// we have to create a new array -- but, create it
		// only if needed
		//
		// FIXME: If tokens is not frozen, we can avoid
		// all this circus with leadingToks and trailingToks
		// but we will need a new function altogether -- so,
		// something worth considering if this is a perf. problem.

		var i, token;
		var n = tokens.length;

		// strip leading space
		var leadingToks = [];
		for (i = 0; i < n; i++) {
			token = tokens[i];
			if (token.constructor === pd.NlTk) {
				leadingToks.push('');
			} else if (token.constructor === String) {
				leadingToks.push(token.replace(/^\s+/, ''));
				if (token !== '') {
					break;
				}
			} else {
				break;
			}
		}

		i = leadingToks.length;
		if (i > 0) {
			tokens = leadingToks.concat(tokens.slice(i));
		}

		// strip trailing space
		var trailingToks = [];
		for (i = n - 1; i >= 0; i--) {
			token = tokens[i];
			if (token.constructor === pd.NlTk) {
				trailingToks.push(''); // replace newline with empty
			} else if (token.constructor === String) {
				trailingToks.push(token.replace(/\s+$/, ''));
				if (token !== '') {
					break;
				}
			} else {
				break;
			}
		}

		var j = trailingToks.length;
		if (j > 0) {
			tokens = tokens.slice(0, n - j).concat(trailingToks.reverse());
		}

		return tokens;
	},

	/**
	 * Strip EOFTk token from token chunk.
	 */
	stripEOFTkfromTokens: function(tokens) {
		// this.dp( 'stripping end or whitespace tokens' );
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		if (!tokens.length) {
			return tokens;
		}
		// Strip 'end' token
		if (tokens.length && lastItem(tokens).constructor === pd.EOFTk) {
			var rank = tokens.rank;
			tokens = tokens.slice(0, -1);
			tokens.rank = rank;
		}

		return tokens;
	},

	/**
	 * Strip NlTk and ws-only trailing text tokens. Used to be part of
	 * stripEOFTkfromTokens, but unclear if this is still needed.
	 *
	 * TODO: remove this if this is not needed any more!
	 */
	stripTrailingNewlinesFromTokens: function(tokens) {
		var token = lastItem(tokens);
		var lastMatches = function(toks) {
			var lastTok = lastItem(toks);
			return lastTok && (
				lastTok.constructor === pd.NlTk ||
					lastTok.constructor === String && /^\s+$/.test(token));
		};
		if (lastMatches) {
			tokens = tokens.slice();
		}
		while (lastMatches) {
			tokens.pop();
		}
		return tokens;
	},

	/**
	 * Creates a dom-fragment-token for processing 'content' (an array of tokens)
	 * in its own subpipeline all the way to DOM. These tokens will be processed
	 * by their own handler (DOMFragmentBuilder) in the last stage of the async
	 * pipeline.
	 *
	 * srcOffsets should always be provided to process top-level page content in a
	 * subpipeline. Without it, DSR computation and template wrapping cannot be done
	 * in the subpipeline. While unpackDOMFragment can do this on unwrapping, that can
	 * be a bit fragile and makes dom-fragments a leaky abstraction by leaking subpipeline
	 * processing into the top-level pipeline.
	 *
	 * @param {Token[]} content
	 *   The array of tokens to process.
	 * @param {number[]} srcOffsets
	 *   Wikitext source offsets (start/end) of these tokens.
	 * @param {Object} [opts]
	 *   Parsing options.
	 * @param {Token} opts.contextTok
	 *   The token that generated the content.
	 * @param {boolean} opts.noPre
	 *   Suppress indent-pres in content.
	 */
	getDOMFragmentToken: function(content, srcOffsets, opts) {
		if (!opts) {
			opts = {};
		}

		return new pd.SelfclosingTagTk('mw:dom-fragment-token', [
			new pd.KV('contextTok', opts.token),
			new pd.KV('content', content),
			new pd.KV('noPre',  opts.noPre || false),
			new pd.KV('noPWrapping',  opts.noPWrapping || false),
			new pd.KV('srcOffsets', srcOffsets),
		]);
	},

	// Does this need separate UI/content inputs?
	formatNum: function(num) {
		return num + '';
	},

	/**
	 * Emulate PHP's urlencode by patching results of
	 * JS's `encodeURIComponent`.
	 *
	 * PHP: https://secure.php.net/manual/en/function.urlencode.php
	 *
	 * JS:  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
	 *
	 * Spaces to '+' is a PHP peculiarity as well.
	 */
	phpURLEncode: function(txt) {
		return encodeURIComponent(txt)
			.replace(/!/g, '%21')
			.replace(/'/g, '%27')
			.replace(/\(/g, '%28')
			.replace(/\)/g, '%29')
			.replace(/\*/g, '%2A')
			.replace(/~/g, '%7E')
			.replace(/%20/g, '+');
	},

	/*
	 * Wraps `decodeURI` in a try/catch to suppress throws from malformed URI
	 * sequences.  Distinct from `decodeURIComponent` in that certain
	 * sequences aren't decoded if they result in (un)reserved characters.
	 */
	decodeURI: function(s) {
		return s.replace(/(%[0-9a-fA-F][0-9a-fA-F])+/g, function(m) {
			try {
				return decodeURI(m);
			} catch (e) {
				return m;
			}
		});
	},

	/*
	 * Wraps `decodeURIComponent` in a try/catch to suppress throws from
	 * malformed URI sequences.
	 */
	decodeURIComponent: function(s) {
		return s.replace(/(%[0-9a-fA-F][0-9a-fA-F])+/g, function(m) {
			try {
				return decodeURIComponent(m);
			} catch (e) {
				return m;
			}
		});
	},

	/**
	 * Strip a string suffix if it matches.
	 */
	stripSuffix: function(text, suffix) {
		var sLen = suffix.length;
		if (sLen && text.substr(-sLen) === suffix) {
			return text.substr(0, text.length - sLen);
		} else {
			return text;
		}
	},

	/**
	 * Processes content (wikitext, array of tokens, whatever) in its own pipeline
	 * based on options.
	 *
	 * @param {Object} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object} content
	 *    This could be wikitext or single token or an array of tokens.
	 *    How this content is processed depends on what kind of pipeline
	 *    is constructed specified by opts.
	 *
	 * @param {Object} opts
	 *    Processing options that specify pipeline-type, opts, and callbacks.
	 */
	processContentInPipeline: function(env, frame, content, opts) {
		// Build a pipeline
		var pipeline = env.pipelineFactory.getPipeline(
			opts.pipelineType,
			opts.pipelineOpts
		);

		// Set frame if necessary
		if (opts.tplArgs) {
			pipeline.setFrame(frame, opts.tplArgs.name, opts.tplArgs.attribs);
		} else {
			pipeline.setFrame(frame, null, []);
		}

		// Set source offsets for this pipeline's content
		if (opts.srcOffsets) {
			pipeline.setSourceOffsets(opts.srcOffsets[0], opts.srcOffsets[1]);
		}

		// Set up provided callbacks
		if (opts.chunkCB) {
			pipeline.addListener('chunk', opts.chunkCB);
		}
		if (opts.endCB) {
			pipeline.addListener('end', opts.endCB);
		}
		if (opts.documentCB) {
			pipeline.addListener('document', opts.documentCB);
		}

		// Off the starting block ... ready, set, go!
		pipeline.process(content);
	},

	/**
	 * A promise returning wrapper around processContentInPipeline that
	 * resolves with the docuemnt.
	 * @return {Promise<Document>}
	 */
	promiseToProcessContent: function(env, frame, content, opts, cb) {
		cb = JSUtils.mkPromised(cb);
		Util.processContentInPipeline(env, frame, content, {
			pipelineType: opts.pipelineType,
			pipelineOpts: opts.pipelineOpts,
			srcOffsets: opts ? opts.srcOffsets : undefined,
			// processContentInPipeline has no error callback :(
			documentCB: function(dom) { cb(null, dom); },
		});
		return cb.promise;
	},

	/**
	 * Expands values all the way to DOM and passes them back to a callback.
	 *
	 * FIXME: More of the users of `Util.promiseToProcessContent` and
	 * `Util.processContentInPipeline` could be converted to use this method
	 * if we could find a good way to abstract the different use cases.
	 *
	 * @param {Object} env
	 *    The environment/context for the expansion.
	 *
	 * @param {Object} frame
	 *    The parent frame within which the expansion is taking place.
	 *    This param is mostly defunct now that we are not doing native
	 *    expansion anymore.
	 *
	 * @param {Object[]} vals
	 *    The array of values to process.
	 *    Each value of this array is expected to be an object with a "html" property.
	 *    The html property is expanded to DOM only if it is an array (of tokens).
	 *    Non-arrays are passed back unexpanded.
	 *
	 * @param {boolean} expandTemplates
	 *    Should any templates encountered here be expanded
	 *    (usually false for nested templates since they are never directly editable).
	 *
	 * @param {boolean} inTemplate
	 *    Unexpanded templates can occur in the content of extension tags.
	 *
	 * @param {Function} [finalCB]
	 *    The (optional) callback to pass the expanded values into.
	 *
	 * @return {Promise}
	 *    A promise that will be resolved with the expanded values.
	 */
	expandValuesToDOM: function(env, frame, vals, expandTemplates, inTemplate, finalCB) {
		if (!DU) { DU = require('./DOMUtils.js').DOMUtils; }
		return Promise.all(vals.map(Promise.async(function *(v) {
			if (Array.isArray(v.html)) {
				// Set up pipeline options
				var opts = {
					pipelineType: 'tokens/x-mediawiki/expanded',
					pipelineOpts: {
						attrExpansion: true,
						noPWrapping: true,
						noPre: true,
						expandTemplates: expandTemplates,
						inTemplate: inTemplate,
					},
				};
				var content = v.html.concat([new pd.EOFTk()]);
				try {
					var dom = yield Util.promiseToProcessContent(
						env, frame, content, opts
					);
					// Since we aren't at the top level, data attrs
					// were not applied in cleanup.  However, tmp
					// was stripped.
					v.html = DU.ppToXML(dom.body, { innerXML: true });
				} catch (err) {
					env.log('error', 'Expanding values to DOM', err);
				}
			}
			return v;
		}))).nodify(finalCB);
	},

	extractExtBody: function(token) {
		var src = token.getAttribute('source');
		var tagWidths = token.dataAttribs.tagWidths;
		return src.substring(tagWidths[0], src.length - tagWidths[1]);
	},

	/**
	 * Returns a JS string from the provided code point.
	 */
	codepointToUtf8: function(cp) {
		return String.fromCodePoint(cp);
	},

	/**
	 * Returns the code point at the first position of the string.
	 */
	utf8ToCodepoint: function(str) {
		return str.codePointAt(0);
	},

	/**
	 * Returns true if a given Unicode codepoint is a valid character in XML.
	 */
	validateCodepoint: function(cp) {
		return (cp ===    0x09) ||
			(cp ===   0x0a) ||
			(cp ===   0x0d) ||
			(cp >=    0x20 && cp <=   0xd7ff) ||
			(cp >=  0xe000 && cp <=   0xfffd) ||
			(cp >= 0x10000 && cp <= 0x10ffff);
	},

	isValidDSR: function(dsr, all) {
		const isValidOffset = n => typeof (n) === 'number' && n >= 0;
		return dsr &&
			isValidOffset(dsr[0]) && isValidOffset(dsr[1]) &&
			(!all || (isValidOffset(dsr[2]) && isValidOffset(dsr[3])));
	},

	/**
	 * Quickly hash an array or string.
	 *
	 * @param {Array|string} arr
	 */
	makeHash: function(arr) {
		var md5 = crypto.createHash('MD5');
		var i;
		if (Array.isArray(arr)) {
			for (i = 0; i < arr.length; i++) {
				if (arr[i] instanceof String) {
					md5.update(arr[i]);
				} else {
					md5.update(arr[i].toString());
				}
				md5.update("\0");
			}
		} else {
			md5.update(arr);
		}
		return md5.digest('hex');
	},

	/**
	 * Determine whether the current token was an HTML tag in wikitext.
	 *
	 * @return {boolean}
	 */
	isHTMLTag: function(token) {
		switch (token.constructor) {
			case String:
			case pd.NlTk:
			case pd.CommentTk:
			case pd.EOFTk:
				return false;
			case pd.TagTk:
			case pd.EndTagTk:
			case pd.SelfclosingTagTk:
				return token.dataAttribs.stx === 'html';
			default:
				console.assert(false, 'Unhandled token type');
		}
	},
};

/**
 * This regex was generated by running through *all unicode characters* and
 * testing them against *all regexes* for linktrails in a default MW install.
 * We had to treat it a little bit, here's what we changed:
 *
 * 1. A-Z, though allowed in Walloon, is disallowed.
 * 2. '"', though allowed in Chuvash, is disallowed.
 * 3. '-', though allowed in Icelandic (possibly due to a bug), is disallowed.
 * 4. '1', though allowed in Lak (possibly due to a bug), is disallowed.
 * @property {RegExp}
 */
Util.linkTrailRegex = new RegExp(
	'^[^\0-`{÷ĀĈ-ČĎĐĒĔĖĚĜĝĠ-ĪĬ-įĲĴ-ĹĻ-ĽĿŀŅņŉŊŌŎŏŒŔŖ-ŘŜŝŠŤŦŨŪ-ŬŮŲ-ŴŶŸ' +
	'ſ-ǤǦǨǪ-Ǯǰ-ȗȜ-ȞȠ-ɘɚ-ʑʓ-ʸʽ-̂̄-΅·΋΍΢Ϗ-ЯѐѝѠѢѤѦѨѪѬѮѰѲѴѶѸѺ-ѾҀ-҃҅-ҐҒҔҕҘҚҜ-ҠҤ-ҪҬҭҰҲ' +
	'Ҵ-ҶҸҹҼ-ҿӁ-ӗӚ-ӜӞӠ-ӢӤӦӪ-ӲӴӶ-ՠֈ-׏׫-ؠً-ٳٵ-ٽٿ-څڇ-ڗڙ-ڨڪ-ڬڮڰ-ڽڿ-ۅۈ-ۊۍ-۔ۖ-਀਄਋-਎਑਒' +
	'਩਱਴਷਺਻਽੃-੆੉੊੎-੘੝੟-੯ੴ-჏ჱ-ẼẾ-​\u200d-‒—-‗‚‛”--\ufffd\ufffd]+$');

/**
 * Check whether some text is a valid link trail.
 *
 * @param {string} text
 * @return {boolean}
 */
Util.isLinkTrail = function(text) {
	if (text && text.match && text.match(this.linkTrailRegex)) {
		return true;
	} else {
		return false;
	}
};

/**
 * Cannonicalizes a namespace name.
 *
 * Used by {@link WikiConfig}.
 *
 * @param {string} name Non-normalized namespace name.
 * @return {string}
 */
Util.normalizeNamespaceName = function(name) {
	return name.toLowerCase().replace(' ', '_');
};


/**
 * Decode HTML5 entities in text.
 *
 * @param {string} text
 * @return {string}
 */
Util.decodeEntities = function(text) {
	return entities.decodeHTML5(text);
};


/**
 * Entity-escape anything that would decode to a valid HTML entity.
 *
 * @param {string} text
 * @return {string}
 */
Util.escapeEntities = function(text) {
	// [CSA] replace with entities.encode( text, 2 )?
	// but that would encode *all* ampersands, where we apparently just want
	// to encode ampersands that precede valid entities.
	return text.replace(/&[#0-9a-zA-Z]+;/g, function(match) {
		var decodedChar = Util.decodeEntities(match);
		if (decodedChar !== match) {
			// Escape the and
			return '&amp;' + match.substr(1);
		} else {
			// Not an entity, just return the string
			return match;
		}
	});
};

Util.escapeHtml = function(s) {
	return s.replace(/["'&<>]/g, entities.encodeHTML5);
};

/**
 * Encode all characters as entity references.  This is done to make
 * characters safe for wikitext (regardless of whether they are
 * HTML-safe).
 * @param {string} s
 * @return {string}
 */
Util.entityEncodeAll = function(s) {
	// this is surrogate-aware
	return Array.from(s).map(function(c) {
		c = c.codePointAt(0).toString(16).toUpperCase();
		if (c.length === 1) { c = '0' + c; } // convention
		if (c === 'A0') { return '&nbsp;'; } // special-case common usage
		return '&#x' + c + ';';
	}).join('');
};

/**
 * Determine whether the protocol of a link is potentially valid. Use the
 * environment's per-wiki config to do so.
 */
Util.isProtocolValid = function(linkTarget, env) {
	var wikiConf = env.conf.wiki;
	if (typeof linkTarget === 'string') {
		return wikiConf.hasValidProtocol(linkTarget);
	} else {
		return true;
	}
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
Util.retryingHTTPRequest = function(retries, requestOptions, delay) {
	delay = delay || 100;  // start with 100ms
	return request(requestOptions)
	.catch(function(error) {
		if (retries--) {
			console.error('HTTP ' + requestOptions.method + ' to \n' +
					(requestOptions.uri || requestOptions.url) + ' failed: ' + error +
					'\nRetrying in ' + (delay / 1000) + ' seconds.');
			return Promise.delay(delay).then(function() {
				return Util.retryingHTTPRequest(retries, requestOptions, delay * 2);
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

/**
 * Magic words masquerading as templates.
 * @property {Set}
 */
Util.magicMasqs = new Set(["defaultsort", "displaytitle"]);

Util.getExtArgInfo = function(extToken) {
	var name = extToken.getAttribute('name');
	var options = extToken.getAttribute('options');
	return {
		dict: {
			name: name,
			attrs: Util.kvToHash(options, true),
			body: { extsrc: Util.extractExtBody(extToken) },
		},
	};
};

Util.placeholder = function(content, dataAttribs, endAttribs) {
	if (content === null) {
		return [
			new pd.SelfclosingTagTk('meta', [
				new pd.KV('typeof', 'mw:Placeholder'),
			], dataAttribs),
		];
	} else {
		return [
			new pd.TagTk('span', [
				new pd.KV('typeof', 'mw:Placeholder'),
			], dataAttribs),
			content,
			new pd.EndTagTk('span', [], endAttribs),
		];
	}
};

Util.parseMediaDimensions = function(str, onlyOne) {
	var dimensions = null;
	var match = str.match(/^(\d*)(?:x(\d+))?\s*(?:px\s*)?$/);
	if (match) {
		dimensions = { x: Number(match[1]) };
		if (match[2] !== undefined) {
			if (onlyOne) { return null; }
			dimensions.y = Number(match[2]);
		}
	}
	return dimensions;
};

// More generally, this is defined by the media handler in core
Util.validateMediaParam = function(num) {
	return num > 0;
};

// Extract content in a backwards compatible way
Util.getStar = function(revision) {
	var content = revision;
	if (revision && revision.slots) {
		content = revision.slots.main;
	}
	return content;
};

if (typeof module === "object") {
	module.exports.Util = Util;
}
