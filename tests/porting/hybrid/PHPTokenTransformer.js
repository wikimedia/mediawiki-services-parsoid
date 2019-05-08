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
			currentUid: env.uid,
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
			fragmentMap: Array.from(env.fragmentMap.entries()).map((pair) => {
				const [k,v] = pair;
				return [k, v.map(node => node.outerHTML)];
			}),
		};
		const res = childProcess.spawnSync("php", [
			path.resolve(__dirname, "runTokenTransformer.php"),
			this.transformerName,
			fileName,
		], {
			input: JSON.stringify(opts),
			stdio: [ 'pipe', 'pipe', process.stderr ],
		});
		if (res.error) {
			throw res.error;
		}

		// First line will be the new UID for env
		const lines = res.stdout.toString().trim().split("\n");
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
