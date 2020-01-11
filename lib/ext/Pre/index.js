/**
 * The `<pre>` extension tag shadows the html pre tag, but has different
 * semantics.  It treats anything inside it as plaintext.
 * @module ext/Pre
 */

'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.11.0');

const { Util, DOMDataUtils, Sanitizer, Promise } = ParsoidExtApi;

const toDOM = Promise.method(function(state, txt, extArgs) {
	const doc = state.env.createDocument();
	const pre = doc.createElement('pre');

	Sanitizer.applySanitizedArgs(state.env, pre, extArgs);
	DOMDataUtils.getDataParsoid(pre).stx = 'html';

	// Support nowikis in pre.  Do this before stripping newlines, see test,
	// "<pre> with <nowiki> inside (compatibility with 1.6 and earlier)"
	txt = txt.replace(/<nowiki\s*>([^]*?)<\/nowiki\s*>/g, '$1');

	// Strip leading newline to match php parser.  This is probably because
	// it doesn't do xml serialization accounting for `newlineStrippingElements`
	// Of course, this leads to indistinguishability between n=0 and n=1
	// newlines, but that only seems to affect parserTests output.  Rendering
	// is the same, and the newline is preserved for rt in the `extSrc`.
	txt = txt.replace(/^\n/, '');

	// `extSrc` will take care of rt'ing these
	txt = Util.decodeWtEntities(txt);

	pre.appendChild(doc.createTextNode(txt));
	doc.body.appendChild(pre);

	return doc;
});

module.exports = function() {
	this.config = {
		tags: [
			{
				name: 'pre',
				toDOM: toDOM,
			},
		],
	};
};
