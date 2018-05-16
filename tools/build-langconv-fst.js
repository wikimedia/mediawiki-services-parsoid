#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');

/**
 * Compile an .att-format finite state transducer (as output by foma)
 * into a compact byte-array representation which is directly executable.
 * The input is expected to be a "byte machine", that is, unicode code units
 * have already been decomposed into code points corresponding to UTF-8
 * bytes.  Symbols used in the ATT file:
 *  @0@      Epsilon ("no character").  Used in both input and output edges;
 *           as an input edge this introduced nondeterminism.
 *  <hh>    The input byte with hexadecimal value <hh>
 *             ("00" should never appear in the ATT file; see below.)
 *  @_IDENTITY_SYMBOL_@   Any character not named in the (implicit) alphabet
 *  [[       Bracket characters, used to delimit "unsafe" strings in
 *  ]]       "bracket machines'.
 *
 * The output is a byte array.  We use a variable-length integer encoding:
 *   0xxx xxxy -> the directly-encoded value (xxx xxxx)
 *   1xxx xxxx -> (xxx xxxx) + 128 * ( 1 + <the value encoded by subsequent bytes>)
 * For signed quantities, the least significant digit is used for a sign
 * bit.  That is, to encode first:
 *   from_signed(x) = (x >= 0) ? (2*x) : (-2*(x + 1) + 1);
 * and when decoding:
 *   to_signed(x) = (x & 1) ? (((x-1)/-2)-1) : (x/2);
 * See [en:Variable-length_quantity#Zigzag_encoding] for details.
 *
 * Byte value 0x00 is used for "epsilon" edges.  Null characters are
 *  disallowed in wikitext, and foma would have trouble handling them
 *  natively since it is written in C with null-terminated strings.
 *  As an input character this represents a non-deterministic transition;
 *  as an output character it represents "no output".
 *  If you wanted (for some reason) to allow null characters in the
 *  input (which are not included in the "anything else" case), then
 *  encode them as 0xC0 0x80 (aka "Modified UTF-8").  Similarly, if
 *  you wanted to emit a null character, you should emit 0xC0 0x80.
 *
 * Byte values 0xF8 - 0xFF are disallowed in UTF-8.  We use them for
 * special cases, as follows:
 *  0xFF: EOF (the end of the input string).  Final states in the machine
 *   are represented with an inchar=0xFF outchar=0x00 transition to a
 *   unique "stop state" (aka state #1).  Non-final states have no outgoing
 *   edge for input 0xFF.
 *  0xFE: IDENTITY.  As an input character this matches any "anything else"
 *   character.  As an output character it copies the input character.
 *  0xFD: ]]
 *  0xFC: [[  These bracketing characters should only appear as output
 *   characters; they will never appear in the input.
 *  0xF8: Padding character (see below).
 *
 * The byte array begins with an array of 256 bits (32 bytes).  A 1 in this
 * array indicates that this byte value should be treated as
 * "@_IDENTITY_SYMBOL_@" (that is, "anything else") and thus mapped to 0xFE.
 * (Byte values 0x00 and 0xF8-0xFF will always have their bits set.)
 *
 * Following this, we have an array of states.  Each state is:
 *   <# edges: variable unsigned int> <edge #0>, <edge #1>, etc
 * Each edge is:
 *   <inchar:1 byte> <outchar: 1 byte> <state #: variable signed int>
 *
 * Edges are sorted by <inchar> to allow binary search. All state #s
 * are relative, refer to the start position of that state in the byte
 * array, and are padded with trailing 0xF8 to the same size within
 * each state.  If the first edge(s) have <inchar> = 0x00 then these edges
 * represents possible epsilon transitions from this state (aka, these
 * edge should be tried if subsequent execution from this state
 * fails).  The first edge can always be examined to determine the
 * (variable length) size of all edges in this state by counting the
 * trailing 0xF8 bytes since only <inchar> should never be 0xF8.
 */

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const { StringDecoder } = require('string_decoder');

const FST = require('../lib/language/FST.js');

const BYTE_EOF      = FST.constants.BYTE_EOF;
const BYTE_IDENTITY = FST.constants.BYTE_IDENTITY;
const BYTE_RBRACKET = FST.constants.BYTE_RBRACKET;
const BYTE_LBRACKET = FST.constants.BYTE_LBRACKET;
const BYTE_PADDING  = FST.constants.BYTE_PADDING;
const BYTE_EPSILON  = FST.constants.BYTE_EPSILON;

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

// Splits input on `\r\n?|\n` without holding entire file in memory at once.
function *readLines(inFile) {
	const fd = fs.openSync(inFile, 'r');
	try {
		const buf = new Buffer(1024);
		const decoder = new StringDecoder('utf8');
		let line = '';
		let sawCR = false;
		while (true) {
			const bytesRead = fs.readSync(fd, buf, 0, buf.length);
			if (bytesRead === 0) { break; }
			let lineStart = 0;
			for (let i = 0; i < bytesRead; i++) {
				if (buf[i] === 13 || buf[i] === 10) {
					line += decoder.write(buf.slice(lineStart, i));
					if (!(buf[i] === 10 && sawCR)) {
						// skip over the zero-length "lines" caused by \r\n
						yield line;
					}
					line = '';
					lineStart = i + 1;
					sawCR = (buf[i] === 13);
				} else {
					sawCR = false;
				}
			}
			line += decoder.write(buf.slice(lineStart, bytesRead));
		}
		line += decoder.end();
		yield line;
	} finally {
		fs.closeSync(fd);
	}
}

function readAttFile(inFile, handleState, handleFinal) {
	let lastState = 0;
	let edges = [];
	const finalStates = [];
	for (const line of readLines(inFile)) {
		if (line.length === 0) { continue; }
		const fields = line.split(/\t/g);
		const state = +fields[0];
		if (fields.length === 1 || state !== lastState) {
			if (lastState >= 0) {
				handleState(lastState, edges);
				edges = [];
				lastState = -1;
			}
		}
		if (fields.length === 1) {
			finalStates.push(state);
		} else {
			console.assert(fields.length === 4);
			const to = +fields[1];
			const inChar = fields[2];
			const outChar = fields[3];
			edges.push({ to, inChar, outChar });
			lastState = state;
		}
	}
	if (lastState >= 0) {
		handleState(lastState, edges);
	}
	if (handleFinal) {
		handleFinal(finalStates);
	}
}

class DynamicBuffer {
	constructor(chunkLength) {
		this.chunkLength = chunkLength || 16384;
		this.currBuff = new Buffer(this.chunkLength);
		this.buffNum = 0;
		this.offset = 0;
		this.buffers = [ this.currBuff ];
		this.lastLength = 0;
	}
	emit(b) {
		console.assert(b !== undefined);
		if (this.offset >= this.currBuff.length) {
			this.buffNum++; this.offset = 0;
			this._maybeCreateBuffers();
			this.currBuff = this.buffers[this.buffNum];
		}
		this.currBuff[this.offset++] = b;
		this._maybeUpdateLength();
	}
	emitUnsignedV(val, pad) {
		const o = [];
		/* eslint-disable no-bitwise */
		o.push(val & 127);
		for (val >>>= 7; val; val >>>= 7) {
			o.push(128 | (--val & 127));
		}
		/* eslint-enable no-bitwise */
		for (let j = o.length - 1; j >= 0; j--) {
			this.emit(o[j]);
		}
		if (pad !== undefined) {
			for (let j = o.length; j < pad; j++) {
				this.emit(BYTE_PADDING);
			}
		}
	}
	emitSignedV(val, pad) {
		if (val >= 0) {
			val *= 2;
		} else {
			val = (-val) * 2 - 1;
		}
		this.emitUnsignedV(val, pad);
	}
	position() {
		return this.offset + this.buffNum * this.chunkLength;
	}
	length() {
		return this.lastLength + (this.buffers.length - 1) * this.chunkLength;
	}
	truncate() {
		this.lastLength = this.offset;
		this.buffers.length = this.buffNum + 1;
	}
	_maybeCreateBuffers() {
		while (this.buffNum >= this.buffers.length) {
			this.buffers.push(new Buffer(this.chunkLength));
			this.lastLength = 0;
		}
	}
	_maybeUpdateLength() {
		if (
			this.offset > this.lastLength &&
			this.buffNum === this.buffers.length - 1
		) {
			this.lastLength = this.offset;
		}
	}
	seek(pos) {
		console.assert(pos !== undefined);
		this.buffNum = Math.floor(pos / this.chunkLength);
		this.offset = pos - (this.buffNum * this.chunkLength);
		this._maybeCreateBuffers();
		this.currBuff = this.buffers[this.buffNum];
		this._maybeUpdateLength();
	}
	read() {
		if (this.offset >= this.currBuff.length) {
			this.buffNum++; this.offset = 0;
			this._maybeCreateBuffers();
			this.currBuff = this.buffers[this.buffNum];
		}
		const b = this.currBuff[this.offset++];
		this._maybeUpdateLength();
		return b;
	}
	readUnsignedV(skipPad) {
		let b = this.read();
		/* eslint-disable no-bitwise */
		let val = b & 127;
		while (b & 128) {
			val += 1;
			b = this.read();
			val = (val << 7) + (b & 127);
		}
		/* eslint-enable no-bitwise */
		if (skipPad) {
			let p = this.position();
			while (p < this.length()) {
				if (this.read() !== BYTE_PADDING) { break; }
				p = this.position();
			}
			this.seek(p);
		}
		return val;
	}
	readSignedV(skipPad) {
		const v = this.readUnsignedV(skipPad);
		/* eslint-disable no-bitwise */
		if (v & 1) {
			return -(v >>> 1) - 1;
		} else {
			return (v >>> 1);
		}
		/* eslint-enable no-bitwise */
	}
	writeFile(outFile) {
		const fd = fs.openSync(outFile, 'w');
		try {
			let i;
			for (i = 0; i < this.buffers.length - 1; i++) {
				fs.writeSync(fd, this.buffers[i]);
			}
			fs.writeSync(fd, this.buffers[i], 0, this.lastLength);
		} finally {
			fs.closeSync(fd);
		}
	}
}

function processOne(inFile, outFile, verbose, justBrackets, maxStateBytes) {
	if (justBrackets === undefined) {
		justBrackets = /\bbrack-/.test(inFile);
	}
	if (maxStateBytes === undefined) {
		maxStateBytes = 8;
	}

	let finalStates;
	const alphabet = new Set();
	const sym2byte = function(sym) {
		if (sym === '@_IDENTITY_SYMBOL_@') { return BYTE_IDENTITY; }
		if (sym === '@0@') { return BYTE_EPSILON; }
		if (sym === '[[') { return BYTE_LBRACKET; }
		if (sym === ']]') { return BYTE_RBRACKET; }
		if (/^[0-9A-F][0-9A-F]$/i.test(sym)) {
			const b = Number.parseInt(sym, 16);
			console.assert(b !== 0 && b < 0xF8);
			return b;
		}
		console.assert(false, `Bad symbol: ${sym}`);
	};
	// Quickly read through once in order to pull out the set of final states
	// and the alphabet
	readAttFile(inFile, (state, edges) => {
		for (const e of edges) {
			alphabet.add(sym2byte(e.inChar));
			alphabet.add(sym2byte(e.outChar));
		}
	}, (fs) => {
		finalStates = new Set(fs);
	});
	// Anything not in `alphabet` is going to be treated as 'anything else'
	// but we want to force 0x00 and 0xF8-0xFF to be treated as 'anything else'
	alphabet.delete(0);
	for (let i = 0xF8; i < 0xFF; i++) { alphabet.delete(i); }
	// Emit a magic number; make it a multiple of 8 bytes to keep the
	// "anything else" table word-aligned.
	const out = new DynamicBuffer();
	out.emit(0x70); out.emit(0x46); out.emit(0x53); out.emit(0x54);
	out.emit(0x00); out.emit(0x57); out.emit(0x4D); out.emit(0x00);
	// Emit the initial "anything else" table
	for (let i = 0; i < 0x100; i += 8) {
		let val = 0;
		for (let j = 7; j >= 0; j--) {
			/* eslint-disable no-bitwise */
			val = (val << 1) | (alphabet.has(i + j) ? 0 : 1);
			/* eslint-enable no-bitwise */
		}
		out.emit(val);
	}
	// Ok, now read through and build the output array
	let synState = -1;
	const stateMap = new Map();
	// Reserve the EOF state (0 in output)
	stateMap.set(synState--, out.position());
	out.emitUnsignedV(0);
	const processState = (state, edges) => {
		console.assert(!stateMap.has(state));
		stateMap.set(state, out.position());
		edges.sort((a,b) => a.inByte - b.inByte);
		out.emitUnsignedV(edges.length);
		edges.forEach((e) => {
			out.emit(e.inByte);
			out.emit(e.outByte);
			out.emitSignedV(e.to, maxStateBytes);
		});
	};
	readAttFile(inFile, (state, edges) => {
		// Map characters to bytes
		edges = edges.map((e) => {
			return {
				to: e.to,
				inByte: sym2byte(e.inChar),
				outByte: sym2byte(e.outChar),
			};
		});
		// If this is a final state, add a synthetic EOF edge
		if (finalStates.has(state)) {
			edges.push({ to: -1, inByte: BYTE_EOF, outByte: BYTE_EPSILON });
		}
		// Collect edges and figure out if we need to split the state
		// (if there are multiple edges with the same non-epsilon inByte).
		const edgeMap = new DefaultMap(() => []);
		for (const e of edges) {
			edgeMap.getDefault(e.inByte).push(e);
		}
		// For each inByte with multiple outgoing edges, replace those
		// edges with a single edge:
		//  { to: newState, inChar: e.inByte, outChar: BYTE_EPSILON }
		// ...and then create a new state with edges:
		//  [{ to: e[n].to, inChar: BYTE_EPSILON, outChar: e[n].outChar},...]
		const extraStates = [];
		for (const [inByte, e] of edgeMap.entries()) {
			if (inByte !== BYTE_EPSILON && e.length > 1) {
				const nstate = synState--;
				extraStates.push({
					state: nstate,
					edges: e.map((ee) => {
						return {
							to: ee.to,
							inByte: BYTE_EPSILON,
							outByte: ee.outByte,
						};
					}),
				});
				edgeMap.set(inByte, [{
					to: nstate,
					inByte: inByte,
					outByte: BYTE_EPSILON
				}]);
			}
		}
		processState(state, [].concat.apply([], Array.from(edgeMap.values())));
		extraStates.forEach((extra) => {
			processState(extra.state, extra.edges);
		});
	});
	// Rarely a state will not be mentioned in the .att file except
	// in the list of final states; check this & process at the end.
	finalStates.forEach((state) => {
		if (!stateMap.has(state)) {
			processState(state, [
				{ to: -1, inByte: BYTE_EOF, outByte: BYTE_EPSILON }
			]);
		}
	});
	// Fixup buffer to include relative offsets to states
	const state0pos = stateMap.get(-1);
	out.seek(state0pos);
	while (out.position() < out.length()) {
		const nEdges = out.readUnsignedV();
		const edge0 = out.position();
		for (let i = 0; i < nEdges; i++) {
			const p = edge0 + i * (2 + maxStateBytes) + 2;
			out.seek(p);
			const state = out.readSignedV();
			out.seek(p);
			console.assert(stateMap.has(state), `${state} not found`);
			out.emitSignedV(stateMap.get(state) - p, maxStateBytes);
		}
		out.seek(edge0 + nEdges * (2 + maxStateBytes));
	}
	// Now iteratively narrow the field widths until the file is as small
	// as it can be.
	while (true) {
		let trimmed = 0;
		stateMap.clear();
		const widthMap = new Map();
		out.seek(state0pos);
		while (out.position() < out.length()) {
			const statePos = out.position();
			stateMap.set(statePos, statePos - trimmed);
			const nEdges = out.readUnsignedV();
			let minPadding = maxStateBytes;
			let fieldWidth = maxStateBytes;
			for (let i = 0; i < nEdges; i++) {
				out.read(); out.read();
				fieldWidth = out.position();
				out.readSignedV();
				const p = out.position();
				out.seek(fieldWidth);
				out.readSignedV(true);
				const cnt = out.position() - p;
				fieldWidth = out.position() - fieldWidth;
				minPadding = Math.min(minPadding, cnt);
			}
			widthMap.set(statePos, fieldWidth - minPadding);
			trimmed += minPadding * nEdges;
		}
		stateMap.set(out.position(), out.position() - trimmed);

		if (trimmed === 0) { break; /* nothing left to do */ }
		if (verbose) { console.log('.'); }

		out.seek(state0pos);
		while (out.position() < out.length()) {
			const statePos = out.position();
			console.assert(stateMap.has(statePos) && widthMap.has(statePos));
			const nWidth = widthMap.get(statePos);

			const nEdges = out.readUnsignedV();
			let edge0 = out.position();

			let nPos = stateMap.get(statePos);
			out.seek(nPos);
			out.emitUnsignedV(nEdges);
			nPos = out.position();

			for (let i = 0; i < nEdges; i++) {
				out.seek(edge0);
				const inByte = out.read();
				const outByte = out.read();
				let toPos = out.position();
				toPos += out.readSignedV(true);
				console.assert(stateMap.has(toPos), toPos);
				toPos = stateMap.get(toPos);
				edge0 = out.position();

				out.seek(nPos);
				out.emit(inByte);
				out.emit(outByte);
				toPos -= out.position();
				out.emitSignedV(toPos, nWidth);
				nPos = out.position();
			}
			out.seek(edge0);
		}
		out.seek(stateMap.get(out.position()));
		out.truncate();
	}

	// Done!
	out.writeFile(outFile);
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
				path.join(baseDir, `${f}.pfst`),
				argv.verbose
			);
		}
	} else {
		yopts.showHelp();
	}
}

if (require.main === module) {
	main();
}
