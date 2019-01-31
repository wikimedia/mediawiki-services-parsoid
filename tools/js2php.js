#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');
const childProcess = require('pn/child_process');
const fs = require('pn/fs');
const path = require('path');

const { JSUtils } = require('../lib/utils/jsutils.js');
const Promise = require('../lib/utils/promise.js');

const WATERMARK = "REMOVE THIS COMMENT AFTER PORTING";
const WATERMARK_RE = new RegExp(JSUtils.escapeRegExp('/* ' + WATERMARK + ' */'));

const MAPPING = {
	'lib': 'src',
	'html2wt': 'Html2Wt',
	'wt2html': 'Wt2Html',
	'tt': 'TT',
	'pp': 'PP',
};
const BASEDIR = path.join(__dirname, '..');

const remapName = function(f) {
	return f.split(/[/]/g).map(function(piece, idx, arr) {
		var isLast = (idx + 1) >= arr.length;
		if (isLast) { return piece.replace(/[.]js$/, '.php'); }
		if (MAPPING[piece]) { return MAPPING[piece]; }
		return piece.slice(0, 1).toUpperCase() + piece.slice(1);
	}).join('/');
};

Promise.async(function *() {
	const files = (yield childProcess.execFile(
		'git', ['ls-files'], {
			cwd: path.join(BASEDIR, 'lib'),
			env: process.env,
		}).promise).stdout.split(/\n/g).filter(s => !!s);
	for (let oldFile of files) {
		const newFile = path.join(BASEDIR, 'src', remapName(oldFile));
		oldFile = path.join(BASEDIR, 'lib', oldFile);
		console.assert(yield fs.exists(oldFile));
		if (!(yield fs.exists(newFile))) { continue; /* Skip this */ }
		/* check for the watermark string; only overwrite if it is present */
		/* this ensures we don't overwrite actually-ported files */
		if (!WATERMARK_RE.test(fs.readFileSync(newFile, 'utf8'))) { continue; }

		/* run our translation tool! */
		// console.log(oldFile);
		try {
			yield childProcess.execFile(
				path.join(BASEDIR, 'node_modules', '.bin', 'js2php'), [
					'--namespace', 'Parsoid',
					'--watermark', WATERMARK,
					oldFile, newFile,
				], {
					cwd: BASEDIR,
					env: process.env,
				}).promise;
		} catch (e) {
			console.log(`SKIPPING ${oldFile}`);
		}
	}
	console.log('all done');
})().done();
