/** @module */

'use strict';

const fs = require('fs');
const TokenHandler = require('../../../lib/wt2html/tt/TokenHandler.js');
const { HybridTestUtils }  = require('./HybridTestUtils.js');
const { TokenUtils } = require('../../../lib/utils/TokenUtils.js');

/**
 * Wrapper that invokes a PHP token transformer to do the work
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class PHPTokenTransformer extends TokenHandler {
	constructor(env, manager, name, options) {
		super(manager, options);
		this.transformerName = name;
	}

	processTokensSync(env, tokens, traceState) {
		if (!(/^\w+$/.test(this.transformerName))) {
			console.error("Transformer name " + this.transformerName + " failed sanity check.");
			process.exit(-1);
		}

		const fileName = `/tmp/${this.transformerName}.${process.pid}.tokens`;
		fs.writeFileSync(fileName, tokens.map(t => JSON.stringify(t)).join('\n'));

		const opts = {
			envOpts: HybridTestUtils.mkEnvOpts(env),
			pipelineOpts: this.options,
			pipelineId: this.manager.pipelineId,
			topLevel: this.atTopLevel,
		};

		const res = HybridTestUtils.runPHPCode(
			"runTokenTransformer.php",
			[this.transformerName, fileName],
			opts
		);

		// First line will be the new UID for env
		const lines = res.trim().split("\n");
		const newEnvUID = lines.shift();
		this.env.uid = parseInt(newEnvUID, 10);

		const toks = lines.map((str) => {
			return str ? JSON.parse(str, (k, v) => TokenUtils.getToken(v)) : "";
		});

		return toks;
	}
}

if (typeof module === "object") {
	module.exports.PHPTokenTransformer = PHPTokenTransformer;
}
