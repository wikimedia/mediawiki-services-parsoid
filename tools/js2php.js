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
	'pegTokenizer.pegjs': 'PegTokenizer.pegphp',
};
const BASEDIR = path.join(__dirname, '..');

const remapName = function(f) {
	return f.split(/[/]/g).map(function(piece, idx, arr) {
		var isLast = (idx + 1) >= arr.length;
		if (MAPPING[piece]) { return MAPPING[piece]; }
		if (isLast) { return piece.replace(/[.]js$/, '.php'); }
		return piece.slice(0, 1).toUpperCase() + piece.slice(1);
	}).join('/');
};

const rewriteFile = Promise.async(function *(filename, search, replace) {
	var contents = yield fs.readFile(filename, 'utf8');
	contents = contents.replace(search, replace);
	yield fs.writeFile(filename, contents, 'utf8');
});

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
		if (!WATERMARK_RE.test(yield fs.readFile(newFile, 'utf8'))) { continue; }

		/* run our translation tool! */
		var isPeg = /\.pegjs$/.test(oldFile);
		try {
			var args = (isPeg ? [ '--braced' ] : [])
				.concat([
					'--namespace', 'Parsoid',
					'--watermark', WATERMARK,
					oldFile, newFile,
				]);
			yield childProcess.execFile(
				path.join(BASEDIR, 'node_modules', '.bin', 'js2php'), args, {
					cwd: BASEDIR,
					env: process.env,
				}).promise;
		} catch (e1) {
			console.log(`SKIPPING ${oldFile}`);
			continue;
		}
		if (isPeg) { continue; }
		// Now run phpcbf, but it's allowed to return non-zero
		try {
			yield childProcess.execFile(
				path.join(BASEDIR, 'vendor', 'bin', 'phpcbf'), [
					newFile,
				]).promise;
		} catch (e2) { /* of course there were code style issues */ }
		// Comment length warnings are bogus...
		yield rewriteFile(
			newFile, /^<\?php\n/,
			'$&// phpcs:disable Generic.Files.LineLength.TooLong\n'
		);
		// So, were we successful?  If not, disable phpcs for this file.
		var codeStyleErrors = false;
		try {
			yield childProcess.execFile(
				path.join(BASEDIR, 'vendor', 'bin', 'phpcs'), [
					newFile,
				]).promise;
		} catch (e3) {
			codeStyleErrors = true;
			yield rewriteFile(
				newFile, /^<\?php\n/,
				'$&// phpcs:ignoreFile\n'
			);
		}
		// Same idea, but for lint errors
		var lintErrors = false;
		try {
			yield childProcess.execFile(
				path.join(BASEDIR, 'vendor', 'bin', 'parallel-lint'), [
					newFile,
				]).promise;
		} catch (e4) {
			lintErrors = true;
			yield rewriteFile(
				newFile, /^<\?php\n/,
				'<?php // lint >= 99.9\n'
			);
		}
		process.stdout.write(
			codeStyleErrors ?
				(lintErrors ? 'X' : '^') :
				(lintErrors ? 'v' : '.')
		);
	}
	process.stdout.write('\n');
	console.log('all done');
})().done();
