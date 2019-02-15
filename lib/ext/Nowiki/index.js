/**
 * Nowiki treats anything inside it as plain text.
 * @module ext/Nowiki
 */

'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.10.0');

const { Promise, Util, DOMUtils, WTUtils, DOMDataUtils } = ParsoidExtApi;

const toDOM = Promise.method(function(state, txt, extArgs) {
	const doc = state.env.createDocument();
	const span = doc.createElement('span');
	span.setAttribute('typeof', 'mw:Nowiki');

	txt.split(/(&[#0-9a-zA-Z]+;)/).forEach(function(t, i) {
		if (i % 2 === 1) {
			const cc = Util.decodeWtEntities(t);
			if (cc.length < 3) {
				// This should match the output of the "htmlentity" rule
				// in the tokenizer.
				const entity = doc.createElement('span');
				entity.setAttribute('typeof', 'mw:Entity');
				DOMDataUtils.setDataParsoid(entity, {
					src: t,
					srcContent: cc,
				});
				entity.appendChild(doc.createTextNode(cc));
				span.appendChild(entity);
				return;
			}
			// else, fall down there
		}
		span.appendChild(doc.createTextNode(t));
	});

	span.normalize();
	doc.body.appendChild(span);
	return doc;
});

const serialHandler = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		if (!node.hasChildNodes()) {
			state.hasSelfClosingNowikis = true;
			state.emitChunk('<nowiki/>', node);
			return;
		}
		state.emitChunk('<nowiki>', node);
		for (var child = node.firstChild; child; child = child.nextSibling) {
			if (DOMUtils.isElt(child)) {
				if (DOMUtils.isDiffMarker(child)) {
					/* ignore */
				} else if (child.nodeName === 'SPAN' &&
						child.getAttribute('typeof') === 'mw:Entity') {
					yield state.serializer._serializeNode(child);
				} else {
					state.emitChunk(child.outerHTML, node);
				}
			} else if (DOMUtils.isText(child)) {
				state.emitChunk(WTUtils.escapeNowikiTags(child.nodeValue), child);
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
				toDOM,
				// FIXME: This'll also be called on type mw:Extension/nowiki
				serialHandler,
			},
		],
	};
};
