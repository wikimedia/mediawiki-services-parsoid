/** @module */

"use strict";

var Consts = require('../../config/WikitextConstants.js').WikitextConstants;
var DU = require('../../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../../utils/jsutils.js').JSUtils;
var Promise = require('../../utils/promise.js');
var TokenHandler = require('./TokenHandler.js');
var Util = require('../../utils/Util.js').Util;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var EOFTk = defines.EOFTk;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;


/**
 * Handler for language conversion markup, which looks like `-{ ... }-`.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class LanguageVariantHandler extends TokenHandler {
	/**
	 * @param {Object} manager
	 * @param {Object} options
	 */
	constructor(manager, options) {
		super(manager, options);
		this.manager.addTransformP(this, this.onLanguageVariant, "LanguageVariantHandler:onLanguageVariant", this.rank, 'tag', 'language-variant');
	}
}

// Indicates where in the pipeline this handler should be run.
LanguageVariantHandler.prototype.rank = 1.16;

/**
 * Main handler.
 * See {@link TokenTransformManager#addTransform}'s transformation parameter
 */
LanguageVariantHandler.prototype.onLanguageVariant = Promise.async(function *(token, frame) {
	var manager = this.manager;
	var options = this.options;
	var attribs = token.attribs;
	var dataAttribs = token.dataAttribs;
	var tsr = dataAttribs.tsr;
	var flags = dataAttribs.flags || [];
	var flagSp = dataAttribs.flagSp;
	var isMeta = false;
	var sawFlagA = false;

	// convert one variant text to dom.
	var convertOne = Promise.async(function *(t) {
		// we're going to fetch the actual token list from attribs
		// (this ensures that it has gone through the earlier stages
		// of the pipeline already to be expanded)
		t = +(t.replace(/^mw:lv/, ''));
		var doc = yield Util.promiseToProcessContent(
			manager.env, manager.frame, attribs[t].v.concat([new EOFTk()]),
			{
				pipelineType: 'tokens/x-mediawiki/expanded',
				pipelineOpts: {
					inlineContext: true,
					expandTemplates: options.expandTemplates,
					inTemplate: options.inTemplate,
				},
				srcOffsets: attribs[t].srcOffsets,
			}
		);
		return {
			xmlstr: DU.ppToXML(doc.body, { innerXML: true }),
			isBlock: DU.hasBlockElementDescendant(doc.body)
		};
	});
	// compress a whitespace sequence
	var compressSpArray = function(a) {
		var result = [];
		var ctr = 0;
		if (a === undefined) {
			return a;
		}
		a.forEach(function(sp) {
			if (sp === '') {
				ctr++;
			} else {
				if (ctr > 0) {
					result.push(ctr);
					ctr = 0;
				}
				result.push(sp);
			}
		});
		if (ctr > 0) { result.push(ctr); }
		return result;
	};
	// remove trailing semicolon marker, if present
	var trailingSemi = false;
	if (
		dataAttribs.texts.length &&
		dataAttribs.texts[dataAttribs.texts.length - 1].semi
	) {
		trailingSemi = dataAttribs.texts.pop().sp;
	}
	// convert all variant texts to DOM
	var isBlock = false;
	var texts = yield Promise.map(dataAttribs.texts, Promise.async(function *(t) {
		var text, from, to;
		if (t.twoway) {
			text = yield convertOne(t.text);
			isBlock = isBlock || text.isBlock;
			return { lang: t.lang, text: text.xmlstr, twoway: true, sp: t.sp };
		} else if (t.lang) {
			from = yield convertOne(t.from);
			to = yield convertOne(t.to);
			isBlock = isBlock || from.isBlock || to.isBlock;
			return { lang: t.lang, from: from.xmlstr, to: to.xmlstr, sp: t.sp };
		} else {
			text = yield convertOne(t.text);
			isBlock = isBlock || text.isBlock;
			return { text: text.xmlstr, sp: [] };
		}
	}));
	// collect two-way/one-way conversion rules
	var oneway = [];
	var twoway = [];
	var sawTwoway = false;
	var sawOneway = false;
	var textSp;
	var twowaySp = [];
	var onewaySp = [];
	texts.forEach(function(t) {
		if (t.twoway) {
			twoway.push({ l: t.lang, t: t.text });
			twowaySp.push(t.sp[0], t.sp[1], t.sp[2]);
			sawTwoway = true;
		} else if (t.lang) {
			oneway.push({ l: t.lang, f: t.from, t: t.to });
			onewaySp.push(t.sp[0], t.sp[1], t.sp[2], t.sp[3]);
			sawOneway = true;
		}
	});

	// To avoid too much data-mw bloat, only the top level keys in
	// data-mw-variant as "human readable".  Nested keys are single-letter:
	// `l` for `language`, `t` for `text` or `to`, `f` for `from`.
	var dataMWV;
	if (flags.length === 0 && dataAttribs.variants.length > 0) {
		// "Restrict possible variants to a limited set"
		dataMWV = {
			filter: { l: dataAttribs.variants, t: texts[0].text },
			show: true
		};
	} else {
		dataMWV = flags.reduce(function(dmwv, f) {
			if (Consts.LCFlagMap.has(f)) {
				if (Consts.LCFlagMap.get(f)) {
					dmwv[Consts.LCFlagMap.get(f)] = true;
					if (f === 'A') {
						sawFlagA = true;
					}
				}
			} else {
				dmwv.error = true;
			}
			return dmwv;
		}, {});
		// (this test is done at the top of ConverterRule::getRuleConvertedStr)
		// (also partially in ConverterRule::parse)
		if (texts.length === 1 && !texts[0].lang  && !dataMWV.name) {
			if (dataMWV.add || dataMWV.remove) {
				var variants = [ '*' ];
				twoway = variants.map(function(code) {
					return { l: code, t: texts[0].text };
				});
				sawTwoway = true;
			} else {
				dataMWV.disabled = true;
				dataMWV.describe = undefined;
			}
		}
		if (dataMWV.describe) {
			if (!sawFlagA) { dataMWV.show = true; }
		}
		if (dataMWV.disabled || dataMWV.name) {
			if (dataMWV.disabled) {
				dataMWV.disabled = { t: texts[0].text };
			} else {
				dataMWV.name = { t: texts[0].text };
			}
			dataMWV.show =
				(dataMWV.title || dataMWV.add) ? undefined : true;
		} else if (sawTwoway) {
			dataMWV.twoway = twoway;
			textSp = twowaySp;
			if (sawOneway) { dataMWV.error = true; }
		} else {
			dataMWV.oneway = oneway;
			textSp = onewaySp;
			if (!sawOneway) { dataMWV.error = true; }
		}
	}
	// Use meta/not meta instead of explicit 'show' flag.
	isMeta = !dataMWV.show;
	dataMWV.show = undefined;
	// Trim some data from data-parsoid if it matches the defaults
	if (flagSp.length === 2 * dataAttribs.original.length) {
		if (flagSp.every(function(s) { return s === ''; })) {
			flagSp = undefined;
		}
	}
	if (trailingSemi !== false && textSp) {
		textSp.push(trailingSemi);
	}

	// Our markup is always the same, except for the contents of
	// the data-mw-variant attribute and whether it's a span, div, or a
	// meta, depending on (respectively) whether conversion output
	// contains only inline content, could contain block content,
	// or never contains any content.
	var tokens = [
		new TagTk(isMeta ? 'meta' : isBlock ? 'div' : 'span', [
			new KV('typeof', 'mw:LanguageVariant'),
			new KV(
				'data-mw-variant',
				JSON.stringify(JSUtils.sortObject(dataMWV))
			),
		], {
			fl: dataAttribs.original, // original "fl"ags
			flSp: compressSpArray(flagSp), // spaces around flags
			src: dataAttribs.src,
			tSp: compressSpArray(textSp), // spaces around texts
			tsr: [ tsr[0], isMeta ? tsr[1] : (tsr[1] - 2) ],
		}),
	];
	if (!isMeta) {
		tokens.push(new EndTagTk(isBlock ? 'div' : 'span', [], {
			tsr: [ tsr[1] - 2, tsr[1] ],
		}));
	}

	return { tokens: tokens };
});

if (typeof module === "object") {
	module.exports.LanguageVariantHandler = LanguageVariantHandler;
}
