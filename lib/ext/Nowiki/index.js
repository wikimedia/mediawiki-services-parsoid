/**
 * Nowiki treats anything inside it as plain text.
 * @module ext/Nowiki
 */

'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.11.0');

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
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		if (!node.hasChildNodes()) {
			state.hasSelfClosingNowikis = true;
			return '<nowiki/>';
		}
		let src = '<nowiki>';
		for (var child = node.firstChild; child; child = child.nextSibling) {
			let out = null;
			if (DOMUtils.isElt(child)) {
				if (DOMUtils.isDiffMarker(child)) {
					/* ignore */
				} else if (child.nodeName === 'SPAN' &&
						child.getAttribute('typeof') === 'mw:Entity' &&
						DOMUtils.hasNChildren(child, 1)
				) {
					const dp = DOMDataUtils.getDataParsoid(child);
					if (dp.src !== undefined && dp.srcContent === child.textContent) {
						// Unedited content
						out = dp.src;
					} else {
						// Edited content
						out = Util.entityEncodeAll(child.firstChild.nodeValue);
					}
				} else {
					/* This is a hacky fallback for what is essentially
					 * undefined behavior. No matter what we emit here,
					 * this won't roundtrip html2html. */
					state.env.log('error/html2wt/nowiki', 'Invalid nowiki content');
					out = child.textContent;
				}
			} else if (DOMUtils.isText(child)) {
				out = child.nodeValue;
			} else {
				console.assert(DOMUtils.isComment(child));
				/* Comments can't be embedded in a <nowiki> */
				state.env.log('error/html2wt/nowiki',
					'Discarded invalid embedded comment in a <nowiki>');
				out = '';
			}

			// Always escape any nowikis found in out
			if (out) {
				src += WTUtils.escapeNowikiTags(out);
			}
		}
		return src + '</nowiki>';
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
