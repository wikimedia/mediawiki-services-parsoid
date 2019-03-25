'use strict';

const fs = require('fs');
const PegTokenizer = require('../../lib/wt2html/tokenizer.js');
const getStream = require('get-stream');

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
		newAboutId: () => '#1', // #1 always
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

let inputStream, outputStream;

if (process.argv[2]) {
	inputStream = fs.createReadStream(process.argv[2], { encoding: 'utf8' });
	outputStream = fs.createWriteStream(process.argv[2] + ".js.tokens", { encoding: 'utf8' });
} else {
	inputStream = process.stdin;
	outputStream = process.stdout;
}
getStream(inputStream).then(function(input) {
	const tokens = parse(input);
	outputStream.write(tokens.map(t => JSON.stringify(t)).join('\n') + '\n');
});
