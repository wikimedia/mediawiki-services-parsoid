/**
 * This is a wrapper around functionality similar to PHP's `ReplacementArray`,
 * but built on (reversible) Finite-State Transducers.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const FST = require('./FST.js');
const DU = require('../utils/DOMUtils.js').DOMUtils;

class ReplacementMachine {
	/**
	 * Create a new ReplacementArray, which holds a given source->destination
	 * transformation.
	 */
	constructor(baseLanguage, ...codes) {
		this.baseLanguage = baseLanguage;
		this.codes = codes.slice(0);
		this.machine = new Map(codes.map(c => [c, {
			convert: ReplacementMachine.loadFST(`trans-${c}`),
			bracket: new Map(codes.map(cc => [
				cc,
				ReplacementMachine.loadFST(
					`brack-${c}-${c === cc ? 'noop' : cc}`,
					'bracket'
				)
			])),
		}]));
	}

	/**
	 * @private
	 */
	static loadFST(filename, bracket) {
		return FST.compile(`${__dirname}/fst/${filename}.pfst`, bracket);
	}

	/**
	 * Quantify a guess about the "native" language of string `s`.
	 * We will be converting *to* `destCode`, and our guess is that
	 * when we round trip we'll want to convert back to `invertCode`
	 * (so `invertCode` is our guess about the actual language of `s`).
	 * If we were to make this encoding, the returned value `unsafe` is
	 * the number of codepoints we'd have to specially-escape, `safe` is
	 * the number of codepoints we wouldn't have to escape, and `len` is
	 * the total number of codepoints in `s`.  Generally lower values of
	 * `nonsafe` indicate a better guess for `invertCode`.
	 * @return {Object} Statistics about the given guess.
	 * @return {number} return.safe
	 * @return {number} return.unsafe
	 * @return {number} return.length (Should be `safe+unsafe`.)
	 * @private
	 */
	countBrackets(s, destCode, invertCode) {
		const m = this.machine.get(destCode).bracket.get(invertCode);
		const buf = Buffer.from(s, 'utf8');
		const brackets = m(buf, 0, buf.length, 'unicode'/* codepoints*/);
		let safe = 0;
		let unsafe = 0;
		for (let i = 1; i < brackets.length; i++) {
			safe += (brackets[i] - brackets[i - 1]);
			if (++i < brackets.length) {
				unsafe += (brackets[i] - brackets[i - 1]);
			}
		}
		// Note that this is counting codepoints, not UTF-8 code units.
		return { safe, unsafe, length: brackets[brackets.length - 1] };
	}

	/**
	 * Replace the given text Node with converted text, protecting any
	 * markup which can't be round-tripped back to `invertCode` with
	 * appropriate synthetic language-converter markup.
	 * @param {Node} textNode
	 * @param {string} destCode
	 * @param {string} invertCode
	 * @return {Node|null} the next sibling of textNode (for traversal)
	 */
	replace(textNode, destCode, invertCode) {
		const fragment = this.convert(
			textNode.ownerDocument, textNode.textContent, destCode, invertCode
		);
		// Was a change made?
		const next = textNode.nextSibling;
		if (
			DU.hasNChildren(fragment, 1) &&
			DU.isText(fragment.firstChild) &&
			DU.isText(textNode) &&
			textNode.textContent === fragment.textContent
		) {
			return next; // No change.
		}
		textNode.replaceWith(fragment);
		return next;
	}

	/**
	 * Convert the given string, protecting any
	 * markup which can't be round-tripped back to `invertCode` with
	 * appropriate synthetic language-converter markup.  Returns
	 * a DocumentFragment.
	 * @param {Document} document
	 *   Owner of the resulting DocumentFragment.
	 * @param {string} s
	 *   Text to convert.
	 * @param {string} destCode
	 *   Target language code for the conversion.
	 * @param {string} invertCode
	 *   Language code which will be used to round-trip the result.
	 * @return {DocumentFragment}
	 */
	convert(document, s, destCode, invertCode) {
		const machine = this.machine.get(destCode);
		const convertM = machine.convert;
		const bracketM = machine.bracket.get(invertCode);
		const result = document.createDocumentFragment();
		const buf = Buffer.from(s, 'utf8');
		const brackets = bracketM(buf);
		for (let i = 1; i < brackets.length; i++) {
			// A safe string
			const safe = convertM(buf, brackets[i - 1], brackets[i]);
			if (safe.length > 0) {
				result.appendChild(document.createTextNode(safe));
			}
			if (++i < brackets.length) {
				// An unsafe string
				const orig = buf.toString('utf8', brackets[i - 1], brackets[i]);
				const unsafe = convertM(buf, brackets[i - 1], brackets[i]);
				const span = document.createElement('span');
				span.textContent = unsafe;
				span.setAttribute('typeof', 'mw:LanguageVariant');
				// If this is an anomalous piece of text in a paragraph
				// otherwise written in destCode, then it's possible
				// invertCode === destCode.  In this case try to pick a
				// more appropriate invertCode !== destCode.
				let ic = invertCode;
				if (ic === destCode) {
					const cs = this.codes.filter(c => c !== destCode).map((code) => {
						return {
							code,
							stats: this.countBrackets(orig, code, code)
						};
					}).sort((a,b) => a.stats.unsafe - b.stats.unsafe);
					if (cs.length === 0) {
						ic = '-';
					} else {
						ic = cs[0].code;
						span.setAttribute('data-mw-variant-lang', ic);
					}
				}
				DU.setJSONAttribute(span, 'data-mw-variant', {
					twoway: [
						{ l: ic, t: orig },
						{ l: destCode, t: unsafe },
					],
					rt: true, /* Synthetic markup used for round-tripping */
				});
				if (unsafe.length > 0) {
					result.appendChild(span);
				}
			}
		}
		// Merge Text nodes, just in case we had zero-length brackets.
		result.normalize();
		return result;
	}
}

module.exports.ReplacementMachine = ReplacementMachine;
