/**
 * Serializes language variant markup, like `-{ ... }-`.
 * @module
 */

"use strict";

var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var DOMDataUtils = require('../utils/DOMDataUtils.js').DOMDataUtils;
var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var LanguageVariantText = require('./ConstrainedText.js').LanguageVariantText;

var expandSpArray = function(a) {
	var result = [];
	if (Array.isArray(a)) {
		a.forEach(function(el) {
			if (typeof (el) === 'number') {
				for (var i = 0; i < el; i++) {
					result.push('');
				}
			} else {
				result.push(el);
			}
		});
	}
	return result;
};

/**
 * @function
 * @param {Node} node
 * @return {Promise}
 */
var languageVariantHandler = Promise.async(function *(state, node) {
	var dataMWV = DOMDataUtils.getJSONAttribute(node, 'data-mw-variant', {});
	var dp = DOMDataUtils.getDataParsoid(node);
	var flSp = expandSpArray(dp.flSp);
	var textSp = expandSpArray(dp.tSp);
	var trailingSemi = false;
	var text;
	var flags;
	var originalFlags = (dp.fl || []).reduce(function(m, k, idx) {
		if (!m.has(k)) { m.set(k, idx); }
		return m;
	}, new Map());
	var result = '$E|'; // "error" flag

	// Backwards-compatibility: `bidir` => `twoway` ; `unidir` => `oneway`
	if (dataMWV.bidir) {
		dataMWV.twoway = dataMWV.bidir;
		delete dataMWV.bidir;
	}
	if (dataMWV.unidir) {
		dataMWV.oneway = dataMWV.undir;
		delete dataMWV.unidir;
	}

	flags = Object.keys(dataMWV).reduce(function(f, k) {
		if (Consts.LCNameMap.has(k)) {
			f.add(Consts.LCNameMap.get(k));
		}
		return f;
	}, new Set());
	var maybeDeleteFlag = function(f) {
		if (!originalFlags.has(f)) { flags.delete(f); }
	};

	// Tweak flag set to account for implicitly-enabled flags.
	if (node.tagName !== 'META') {
		flags.add('$S');
	}
	if (!flags.has('$S') && !flags.has('T') && dataMWV.filter === undefined) {
		flags.add('H');
	}
	if (flags.size === 1 && flags.has('$S')) {
		maybeDeleteFlag('$S');
	} else if (flags.has('D')) {
		// Weird: Only way to hide a 'describe' rule is to write -{D;A|...}-
		if (flags.has('$S')) {
			if (flags.has('A')) {
				flags.add('H');
			}
			flags.delete('A');
		} else {
			flags.add('A');
			flags.delete('H');
		}
	} else if (flags.has('T')) {
		if (flags.has('A') && !flags.has('$S')) {
			flags.delete('A');
			flags.add('H');
		}
	} else if (flags.has('A')) {
		if (flags.has('$S')) {
			maybeDeleteFlag('$S');
		} else if (flags.has('H')) {
			maybeDeleteFlag('A');
		}
	} else if (flags.has('R')) {
		maybeDeleteFlag('$S');
	} else if (flags.has('-')) {
		maybeDeleteFlag('H');
	}

	// Helper function: serialize a DOM string; returns a Promise
	var ser = function(t, opts) {
		var options = Object.assign({
			env: state.env,
			onSOL: false
		}, opts || {});
		return state.serializer.serializeHTML(options, t);
	};

	// Helper function: protect characters not allowed in language names.
	var protectLang = function(l) {
		if (/^[a-z][-a-zA-Z]+$/.test(l)) { return l; }
		return '<nowiki>' + Util.escapeWtEntities(l) + '</nowiki>';
	};

	// Helper function: combine the three parts of the -{ }- string
	var combine = function(flagStr, bodyStr, useTrailingSemi) {
		if (flagStr || /\|/.test(bodyStr)) { flagStr += '|'; }
		if (useTrailingSemi !== false) { bodyStr += ';' + useTrailingSemi; }
		return flagStr + bodyStr;
	};

	// Canonicalize combinations of flags.
	var sortedFlags = function(flags, noFilter, protectFunc) {
		var s = Array.from(flags).filter(function(f) {
			// Filter out internal-use-only flags
			if (noFilter) { return true; }
			return !/^[$]/.test(f);
		}).sort(function(a, b) {
			var ai = originalFlags.has(a) ? originalFlags.get(a) : -1;
			var bi = originalFlags.has(b) ? originalFlags.get(b) : -1;
			return ai - bi;
		}).map(function(f) {
			// Reinsert the original whitespace around the flag (if any)
			var i = originalFlags.get(f);
			var p = protectFunc ? protectFunc(f) : f;
			if (i !== undefined && (2 * i + 1) < flSp.length) {
				return flSp[2 * i] + p + flSp[2 * i + 1];
			}
			return p;
		}).join(';');
		if (2 * originalFlags.size + 1 === flSp.length) {
			if (flSp.length > 1 || s.length) { s += ';'; }
			s += flSp[2 * originalFlags.size];
		}
		return s;
	};

	if (dataMWV.filter && dataMWV.filter.l) {
		// "Restrict possible variants to a limited set"
		text = yield ser(dataMWV.filter.t, { protect: /\}-/ });
		console.assert(flags.size === 0);
		result = combine(
			sortedFlags(dataMWV.filter.l, true, protectLang),
			text,
			false /* no trailing semi */);
	} else if (dataMWV.disabled || dataMWV.name) {
		// "Raw" / protect contents from language converter
		text = yield ser((dataMWV.disabled || dataMWV.name).t, { protect: /\}-/ });
		if (!/[:;|]/.test(text)) {
			maybeDeleteFlag('R');
		}
		result = combine(sortedFlags(flags), text, false);
	} else if (Array.isArray(dataMWV.twoway)) {
		// Two-way rules (most common)
		if (textSp.length % 3 === 1) {
			trailingSemi = textSp[textSp.length - 1];
		}
		var b = (dataMWV.twoway[0] && dataMWV.twoway[0].l === '*') ?
			dataMWV.twoway.slice(0, 1) :
			dataMWV.twoway;
		text = (yield Promise.all(b.map(Promise.async(function *(rule, idx) {
			var text = yield ser(rule.t, { protect: /;|\}-/ });
			if (rule.l === '*') {
				trailingSemi = false;
				return text;
			}
			var ws = (3 * idx + 2 < textSp.length) ?
				textSp.slice(3 * idx, 3 * (idx + 1)) :
				[ (idx > 0) ? ' ' : '', '', '' ];
			return ws[0] + protectLang(rule.l) + ws[1] + ':' + ws[2] + text;
		})))).join(';');
		// suppress output of default flag ('S')
		maybeDeleteFlag('$S');
		result = combine(sortedFlags(flags), text, trailingSemi);
	} else if (Array.isArray(dataMWV.oneway)) {
		// One-way rules (uncommon)
		if (textSp.length % 4 === 1) {
			trailingSemi = textSp[textSp.length - 1];
		}
		text = (yield Promise.all(dataMWV.oneway.map(Promise.async(function *(rule, idx) {
			var from = yield ser(rule.f, { protect: /:|;|=>|\}-/ });
			var to = yield ser(rule.t, { protect: /;|\}-/ });
			var ws = (4 * idx + 3 < textSp.length) ?
				textSp.slice(4 * idx, 4 * (idx + 1)) :
				[ '', '', '', '' ];
			return ws[0] + from + '=>' + ws[1] + protectLang(rule.l) +
				ws[2] + ':' + ws[3] + to;
		})))).join(';');
		result = combine(sortedFlags(flags), text, trailingSemi);
	}
	state.emitChunk(new LanguageVariantText('-{' + result + '}-', node), node);
});

if (typeof module === 'object') {
	module.exports.languageVariantHandler = languageVariantHandler;
}
