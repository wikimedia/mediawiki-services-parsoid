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

	resetState() {
		this.tokens = [];
		this.sourceOffsets = null;
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

	runPHPCode(argv, opts) {
		opts.pipeline = this.options;
		opts.pageContent = this.env.page.src;
		opts.pipelineId = this.pipelineId;
		const res = childProcess.spawnSync("php", [
			path.resolve(__dirname, "runPipelineStage.php"),
			this.stageName
		].concat(argv), {
			input: JSON.stringify(opts),
			stdio: [ 'pipe', 'pipe', process.stderr ],
		});
		if (res.error) {
			throw res.error;
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
		const toks = [];
		let chunk = [];
		for (const str of out.trim().split("\n")) {
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

	emitDoc(out) {
		this.emitEvents(this.loadDOMFromStdout(out));
	}

	mkOpts(extra = {}) {
		return Object.assign({}, {
			pageContent: this.env.page.src,
			prefix: this.env.conf.wiki.iwp,
			apiURI: this.env.conf.wiki.apiURI,
			pagelanguage: this.env.page.pagelanguage,
			pagelanguagedir: this.env.page.pagelanguagedir,
			pagetitle: this.env.page.title,
			pagens: this.env.page.ns,
			tags: Array.from(this.env.conf.wiki.extConfig.tags.keys()),
		}, extra);
	}

	// called only for the tokenizer (stage 1)
	processWikitext(input, sol) {
		const fileName = `/tmp/${this.stageName}.${process.pid}.txt`;
		fs.writeFileSync(fileName, input);
		this.env.log('trace/pre-peg', this.pipelineId, () => JSON.stringify(input));
		const out = this.runPHPCode([fileName], this.mkOpts({
			sol: sol,
			offsets: this.sourceOffsets,
		}));
		this.emitTokens(out);
	}

	// called for stages 2-5 (sync, async ttms + tree builder)
	processTokens() {
		const fileName = `/tmp/${this.stageName}.${process.pid}.tokens`;
		const input = this.tokens.map(t => JSON.stringify(t)).join('\n');
		fs.writeFileSync(fileName, input);

		const out = this.runPHPCode([fileName], this.mkOpts({
			phaseEndRank: this.phaseEndRank,
			transformers: this.transformers, // will only be relevant for sync & aync ttms
		}));

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
		const out = this.runPHPCode([fileName], this.mkOpts({}));
		this.emitDoc(out);
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
