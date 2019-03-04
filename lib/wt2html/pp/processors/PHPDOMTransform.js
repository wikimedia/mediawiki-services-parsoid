'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { ContentUtils } = require('../../../utils/ContentUtils.js');

class PHPDOMTransform {
	run(transformerName, root, env, options, atTopLevel) {
		if (!(/^\w+$/.test(transformerName))) {
			console.error("Transformer name failed sanity check.");
			process.exit(-1);
		}

		const opts = this.options || {};
		// These are the only env properties used by DOM processors
		// in wt2html/pp/processors/*. Handlers may use other properties.
		// We can cross that bridge when we get there.
		opts.wrapSections = env.wrapSections;
		opts.rtTestMode = env.conf.parsoid.rtTestMode;
		opts.pageContent = env.page.src;
		opts.sourceOffsets = options.sourceOffsets;

		const html = ContentUtils.ppToXML(root, { tunnelFosteredContent: true, keepTmp: true });
		const fileName = `/tmp/${transformerName}.${process.pid}.html`;
		fs.writeFileSync(fileName, html);

		const res = childProcess.spawnSync("php", [
			path.resolve(__dirname, "../../../../bin/runDOMTransform.php"),
			transformerName,
			fileName
		], { input: JSON.stringify(opts) });

		const stdout = res.stdout.toString();
		const stderr = res.stderr.toString();
		if (stderr) {
			console.error(stderr);
		}

		const newDom = ContentUtils.ppToDOM(env, stdout, {
			reinsertFosterableContent: true,
			markNew: true
		}).ownerDocument;
		return newDom;
	}
}

if (typeof module === "object") {
	module.exports.PHPDOMTransform = PHPDOMTransform;
}
