'use strict';

const childProcess = require('child_process');
const path = require('path');

class HybridTestUtils {
	static updateEnvUid(env, body) {
		// Extract piggybacked env uid from <body>
		env.uid = parseInt(body.getAttribute("data-env-newuid"), 10);
		body.removeAttribute("data-env-newuid");
	}

	static mkEnvOpts(env, extra = {}) {
		return Object.assign({}, {
			currentUid: env.uid,
			pageContent: env.page.src,
			prefix: env.conf.wiki.iwp,
			apiURI: env.conf.wiki.apiURI,
			pagelanguage: env.page.pagelanguage,
			pagelanguagedir: env.page.pagelanguagedir,
			pagetitle: env.page.title,
			pagens: env.page.ns,
			pageId: env.page.id,
			tags: Array.from(env.conf.wiki.extConfig.tags.keys()),
			fragmentMap: Array.from(env.fragmentMap.entries()).map((pair) => {
				const [k,v] = pair;
				return [k, v.map(node => node.outerHTML)];
			}),
			wrapSections: env.wrapSections,
			rtTestMode: env.conf.parsoid.rtTestMode,
			tidyWhitespaceBugMaxLength: env.conf.parsoid.linter.tidyWhitespaceBugMaxLength,
			discardDataParsoid: env.discardDataParsoid,
			pageBundle: env.pageBundle,
		}, extra);
	}

	static runPHPCode(phpScriptName, argv, opts) {
		const res = childProcess.spawnSync("php", [
			path.resolve(__dirname, phpScriptName)
		].concat(argv), {
			input: JSON.stringify(opts),
			stdio: [ 'pipe', 'pipe', process.stderr ],
		});
		if (res.error) {
			throw res.error;
		}

		return res.stdout.toString();
	}

}

if (typeof module === "object") {
	module.exports.HybridTestUtils = HybridTestUtils;
}
