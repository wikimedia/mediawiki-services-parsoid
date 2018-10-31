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
var TokenUtils = require('./TokenUtils.js').TokenUtils;
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
	 * Regep for checking marker metas typeofs representing
	 * transclusion markup or template param markup.
	 * @property {RegExp}
	 */
	TPL_META_TYPE_REGEXP: /(?:^|\s)(mw:(?:Transclusion|Param)(?:\/End)?)(?=$|\s)/,

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
	 * Determine if the named tag is void (can not have content).
	 */
	isVoidElement: function(name) {
		return Consts.HTML.VoidTags.has(name.toUpperCase());
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
	 * @param {boolean} opts.inlineContext
	 *   Is this DOM fragment used in an inline context?
	 * @param {boolean} opts.inPHPBlock
	 *   Is this DOM fragment used inside a "PHP Block"
	 *   FIXME: This primarily exists for backward compatibility
	 *   reasons and is likely to eventually go away.
	 */
	getDOMFragmentToken: function(content, srcOffsets, opts) {
		if (!opts) {
			opts = {};
		}

		return new pd.SelfclosingTagTk('mw:dom-fragment-token', [
			new pd.KV('contextTok', opts.token),
			new pd.KV('content', content),
			new pd.KV('inlineContext',  opts.inlineContext || false),
			new pd.KV('inPHPBLock',  opts.inPHPBLock || false),
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
						inlineContext: true,
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
			attrs: TokenUtils.kvToHash(options, true),
			body: { extsrc: Util.extractExtBody(extToken) },
		},
	};
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
