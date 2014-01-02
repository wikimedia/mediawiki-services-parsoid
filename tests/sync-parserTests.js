#!/usr/bin/env node
"use strict";

/**
   == USAGE ==
   Script to synchronize parsoid parserTests with mediawiki/core parserTests.

   Basic use:
     $PARSOID is the path to a checked out git copy of Parsoid
     $MEDIAWIKI is the path to a checked out git copy of mediawiki/core
     $BRANCH is a branch name for the patch to mediawiki/core (ie, 'pt-sync')

   $ cd $PARSOID
   $ tests/sync-parserTests.js $MEDIAWIKI $BRANCH
   $ cd $MEDIAWIKI
   $ git rebase master
     ... resolve conflicts, sigh ...
   $ php tests/parserTests.php
     ... fix any failures by marking tests parsoid-only, etc ...
   $ git review

     ... time passes, eventually your patch is merged to core ...

   $ cd $PARSOID
   $ tests/fetch-parserTests.txt.js --force
   $ git commit -m "Sync parserTests" tests/fetch-parserTests.txt.js
   $ git review

  Simple, right?
== USAGE ==
*/

var fetcher = require('./fetch-parserTests.txt.js');
var optimist = require('optimist');
var child_process = require('child_process');
var async = require('async');
var path = require('path');
var fs = require('fs');

var strip = function(s) {
	return s.replace(/(^\s+)|(\s+$)/g, '');
};

// Option parsing and helpful messages.
var usage = 'Usage: $0 <mediawiki checkout path> <branch name>';
var opts = optimist.usage( usage, {
	'help': { description: 'Show this message' }
}).argv;
if (opts.help || opts._.length !== 2) {
	optimist.showHelp();
	var morehelp = fs.readFileSync(__filename, 'utf8');
	morehelp = strip(morehelp.split(/== USAGE ==/, 2)[1]);
	console.log(morehelp.replace(/^   /mg,''));
	return;
}

// Ok, let's do this thing!
var mwpath = path.resolve(opts._[0]);
var branch = opts._[1];
var oldhash = fetcher.latestCommit;

var mwexec = function(cmd) {
	return function(callback) {
		console.log('>>>', cmd.join(' '));
		child_process.spawn(cmd[0], cmd.slice(1), {
			cwd: mwpath,
			env: process.env,
			stdio: 'inherit'
		}).on('close', function(code) {
			callback(code === 0 ? null : code, code);
		});
	};
};

var q = [];
var PARSERTESTS = 'parserTests.txt';
var pPARSERTESTS = path.join(__dirname, PARSERTESTS);
var mwPARSERTESTS = path.join(mwpath, 'tests', 'parser', PARSERTESTS);

// Fetch current Parsoid git hash.
var phash;
q.push(function(callback) {
	child_process.execFile('git',['log','--max-count=1','--pretty=format:%H'],{
		cwd: __dirname, env: process.env
	}, function(error, stdout, stderr) {
		if (error) { return callback(error.code || 1); }
		phash = strip(stdout);
		callback(null, 0);
	});
});
q.push(function(callback) {
	// A bit of user-friendly logging.
	console.log('Parsoid git HEAD is', phash);
	console.log('>>> cd', mwpath);
	callback(null);
});

// Create a new mediawiki/core branch, based on the previous sync point.
q.push(mwexec('git fetch origin'.split(' ')));
q.push(mwexec(['git','checkout','-b', branch, oldhash]));
var cleanup = function(callback) {
	var qq = [
		mwexec('git checkout master'.split(' ')),
		mwexec(['git','branch','-d',branch])
	];
	async.series(qq, callback);
};

// Copy our locally-modified parser tests over to mediawiki/core.
q.push(function(callback) {
	// cp __dirname/parserTests.txt $mwpath/tests/parser
	fs.readFile(pPARSERTESTS, function(err, data) {
		if (err) { return cleanup(function() { callback(err); }); }
		console.log('>>>', 'cp', pPARSERTESTS, mwPARSERTESTS);
		fs.writeFile(mwPARSERTESTS, data, function(err) {
			if (err) { return cleanup(function() { callback(err); }); }
			callback();
		});
	});
});

// Make a new mediawiki/core commit with an appropriate message.
q.push(function(callback) {
	var commitmsg = 'Sync up with Parsoid parserTests.';
	commitmsg += '\n\nThis now aligns with Parsoid commit '+phash;
	mwexec(['git','commit','-m', commitmsg, mwPARSERTESTS])(callback);
});

// Ok, run these commands in series, stopping if any fail.
async.series(q, function(err, allresults) {
	if (err) { process.exit(err); }

	// ok, we were successful at making the commit.  Give further instructions.
	console.log();
	console.log('Success!  Now:');
	console.log(' cd', mwpath);
	console.log(' git rebase origin/master');
	console.log(' .. fix any conflicts .. ');
	console.log(' php tests/parserTests.php');
	console.log(' git review');

	// XXX to rebase semi-automatically, we might do something like:
	//mwexec('git rebase origin/master'.split(' '))(function(err, code) {
	//});
	// XXX but it seems rather confusing to do it this way, since the
	// current working directory when we finish is still parsoid.

	process.exit(0);
});
