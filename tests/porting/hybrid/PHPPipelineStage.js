/** @module */

'use strict';

const childProcess = require('child_process');
const events = require('events');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { TokenUtils } = require('../../../lib/utils/TokenUtils.js');
const { ContentUtils } = require('../../../lib/utils/ContentUtils.js');

/**
 * Wrapper that invokes a PHP token stage to do the work
 *
 * @class
 */
class PHPPipelineStage {
	constructor(env, pipeFactory, name, options) {
		events.EventEmitter.call(this);
		this.env = env;
		this.pipeFactory = pipeFactory;
		this.stageName = name;
		this.options = options;
		this.resetState();
	}

	addListenersOn(emitter) {
		switch (this.stageName) {
			case 'SyncTokenTransformManager':
			case 'AsyncTokenTransformManager':
			case 'HTML5TreeBuilder':
				emitter.addListener('chunk', (tokens) => {
					this.tokens = this.tokens.concat(tokens);  // Buffer
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
				this.emit('chunk', output);
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

	runPHPCode(argv, opts) {
		const res = childProcess.spawnSync(
			"php",
			[ path.resolve(__dirname, "runPipelineStage.php"), this.stageName ].concat(argv),
			{ input: JSON.stringify(opts) }
		);

		const stderr = res.stderr.toString();
		if (stderr) {
			console.error(stderr);
		}

		return res.stdout.toString();
	}

	loadDOMFromStdout(out) {
		return ContentUtils.ppToDOM(this.env, out, {
			reinsertFosterableContent: true,
			markNew: true
		}).ownerDocument;
	}

	emitTokens(out) {
		const toks = out.trim().split("\n").map((str) => {
			return str ? JSON.parse(str, (k, v) => TokenUtils.getToken(v)) : "";
		});
		// console.log("TOKS: " + JSON.stringify(toks));
		this.emitEvents(toks);
	}

	emitDoc(out) {
		this.emitEvents(this.loadDOMFromStdout(out));
	}

	// called only for the tokenizer (stage 1)
	process(input, sol) {
		const fileName = `/tmp/${this.stageName}.${process.pid}.txt`;
		fs.writeFileSync(fileName, input);
		const out = this.runPHPCode([fileName], {
			pipeline: this.options,
			sol: sol,
			offsets: this.sourceOffsets,
			pageContent: this.env.page.src
		});
		// console.log("IN: " + input);
		this.emitTokens(out);
	}

	setSourceOffsets(start, end) {
		this.sourceOffsets = [start, end];
	}

	resetState() {
		this.tokens = [];
		this.sourceOffsets = null;
	}

	// called for stages 2-5 (sync, async ttms + tree builder)
	processTokens() {
		const fileName = `/tmp/${this.stageName}.${process.pid}.tokens`;
		fs.writeFileSync(fileName, this.tokens.map(t => JSON.stringify(t)).join('\n'));

		const out = this.runPHPCode([fileName], {
			pipeline: this.options,
			pageContent: this.env.page.src
		});

		if (this.stageName === 'HTML5TreeBuilder') {
			this.emitDoc(out);
		} else {
			this.emitTokens(out);
		}
	}

	// called for stage 5 (DOM Post Processor)
	processDocument(doc) {
		const fileName = `/tmp/${this.stageName}.${process.pid}.html`;
		const html = ContentUtils.ppToXML(doc.body, { tunnelFosteredContent: true, keepTmp: true });
		fs.writeFileSync(fileName, html);
		const out = this.runPHPCode([fileName], {
			pipeline: this.options,
			pageContent: this.env.page.src
		});
		this.emitDoc(out);
	}
}

// Inherit from EventEmitter
util.inherits(PHPPipelineStage, events.EventEmitter);


if (typeof module === "object") {
	module.exports.PHPPipelineStage = PHPPipelineStage;
}
