/**
 * Load and execute a finite-state transducer (FST) based converter or
 * bracketing machine from a compact JSON description.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const STATE_INITIAL = 0;
const STATE_EOF = -1;
const STATE_FAIL = -2;

const SAVE_NONE = -1;
const SAVE_EPSILON = -2;

const IN_EOF = -1;
const IN_ANYTHING_ELSE = -2;

const OUT_NONE = -1;
const OUT_IDENTITY = -2;
const OUT_LBRACKET = -3;
const OUT_RBRACKET = -4;

/* eslint-disable jsdoc/check-tag-names */ // eslint doesn't know @generator yet
/**
 * Decode compact JSON range specifications.
 * Sets of codepoints are encoded in the JSON machine description as a
 * list of codepoints interspersed with [min,max] range specifications.
 * This helper function yields all the actual codepoints described by
 * a JSON range description.
 * @param {Array} range
 * @generator
 * @yields {number} The next codepoint included in the range.
 */
function *decodeRange(range) {
	for (const el of range) {
		let min, max;
		if (Array.isArray(el)) {
			[min,max] = el;
		} else {
			min = max = el;
		}
		for (let i = min; i <= max; i++) {
			yield i;
		}
	}
}
/* eslint-enable jsdoc/check-tag-names */

/**
 * A FST conversion machine.
 * @callback module:language/FST~ConversionMachine
 * @param {Buffer} buffer UTF-8 encoded input buffer.
 * @param {Number} [start] Start position in the buffer, default 0.
 * @param {Number} [end] End position in the buffer, defaults to
 *   `buffer.length`.
 * @return {String} The converted string.
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
 * Parse a JSON FST description and return a function which runs the machine.
 * @param {Object|String} json The FST description.
 * @param {boolean} [justBrackets] The machine will return an array of
 *  bracket locations in the input buffer, instead of a converted buffer.
 * @return {BracketMachine|ConversionMachine}
 */
function compile(json, justBrackets) {
	if (typeof json === 'string') {
		json = JSON.parse(json);
	}
	if (justBrackets === 'split') {
		// Debugging helper: instead of an array of positions, split the
		// input at the bracket locations and return an array of strings.
		const bfunc = compile(json, true);
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
	const EQ_OFFSET = 2; // offset EQ class indices to make them all >= 0
	const eqMap = [];
	for (var [range,rep] of json.eq) {
		for (const i of decodeRange(range)) {
			// add EQ_OFFSET to keep all reps >= 0
			eqMap[i] = rep + EQ_OFFSET;
		}
	}
	const stateSave = [];
	const stateCases = [];
	// Each state starts with a "save state" value (for epsilon edges) then
	// an array of cases.
	for (var [save,cases] of json.state) {
		const s = [];
		stateSave.push(save);
		stateCases.push(s);
		for (const c of cases) {
			// Each state case is a four-element array: the range of
			// characters which share the case, a "save state" value (for
			// non-deterministic edges), a character to emit, and a
			// next state.
			const [range,save,emit,next] = c;
			const r = { save, emit, next };
			for (const i of decodeRange(range)) {
				// again, add EQ_OFFSET to keep all indices >= 0
				s[i + EQ_OFFSET] = r;
			}
		}
	}
	return (buf, start, end, unicode) => {
		start = start === undefined ? 0 : start;
		end = end === undefined ? buf.length : end;
		const countCodePoints = justBrackets && unicode;
		let state = STATE_INITIAL;
		let idx = start;
		let c, sz, eq;
		let outpos = 0;
		const brackets = [countCodePoints ? 0 : start];
		const stack = [];
		let chunk = { buf: justBrackets ? null : new Buffer(256), next: null };
		let firstChunk = chunk;
		// Add a character to the output.
		const emit = justBrackets ? () => { outpos++; } : function(code) {
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
		var save = function(state) {
			stack.push({
				state,
				outpos,
				idx: idx - sz,
				chunk,
				blen:brackets.length
			});
		};
		// When the machine has failed, restart at the saved state.
		var reset = function() {
			var s = stack.pop();
			state = s.state;
			outpos = s.outpos;
			chunk = s.chunk;
			chunk.next = null;
			idx = s.idx;
			brackets.length = s.blen;
		};
		// This runs the machine until we reach the EOF state
		while (state !== STATE_EOF) {
			if (idx < end) {
				// Decode the next UTF-8 code point.
				/* eslint-disable no-bitwise */
				c = buf[idx];
				if (c < 0x80) {
					sz = 1;
				} else if (c < 0xC2) {
					// Invalid UTF-8 :(
					throw new Error('Illegal UTF-8');
				} else if (c < 0xE0) {
					c = ((c & 0x1F) << 6) + (buf[idx + 1] & 0x3F);
					sz = 2;
				} else if (c < 0xF0) {
					c = ((c & 0x0F) << 12) + ((buf[idx + 1] & 0x3F) << 6) + (buf[idx + 2] & 0x3F);
					sz = 3;
				} else if (c < 0xF5) {
					c = ((c & 0x7) << 18) + ((buf[idx + 1] & 0x3F) << 12) + ((buf[idx + 2] & 0x3F) << 6) + (buf[idx + 3] & 0x3F);
					sz = 4;
				} else {
					// Invalid UTF-8 :(
					throw new Error('Illegal UTF-8');
				}
				/* eslint-enable no-bitwise */
				idx += sz;
				// Look up character in the equivalence-class map.
				eq = eqMap[c];
				if (eq === undefined) {
					eq = IN_ANYTHING_ELSE + EQ_OFFSET;
				}
			} else {
				// This is the EOF "character"
				c = IN_EOF; eq = IN_EOF + EQ_OFFSET; sz = 0;
			}

			// Push next state if there are epsilon edges out from this state.
			const ss = stateSave[state];
			if (ss !== SAVE_NONE) { save(ss); }
			// Find the appropriate edge out based on the character's eq class.
			const sc = stateCases[state][eq];
			state = sc.next;
			if (state === STATE_FAIL) {
				// The machine has failed.  Backtrack.
				reset();
			} else {
				// Push a state if there are multiple edges for this character.
				if (sc.save !== SAVE_NONE) {
					if (sc.save === SAVE_EPSILON) {
						idx -= sz; // Epsilon edge, push back input char.
					} else {
						save(sc.save);
					}
				}
				let out = sc.emit;
				if (out !== OUT_NONE) {
					if (out === OUT_IDENTITY) {
						out = c; // Copy input character to output.
					}
					if (out === OUT_LBRACKET || out === OUT_RBRACKET) {
						// Record bracket position (don't output them).
						brackets.push(outpos);
					} else {
						// Encode output character as UTF-8.
						/* eslint-disable no-bitwise */
						if (out < 0x80 || countCodePoints) {
							emit(out);
						} else if (out < 0x800) {
							emit(0xC0 | (out >>> 6));
							emit(0x80 | (out & 0x3F));
						} else if (out < 0x10000) {
							emit(0xE0 | (out >>> 12));
							emit(0x80 | ((out >>> 6) & 0x3F));
							emit(0x80 | (out & 0x3F));
						} else {
							emit(0xF0 | (out >>> 18));
							emit(0x80 | ((out >>> 12) & 0x3F));
							emit(0x80 | ((out >>> 6) & 0x3F));
							emit(0x80 | (out & 0x3F));
						}
						/* eslint-enable no-bitwise */
					}
				}
			}
		}
		// Ok, process the final state and return something.
		if (justBrackets) {
			brackets.push(outpos);
			return brackets;
		}
		// Convert the chunked UTF-8 output back into a JavaScript string.
		chunk.buf = chunk.buf.slice(0, outpos);
		chunk = null; // free memory as we go along
		var decoder = new (require('string_decoder').StringDecoder)('utf8');
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
		STATE_INITIAL,
		STATE_EOF,
		STATE_FAIL,
		SAVE_NONE,
		SAVE_EPSILON,
		IN_EOF,
		IN_ANYTHING_ELSE,
		OUT_NONE,
		OUT_IDENTITY,
		OUT_LBRACKET,
		OUT_RBRACKET
	},
	compile,
};
