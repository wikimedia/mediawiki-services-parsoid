'use strict';

const ParsoidExtApi = module.parent.parent.require('./extapi.js').versionCheck('^0.11.0');
const { ContentUtils, DOMDataUtils, WTUtils, Promise } = ParsoidExtApi;

/**
 * Simple token transform version of the Ref extension tag.
 *
 * @class
 */
class Ref {
	static toDOM(state, content, args) {
		// Drop nested refs entirely, unless we've explicitly allowed them
		if (state.parseContext.extTag === 'ref' &&
			!(state.parseContext.extTagOpts && state.parseContext.extTagOpts.allowNestedRef)
		) {
			return null;
		}

		// The one supported case for nested refs is from the {{#tag:ref}} parser
		// function.  However, we're overly permissive here since we can't
		// distinguish when that's nested in another template.
		// The php preprocessor did our expansion.
		const allowNestedRef = state.parseContext.inTemplate && state.parseContext.extTag !== 'ref';

		return ParsoidExtApi.parseTokenContentsToDOM(state, args, '', content, {
			// NOTE: sup's content model requires it only contain phrasing
			// content, not flow content. However, since we are building an
			// in-memory DOM which is simply a tree data structure, we can
			// nest flow content in a <sup> tag.
			wrapperTag: 'sup',
			pipelineOpts: {
				extTag: 'ref',
				extTagOpts: {
					allowNestedRef: !!allowNestedRef,
				},
				inTemplate: state.parseContext.inTemplate,
				// FIXME: One-off PHP parser state leak.
				// This needs a better solution.
				inPHPBlock: true,
			},
		});
	}

	static lintHandler(ref, env, tplInfo, domLinter) {
		// Don't lint the content of ref in ref, since it can lead to cycles
		// using named refs
		if (WTUtils.fromExtensionContent(ref, 'references')) { return ref.nextSibling; }

		var linkBackId = ref.firstChild.getAttribute('href').replace(/[^#]*#/, '');
		var refNode = ref.ownerDocument.getElementById(linkBackId);
		if (refNode) {
			// Ex: Buggy input wikitext without ref content
			domLinter(refNode.lastChild, env, tplInfo.isTemplated ? tplInfo : null);
		}
		return ref.nextSibling;
	}
}

Ref.serialHandler = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		var startTagSrc = yield state.serializer.serializeExtensionStartTag(node, state);
		var dataMw = DOMDataUtils.getDataMw(node);
		var env = state.env;
		var html;
		if (!dataMw.body) {
			return startTagSrc;  // We self-closed this already.
		} else if (typeof dataMw.body.html === 'string') {
			// First look for the extension's content in data-mw.body.html
			html = dataMw.body.html;
		} else if (typeof dataMw.body.id === 'string') {
			// If the body isn't contained in data-mw.body.html, look if
			// there's an element pointed to by body.id.
			var bodyElt = node.ownerDocument.getElementById(dataMw.body.id);
			if (!bodyElt && env.page.editedDoc) {
				// Try to get to it from the main page.
				// This can happen when the <ref> is inside another
				// extension, most commonly inside a <references>.
				// The recursive call to serializeDOM puts us inside
				// inside a new document.
				bodyElt = env.page.editedDoc.getElementById(dataMw.body.id);
			}
			if (bodyElt) {
				// n.b. this is going to drop any diff markers but since
				// the dom differ doesn't traverse into extension content
				// none should exist anyways.
				DOMDataUtils.visitAndStoreDataAttribs(bodyElt);
				html = ContentUtils.toXML(bodyElt, { innerXML: true });
				DOMDataUtils.visitAndLoadDataAttribs(bodyElt);
			} else {
				// Some extra debugging for VisualEditor
				var extraDebug = '';
				var firstA = node.querySelector('a[href]');
				if (firstA && /^#/.test(firstA.getAttribute('href') || '')) {
					var href = firstA.getAttribute('href') || '';
					try {
						var ref = node.ownerDocument.querySelector(href);
						if (ref) {
							extraDebug += ' [own doc: ' + ref.outerHTML + ']';
						}
						ref = env.page.editedDoc.querySelector(href);
						if (ref) {
							extraDebug += ' [main doc: ' + ref.outerHTML + ']';
						}
					} catch (e) { }  // eslint-disable-line
					if (!extraDebug) {
						extraDebug = ' [reference ' + href + ' not found]';
					}
				}
				env.log('error/' + dataMw.name,
						'extension src id ' + dataMw.body.id +
						' points to non-existent element for:', node.outerHTML,
						'. More debug info: ', extraDebug);
				return '';  // Drop it!
			}
		} else {
			env.log('error', 'Ref body unavailable for: ' + node.outerHTML);
			return '';  // Drop it!
		}
		var src = yield state.serializer.serializeHTML({
			env: state.env,
			extName: dataMw.name,
			// FIXME: One-off PHP parser state leak.
			// This needs a better solution.
			inPHPBlock: true,
		}, html);
		return startTagSrc + src + '</' + dataMw.name + '>';
	}),
};

module.exports = Ref;
