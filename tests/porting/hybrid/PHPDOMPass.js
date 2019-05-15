'use strict';

const fs = require('fs');
const { ContentUtils } = require('../../../lib/utils/ContentUtils.js');
const { DOMUtils }  = require('../../../lib/utils/DOMUtils.js');
const { HybridTestUtils }  = require('./HybridTestUtils.js');

class PHPDOMPass {
	dumpDOMToFile(root, fileName) {
		const html = ContentUtils.ppToXML(root, {
			tunnelFosteredContent: true,
			keepTmp: true,
			storeDiffMark: true
		});
		fs.writeFileSync(fileName, html);
	}

	loadDOMFromStdout(inputBody, transformerName, atTopLevel, env, stdout) {
		let newDOM;

		if (transformerName === 'CleanUp-cleanupAndSaveDataParsoid') {
			// HACK IT! Cleanup only runs on the top-level.
			// For nested pipelines, the DOM is unmodified.
			// We aren't verifying this functionality since it adds
			// to the complexity of passing DOMs across JS/PHP.
			if (atTopLevel) {
				newDOM = DOMUtils.parseHTML(stdout);
				HybridTestUtils.updateEnvIdCounters(env, newDOM.body);
			} else {
				newDOM = inputBody.ownerDocument;
			}
		} else if (transformerName === 'Linter') {
			env.lintLogger.buffer = env.lintLogger.buffer.concat(JSON.parse(stdout));
			// DOM is not modified
			newDOM = inputBody.ownerDocument;
		} else {
			newDOM = ContentUtils.ppToDOM(env, stdout, {
				reinsertFosterableContent: true,
				markNew: true
			}).ownerDocument;
			HybridTestUtils.updateEnvIdCounters(env, newDOM.body);
		}

		return newDOM;
	}

	mkOpts(env, extraOpts = {}, extraEnvOpts = {}) {
		return Object.assign({
			envOpts: HybridTestUtils.mkEnvOpts(env, extraEnvOpts)
		}, extraOpts);
	}

	wt2htmlPP(transformerName, root, env, options, atTopLevel) {
		if (!(/^[\w\-]+$/.test(transformerName))) {
			console.error("Transformer name failed sanity check.");
			process.exit(-1);
		}

		const fileName = `/tmp/${transformerName}.${process.pid}.html`;
		this.dumpDOMToFile(root, fileName);
		const res = HybridTestUtils.runPHPCode(
			"runDOMPass.php",
			[transformerName, fileName],
			this.mkOpts(env, {
				toplevel: !!atTopLevel,
				pipelineId: -1 /* FIXME */,
				sourceOffsets: options.sourceOffsets,
				runOptions: options || {},
			})
		);

		return this.loadDOMFromStdout(root, transformerName, atTopLevel, env, res);
	}

	diff(env, domA, domB) {
		const fileName1 = `/tmp/diff.${process.pid}.f1.html`;
		this.dumpDOMToFile(domA, fileName1);
		const fileName2 = `/tmp/diff.${process.pid}.f2.html`;
		this.dumpDOMToFile(domB, fileName2);
		const res = HybridTestUtils.runPHPCode(
			"runDOMPass.php",
			["DOMDiff", fileName1, fileName2],
			this.mkOpts(env, {
				toplevel: true,
				pipelineId: -1 /* FIXME */,
			})
		);

		const ret = JSON.parse(res);
		ret.dom = ContentUtils.ppToDOM(env, ret.html, {
			reinsertFosterableContent: true,
			markNew: true
		}).ownerDocument.body;

		HybridTestUtils.updateEnvIdCounters(env, ret.dom);

		return ret;
	}

	normalizeDOM(state, body) {
		const fileName = `/tmp/normalize.${process.pid}${state.selserMode ? '.selser' : ''}.html`;
		this.dumpDOMToFile(body, fileName);
		const res = HybridTestUtils.runPHPCode(
			"runDOMPass.php",
			["DOMNormalizer", fileName],
			this.mkOpts(state.env, {
				toplevel: true,
				selserMode: state.selserMode,
				rtTestMode: state.rtTestMode,
				pipelineId: -1 /* FIXME */,
			}, {
				scrubWikitext: state.env.scrubWikitext
			})
		);
		return this.loadDOMFromStdout(body, 'normalizeDOM', true, state.env, res).body;
	}

	serialize(env, body, useSelser) {
		// We are using outerHTML because the DOMs haven't had
		// their attributes loaded via loadDataAttribs
		const fileName1 = `/tmp/page.${process.pid}.edited.html`;
		fs.writeFileSync(fileName1, body.outerHTML);
		const fileName2 = `/tmp/page.${process.pid}.orig.html`;
		if (useSelser) {
			fs.writeFileSync(fileName2, env.page.dom.body.outerHTML);
		}

		return HybridTestUtils.runPHPCode(
			"runDOMPass.php",
			["HTML2WT", useSelser, fileName1].concat(useSelser ? [fileName2] : []),
			this.mkOpts(env, {
				toplevel: true,
				pipelineId: -1 /* FIXME */,
			})
		);
	}
}

if (typeof module === "object") {
	module.exports.PHPDOMPass = PHPDOMPass;
}
