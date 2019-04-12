/** @module */

'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const TokenHandler = require('../../../lib/wt2html/tt/TokenHandler.js');
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
			pageContent: env.page.src,
			prefix: env.conf.wiki.iwp,
			apiURI: env.conf.wiki.apiURI,
			pagelanguage: env.page.pagelanguage,
			pagelanguagedir: env.page.pagelanguagedir,
			pagetitle: env.page.title,
			pagens: env.page.ns,
			tags: Array.from(env.conf.wiki.extConfig.tags.keys()),

			toplevel: this.atTopLevel,
			pipeline: this.options,
			pipelineId: this.manager.pipelineId,
		};
		const res = childProcess.spawnSync("php", [
			path.resolve(__dirname, "runTokenTransformer.php"),
			this.transformerName,
			fileName,
		], { input: JSON.stringify(opts) });

		const stderr = res.stderr.toString();
		if (stderr) {
			console.error(stderr);
		}

		const toks = res.stdout.toString().split("\n").map((str) => {
			return str ? JSON.parse(str, (k, v) => TokenUtils.getToken(v)) : "";
		});

		return toks;
	}
}

if (typeof module === "object") {
	module.exports.PHPTokenTransformer = PHPTokenTransformer;
}
