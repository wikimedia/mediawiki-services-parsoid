/** @module wt2html/Frame */

'use strict';

require('../../core-upgrade.js');

const { Params } = require('./Params.js');

const { EOFTk } = require('../tokens/TokenTypes.js');

const { JSUtils } = require('../utils/jsutils.js');
const { PipelineUtils } = require('../utils/PipelineUtils.js');
const { TokenUtils } = require('../utils/TokenUtils.js');
const { Util } = require('../utils/Util.js');

/**
 * @class
 *
 * The Frame object
 *
 * A frame represents a template expansion scope including parameters passed
 * to the template (args). It provides a generic 'expand' method which
 * expands / converts individual parameter values in its scope.  It also
 * provides methods to check if another expansion would lead to loops or
 * exceed the maximum expansion depth.
 */
class Frame {
	constructor(title, env, args, srcText, parentFrame) {
		this.title = title;
		this.env = env;
		this.args = new Params(args);
		this.srcText = srcText;
		console.assert(typeof (srcText) === 'string');

		if (parentFrame) {
			this.parentFrame = parentFrame;
			this.depth = parentFrame.depth + 1;
		} else {
			this.parentFrame = null;
			this.depth = 0;
		}
	}

	/**
	 * Create a new child frame.
	 */
	newChild(title, args, srcText) {
		return new Frame(title, this.env, args, srcText, this);
	}

	/**
	 * Expand / convert a thunk (a chunk of tokens not yet fully expanded).
	 *
	 * XXX: Support different input formats, expansion phases / flags and more
	 * output formats.
	 *
	 * @return {Promise} A promise which will be resolved with the expanded
	 *  chunk of tokens.
	 */
	expand(chunk, options) {
		const outType = options.type;
		console.assert(outType === 'tokens/x-mediawiki/expanded', "Expected tokens/x-mediawiki/expanded type");
		this.env.log('debug', 'Frame.expand', chunk);

		const cb = JSUtils.mkPromised(
			options.cb
			// XXX ignores the `err` parameter in callback.  This isn't great!
				? function(err, val) { options.cb(val); } // eslint-disable-line handle-callback-err
				: undefined
		);
		if (!chunk.length || chunk.constructor === String) {
			// Nothing to do
			cb(null, chunk);
			return cb.promise;
		}

		if (options.asyncCB) {
			// Signal (potentially) asynchronous expansion to parent.
			options.asyncCB({ async: true });
		}

		// Downstream template uses should be tracked and wrapped only if:
		// - not in a nested template        Ex: {{Templ:Foo}} and we are processing Foo
		// - not in a template use context   Ex: {{ .. | {{ here }} | .. }}
		// - the attribute use is wrappable  Ex: [[ ... | {{ .. link text }} ]]

		const opts = {
			// XXX: use input type
			pipelineType: 'tokens/x-mediawiki',
			pipelineOpts: {
				isInclude: this.depth > 0,
				expandTemplates: options.expandTemplates,
				inTemplate: options.inTemplate,
			},
			sol: true,
			srcOffsets: options.srcOffsets,
		};

		// In the name of interface simplicity, we accumulate all emitted
		// chunks in a single accumulator.
		const eventState = { options: options, accum: [], cb: cb };
		opts.chunkCB = this.onThunkEvent.bind(this, eventState, true);
		opts.endCB = this.onThunkEvent.bind(this, eventState, false);
		opts.tplArgs = { name: null, title: null, attribs: [] };

		const content = chunk;
		if (JSUtils.lastItem(chunk).constructor !== EOFTk) {
			content.push(new EOFTk());
		}

		// XXX should use `PipelineUtils#promiseToProcessContent` for better error handling.
		PipelineUtils.processContentInPipeline(this.env, this, content, opts);
		return cb.promise;
	}

	/**
	 * Event handler for chunk conversion pipelines.
	 * @private
	 */
	onThunkEvent(state, notYetDone, ret) {
		if (notYetDone) {
			state.accum = JSUtils.pushArray(state.accum, TokenUtils.stripEOFTkfromTokens(ret));
			this.env.log('debug', 'Frame.onThunkEvent accum:', state.accum);
		} else {
			this.env.log('debug', 'Frame.onThunkEvent:', state.accum);
			state.cb(null, state.accum);
		}
	}

	/**
	 * Check if expanding a template would lead to a loop, or would exceed the
	 * maximum expansion depth.
	 *
	 * @param {string} title
	 */
	loopAndDepthCheck(title, maxDepth, ignoreLoop) {
		if (this.depth > maxDepth) {
			// Too deep
			return `Template recursion depth limit exceeded (${maxDepth}): `;
		}
		if (ignoreLoop) { return false; }
		let elem = this;
		do {
			if (title && elem.title && Util.titleEquals(elem.title, title)) {
				// Loop detected
				return 'Template loop detected: ';
			}
			elem = elem.parentFrame;
		} while (elem);
		// No loop detected.
		return false;
	}

	_getID(options) {
		if (!options || !options.cb) {
			console.trace();
			console.warn('Error in Frame._getID: no cb in options!');
		} else {
			return options.cb(this);
		}
	}
}

if (typeof module === "object") {
	module.exports = {
		Frame,
	};
}
