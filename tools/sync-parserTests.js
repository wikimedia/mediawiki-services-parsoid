#!/usr/bin/env node

"use strict";

require('../core-upgrade.js');

/**
 * == USAGE ==
 *
 * Script to synchronize parsoid parserTests with parserTests in other repos.
 *
 * Basic use:
 * $PARSOID is the path to a checked out git copy of Parsoid
 * $TARGET_REPO identifies which set of parserTests we're synchronizing.
 *   This should be one of the top-level keys in tests/parserTests.json,
 *   like 'core' or 'Cite'.
 *   The `path` key under that gives the gerrit project name for the repo; see
 *       https://gerrit.wikimedia.org/r/admin/repos/$project
 * $REPO_PATH is the path to a checked out git copy of the repo containing
 *   the parserTest file on your local machine.
 * $BRANCH is a branch name for the patch to $TARGET_REPO (ie, 'ptsync-<date>')
 *
 *   $ cd $PARSOID
 *   $ tools/sync-parserTests.js $TARGET_REPO $REPO_PATH $BRANCH
 *   $ cd $REPO_PATH
 *   $ git rebase --keep-empty master origin/master
 *     ... resolve conflicts, sigh ...
 *   $ php tests/parser/parserTests.php
 *     ... fix any failures by marking tests parsoid-only, etc ...
 *   $ git review  (only if the patch is not empty, see below)
 *
 *     ... time passes, eventually your patch is merged to $TARGET_REPO ...
 *
 *   (You might be tempted to skip the following step if the previous
 *   patch was empty, or the merged parser tests file is now identical
 *   to Parsoid's copy and you think "there is nothing to pull from
 *   core/the extension".  But don't; see "Empty Patches" below. On
 *   the other hand, if you need to sync core and multiple extensions,
 *   it's fine to do the steps above for them all and get them all
 *   merged before continuing.)
 *
 *   $ cd $PARSOID
 *   $ tools/fetch-parserTests.txt.js $TARGET_REPO
 *   $ php bin/parserTests.php --updateKnownFailures
 *   $ git add -u
 *   $ git commit -m "Sync parserTests with core"
 *   $ git review
 *
 *   Simple, right?
 *
 * == WHY ==
 *
 * There are two copies of parserTests files.
 *
 * Since Parsoid & core are in different repositories and both Parsoid
 * and the legacy parser are still operational, we need a parserTests
 * file in each repository. They are usually in sync but since folks
 * are hacking both wikitext engines simultaneously, the two copies
 * might be modified independently. So, we need to periodically sync
 * them (which is just a multi-repo rebase).
 *
 * We detect incompatible divergence of the two copies via CI. We run the
 * legacy parser against Parsoid's copy of the test file and test failures
 * indicate a divergence and necessitates a sync. Core also runs Parsoid
 * against core's copy of the test file in certain circumstances (and
 * this uses the version of Parsoid from mediawiki-vendor, which is
 * "the latest deployed version" not "the latest version").
 *
 * This discussion only touched upon tests/parser/parserTests.txt but
 * all of the same considerations apply to the parser test file for
 * extensions since we have a Parsoid-version and a legacy-parser version
 * of many extensions at this time.  When CI runs tests on extension
 * repositories it runs them through both the legacy parser and
 * Parsoid (but only if you opt-in by adding a 'parsoid-compatible'
 * flag to the parser test file).
 * https://codesearch.wmcloud.org/search/?q=parsoid-compatible&i=nope
 *
 * == THINKING ==
 *
 * The "thinking" part of the sync is to look at the patches created and
 * make sure that whatever change was made upstream (as shown in the diff
 * of the sync patch) doesn't require a corresponding change in Parsoid
 * and file a phab task and regenerate the known-differences list if that
 * happens to be the case.
 *
 * == EMPTY PATCHES ==
 *
 * If the patch to core (or to the extension) is empty, it's not
 * necessary to push it to Gerrit. (We use `--keep-empty` in the
 * suggested commands so that the process doesn't seem to "crash" in
 * this case, and because it's possible you still need to tweak tests
 * in order to make core happy after the sync.) Don't stop there,
 * though: you obviously don't need to wait for "time passes,
 * eventually your patch is merged to $REPO_PATH", but that means you can
 * and should just continue immediately to do the Parsoid side of the
 * sync. Just because core/the extension already had all Parsoid's
 * changes doesn't mean Parsoid has all of core's/the extension's, and
 * you'll need to update the commit hashes in Parsoid as well.
 *
 * In the other direction (when you pushed some Parsoid changes to
 * core/an extension, but the result is then identical to Parsoid's
 * copy of the parser tests), don't be tempted to skip the second half
 * of the sync either, because the Parsoid commit won't actually be
 * empty: it updates the commit hashes and effectively changes the
 * rebase source for the next sync. The sync point is recorded in
 * parserTests.json via the fetch-parserTests.txt.js script. Since the
 * hash in the json file is checked out and rebased, without this
 * update, the next sync from Parsoid will start from an older
 * baseline and introduce pointless merge conflicts to resolve.
 */

const yargs = require('yargs');
const childProcess = require('pn/child_process');
const path = require('path');
const fs = require('pn/fs');
const Promise = require('../lib/utils/promise.js');
const testDir = path.join(__dirname, '../tests/');
const testFilesPath = path.join(testDir, 'parserTests.json');
const testFiles = require(testFilesPath);

const strip = function(s) {
	return s.replace(/(^\s+)|(\s+$)/g, '');
};

Promise.async(function *() {
	// Option parsing and helpful messages.
	const usage = 'Usage: $0  <target-repo-key> <repo-path> <branch>';
	const opts = yargs
	.usage(usage)
	.help(false)
	.options({
		'help': { description: 'Show this message' },
	});
	const argv = opts.argv;
	if (argv.help || argv._.length !== 3) {
		opts.showHelp();
		let morehelp = yield fs.readFile(__filename, 'utf8');
		morehelp = strip(morehelp.split(/== [A-Z]* ==/, 2)[1]);
		console.log(morehelp.replace(/^ {3}/mg, ''));
		return;
	}

	// Ok, let's do this thing!
	const targetRepo = argv._[0];
	if (!testFiles.hasOwnProperty(targetRepo)) {
		console.warn(targetRepo + ' not defined in parserTests.json');
		return;
	}

	if (targetRepo === 'parsoid') {
		console.warn('Nothing to sync for Parsoid-only files.');
		return;
	}

	const mwexec = function(cmd) {
		// Execute `cmd` in the mwpath directory.
		return new Promise(function(resolve, reject) {
			console.log('>>>', cmd.join(' '));
			childProcess.spawn(cmd[0], cmd.slice(1), {
				cwd: mwpath,
				env: process.env,
				stdio: 'inherit',
			}).on('close', function(code) {
				if (code === 0) {
					resolve(code);
				} else {
					reject(code);
				}
			}).on('error', reject);
		});
	};

	let phash = null;
	let firstTarget = true;
	const mwpath = path.resolve(argv._[1]);
	const repoInfo = testFiles[targetRepo];
	const oldCommitHash = repoInfo.latestCommit;
	const targets = repoInfo.targets;
	const branch = argv._[2];
	const changedFiles = [];
	for (const targetName in targets) {
		console.log("Processing " + targetName);

		// A bit of user-friendly logging.
		if (firstTarget) {
			// Fetch current Parsoid git hash.
			const result = yield childProcess.execFile(
				'git', ['log', '--max-count=1', '--pretty=format:%H'], {
					cwd: __dirname,
					env: process.env,
				}).promise;
			phash = strip(result.stdout);
			console.log('Parsoid git HEAD is', phash);
			console.log('>>> cd', mwpath);
			yield mwexec('git fetch origin'.split(' '));

			// Create/checkout a branch, based on the previous sync point.
			yield mwexec(['git', 'checkout', '-b', branch, oldCommitHash]);
		}

		// Copy our locally-modified parser tests over to the target repo
		const targetInfo = targets[targetName];
		const parsoidFile = path.join(__dirname, '..', 'tests', 'parser', targetName);
		const targetFile = path.join(mwpath, targetInfo.path);
		try {
			const data = yield fs.readFile(parsoidFile);
			console.log('>>>', 'cp', parsoidFile, targetFile);
			yield fs.writeFile(targetFile, data);
			changedFiles.push(targetFile);
			firstTarget = false;
		} catch (e) {
			// cleanup
			yield mwexec('git checkout master'.split(' '));
			yield mwexec(['git', 'branch', '-d', branch]);
			throw e;
		}
	}

	// Make a new commit with an appropriate message.
	let commitmsg = 'Sync up ' + targetRepo + ' repo with Parsoid';
	commitmsg += '\n\nThis now aligns with Parsoid commit ' + phash;
	// Note the --allow-empty, because sometimes there are no parsoid-side
	// changes to merge. (We just need to get changes from upstream.)
	yield mwexec(['git', 'commit', '-m', commitmsg, '--allow-empty'].concat(changedFiles));

	// ok, we were successful at making the commit.  Give further instructions.
	console.log();
	console.log('Success!  Now:');
	console.log(' cd', mwpath);
	console.log(' git rebase --keep-empty origin/master');
	console.log(' .. fix any conflicts .. ');
	console.log(' php tests/parser/parserTests.php');
	console.log(' git review');

	// XXX to rebase semi-automatically, we might do something like:
	//  yield mwexec('git rebase origin/master'.split(' '));
	// XXX but it seems rather confusing to do it this way, since the
	// current working directory when we finish is still parsoid.

	process.exit(0);
})().done();
