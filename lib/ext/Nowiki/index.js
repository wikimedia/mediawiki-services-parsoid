/**
 * Nowiki treats anything inside it as plain text.
 * @module ext/Nowiki
 */

'use strict';

// Use a relative include since it's questionably whether we want to expose
// this through the extensions api, and nowikis are ostensibly core
// functionality.  See T156099
var PegTokenizer = require('../../wt2html/tokenizer.js').PegTokenizer;

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.9.0');
var Promise = ParsoidExtApi.Promise;
var TokenUtils = ParsoidExtApi.TokenUtils;
var Util = ParsoidExtApi.Util;
var DU = ParsoidExtApi.DOMUtils;
const { KV, TagTk, EndTagTk } = ParsoidExtApi.TokenTypes;

var tokenHandler = function(manager, pipelineOpts, extToken, cb) {
	var argDict = Util.getExtArgInfo(extToken).dict;
	var tsr = extToken.dataAttribs.tsr;
	var tagWidths = extToken.dataAttribs.tagWidths;

	var start = new TagTk('span', [ new KV('typeof', 'mw:Nowiki') ], {
		tsr: [tsr[0], tsr[0] + tagWidths[0]],
	});
	var end = new EndTagTk('span', null, {
		tsr: [tsr[1] - tagWidths[1], tsr[1]],
	});

	var txt = argDict.body.extsrc;
	var toks = [txt];

	// TODO: This might be too heavyweight. Maybe just use a split and map.
	if (/&[#0-9a-zA-Z]+;/.test(txt)) {
		toks = (new PegTokenizer(manager.env)).tokenizeSync(txt, "nowiki_content");
		TokenUtils.shiftTokenTSR(toks, tsr[0] + tagWidths[0]);
	}

	cb({ tokens: [start].concat(toks, end) });
};

var serialHandler = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		if (!node.hasChildNodes()) {
			state.hasSelfClosingNowikis = true;
			state.emitChunk('<nowiki/>', node);
			return;
		}
		state.emitChunk('<nowiki>', node);
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (DU.isElt(child)) {
				if (DU.isDiffMarker(child)) {
					/* ignore */
				} else if (child.nodeName === 'SPAN' &&
						child.getAttribute('typeof') === 'mw:Entity') {
					yield state.serializer._serializeNode(child);
				} else {
					state.emitChunk(child.outerHTML, node);
				}
			} else if (DU.isText(child)) {
				state.emitChunk(DU.escapeNowikiTags(child.nodeValue), child);
			} else {
				yield state.serializer._serializeNode(child);
			}
		}
		state.emitChunk('</nowiki>', node);
	}),
};

module.exports = function() {
	this.config = {
		tags: [
			{
				name: 'nowiki',
				tokenHandler: tokenHandler,
				// FIXME: This'll also be called on type mw:Extension/nowiki
				serialHandler: serialHandler,
			},
		],
	};
};
