/** @module ext/Poem */

'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.10.0');
const DOMUtils = ParsoidExtApi.DOMUtils;

const dummyDoc = DOMUtils.parseHTML('');
const toDOM = function(state, content, args) {
	if (content && content.length > 0) {
		content = content
			// Strip leading/trailing newline
			.replace(/^\n/, '')
			.replace(/\n$/, '')
			// Suppress indent-pre by replacing leading space with &nbsp;
			.replace(/^ /mg, '&nbsp;');
		// Add <br/> for newlines except (a) in nowikis (b) after ----
		// nowiki newlines will be processed on the DOM.
		content = content.split(/(<nowiki>[\s\S]*?<\/nowiki>)/).map(function(p, i) {
			if (i % 2 === 1) {
				return p;
			}

			// This is a hack that exploits the fact that </poem>
			// cannot show up in the extension's content.
			// When we switch to node v8, we can use a negative lookbehind if we want.
			// https://v8project.blogspot.com/2016/02/regexp-lookbehind-assertions.html
			return p.replace(/(^----+)\n/mg, '$1</poem>')
				.replace(/\n/mg, '<br/>\n')
				.replace(/^(-+)<\/poem>/mg, '$1\n');
		}).join('');
		// Replace colons with indented spans
		content = content.replace(/^(:+)(.+)$/g, function(match, colons, verse) {
			const span = dummyDoc.createElement('span');
			span.setAttribute('class', 'mw-poem-indented');
			span.setAttribute('style', 'display: inline-block; margin-left: ' + colons.length + 'em;');
			span.appendChild(dummyDoc.createTextNode(verse));
			return span.outerHTML;
		});
	}

	return ParsoidExtApi.parseTokenContentsToDOM(state, args, '', content, {
		wrapperTag: 'div',
		extTag: 'poem'
	});
};

function processNowikis(node) {
	const doc = node.ownerDocument;
	let c = node.firstChild;
	while (c) {
		if (!DOMUtils.isElt(c)) {
			c = c.nextSibling;
			continue;
		}

		if (!/\bmw:Nowiki\b/.test(c.getAttribute('typeof'))) {
			processNowikis(c);
			c = c.nextSibling;
			continue;
		}

		// Replace nowiki's text node with a combination
		// of content and <br/>s. Take care to deal with
		// entities that are still entity-wrapped (!!).
		let cc = c.firstChild;
		while (cc) {
			const next = cc.nextSibling;
			if (DOMUtils.isText(cc)) {
				const pieces = cc.nodeValue.split(/\n/);
				const n = pieces.length;
				let nl = '';
				for (let i = 0; i < n; i++) {
					const p = pieces[i];
					c.insertBefore(doc.createTextNode(nl + p), cc);
					if (i < n - 1) {
						c.insertBefore(doc.createElement('br'), cc);
						nl = '\n';
					}
				}
				c.removeChild(cc);
			}
			cc = next;
		}
		c = c.nextSibling;
	}
}

// FIXME: We could expand the parseTokenContentsToDOM helper to let us
// pass in a handler that post-processes the DOM immediately,
// instead of in the end.
const _domPostProcessor = function(node, env, options, atTopLevel) {
	if (!atTopLevel) {
		return;
	}

	let c = node.firstChild;
	while (c) {
		if (DOMUtils.isElt(c)) {
			if (/\bmw:Extension\/poem\b/.test(c.getAttribute('typeof'))) {
				// In nowikis, replace newlines with <br/>.
				// Cannot do it before parsing because <br/> will get escaped!
				processNowikis(c);
			} else {
				_domPostProcessor(c, env, options, atTopLevel);
			}
		}
		c = c.nextSibling;
	}
};

/*
const serialHandler = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		// Initially, we will let the default extension
		// html2wt handler take care of this.
		//
		// If VE starts supporting editing of poem content
		// natively, we can add a custom html2wt handler.
	}),
};
*/

module.exports = function() {
	this.config = {
		name: 'poem',
		domProcessors: {
			wt2htmlPostProcessor: _domPostProcessor,
		},
		tags: [
			{
				name: 'poem',
				toDOM: toDOM,
			},
		],
	};
};
