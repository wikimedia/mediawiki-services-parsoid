"use strict";

var Consts = require('../config/WikitextConstants.js').WikitextConstants;
var DU = require('../utils/DOMUtils.js').DOMUtils;
var Promise = require('../utils/promise.js');
var Util = require('../utils/Util.js').Util;
var LanguageVariantText = require('./ConstrainedText.js').LanguageVariantText;

// should be called with this == instance of WikitextSerializer
var LanguageVariantHandler = function(node) {
	var state = this.state;
	var dataMWV = DU.getJSONAttribute(node, 'data-mw-variant', {});
	var dp = DU.getDataParsoid(node);
	var trailingSemi = dp.ts;
	var textP;
	var flags;
	var originalFlags = (dp.fl || []).reduce(function(m, k, idx) {
		if (!m.has(k)) { m.set(k, idx); }
		return m;
	}, new Map());
	var resultP = Promise.resolve('$E|'); // "error" flag

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
		if (/^[a-z][-a-z]+$/.test(l)) { return l; }
		return '<nowiki>' + Util.escapeEntities(l) + '</nowiki>';
	};

	// Helper function: combine the three parts of the -{ }- string
	var combine = function(flagStr, bodyStr, useTrailingSemi) {
		if (flagStr || /\|/.test(bodyStr)) { flagStr += '|'; }
		if (useTrailingSemi) { bodyStr += ';'; }
		return flagStr + bodyStr;
	};

	// Canonicalize combinations of flags.
	var sortedFlags = function() {
		return Array.from(flags).filter(function(f) {
			// Filter out internal-use-only flags
			return !/^[$]/.test(f);
		}).sort(function(a, b) {
			var ai = originalFlags.has(a) ? originalFlags.get(a) : -1;
			var bi = originalFlags.has(b) ? originalFlags.get(b) : -1;
			return ai - bi;
		}).join(';');
	};

	if (dataMWV.filter && dataMWV.filter.l) {
		// "Restrict possible variants to a limited set"
		textP = ser(dataMWV.filter.t, { protect: /\}-/ });
		resultP = textP.then(function(text) {
			console.assert(flags.size === 0);
			return combine(
				dataMWV.filter.l.map(protectLang).join(';'),
				text,
				false /* no trailing semi */);
		});
	} else if (dataMWV.disabled || dataMWV.name) {
		// "Raw" / protect contents from language converter
		textP = ser((dataMWV.disabled || dataMWV.name).t, { protect: /\}-/ });
		resultP = textP.then(function(text) {
			if (!/[:;|]/.test(text)) {
				maybeDeleteFlag('R');
			}
			return combine(sortedFlags(), text, false);
		});
	} else if (Array.isArray(dataMWV.bidir)) {
		// Bidirectional rules
		var b = (dataMWV.bidir[0] && dataMWV.bidir[0].l === '*') ?
			dataMWV.bidir.slice(0, 1) :
			dataMWV.bidir;
		textP = Promise.all(b.map(function(rule) {
			return ser(rule.t, { protect: /;|\}-/ }).then(function(text) {
				if (rule.l === '*') {
					trailingSemi = false;
					return text;
				}
				return protectLang(rule.l) + ':' + text;
			});
		})).then(function(arr) { return arr.join(';'); });
		resultP = textP.then(function(text) {
			// suppress output of default flag ('S')
			maybeDeleteFlag('$S');
			return combine(sortedFlags(), text, trailingSemi);
		});
	} else if (Array.isArray(dataMWV.unidir)) {
		textP = Promise.all(dataMWV.unidir.map(function(rule) {
			return Promise.all([
				ser(rule.f, { protect: /:|;|=>|\}-/ }),
				ser(rule.t, { protect: /;|\}-/ })
			]).spread(function(from, to) {
				return from + '=>' + protectLang(rule.l) + ':' + to;
			});
		})).then(function(arr) { return arr.join(';'); });
		resultP = textP.then(function(text) {
			return combine(sortedFlags(), text, trailingSemi);
		});
	}
	return resultP.then(function(result) {
		state.emitChunk(new LanguageVariantText('-{' + result + '}-', node), node);
	});
};

if (typeof module === 'object') {
	module.exports.LanguageVariantHandler = LanguageVariantHandler;
}
