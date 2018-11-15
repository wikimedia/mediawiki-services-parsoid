'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.9.0');
const { DOMUtils: DU, returnDoc } = ParsoidExtApi;

/**
 * See tests/parser/ParserTestParserHook.php in core.
 */

const dumpHook = function(state, content, args) {
	return returnDoc(state, DU.parseHTML('<pre />'));
};

const staticTagHook = function(state, content, args) {
	// FIXME: Choose a better DOM representation that doesn't mess with
	// newline constraints.
	return returnDoc(state, DU.parseHTML('<span />'));
};

const staticTagPostProcessor = function(node, obj) {
	let child = node.firstChild;
	while (child !== null) {
		const nextChild = child.nextSibling;
		if (DU.isElt(child)) {
			const typeOf = child.getAttribute('typeOf');
			if ((/(?:^|\s)mw:Extension\/statictag(?=$|\s)/).test(typeOf)) {
				const dataMw = DU.getDataMw(child);
				if (dataMw.attrs.action === 'flush') {
					child.appendChild(child.ownerDocument.createTextNode(obj.buf));
					obj.buf = '';
				} else {
					obj.buf += dataMw.body.extsrc;
				}
			} else if (child.hasChildNodes()) {
				staticTagPostProcessor(child, obj);
			}
		}
		child = nextChild;
	}
};

// Tag constructor
module.exports = function() {
	this.config = {
		tags: [
			{ name: 'tag', toDOM: dumpHook },
			{ name: 'tåg', toDOM: dumpHook },
			{ name: 'statictag', toDOM: staticTagHook },
		],
		domProcessors: {
			wt2htmlPostProcessor: (body, env, options, atTopLevel) => {
				if (atTopLevel) {
					const obj = { buf: '' };
					staticTagPostProcessor(body, obj);
				}
			},
		},
	};
};
