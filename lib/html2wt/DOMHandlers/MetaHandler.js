'use strict';

const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { Util } = require('../../utils/Util.js');
const { WTUtils } = require('../../utils/WTUtils.js');

const DOMHandler = require('./DOMHandler.js');
const FallbackHTMLHandler = require('./FallbackHTMLHandler.js');

class MetaHandler extends DOMHandler {
	constructor() {
		super(false);
	}
	*handleG(node, state, wrapperUnmodified) {
		var type = node.getAttribute('typeof') || '';
		var property = node.getAttribute('property') || '';
		var dp = DOMDataUtils.getDataParsoid(node);
		var dmw = DOMDataUtils.getDataMw(node);

		if (dp.src !== undefined &&
				/(^|\s)mw:Placeholder(\/\w*)?$/.test(type)) {
			return this.emitPlaceholderSrc(node, state);
		}

		// Check for property before type so that page properties with
		// templated attrs roundtrip properly.
		// Ex: {{DEFAULTSORT:{{echo|foo}} }}
		if (property) {
			var switchType = property.match(/^mw\:PageProp\/(.*)$/);
			if (switchType) {
				var out = switchType[1];
				var cat = out.match(/^(?:category)?(.*)/);
				if (cat && Util.magicMasqs.has(cat[1])) {
					var contentInfo =
						yield state.serializer.serializedAttrVal(
							node, 'content', {}
						);
					if (WTUtils.hasExpandedAttrsType(node)) {
						out = '{{' + contentInfo.value + '}}';
					} else if (dp.src !== undefined) {
						var colon = dp.src.indexOf(':', 2);
						out = dp.src.replace(/^([^:}]+).*$/, "$1");
						if (colon === -1 && !contentInfo.value) {
							out += '}}';
						} else {
							out += `:${contentInfo.value}}}`;
						}
					} else {
						var magicWord = cat[1].toUpperCase();
						state.env.log("warn", cat[1] +
							' is missing source. Rendering as ' +
							magicWord + ' magicword');
						out = "{{" + magicWord + ":" +
							contentInfo.value + "}}";
					}
				} else {
					out = state.env.conf.wiki.getMagicWordWT(
						switchType[1], dp.magicSrc) || '';
				}
				state.emitChunk(out, node);
			} else {
				yield FallbackHTMLHandler.handler(node, state);
			}
		} else if (type) {
			switch (type) {
				case 'mw:Includes/IncludeOnly':
					// Remove the dp.src when older revisions of HTML expire in RESTBase
					state.emitChunk(dmw.src || dp.src || '', node);
					break;
				case 'mw:Includes/IncludeOnly/End':
					// Just ignore.
					break;
				case 'mw:Includes/NoInclude':
					state.emitChunk(dp.src || '<noinclude>', node);
					break;
				case 'mw:Includes/NoInclude/End':
					state.emitChunk(dp.src || '</noinclude>', node);
					break;
				case 'mw:Includes/OnlyInclude':
					state.emitChunk(dp.src || '<onlyinclude>', node);
					break;
				case 'mw:Includes/OnlyInclude/End':
					state.emitChunk(dp.src || '</onlyinclude>', node);
					break;
				case 'mw:DiffMarker/inserted':
				case 'mw:DiffMarker/deleted':
				case 'mw:DiffMarker/moved':
				case 'mw:Separator':
					// just ignore it
					break;
				default:
					yield FallbackHTMLHandler.handler(node, state);
			}
		} else {
			yield FallbackHTMLHandler.handler(node, state);
		}
	}
	before(node, otherNode) {
		var type =
			node.hasAttribute('typeof') ? node.getAttribute('typeof') :
			node.hasAttribute('property') ? node.getAttribute('property') :
			null;
		if (type && type.match(/mw:PageProp\/categorydefaultsort/)) {
			if (otherNode.nodeName === 'P' && DOMDataUtils.getDataParsoid(otherNode).stx !== 'html') {
				// Since defaultsort is outside the p-tag, we need 2 newlines
				// to ensure that it go back into the p-tag when parsed.
				return { min: 2 };
			} else {
				return { min: 1 };
			}
		} else if (WTUtils.isNewElt(node) &&
			// Placeholder metas don't need to be serialized on their own line
			(node.nodeName !== "META" ||
			!/(^|\s)mw:Placeholder(\/|$)/.test(node.getAttribute("typeof") || ''))) {
			return { min: 1 };
		} else {
			return {};
		}
	}
	after(node, otherNode) {
		// No diffs
		if (WTUtils.isNewElt(node) &&
			// Placeholder metas don't need to be serialized on their own line
			(node.nodeName !== "META" ||
			!/(^|\s)mw:Placeholder(\/|$)/.test(node.getAttribute("typeof") || ''))) {
			return { min: 1 };
		} else {
			return {};
		}
	}
}

module.exports = MetaHandler;
