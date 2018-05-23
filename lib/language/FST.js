/**
 * Load and execute a finite-state transducer (FST) based converter or
 * bracketing machine from a compact JSON description.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const { StringDecoder } = require('string_decoder');

const MAGIC_BYTES   = 8; // 8 byte header w/ magic bytes

// These pseudo-characters appear in the "output" side of the FST only.
const BYTE_IDENTITY = 0xFF;
const BYTE_RBRACKET = 0xFE;
const BYTE_LBRACKET = 0xFD;
const BYTE_FAIL     = 0xFC;
// These pseudo-characters appear in the "input" side of the FST.
const BYTE_EOF      = 0xF8; // The highest possible input char
const BYTE_EPSILON  = 0x00; // Always appears first in sorted order

/**
 * A FST conversion machine.
 * @callback module:language/FST~ConversionMachine
 * @param {Buffer} buffer UTF-8 encoded input buffer.
 * @param {Number} [start] Start position in the buffer, default 0.
 * @param {Number} [end] End position in the buffer, defaults to
 *   `buffer.length`.
 * @return {string} The converted string.
 */

/**
 * A FST bracket machine.
 * @callback module:language/FST~BracketMachine
 * @param {Buffer} buffer UTF-8 encoded input buffer.
 * @param {Number} [start] Start position in the buffer, default 0.
 * @param {Number} [end] End position in the buffer, defaults to
 *   `buffer.length`.
 * @return {Number[]} An array of bracket locations in the input buffer.
 */

/**
 * Load an FST description and return a function which runs the machine.
 * @param {Buffer|Utf8Array|string} file The FST description, either as a
 *  filename (to be loaded synchronously) or a loaded byte array.
 * @param {boolean} [justBrackets] The machine will return an array of
 *  bracket locations in the input buffer, instead of a converted buffer.
 * @return {BracketMachine|ConversionMachine}
 */
function compile(file, justBrackets) {
	if (typeof file === 'string') {
		file = require('fs').readFileSync(file);
	}
	// Verify the magic number
	if (
		file.length < (MAGIC_BYTES + 2/* states, min*/) ||
			file.slice(0,8).toString('utf8') !== 'pFST\0WM\0'
	) {
		throw new Error("Invalid pFST file.");
	}
	if (justBrackets === 'split') {
		// Debugging helper: instead of an array of positions, split the
		// input at the bracket locations and return an array of strings.
		const bfunc = compile(file, true);
		return (buf,start,end) => {
			end = end === undefined ? buf.length : end;
			const r = bfunc(buf,start,end);
			r.push(end);
			let i = 0;
			return r.map((j) => {
				const b = buf.slice(i,j);
				i = j;
				return b.toString('utf8');
			});
		};
	}
	return (buf, start, end, unicode) => {
		start = start === undefined ? 0 : start;
		end = end === undefined ? buf.length : end;
		console.assert(start >= 0 && end <= buf.length, "Bad start/end");
		const countCodePoints = justBrackets && unicode;
		const STATE_INITIAL = MAGIC_BYTES + 2/* eof state*/;
		let state = STATE_INITIAL;
		let idx = start;
		let outpos = 0;
		const brackets = [0];
		const stack = [];
		let chunk = { buf: justBrackets ? null : new Buffer(256), next: null };
		let firstChunk = chunk;

		// Read zig-zag encoded variable length integers
		// (See [en:Variable-length_quantity#Zigzag_encoding])
		const readUnsignedV = () => {
			let b = file[state++];
			/* eslint-disable no-bitwise */
			let val = b & 127;
			while (b & 128) {
				val += 1;
				b = file[state++];
				val = (val << 7) + (b & 127);
			}
			/* eslint-enable no-bitwise */
			return val;
		};
		const readSignedV = () => {
			const v = readUnsignedV();
			/* eslint-disable no-bitwise */
			if (v & 1) { // sign bit is in LSB
				return -(v >>> 1) - 1;
			} else {
				return (v >>> 1);
			}
			/* eslint-enable no-bitwise */
		};

		// Add a character to the output.
		const emit = justBrackets ? (code) => {
			if (code === BYTE_LBRACKET || code === BYTE_RBRACKET) {
				brackets.push(outpos);
			} else if (countCodePoints && code >= 0x80 && code < 0xC0) {
				/* Ignore UTF-8 continuation characters */
			} else {
				outpos++;
			}
		} : (code) => {
			// console.assert(code !== 0 && code < 0xF8, code);
			if (outpos >= chunk.buf.length) {
				// Make another chunk, bigger than the last one.
				chunk.next = {
					buf: new Buffer(chunk.buf.length * 2),
					next: null
				};
				chunk = chunk.next;
				outpos = 0;
			}
			chunk.buf[outpos++] = code;
		};
		// Save the current machine state before taking a non-deterministic
		// edge; if the machine fails, restart at the given `state`
		const save = (epsEdge) => {
			stack.push({
				epsEdge,
				outpos,
				idx,
				chunk,
				blen: brackets.length,
			});
		};
		// When the machine has failed, restart at the saved state.
		const reset = () => {
			const s = stack.pop();
			outpos = s.outpos;
			chunk = s.chunk;
			chunk.next = null;
			idx = s.idx;
			brackets.length = s.blen;
			// Get outByte from this edge, then jump to next state
			state = s.epsEdge + 1/* skip over inByte */;
			const edgeOut = file[state++];
			if (edgeOut !== BYTE_EPSILON) {
				emit(edgeOut);
			}
			let edgeDest = state;
			edgeDest += readSignedV();
			state = edgeDest;
		};

		// This runs the machine until we reach the EOF state
		/* eslint-disable no-labels, no-extra-label */
		NEXTSTATE:
		while (state >= STATE_INITIAL) {
			if (state === STATE_INITIAL) {
				// Memory efficiency: since the machine is universal
				// we know we'll never fail as long as we're in the
				// initial state.
				stack.length = 0;
			}
			const edgeWidth = readUnsignedV();
			let nEdges = readUnsignedV();
			if (nEdges === 0) {
				reset();
				continue NEXTSTATE;
			}
			// Read first edge to see if there are any epsilon edges
			let edge0 = state;
			while (file[edge0] === BYTE_EPSILON) {
				// If this is an epsilon edge, then save a backtrack state
				save(edge0);
				edge0 += edgeWidth;
				nEdges--;
				if (nEdges === 0) {
					reset();
					continue NEXTSTATE;
				}
			}
			// Binary search for an edge matching c
			const c = (idx < end) ? buf[idx++] : /* pseudo-character: */ BYTE_EOF;
			let minIndex = 0;
			let maxIndex = nEdges;
			while (minIndex !== maxIndex) {
				/* eslint-disable no-bitwise */
				const currentIndex = (minIndex + maxIndex) >>> 1;
				const targetEdge = edge0 + (edgeWidth * currentIndex);
				const inByte = file[targetEdge];
				if (inByte <= c) {
					minIndex = currentIndex + 1;
				} else {
					maxIndex = currentIndex;
				}
				/* eslint-enable no-bitwise */
			}
			// (minIndex-1).inByte <= c, and maxIndex.inByte > c
			const targetEdge = edge0 + (edgeWidth * (minIndex - 1));
			let outByte = (minIndex > 0) ? file[targetEdge + 1] : BYTE_FAIL;
			if (outByte === BYTE_FAIL) {
				reset();
				continue NEXTSTATE;
			}
			if (outByte !== BYTE_EPSILON) {
				if (outByte === BYTE_IDENTITY) {
					outByte = c; // Copy input byte to output
				}
				emit(outByte);
			}
			state = targetEdge + 2; // skip over inByte/outByte
			state = readSignedV() + (targetEdge + 2);
		}
		/* eslint-enable no-labels, no-extra-label */

		// Ok, process the final state and return something.
		if (justBrackets) {
			brackets.push(outpos);
			return brackets;
		}
		// Convert the chunked UTF-8 output back into a JavaScript string.
		chunk.buf = chunk.buf.slice(0, outpos);
		chunk = null; // free memory as we go along
		var decoder = new StringDecoder('utf8');
		var result = '';
		for (; firstChunk; firstChunk = firstChunk.next) {
			result += decoder.write(firstChunk.buf);
		}
		result += decoder.end();
		return result;
	};
}

module.exports = {
	constants: {
		BYTE_IDENTITY,
		BYTE_RBRACKET,
		BYTE_LBRACKET,
		BYTE_FAIL,
		BYTE_EOF,
		BYTE_EPSILON,
	},
	compile,
};
