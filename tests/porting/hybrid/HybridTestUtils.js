'use strict';

const childProcess = require('child_process');
const path = require('path');

class HybridTestUtils {
	static updateEnvIdCounters(env, body) {
		// Extract piggybacked env uid from <body>
		env.uid = parseInt(body.getAttribute("data-env-newuid"), 10);
		body.removeAttribute("data-env-newuid");

		// Extract piggybacked env fid from <body>
		env.uid = parseInt(body.getAttribute("data-env-newfid"), 10);
		body.removeAttribute("data-env-newfid");
	}

	static mkEnvOpts(env, frame, extra = {}) {
		return Object.assign({}, {
			currentUid: env.uid,
			currentFid: env.fid,
			pageContent: frame.srcText,
			prefix: env.conf.wiki.iwp,
			apiURI: env.conf.wiki.apiURI,
			pagelanguage: env.page.pagelanguage,
			pagelanguagedir: env.page.pagelanguagedir,
			pagetitle: env.normalizeAndResolvePageTitle(),
			pagens: env.page.ns,
			pageId: env.page.id,
			traceFlags: Array.from(env.conf.parsoid.traceFlags || []),
			dumpFlags: Array.from(env.conf.parsoid.dumpFlags || []),
			debugFlags: Array.from(env.conf.parsoid.debugFlags || []),
			tags: Array.from(env.conf.wiki.extConfig.tags.keys()),
			fragmentMap: Array.from(env.fragmentMap.entries()).map((pair) => {
				const [k,v] = pair;
				return [k, v.map(node => node.outerHTML)];
			}),
			wrapSections: env.wrapSections,
			rtTestMode: env.conf.parsoid.rtTestMode,
			scrubWikitext: env.scrubWikitext,
			tidyWhitespaceBugMaxLength: env.conf.parsoid.linter.tidyWhitespaceBugMaxLength,
			discardDataParsoid: env.discardDataParsoid,
			pageBundle: env.pageBundle,
			offline: !env.conf.parsoid.usePHPPreProcessor,
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
