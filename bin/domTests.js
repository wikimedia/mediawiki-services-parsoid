#!/usr/bin/env node
/*
DOM transform unit test system

Purpose:
 During the porting of Parsoid to PHP, we need a system to capture
 and replay Javascript Parsoid DOM transform behavior and performance
 so we can duplicate the functionality and verify adequate performance.

 The domTest.js program works in concert with Parsoid and special
 --genTest capabilities that produce pairs of test files from existing
 wiki pages.

Technical details:
 The test validator and handler runtime emulates the normal
 Parsoid DOMPostProcessoer behavior.

 To create a test from an existing wikitext page, run the following
 commands, for example:
 $ node bin/parse.js --genTest dom:dsr --genDirectory ../tests --pageName Hampi

 For command line options and required parameters, type:
 $ node bin/domTest.js --help

 An example command line to validate and performance test the 'Hampi'
 wikipage created as a dom:dsr test:
 $ node bin/domTests.js --log --timingMode --iterationCount 99 --transformer dsr --inputFilePrefix Hampi

 There are a number of tests in tests/transform directory.  To regenerate
 these, use:
 $ tools/regen-transformTests.sh

 To run these pregenerated tests, use:
 $ npm run transformTests
*/

'use strict';

var fs = require('fs');
var yargs = require('yargs');

var ScriptUtils = require('../tools/ScriptUtils.js').ScriptUtils;
var JSUtils = require('../lib/utils/jsutils.js').JSUtils;
var DOMDataUtils = require('../lib/utils/DOMDataUtils.js').DOMDataUtils;
var ContentUtils = require('../lib/utils/ContentUtils.js').ContentUtils;
var MockEnv = require('../tests/MockEnv.js').MockEnv;

// processors
var requireProcessor = function(p) {
	return require('../lib/wt2html/pp/processors/' + p + '.js')[p];
};

// processors markFosteredContent and processTreeBuilderfixups test files
// Pre and Post will generate dom matching errors in this test environment.
// If --debug_dump flag is used, the TemporaryPost.txt files produced
// by domTests.js and domTests.php maybe compared and of value in determining
// correctness of porting.

var MigrateTemplateMarkerMetas = requireProcessor('MigrateTemplateMarkerMetas');
var HandlePres = requireProcessor('HandlePres');
var MigrateTrailingNLs = requireProcessor('MigrateTrailingNLs');
var ComputeDSR = requireProcessor('ComputeDSR');
var WrapTemplates = requireProcessor('WrapTemplates');
var WrapSections = requireProcessor('WrapSections');
var AddExtLinkClasses = requireProcessor('AddExtLinkClasses');
var PWrap = requireProcessor('PWrap');
var ProcessTreeBuilderFixups = requireProcessor('ProcessTreeBuilderFixups');
var MarkFosteredContent = requireProcessor('MarkFosteredContent');

// handlers
var requireHandlers = function(file) {
	return require('../lib/wt2html/pp/handlers/' + file + '.js');
};
var headings = requireHandlers('headings');

var cachedState = false;
var cachedFilePre = '';
var cachedFilePost = '';

function MockDOMPostProcessor(env, options) {
	this.env = env;
	this.pipelineId = 0;
	this.options = options;
	this.domTransforms = {};
	this.transformTime = 0;
	this.first = true;
}

MockDOMPostProcessor.prototype.log = function() {
	var output = arguments[0];
	for (var index = 1; index < arguments.length; index++) {
		if (typeof arguments[index] === 'function') {
			output = output + ' ' + arguments[index]();
		} else {
			output = output + ' ' + arguments[index];
		}
	}
	console.log(output);
};

// Load pre and post test files then run selected DOM transform function and compare result
MockDOMPostProcessor.prototype.processWikitextFile = function(opts) {
	var testFilePre;
	var testFilePost;
	var numFailures = 0;
	var env = this.env;

	if (cachedState === false) {
		cachedState = true;
		testFilePre = fs.readFileSync(opts.inputFilePrefix + '-' + opts.transformer + '-pre.txt', 'utf8');
		testFilePost = fs.readFileSync(opts.inputFilePrefix + '-' + opts.transformer + '-post.txt', 'utf8');
		// Hack to fix trailing newline being moved by domino around the final </body> tag, remove when fixed in domino
		if (testFilePre[testFilePre.length - 1] === '\n') { testFilePre = testFilePre.slice(0, -1); }
		if (testFilePost[testFilePost.length - 1] === '\n') { testFilePost = testFilePost.slice(0, -1); }
		cachedFilePre = testFilePre;
		cachedFilePost = testFilePost;
	} else {
		testFilePre = cachedFilePre;
		testFilePost = cachedFilePost;
	}

	const body = ContentUtils.ppToDOM(env, testFilePre);
	let dumpOpts = {};

	if (this.first === true) {
		dumpOpts = {
			quiet: true,
			dumpFragmentMap: false,
			keepTmp: true,
			outBuffer: '',
		};
		ContentUtils.dumpDOM(body, '', dumpOpts);

		if (dumpOpts.outBuffer === testFilePre) {
			console.log('comparison of pre files match');
		} else {
			console.log('comparison of pre files DID NOT match');
			numFailures++;
		}

		if (opts.debug_dump) {
			fs.writeFileSync('temporaryPre.txt', dumpOpts.outBuffer);
			console.log('temporaryPre.txt saved!');
		}
	}

	var s = JSUtils.startTime();

	if (opts.transformer === 'dsr') {
		var dp = DOMDataUtils.getDataParsoid(body);
		if (dp.dsr) { opts.sourceOffsets = dp.dsr; }
		(new ComputeDSR()).run(body, env, opts);
	} else if (opts.transformer === 'migrate-metas') {
		(new MigrateTemplateMarkerMetas()).run(body, env, opts);
	} else if (opts.transformer === 'pres') {
		(new HandlePres()).run(body, env, opts);
	} else if (opts.transformer === 'migrate-nls') {
		(new MigrateTrailingNLs()).run(body, env, opts);
	} else if (opts.transformer === 'tplwrap') { // fails, pre matches, but fails at
		// findTopLevelNonOverlappingRanges (processors/wrapTemplates.js:500:12)
		(new WrapTemplates()).run(body, env, opts);
	} else if (opts.transformer === 'sections') {
		(new WrapSections()).run(body, env, opts);
	} else if (opts.transformer === 'linkclasses') { // known failure, pre and post do not match
		(new AddExtLinkClasses()).run(body, env, opts);
	} else if (opts.transformer === 'pwrap') {
		(new PWrap()).run(body, env, opts);
	} else if (opts.transformer === 'process-fixups') { // known failure, pre and post do not match
		(new ProcessTreeBuilderFixups()).run(body, env, opts);
	} else if (opts.transformer === 'fostered') { // known failure, pre and post do not match
		(new MarkFosteredContent()).run(body, env, opts);
	} else if (opts.transformer === 'heading-ids') {
		headings.genAnchors(body, env);
	}

	this.transformTime += JSUtils.elapsedTime(s);

	if (this.first === true) {
		this.first = false;

		dumpOpts.outBuffer = '';
		ContentUtils.dumpDOM(body, '', dumpOpts);

		if (dumpOpts.outBuffer === testFilePost) {
			console.log('comparison of post files match');
		} else {
			console.log('comparison of post files DID NOT match');
			numFailures++;
		}

		if (opts.debug_dump) {
			fs.writeFileSync('temporaryPost.txt', dumpOpts.outBuffer);
			console.log('temporaryPost saved!');
		}
	}

	return numFailures;
};

MockDOMPostProcessor.prototype.wikitextTest = function(opts) {
	var numFailures = 0;
	var iterator = opts.timingMode ? Math.round(opts.iterationCount) : 1;
	while (iterator--) {
		if (!opts.timingMode) {
			console.log('Starting wikitext dom test, files = ' + opts.inputFilePrefix + '-' + opts.transformer + '-pre.txt and ...-post.txt');
		}
		numFailures += this.processWikitextFile(opts);

		if (!opts.timingMode) {
			console.log('Ending wikitext dom test, files = ' + opts.inputFilePrefix + '-' + opts.transformer + '-pre.txt and ...-post.txt\n');
		}
	}
	return numFailures;
};

var opts = yargs.usage('Usage: $0 [--timingMode [--iterationCount N]] [--log] --transformer NAME --inputFilePrefix /path/filename', {
	help: {
		description: [
			'domTest.js supports parsoid generated test validation.',
			'The --timingMode flag disables console output and',
			'caches the file IO and related text processing and then iterates',
			'the test 50 times, or for example as specified by --iterationCount 100.',
			'The --log option provides additional debug content.',
			'The --debug_dump options provides temporaryPre.txt and ...Post.txt',
			'files for debugging comparison failures manually.',
			'\n'
		].join(' ')
	},
	log: {
		description: 'optional: display handler log info',
		'boolean': true,
		'default': false
	},
	transformer: {
		description: 'Provide the name of the transformer to test',
		'boolean': false,
		'default': null
	},
	timingMode: {
		description: 'Run tests in performance timing mode',
		'boolean': true,
		'default': false
	},
	iterationCount: {
		description: 'How many iterations to run in timing mode?',
		'boolean': false,
		'default': 50
	}
});

function runTests() {
	var argv = opts.argv;

	if (ScriptUtils.booleanOption(argv.help)) {
		opts.showHelp();
		process.exit(1);
	}

	if (!argv.inputFilePrefix) {
		opts.showHelp();
		process.exit(1);
	}

	if (argv.timingMode) {
		if (typeof argv.iterationCount !== 'number' || argv.iterationCount < 1) {
			console.log("Iteration count should be a number > 0");
			process.exit(1);
		}
		console.log("\nTiming Mode enabled, no console output expected till test completes\n");
	}

	var mockEnv = new MockEnv(argv);
	var manager = new MockDOMPostProcessor(mockEnv, {});

	console.log('Selected dom transformer = ' +  argv.transformer);

	var startTime = JSUtils.startTime();

	var numFailures = manager.wikitextTest(argv);

	var totalTime = JSUtils.elapsedTime(startTime);

	console.log('Total DOM test execution time        = ' + totalTime.toFixed(3) + ' milliseconds');
	console.log('Total time processing DOM transforms = ' + manager.transformTime.toFixed(3) + ' milliseconds');

	if (numFailures) {
		console.log('Total failures:', numFailures);
		process.exit(1);
	}

}
runTests();
