'use strict';

const fs = require('fs');
const PegTokenizer = require('../../lib/wt2html/tokenizer.js');

function parse(input) {
	function nop() {}
	function returnFalse() { return false; }

	const env = {
		log: nop,
		conf: {
			wiki: {
				extConfig: {
					tags: new Map([
						['pre', true],
						['nowiki', true],
						['gallery', true],
						['indicator', true],
						['timeline', true],
						['hiero', true],
						['charinsert', true],
						['ref', true],
						['references', true],
						['inputbox', true],
						['imagemap', true],
						['source', true],
						['syntaxhighlight', true],
						['poem', true],
						['section', true],
						['score', true],
						['templatedata', true],
						['math', true],
						['ce', true],
						['chem', true],
						['graph', true],
						['maplink', true],
						['categorytree', true],
					]),
				},
				getMagicWordMatcher: () => { return { test: returnFalse }; },
				isMagicWord: returnFalse,
				hasValidProtocol: prot => /^http/.test(prot),
			},
			parsoid: {
				traceFlags: new Map(),
				maxDepth: 40,
			},
		},
		immutable: false,
		langConverterEnabled: () => true, // true always
		bumpParserResourceUse: nop,
		newAboutId: () => -1, // -1 always
	};
	const tokenizer = new PegTokenizer.PegTokenizer(env);
	tokenizer.initTokenizer();
	const tokens = [];
	tokenizer.tokenizeSync(input, {
		cb: t => tokens.push(t),
		pegTokenizer: tokenizer,
		pipelineOffset: 0,
		env: env,
		pegIncludes: PegTokenizer.pegIncludes,
		startRule: "start"
	});
	return tokens;
}

const inputFile = process.argv[2];
const input = fs.readFileSync(inputFile, 'utf8');
const tokens = parse(input);
fs.writeFileSync(inputFile + ".js.tokens", tokens.map(t => JSON.stringify(t)).join('\n'));
