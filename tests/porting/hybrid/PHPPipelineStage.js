/** @module */

'use strict';

const events = require('events');
const fs = require('fs');
const util = require('util');
const { ContentUtils } = require('../../../lib/utils/ContentUtils.js');
const { DOMUtils }  = require('../../../lib/utils/DOMUtils.js');
const { HybridTestUtils }  = require('./HybridTestUtils.js');
const { TokenUtils } = require('../../../lib/utils/TokenUtils.js');

/**
 * Wrapper that invokes a PHP token stage to do the work
 *
 * @class
 */
class PHPPipelineStage {
	constructor(env, options, pipeFactory, name) {
		events.EventEmitter.call(this);
		this.env = env;
		this.pipeFactory = pipeFactory;
		this.stageName = name;
		this.options = options;
		this.pipelineId = -1;
		this.tokens = [];
		this.resetState();
		// For Sync & Async TTMs
		this.phaseEndRank = -1; // set by parser.js
		this.transformers = []; // array of transformer names set by parser.js
	}

	setPipelineId(id) {
		this.pipelineId = id;
	}

	setSourceOffsets(start, end) {
		this.sourceOffsets = [start, end];
	}

	resetState(opts) {
		this.tokens = [];
		this.sourceOffsets = null;
		this.atTopLevel = opts && opts.toplevel;
	}

	addListenersOn(emitter) {
		switch (this.stageName) {
			case 'SyncTokenTransformManager':
			case 'AsyncTokenTransformManager':
			case 'HTML5TreeBuilder':
				emitter.addListener('chunk', (tokens) => {
					this.tokens = this.tokens.concat(tokens); // Buffer
				});
				emitter.addListener('end', () => this.processTokens());
				break;

			case 'DOMPostProcessor':
				emitter.addListener('document', doc => this.processDocument(doc));
				break;

			// Tokenizer has no listeners registered
			default:
				console.assert(false, 'Should not get here!');
		}
	}

	emitEvents(output) {
		switch (this.stageName) {
			case 'PegTokenizer':
			case 'SyncTokenTransformManager':
			case 'AsyncTokenTransformManager':
				for (const chunk of output) {
					if (this.stageName === 'PegTokenizer') {
						this.env.log('trace/peg', this.pipelineId, '---->  ', chunk);
					}
					this.emit('chunk', chunk);
				}
				this.emit('end');
				break;

			case 'HTML5TreeBuilder':
			case 'DOMPostProcessor':
				this.emit('document', output);
				break;

			default:
				console.assert(false, 'Should not get here!');
		}
	}

	emitTokens(out) {
		// First line will be the new UID for env
		const lines = out.trim().split("\n");
		const newEnvUID = lines.shift();
		this.env.uid = parseInt(newEnvUID, 10);

		const toks = [];
		let chunk = [];
		for (const str of lines) {
			if (str === '--') {
				toks.push(chunk);
				chunk = [];
			} else if (str) {
				chunk.push(JSON.parse(str, (k, v) => TokenUtils.getToken(v)));
			}
		}
		if (chunk.length) { toks.push(chunk); }
		this.emitEvents(toks);
	}

	mkOpts(extra = {}) {
		return Object.assign({
			envOpts: HybridTestUtils.mkEnvOpts(this.env),
			pipelineOpts: this.options,
			pipelineId: this.pipelineId,
			toplevel: this.atTopLevel,
		}, extra);
	}

	// called only for the tokenizer (stage 1)
	processWikitext(input, sol) {
		const fileName = `/tmp/${this.stageName}.${process.pid}.txt`;
		fs.writeFileSync(fileName, input);
		this.env.log('trace/pre-peg', this.pipelineId, () => JSON.stringify(input));
		const out = HybridTestUtils.runPHPCode(
			"runPipelineStage.php",
			[this.stageName, fileName],
			this.mkOpts({
				sol: sol,
				offsets: this.sourceOffsets,
			})
		);
		this.emitTokens(out);
	}

	// called for stages 2-5 (sync, async ttms + tree builder)
	processTokens() {
		const fileName = `/tmp/${this.stageName}.${process.pid}.tokens`;
		const input = this.tokens.map(t => JSON.stringify(t)).join('\n');
		fs.writeFileSync(fileName, input);

		const out = HybridTestUtils.runPHPCode(
			"runPipelineStage.php",
			[this.stageName, fileName],
			this.mkOpts({
				phaseEndRank: this.phaseEndRank,
				transformers: this.transformers, // will only be relevant for sync & aync ttms
			})
		);

		if (this.stageName === 'HTML5TreeBuilder') {
			const body = ContentUtils.ppToDOM(this.env, out, {
				reinsertFosterableContent: true,
				markNew: true
			});
			HybridTestUtils.updateEnvIdCounters(this.env, body);
			this.emitEvents(body.ownerDocument);
		} else {
			this.emitTokens(out);
		}
	}

	// called for stage 5 (DOM Post Processor)
	processDocument(doc) {
		const fileName = `/tmp/${this.stageName}.${process.pid}.html`;
		const html = ContentUtils.ppToXML(doc.body, { tunnelFosteredContent: true, keepTmp: true });
		fs.writeFileSync(fileName, html);
		const out = HybridTestUtils.runPHPCode(
			"runPipelineStage.php",
			[this.stageName, fileName],
			this.mkOpts({})
		);
		if (this.atTopLevel) {
			doc = DOMUtils.parseHTML(out);
		} else {
			doc = ContentUtils.ppToDOM(this.env, out, {
				reinsertFosterableContent: true,
			}).ownerDocument;
		}
		HybridTestUtils.updateEnvIdCounters(this.env, doc.body);
		this.emitEvents(doc);
	}

	process(input, sol) {
		switch (this.stageName) {
			case 'PegTokenizer':
				this.processWikitext(input, sol);
				break;

			case 'SyncTokenTransformManager':
			case 'AsyncTokenTransformManager':
				this.tokens = input;
				this.processTokens();
				break;

			case 'TreeBuilder':
			case 'DOMPostProcessor':
				console.error("--Not handled yet--");
				process.exit(-1);
				break;

			default:
				console.assert(false, 'Should not get here!');
		}
	}
}

// Inherit from EventEmitter
util.inherits(PHPPipelineStage, events.EventEmitter);

if (typeof module === "object") {
	module.exports.PHPPipelineStage = PHPPipelineStage;
}
