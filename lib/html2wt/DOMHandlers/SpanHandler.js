'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { Util } = require('../../utils/Util.js');
const { WTSUtils } = require('../WTSUtils.js');

const DOMHandler = require('./DOMHandler.js');
const FallbackHTMLHandler = require('./FallbackHTMLHandler.js');

class SpanHandler extends DOMHandler {
	constructor() {
		super(false);
		this.genContentSpanTypes = new Set([
			'mw:Nowiki',
			'mw:Image',
			'mw:Image/Frameless',
			'mw:Image/Frame',
			'mw:Image/Thumb',
			'mw:Video',
			'mw:Video/Frameless',
			'mw:Video/Frame',
			'mw:Video/Thumb',
			'mw:Audio',
			'mw:Audio/Frameless',
			'mw:Audio/Frame',
			'mw:Audio/Thumb',
			'mw:Entity',
			'mw:Placeholder',
		]);
	}
	*handleG(node, state, wrapperUnmodified) {
		var env = state.env;
		var dp = DOMDataUtils.getDataParsoid(node);
		var type = node.getAttribute('typeof') || '';
		var contentSrc = node.textContent || node.innerHTML;
		if (this.isRecognizedSpanWrapper(type)) {
			if (type === 'mw:Nowiki') {
				var nativeExt = env.conf.wiki.extConfig.tags.get('nowiki');
				const src = yield nativeExt.serialHandler.handle(node, state, wrapperUnmodified);
				state.serializer.emitWikitext(src, node);
			} else if (/(?:^|\s)mw:(?:Image|Video|Audio)(\/(Frame|Frameless|Thumb))?/.test(type)) {
				// TODO: Remove when 1.5.0 content is deprecated,
				// since we no longer emit media in spans.  See the test,
				// "Serialize simple image with span wrapper"
				yield state.serializer.figureHandler(node);
			} else if (/(?:^|\s)mw\:Entity/.test(type) && DOMUtils.hasNChildren(node, 1)) {
				// handle a new mw:Entity (not handled by selser) by
				// serializing its children
				if (dp.src !== undefined && contentSrc === dp.srcContent) {
					state.serializer.emitWikitext(dp.src, node);
				} else if (DOMUtils.isText(node.firstChild)) {
					state.emitChunk(
						Util.entityEncodeAll(node.firstChild.nodeValue),
						node.firstChild);
				} else {
					yield state.serializeChildren(node);
				}
			} else if (/(^|\s)mw:Placeholder(\/\w*)?/.test(type)) {
				if (dp.src !== undefined) {
					return this.emitPlaceholderSrc(node, state);
				} else if (
					/(^|\s)mw:Placeholder(\s|$)/.test(type) &&
					DOMUtils.hasNChildren(node, 1) &&
					DOMUtils.isText(node.firstChild) &&
					// See the DisplaySpace hack in the urltext rule
					// in the tokenizer.
					/^\u00a0+$/.test(node.firstChild.nodeValue)
				) {
					state.emitChunk(
						' '.repeat(node.firstChild.nodeValue.length),
						node.firstChild);
				} else {
					yield FallbackHTMLHandler.handler(node, state);
				}
			}
		} else {
			var kvs = WTSUtils.getAttributeKVArray(node).filter(function(kv) {
				return !/^data-parsoid/.test(kv.k) &&
					(kv.k !== DOMDataUtils.DataObjectAttrName()) &&
					!(kv.k === 'id' && /^mw[\w-]{2,}$/.test(kv.v));
			});
			if (!state.rtTestMode && dp.misnested && dp.stx !== 'html' &&
					!kvs.length) {
				// Discard span wrappers added to flag misnested content.
				// Warn since selser should have reused source.
				env.log('warn', 'Serializing misnested content: ' + node.outerHTML);
				yield state.serializeChildren(node);
			} else {
				// Fall back to plain HTML serialization for spans created
				// by the editor.
				yield FallbackHTMLHandler.handler(node, state);
			}
		}
	}

	isRecognizedSpanWrapper(type) {
		return type && type.split(/\s+/).find((t) => {
			return this.genContentSpanTypes.has(t);
		}) !== undefined;
	}
}

module.exports = SpanHandler;
