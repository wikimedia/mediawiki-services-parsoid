"use strict";

var Consts = require('../../config/WikitextConstants.js').WikitextConstants;
var DU = require('../../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../../utils/jsutils.js').JSUtils;
var Promise = require('../../utils/promise.js');
var Util = require('../../utils/Util.js').Util;
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var EOFTk = defines.EOFTk;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;


/**
 * @class
 *
 * Handler for language conversion markup, which looks like `-{ ... }-`.
 *
 * @constructor
 * @param {Object} manager
 * @param {Object} options
 */
function LanguageVariantHandler(manager, options) {
	this.manager = manager;
	this.manager.addTransform(this.onLanguageVariant.bind(this), "LanguageVariantHandler:onLanguageVariant", this.rank, 'tag', 'language-variant');
}

// Indicates where in the pipeline this handler should be run.
LanguageVariantHandler.prototype.rank = 1.16;

/**
 * Main handler.
 * See {@link TokenTransformManager#addTransform}'s transformation parameter
 */
LanguageVariantHandler.prototype.onLanguageVariant = function(token, frame, cb) {
	var manager = this.manager;
	var attribs = token.attribs;
	var dataAttribs = token.dataAttribs;
	var tsr = dataAttribs.tsr;
	var flags = dataAttribs.flags || [];
	var isMeta = false;
	var sawFlagA = false;

	cb({ async: true });

	// convert one variant text to dom.
	var convertOne = function(t) {
		// we're going to fetch the actual token list from attribs
		// (this ensures that it has gone through the earlier stages
		// of the pipeline already to be expanded)
		t = +(t.replace(/^mw:lv/, ''));
		return Util.promiseToProcessContent(
			manager.env, manager.frame, attribs[t].v.concat([new EOFTk()]),
			{
				pipelineType: 'tokens/x-mediawiki/expanded',
				pipelineOpts: {
					noPWrapping: true,
					noPre: true,
					token: token,
				},
				srcOffsets: attribs[t].srcOffsets,
			}
		).then(function(doc) {
			return {
				xmlstr: DU.ppToXML(doc.body, { innerXML: true }),
				isBlock: DU.hasBlockElementDescendant(doc.body)
			};
		});
	};
	// remove trailing semicolon marker, if present
	var trailingSemi = false;
	if (
		dataAttribs.texts.length &&
		dataAttribs.texts[dataAttribs.texts.length - 1].semi
	) {
		trailingSemi = true;
		dataAttribs.texts.pop();
	}
	// convert all variant texts to DOM
	var isBlock = false;
	return Promise.map(dataAttribs.texts, function(t) {
		if (t.bidir) {
			return convertOne(t.text).then(function(text) {
				isBlock = isBlock || text.isBlock;
				return { lang: t.lang, text: text.xmlstr, bidir: true };
			});
		} else if (t.lang) {
			return Promise.all([convertOne(t.from), convertOne(t.to)]).
				spread(function(from, to) {
					isBlock = isBlock || from.isBlock || to.isBlock;
					return { lang: t.lang, from: from.xmlstr, to: to.xmlstr };
				});
		} else {
			return convertOne(t.text).then(function(text) {
				isBlock = isBlock || text.isBlock;
				return { text: text.xmlstr };
			});
		}
	}).then(function(texts) {
		// collect bidirectional/unidirectional translations
		var unidir = [];
		var bidir = [];
		var sawBidir = false;
		var sawUnidir = false;
		texts.forEach(function(t) {
			if (t.bidir) {
				bidir.push({ l: t.lang, t: t.text });
				sawBidir = true;
			} else if (t.lang) {
				unidir.push({ l: t.lang, f: t.from, t: t.to });
				sawUnidir = true;
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
					bidir = variants.map(function(code) {
						return { l: code, t: texts[0].text };
					});
					sawBidir = true;
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
			} else if (sawBidir) {
				dataMWV.bidir = bidir;
				if (sawUnidir) { dataMWV.error = true; }
			} else {
				dataMWV.unidir = unidir;
				if (!sawUnidir) { dataMWV.error = true; }
			}
		}
		// Use meta/not meta instead of explicit 'show' flag.
		isMeta = !dataMWV.show;
		dataMWV.show = undefined;

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
				src: dataAttribs.src,
				tsr: [ tsr[0], isMeta ? tsr[1] : (tsr[1] - 2) ],
				ts: trailingSemi ? true : undefined,
				fl: dataAttribs.original, // original "fl"ags
			}),
		];
		if (!isMeta) {
			tokens.push(new EndTagTk(isBlock ? 'div' : 'span', [], {
				tsr: [ tsr[1] - 2, tsr[1] ],
			}));
		}

		return cb({ tokens: tokens });
	}).done();
};

if (typeof module === "object") {
	module.exports.LanguageVariantHandler = LanguageVariantHandler;
}
