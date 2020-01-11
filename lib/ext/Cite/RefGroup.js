'use strict';

const ParsoidExtApi = module.parent.parent.parent.parent.require('./extapi.js').versionCheck('^0.11.0');
const { DOMDataUtils, DOMUtils } = ParsoidExtApi;

/**
 * Helper class used by `<references>` implementation.
 * @class
 */
class RefGroup {
	constructor(group) {
		this.name = group || '';
		this.refs = [];
		this.indexByName = new Map();
	}

	renderLine(env, refsList, ref) {
		var ownerDoc = refsList.ownerDocument;

		// Generate the li and set ref content first, so the HTML gets parsed.
		// We then append the rest of the ref nodes before the first node
		var li = ownerDoc.createElement('li');
		DOMDataUtils.addAttributes(li, {
			'about': "#" + ref.target,
			'id': ref.target,
			'class': ['rtl', 'ltr'].includes(ref.dir) ? 'mw-cite-dir-' + ref.dir : undefined,
		});
		var reftextSpan = ownerDoc.createElement('span');
		DOMDataUtils.addAttributes(reftextSpan, {
			'id': "mw-reference-text-" + ref.target,
			'class': "mw-reference-text",
		});
		if (ref.content) {
			var content = env.fragmentMap.get(ref.content)[0];
			DOMUtils.migrateChildrenBetweenDocs(content, reftextSpan);
			DOMDataUtils.visitAndLoadDataAttribs(reftextSpan);
		}
		li.appendChild(reftextSpan);

		// Generate leading linkbacks
		var createLinkback = function(href, group, text) {
			var a = ownerDoc.createElement('a');
			var s = ownerDoc.createElement('span');
			var textNode = ownerDoc.createTextNode(text + " ");
			a.setAttribute('href', env.page.titleURI + '#' + href);
			s.setAttribute('class', 'mw-linkback-text');
			if (group) {
				a.setAttribute('data-mw-group', group);
			}
			s.appendChild(textNode);
			a.appendChild(s);
			return a;
		};
		if (ref.linkbacks.length === 1) {
			var linkback = createLinkback(ref.id, ref.group, '↑');
			linkback.setAttribute('rel', 'mw:referencedBy');
			li.insertBefore(linkback, reftextSpan);
		} else {
			// 'mw:referencedBy' span wrapper
			var span = ownerDoc.createElement('span');
			span.setAttribute('rel', 'mw:referencedBy');
			li.insertBefore(span, reftextSpan);

			ref.linkbacks.forEach(function(lb, i) {
				span.appendChild(createLinkback(lb, ref.group, i + 1));
			});
		}

		// Space before content node
		li.insertBefore(ownerDoc.createTextNode(' '), reftextSpan);

		// Add it to the ref list
		refsList.appendChild(li);
	}
}

module.exports = RefGroup;
