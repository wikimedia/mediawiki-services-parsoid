/** @module */

'use strict';

const path = require('path');
const childProcess = require('child_process');
const TokenHandler = require('./TokenHandler.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');

/**
 * Wrapper that invokes a PHP token transformer to do the work
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class PHPTransformer extends TokenHandler {
	constructor(manager, name, options) {
		super(manager, options);
		this.phpTransformer = name;
	}

	processTokensSync(env, tokens, traceState) {
		const commandLine = [
			"php",
			path.resolve(__dirname, "../../../bin/runTransform.php"),
			this.phpTransformer,
		].join(' ');
		const pipelineOpts = JSON.stringify(this.options) + "\n";
		const inputToks = tokens.map(t => JSON.stringify(t)).join('\n');
		// console.log("INPUT: " + inputToks);
		const stdout = childProcess.execSync(commandLine, { input: pipelineOpts + inputToks }).toString();
		const toks = stdout.split("\n").map((str) => {
			return str ? JSON.parse(str, (k, v) => TokenUtils.getToken(v)) : "";
		});
		// console.log("OUTPUT: " + JSON.stringify(toks));
		return toks;
	}
}

if (typeof module === "object") {
	module.exports.PHPTransformer = PHPTransformer;
}
