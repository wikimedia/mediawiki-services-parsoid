#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');

/**
 * Compile an .att-format finite state transducer (as output by foma)
 * into an executable JS module or a compact JSON description of the
 * machine.
 *
 * Our descriptions treat Unicode codepoints natively; if you want to
 * run them on UTF-8 or UTF-16-encoded strings, you need to manually
 * compose the code units into code points.
 */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const FST = require('../lib/language/FST.js');

// NOTES
// for JSON output of transducers.
// emit = -1=>EPSILON, -2=>ID, -3=>LBRACKET, -4=>RBRACKET
// nstate = -1 => EOF, -2 => reset()
// save = -1 => don't save, -2 => epsilon case
// no default case in chars, ANYTHING_ELSE gets range
// eq: [[range,output],...] where range is [[min,max],[singleton],[min,max],...]
// state:[/*0*/[[/*chars*/[1,2,3],/*save*/-1,/*emit*/65,/*nstate*/1],[...],...],
// epsilon: [/*N*/[[/*empty*/],[/*save*/-1,/*emit*/-1,/*nstate*/2]]]

const ANYTHING_ELSE = { identity:0,size:-1 }; // singleton object
const LBRACKET = { bracket:'left' }; // special char
const RBRACKET = { bracket:'right' }; // special char
const EPSILON = { epsilon:true };
const EOF = { eof:true }; // special input char
const BUFFER = { buffer:0 }; // special output char
const FAIL = { fail:true }; // special output char
const MAX_CHAR = 0x10FFFF;

// UTF-8 characters can be 1-4 bytes long
const UTF8IDS = [
	{ identity:0,size:1 },{ identity:0,size:2 },
	{ identity:0,size:3 },{ identity:0,size:4 },
];

const isIdentity = c => typeof c !== 'number' && c.identity !== undefined;
const isBuffer = c => typeof c !== 'number' && c.buffer !== undefined;
const charType = (c) => {
	return isIdentity(c) ? -10 : // always smallest/first
		typeof c === 'number' ? -2 :
		isBuffer(c) ? -3 :
		[LBRACKET, RBRACKET, EPSILON, EOF, BUFFER, FAIL].indexOf(c);
};

const charCmp = (a,b) => {
	// numeric char codes are "type -1"
	const typeA = charType(a);
	const typeB = charType(b);
	let r = typeA - typeB;
	if (r !== 0) { return r; }
	if (typeof a === 'number') {
		r = a - b;
	}
	if (isIdentity(a)) {
		r = a.identity - b.identity;
		if (r !== 0) { return r; }
		r = a.size - b.size;
	} else if (isBuffer(a)) {
		r = a.buffer - b.buffer;
	}
	return r;
};

const charPretty = (c) => {
	if (typeof c === 'number') { return String.fromCodePoint(c); }
	if (c === ANYTHING_ELSE) { return '@ID@'; }
	if (UTF8IDS.includes(c)) { return `@ID[${c.size}]@`; }
	if (isIdentity(c)) { return `@ID${c.identity}[${c.size}]@`; }
	if (isBuffer(c)) { return `@BUF${c.buffer}@`; }
	if (c === LBRACKET) { return '@[[@'; }
	if (c === RBRACKET) { return '@]]@'; }
	if (c === EPSILON) { return '@0@'; }
	if (c === EOF) { return '@EOF@'; }
	if (c === FAIL) { return '@FAIL@'; }
	console.assert(false, c);
	return '@unk@';
};

class DefaultMap extends Map {
	constructor(makeDefaultValue) {
		super();
		this.makeDefaultValue = makeDefaultValue;
	}
	getDefault(key) {
		if (!this.has(key)) {
			this.set(key, this.makeDefaultValue());
		}
		return this.get(key);
	}
}

class CharClass {
	constructor() {
		this.ranges = [];
		this.anythingElse = false;
	}
	*[Symbol.iterator]() {
		if (this.anythingElse) {
			yield ANYTHING_ELSE;
		}
		for (const r of this.ranges) {
			for (let i = r.min; i <= r.max; i++) { yield i; }
		}
	}
	size() {
		let sz = 0;
		for (const r of this.ranges) {
			sz += (r.max - r.min) + 1;
		}
		return sz;
	}
	toJSON() {
		if (this.anythingElse) {
			// Any range including the default case is represented by `null`
			return null;
		}
		return this.ranges.map((r) => {
			// Abbreviate one-element ranges.
			return r.min === r.max ? r.min : [r.min, r.max];
		});
	}
	toString() {
		if (this.hasChar(0)) { // heuristic
			return `[^${this.copy().invert().toString().slice(1)}`;
		}
		const s = this.ranges.map((r) => {
			const [min,max] = Array.from(String.fromCodePoint(r.min, r.max));
			return (r.min === r.max) ? min :
				(r.min + 1 === r.max) ? `${min}${max}` :
				`${min}-${max}`;
		}).join('');
		return '[' + s + ']';
	}
	copy() {
		const c = new CharClass();
		c.ranges = this.ranges.map(r => ({ min:r.min,max:r.max }));
		c.anythingElse = this.anythingElse;
		return c;
	}
	isEmpty() { return this.ranges.length === 0 && !this.anythingElse; }
	invert() {
		const nr = [];
		let min = 0;
		for (const r of this.ranges) {
			if (min <= r.min - 1) {
				nr.push({ min:min, max:r.min - 1 });
			}
			min = r.max + 1;
		}
		if (min < MAX_CHAR) {
			nr.push({ min:min, max:MAX_CHAR });
		}
		this.ranges = nr;
		this.anythingElse = !this.anythingElse;
		return this;
	}
	hasChar(c) {
		if (c === ANYTHING_ELSE) {
			return this.anythingElse;
		}
		for (const r of this.ranges) {
			if (r.min <= c) {
				if (c <= r.max) { return true; }
			} else {
				break;
			}
		}
		return false;
	}
	union(cc) {
		for (const r of cc.ranges) {
			this.ranges.push({ min:r.min,max:r.max }); // don't destroy cc
		}
		this.ranges.sort((a,b) => a.min - b.min);
		if (this.ranges.length === 0) { return this; }
		const nr = [];
		let r0 = this.ranges[0];
		for (let i = 1, l = this.ranges.length; i < l; i++) {
			const r1 = this.ranges[i];
			if (r0.max + 1 < r1.min) {
				nr.push(r0);
				r0 = r1;
			} else if (r0.max < r1.max) {
				r0.max = r1.max;
			}
		}
		nr.push(r0);
		this.ranges = nr;
		if (cc.anythingElse) {
			this.anythingElse = true;
		}
		return this;
	}
	subtract(cc) {
		return this.invert().union(cc).invert();
	}
	addChar(c) {
		if (c === ANYTHING_ELSE) {
			this.anythingElse = true;
			return;
		}
		let i = 0;
		for (const l = this.ranges.length; i < l; i++) {
			const r = this.ranges[i];
			if (r.min <= c && c <= r.max) { return; }
			if (c === r.max + 1) {
				r.max++;
				if (i + 1 < l) {
					const r2 = this.ranges[i + 1];
					if (r.max + 1 === r2.min) {
						r.max = r2.max;
						this.ranges.splice(i + 1, 1);
					}
				}
				return;
			}
			if (c + 1 === r.min) {
				r.min--;
				return;
			}
			if (c < r.min) { break; }
		}
		this.ranges.splice(i, 0, { min:c, max:c });
	}
}

/**
 * Read in an .att-format FST file and parse it into our internal graph
 * format.
 */
function snarfFile(inFile) {
	const alphabet = new CharClass();
	const statePairEdges = new DefaultMap(() => new DefaultMap(() => {
		return [];
	}));
	const finalStates = new Set();
	let maxState = 0;

	const edgesByChar = new DefaultMap(() => new Set());
	const charsFromState = new DefaultMap(() => new CharClass());

	const mapChar = (c) => {
		if (c === '@_IDENTITY_SYMBOL_@') {
			return ANYTHING_ELSE;
		} else if (c === '@0@') {
			return EPSILON;
		} else if (c === '[[') {
			return LBRACKET;
		} else if (c === ']]') {
			return RBRACKET;
		} else if (/^\[.*\]$/.test(c)) {
			// Internal character; shouldn't really appear
			return null;
		} else {
			// Should be a single codepoint.
			console.assert(Array.from(c).length === 1, c);
			return c.codePointAt(0);
		}
	};

	const data = fs.readFileSync(inFile, 'utf-8').split(/\r?\n/g);
	for (const line of data) {
		if (line.length === 0) { continue; }
		const fields = line.split(/\t/g);
		if (fields.length === 1) {
			const fState = +fields[0];
			charsFromState.getDefault(fState);
			statePairEdges.getDefault(fState);
			finalStates.add(fState);
			continue;
		}
		console.assert(fields.length === 4);
		const fromState = +fields[0];
		const toState = +fields[1];
		const inChar = fields[2];
		const outChar = fields[3];
		maxState = Math.max(maxState, fromState, toState);
		const inCharCode = mapChar(inChar);
		const outCharCode = mapChar(outChar);
		if (inCharCode === LBRACKET || inCharCode === RBRACKET || inCharCode === null) {
			console.assert(outCharCode === EPSILON, `${inFile}: ${line}`);
			continue; // ignore these edges!
		}
		if (inCharCode !== EPSILON) {
			alphabet.addChar(inCharCode);
		}

		// collect chars for each edge (to find chars that would fail)
		if (inCharCode !== EPSILON) {
			charsFromState.getDefault(fromState).addChar(inCharCode);
		}

		// collect edges for each char
		// XXX this gets @ID@->b a->b and @ID@->@ID@ a->a, but not @ID@->a a->a
		const mod = (inCharCode === outCharCode) ? '' : `${charPretty(outCharCode)};`;
		// Keep epsilon edges separate from others
		const eps = (inCharCode === EPSILON) ? 'EPS;' : '';
		edgesByChar.getDefault(inCharCode).add(`${mod}${eps}${fromState}->${toState}`);
		// collect character classes
		const fromMap = statePairEdges.getDefault(fromState);
		const cc = fromMap.getDefault(toState);
		cc.push({
			inCharCode,
			// we're representing out as a *list* of output characters,
			// not just one.
			out: (outCharCode === EPSILON) ? [] :
			[(inCharCode === outCharCode) ? ANYTHING_ELSE : outCharCode],
		});
	}
	// add 'fail' edges
	for (const fromState of statePairEdges.keys()) {
		const chars = charsFromState.get(fromState) || new CharClass();
		const missing = alphabet.copy().subtract(chars);
		for (const c of missing) {
			edgesByChar.getDefault(c).add(`${fromState}->FAIL`);
		}
	}
	// ok, identify equivalent character classes
	const eqClass = new DefaultMap(() => []);
	for (var [charCode,transitions] of edgesByChar.entries()) {
		const sorted = Array.from(transitions).sort().join('|');
		eqClass.getDefault(sorted).push(charCode);
	}
	for (const charCodeList of eqClass.values()) {
		charCodeList.sort(charCmp);
	}

	return {
		alphabet, maxState, statePairEdges, finalStates, eqClass,
	};
}

function mergeEqClasses(graph, pickRep) {
	const { eqClass } = graph;
	const wrapSpecial = func => ((list) => {
		if (list.some(c => c === ANYTHING_ELSE)) { return ANYTHING_ELSE; }
		if (list.some(c => c === EPSILON)) { return EPSILON; }
		return func(list);
	});
	const pickFirst = wrapSpecial(list => list[0]);
	pickRep = pickRep ? wrapSpecial(pickRep) : pickFirst;
	const canon = new Map();
	const first = new Set();
	const alphabet = new CharClass();
	const eqMap = new Map();
	for (const charCodeList of eqClass.values()) {
		first.add(pickFirst(charCodeList));
		const rep = pickRep(charCodeList);
		for (const c of charCodeList) { canon.set(c, rep); }
		if (rep !== EPSILON) {
			alphabet.addChar(rep);
		}
		// Record equivalencies in a convenient form.
		eqMap.set(rep, charCodeList);
	}
	const statePairEdges = new Map();
	for (var [fromState, fromMap] of graph.statePairEdges.entries()) {
		statePairEdges.set(fromState, new Map());
		for (var [toState,cc] of fromMap.entries()) {
			console.assert(Array.isArray(cc));
			statePairEdges.get(fromState).set(toState, cc.filter((e) => {
				return first.has(e.inCharCode);
			}).map((e) => {
				console.assert(canon.has(e.inCharCode), e);
				return { inCharCode: canon.get(e.inCharCode), out: e.out };
			}));
		}
	}
	return {
		alphabet,
		maxState: graph.maxState,
		statePairEdges,
		finalStates: graph.finalStates,
		eqMap,
	};
}

function emitJavaScriptNonDetTransducer(outFile, graph, justBrackets, emitJson) {
	const jsonResult = {};
	// Prologue
	let result =
		'/* AUTOMATICALLY GENERATED FILE, DO NOT EDIT */\n' +
		'\n' +
		'"use strict";\n' +
		'\n' +
		`module.exports = function(buf, start, end${justBrackets ? ', unicode' : ''}) {\n` +
		'  start = start === undefined ? 0 : start;\n' +
		'  end = end === undefined ? buf.length : end;\n' +
		`  var state = ${FST.constants.STATE_INITIAL};\n` +
		'  var idx = start;\n' +
		'  var c, sz;\n' +
		'  var outpos = 0;\n' +
		'  var stack = [];\n' + (justBrackets ?
			// Just track brackets.
			'  var countCodePoints = !!unicode;\n' +
			'  var result = [countCodePoints ? 0 : start];\n' +
			'  var save = function(nstate) {\n' +
			'    stack.push({ state: nstate, outpos: outpos, idx: idx - sz, resultLength: result.length });\n' +
			'  };\n' +
			'  var reset = function() {\n' +
			'    var s = stack.pop();\n' +
			'    state = s.state;\n' +
			'    outpos = s.outpos;\n' +
			'    result.length = s.resultLength;\n' +
			'    idx = s.idx;\n' +
			'  };\n'
			: // Accumulate all output in chunks.
			'  var chunk = { buf: new Buffer(1024), next: null };\n' +
			'  var firstChunk = chunk;\n' +
			'  var emit = function(code) {\n' +
			'    if (outpos >= chunk.buf.length) {\n' +
			'      chunk.next = { buf: new Buffer(chunk.buf.length * 2), next: null };\n' +
			'      chunk = chunk.next;\n' +
			'      outpos = 0;\n' +
			'    }\n' +
			'    chunk.buf[outpos++] = code;\n' +
			'  };\n' +
			'  var decode = function() {\n' +
			'    chunk = null; // free memory as we go along\n' +
			`    var decoder = new (require('string_decoder').StringDecoder)('utf8');\n` +
			`    var result = '';\n` +
			'    for (; firstChunk; firstChunk = firstChunk.next) {\n' +
			'      result += decoder.write(firstChunk.buf);\n' +
			'    }\n' +
			'    result += decoder.end();\n' +
			'    return result;\n' +
			'  };\n' +
			// Deterministic transducers won't end up using save/reset
			'  // eslint-disable-next-line no-unused-vars\n' +
			'  var save = function(nstate) {\n' +
			'    stack.push({ state: nstate, outpos: outpos, idx: idx - sz, chunk: chunk });\n' +
			'  };\n' +
			'  // eslint-disable-next-line no-unused-vars\n' +
			'  var reset = function() {\n' +
			'    var s = stack.pop();\n' +
			'    state = s.state;\n' +
			'    outpos = s.outpos;\n' +
			'    chunk = s.chunk;\n' +
			'    chunk.next = null;\n' +
			'    idx = s.idx;\n' +
			'  };\n'
		) +
		'  while (true) {\n' +
		'    if (idx < end) {\n' +
		'      /* eslint-disable no-bitwise */\n' +
		'      c = buf[idx];\n' +
		'      if (c < 0x80) {\n' +
		'        sz = 1;\n' +
		'      } else if (c < 0xC2) {\n' +
		'        throw new Error(\'Illegal UTF-8\');\n' +
		'      } else if (c < 0xE0) {\n' +
		'        c = ((c & 0x1F) << 6) + (buf[idx + 1] & 0x3F);\n' +
		'        sz = 2;\n' +
		'      } else if (c < 0xF0) {\n' +
		'        c = ((c & 0x0F) << 12) + ((buf[idx + 1] & 0x3F) << 6) + (buf[idx + 2] & 0x3F);\n' +
		'        sz = 3;\n' +
		'      } else if (c < 0xF5) {\n' +
		'        c = ((c & 0x7) << 18) + ((buf[idx + 1] & 0x3F) << 12) + ((buf[idx + 2] & 0x3F) << 6) + (buf[idx + 3] & 0x3F);\n' +
		'        sz = 4;\n' +
		'      } else {\n' +
		'        throw new Error(\'Illegal UTF-8\');\n' +
		'      }\n' +
		'      /* eslint-enable no-bitwise */\n' +
		'      idx += sz;\n' +
		'    } else {\n' +
		`      c = ${FST.constants.IN_EOF}; sz = 0; // EOF\n` +
		'    }\n';

	let inCharPretty = charPretty;
	if (graph.eqMap) {
		jsonResult.eq = [];
		inCharPretty = c => charPretty(graph.eqMap.get(c)[0]);
		result +=
			'    var eq;\n' +
			'    switch (c) {\n' +
			`      case ${FST.constants.IN_EOF}: // ${JSON.stringify(charPretty(EOF))}\n` +
			`        eq = ${FST.constants.IN_EOF};\n` +
			'        break;\n';
		for (var [rep,charCodeList] of graph.eqMap.entries()) {
			if (rep === EPSILON) {
				continue;
			}
			const hasDefault = charCodeList.some(c => c === ANYTHING_ELSE);
			const chcls = new CharClass();
			for (const c of charCodeList) {
				chcls.addChar(c);
				if (c === ANYTHING_ELSE) {
					result += `      default: // ${JSON.stringify(charPretty(c))}\n`;
				} else if (!hasDefault) {
					console.assert(typeof c === 'number', c);
					result += `      case ${c}: // ${JSON.stringify(charPretty(c))}\n`;
				}
			}
			result +=
				`        eq = ${rep === ANYTHING_ELSE ? FST.constants.IN_ANYTHING_ELSE : rep};\n` +
				'        break;\n';
			if (rep !== ANYTHING_ELSE) {
				jsonResult.eq.push([chcls.toJSON(),rep]);
			}
		}
		result +=
			'    }\n';
	}
	const emit = (prefix, c, jsonCase) => {
		if (c === EPSILON) {
			jsonCase.emit = FST.constants.OUT_NONE;
			return '';
		}
		if (c === FAIL) {
			jsonCase.next = FST.constants.STATE_FAIL;
			return `${prefix}reset();\n`;
		}
		const s = charPretty(c);
		const b = Buffer.from(s, 'utf8');
		if (justBrackets) {
			if (c === LBRACKET || c === RBRACKET) {
				jsonCase.emit = (c === LBRACKET) ?
					FST.constants.OUT_LBRACKET :
					FST.constants.OUT_RBRACKET;
				return `${prefix}result.push(outpos);\n`;
			} else if (c === ANYTHING_ELSE) {
				jsonCase.emit = FST.constants.IN_ANYTHING_ELSE;
				return `${prefix}outpos += countCodePoints ? 1 : sz;\n`;
			} else {
				console.assert(typeof c === 'number', c);
				jsonCase.emit = c;
				return `${prefix}outpos += ${b.length > 1 ? 'countCodePoints ? 1 : ' : ''}${b.length};\n`;
			}
		} else {
			let result = '';
			let comment = ` // ${JSON.stringify(charPretty(c))}`;
			if (c === ANYTHING_ELSE) {
				jsonCase.emit = FST.constants.OUT_IDENTITY;
				result +=
					`${prefix}while (sz) { emit(buf[idx - sz]); sz--; }${comment}\n`;
			} else {
				console.assert(typeof c === 'number', c);
				jsonCase.emit = c;
				for (let i = 0; i < b.length; i++) {
					result += `${prefix}emit(${b[i]});${comment}\n`;
					comment = '';
				}
			}
			return result;
		}
	};
	let maxState = -1;
	const stateMap = new DefaultMap(() => maxState++);
	const stateMapper = (s,v) => stateMap.getDefault(`${s}|${v}`);
	const FINAL_STATE = graph.maxState + 1;
	// force final state to be state #-1
	stateMapper(FINAL_STATE,0);
	// force initial state to be state #0
	stateMapper(0,0);
	// Verify constants are sane.
	console.assert(stateMapper(FINAL_STATE,0) === FST.constants.STATE_EOF);
	console.assert(stateMapper(0,0) === FST.constants.STATE_INITIAL);

	result +=
		'    switch (state) {\n';
	jsonResult.state = [];
	for (let state = 0; state <= graph.maxState + 1; state++) {
		if (emitJson) { result = ''; /* memory management */ }
		if (state === FINAL_STATE) {
			/* final state */
			result +=
				`      case ${stateMapper(state,0)}: // State ${state} FINAL STATE\n`;
			if (justBrackets) {
				result +=
					'        result.push(outpos);\n' +
					'        return result;\n';
			} else {
				result +=
					'        chunk.buf = chunk.buf.slice(0, outpos);\n' +
					'        return decode();\n';
			}
			continue;
		}
		const fromMap = graph.statePairEdges.get(state);
		// collect edges by char
		const outByChar = new DefaultMap(() => []);
		for (const c of graph.alphabet) {
			outByChar.getDefault(c);
		}
		outByChar.getDefault(EOF); // ensure EOF is represented, too
		for (var [toState,edges] of fromMap.entries()) {
			for (const edge of edges) {
				const { inCharCode,out } = edge;
				console.assert(out.length <= 1);
				outByChar.getDefault(inCharCode).push({
					inCharCode,
					toState,
					out: out.length === 0 ? EPSILON : out[0],
					variant:null,
					max: null
				});
			}
		}
		const cases = [];
		const epsCases = [];
		const casesGet = (variant, key) => {
			if (!cases[variant]) { cases[variant] = new DefaultMap(() => []); }
			return cases[variant].getDefault(key);
		};
		let maxVariants = 0;
		const toKey = v => `${v.toState};${v.variant};${v.variant < (v.max - 1)};${charPretty(v.out)}`;
		for (var [inCharCode,list] of outByChar.entries()) {
			list.sort((a,b) => {
				const r = a.toState - b.toState;
				if (r !== 0) { return r; }
				return charCmp(a.out, b.out);
			});
			if (inCharCode !== EPSILON) {
				maxVariants = Math.max(maxVariants, list.length);
			}
			list.forEach((v,i) => {
				v.variant = i;
				v.max = list.length;
				if (inCharCode === EPSILON) {
					epsCases.push(v);
				} else {
					casesGet(i, toKey(v)).push(v);
				}
			});
			if (inCharCode === EOF && graph.finalStates.has(state)) {
				// EOF isn't a FAIL if this is a final state
				continue;
			}
			if (list.length === 0 && inCharCode !== EPSILON) {
				// FAIL case.
				casesGet(0, '<fail>').push({
					inCharCode, toState: null, out: FAIL, variant: 0, max: 1
				});
			}
		}
		if (graph.finalStates.has(state)) {
			// Add EOF cases to first variant.
			casesGet(0, '<eof>').push({
				inCharCode: EOF,
				toState: FINAL_STATE,
				out: EPSILON,
				variant: 0,
				max: 1
			});
		}
		const totalVariants = maxVariants + epsCases.length;
		for (let variant = 0; variant < totalVariants; variant++) {
			const mappedState = stateMapper(state,variant);
			const jsonState = { save: FST.constants.SAVE_NONE, cases: [] };
			jsonResult.state[mappedState] = jsonState;
			result +=
				`      case ${mappedState}: // State ${state} variant ${variant}\n`;
			if (state === 0 && variant === 0) {
				// efficiency hack: truncate the stack since all strings
				// will be accepted starting from initial state.
				// (could truncate stack *whenever* we reach a state from
				//  which all strings are guaranteed to be accepted)
				// XXX SHOULD ESTABLISH THIS BY ANALYSIS, NOT JUST PERFORM
				// THIS OPTIMIZATION BLINDLY.
				result +=
					'        stack.length = 0;\n';
			}
			if (variant >= maxVariants) {
				// This is an epsilon variant
				const eps = variant - maxVariants;
				const jsonCase = {
					save: FST.constants.SAVE_EPSILON,
					// All characters, including EOF, should take this case.
					chars: Array.from(graph.alphabet).map((c) => {
						return (c === ANYTHING_ELSE) ?
							FST.constants.IN_ANYTHING_ELSE :
							c;
					}).concat([FST.constants.IN_EOF]).sort((a,b) => a - b)
				};
				result +=
					`        // EPSILON ${eps + 1}\n`;
				if (eps < epsCases.length - 1) {
					jsonState.save = stateMapper(state, variant + 1);
					result +=
						`        save(${jsonState.save});\n`;
				}
				jsonCase.next = stateMapper(epsCases[eps].toState,0);
				result +=
					'        idx -= sz;\n' +
					emit('        ', epsCases[eps].out, jsonCase) +
					`        state = ${jsonCase.next};\n` +
					'        break;\n';
				jsonState.cases.push(jsonCase);
				continue;
			}
			if (epsCases.length) {
				// if all else fails, try an epsilon
				jsonState.save = stateMapper(state,maxVariants);
				result +=
					`        save(${jsonState.save});\n`;
			}
			result +=
				`        switch (${graph.eqMap ? 'eq' : 'c'}) {\n`;
			for (const list of cases[variant].values()) {
				const jsonCase = { chars:[] };
				jsonState.cases.push(jsonCase);
				for (const v of list) {
					const n =
						(v.inCharCode === ANYTHING_ELSE) ? FST.constants.IN_ANYTHING_ELSE :
						(v.inCharCode === EOF) ? FST.constants.IN_EOF :
						v.inCharCode;
					jsonCase.chars.push(n);
				}
				jsonCase.chars.sort((a,b) => a - b);
				if (list.some(v => v.inCharCode === ANYTHING_ELSE)) {
					result +=
						'          default:\n';
				} else {
					for (const v of list) {
						if (v.inCharCode === EOF) {
							result +=
								`          case ${FST.constants.IN_EOF}:\n`;
							continue;
						} else if (typeof v.inCharCode === 'number') {
							result +=
								`          case ${v.inCharCode}: // ${JSON.stringify(inCharPretty(v.inCharCode))}\n`;
						} else {
							console.assert(false, v.inCharCode);
						}
					}
				}
				const rep = list[0];
				if (rep.variant < (rep.max - 1)) {
					jsonCase.save = stateMapper(state,variant + 1);
					result +=
						`            save(${jsonCase.save});\n`;
				}
				result += emit(`            `, rep.out, jsonCase);
				if (rep.out !== FAIL) {
					jsonCase.next = stateMapper(rep.toState,0);
					result +=
						`            state = ${jsonCase.next};\n`;
				}
				result +=
					'            break;\n';
			}
			result +=
				'        }\n' +
				'        break;\n';
		}
	}
	result +=
		'    }\n' + // switch
		'  }\n' + // while
		'};\n'; // function

	// Convert an array of characters to a JSON "range" by offsetting
	// the characters to be all non-negative, then using CharClass#toJSON,
	// then removing the offset in the result.
	const charToRange = (charArray) => {
		const OFFSET = -FST.constants.IN_ANYTHING_ELSE;
		const cc = new CharClass();
		const add = n => (c => c + n);
		for (const c of charArray.map(add(OFFSET))) { cc.addChar(c); }
		return cc.toJSON().map((r) => {
			if (Array.isArray(r)) {
				return r.map(add(-OFFSET));
			}
			return r - OFFSET;
		});
	};
	jsonResult.state = jsonResult.state.map(st => [
		st.save === undefined ? FST.constants.SAVE_NONE : st.save,
		st.cases.map(c => [
			charToRange(c.chars),
			c.save === undefined ? FST.constants.SAVE_NONE : c.save,
			c.emit === undefined ? FST.constants.OUT_NONE : c.emit,
			c.next
		])
	]);
	if (outFile) {
		// Convert spaces to tabs to conform w/ our style checker
		result = result.replace(/^([ ]{2})+/mg, (s) => {
			return '\t'.repeat(s.length / 2);
		});
		fs.writeFileSync(
			outFile,
			emitJson ? JSON.stringify(jsonResult) : result,
			'utf-8'
		);
	}
	return result;
}

function processOne(inFile, outFile, justBrackets) {
	const graph = snarfFile(inFile);
	if (justBrackets === undefined) {
		justBrackets = /\bbrack-/.test(inFile);
	}

	let eqCnt = 0;
	const ntGraph = mergeEqClasses(graph, (list => eqCnt++));

	if (/\.json$/.test(outFile)) {
		emitJavaScriptNonDetTransducer(outFile, ntGraph, justBrackets, true);
	} else {
		emitJavaScriptNonDetTransducer(outFile, ntGraph, justBrackets);
	}
}

function main() {
	const yopts = yargs.usage(
		'Usage: $0 [options] <conversion> <inverse>\n' +
		'Converts a finite-state transducer in .att format.', {
			'output': {
				description: 'Output filename (or base name)',
				alias: 'o',
				nargs: 1,
				normalize: true,
			},
			'file': {
				description: 'Input .att filename',
				alias: 'f',
				conflicts: 'language',
				implies: 'output',
				nargs: 1,
				normalize: true,
			},
			'language': {
				description: 'Converts trans-{conversion}, brack-{conversion}-noop, and brack-{conversion}-{inverse} in default locations',
				alias: 'l',
				conflicts: 'file',
				nargs: 2,
			},
			'brackets': {
				description: 'Emit a bracket-location machine',
				alias: 'b',
				boolean: true,
				default: undefined,
			},
			'verbose': {
				description: 'Show progress',
				alias: 'v',
				boolean: true,
			},
		}).example('$0 -l tolatin tocyrillic');
	const argv = yopts.argv;
	if (argv.help) {
		yopts.showHelp();
		return;
	}

	if (argv.file) {
		processOne(argv.file, argv.output, argv.brackets);
	} else if (argv.language) {
		const convertLang = argv.language[0];
		const inverseLang = argv.language[1];
		const baseDir = path.join(__dirname, '..', 'lib', 'language', 'fst');
		for (const f of [
			`trans-${convertLang}`,
			`brack-${convertLang}-noop`,
			`brack-${convertLang}-${inverseLang}` ]) {
			if (argv.verbose) {
				console.log(f);
			}
			processOne(
				path.join(baseDir, `${f}.att`),
				path.join(baseDir, `${f}.json`)
			);
		}
	} else {
		yopts.showHelp();
	}
}

if (require.main === module) {
	main();
}
