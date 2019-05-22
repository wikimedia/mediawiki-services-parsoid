#!/usr/bin/env node

'use strict';

/* Fetch new results from https://tools.wmflabs.org/wikitext-deprecation/api
 * and save them locally and run this script to compare how things have changed
 * for a particular category */

// ------------------ Console printer ------------------
function pad(n, len) {
	if (!len) {
		len = 15;
	}
	return String(n).padStart(len);
}

function ConsolePrinter() {}

ConsolePrinter.printSectionHeader = function(heading) {
	console.log(heading);
};

ConsolePrinter.printTableHeader = function(columns) {
	console.log("-".repeat(80));
	console.log(columns.map(function(c) { return pad(c); }).join('\t'));
	console.log("-".repeat(80));
};

ConsolePrinter.printTableRow = function(columns) {
	console.log(columns.map(function(c) { return pad(c); }).join('\t'));
};

ConsolePrinter.printTableFooter = function() {
	console.log("-".repeat(80));
	console.log("\n");
};

// ------------------ Wikitxt printer ------------------
function WikitextPrinter() {}

WikitextPrinter.printSectionHeader = function(heading) {
	console.log('==' + heading + '==');
};

WikitextPrinter.printTableHeader = function(columns) {
	console.log('{| class="wikitable sortable" style="width:60%"');
	console.log('|-');
	console.log('!' + columns.join('!!'));
};

WikitextPrinter.printTableRow = function(columns) {
	console.log('|-');
	console.log('|' + columns.join('||'));
};

WikitextPrinter.printTableFooter = function() {
	console.log('|}\n');
};

// ------------------------------------------------------
require('../core-upgrade.js');
var path = require('path');
var yargs = require('yargs');

var opts = yargs
.usage("Usage $0 [options] old-json-file new-json-file")
.options({
	help: {
		description: 'Show this message',
		'boolean': true,
		'default': false,
	},
	wikify: {
		description: 'Emit report in wikitext format for a wiki',
		'boolean': true,
		'default': false,
	},
	baseline_count: {
		description: 'Baseline count for determinining remex-readiness',
		'boolean': false,
		'default': 25,
	},
});

var highPriorityCats = [
	"deletable-table-tag",
	"pwrap-bug-workaround",
	"self-closed-tag",
	"tidy-whitespace-bug",
	"html5-misnesting",
	"tidy-font-bug",
	"multiline-html-table-in-list",
	"multiple-unclosed-formatting-tags",
	"unclosed-quotes-in-heading",
];

var argv = opts.argv;
var numArgs = argv._.length;
if (numArgs < 2) {
	opts.showHelp();
	process.exit(1);
}

var oldResults = require(path.resolve(process.cwd(), argv._[0]));
var wikis = Object.keys(oldResults);
if (wikis.length === 0) {
	console.log("Old results from " + argv._[0] + " seems empty?");
	process.exit(1);
}

var newResults = require(path.resolve(process.cwd(), argv._[1]));
if (Object.keys(newResults).length === 0) {
	console.log("New results from " + argv._[1] + " seems empty?");
	process.exit(1);
}

var printer = argv.wikify ? WikitextPrinter : ConsolePrinter;

function printStatsForCategory(cat, p) {
	var changes = wikis.reduce(function(accum, w) {
		// Skip wikis that don't have results for both wikis
		if (!newResults[w]) {
			return accum;
		}
		// Record changes
		var o = oldResults[w].linter_info[cat];
		var n = newResults[w].linter_info[cat];
		if (n !== o) {
			accum.push({
				wiki: w,
				old: o,
				new: n,
				change: n - o,
				percentage: o > 0 ? Math.round((n - o) / o * 1000) / 10 : 0,
			});
		}
		return accum;
	}, []);

	// Most improved wikis first
	changes.sort(function(a, b) {
		return a.change > b.change ? 1 : (a.change < b.change ? -1 : 0);
	});

	p.printSectionHeader("Changes in " + cat + " counts for wikis");
	p.printTableHeader(["WIKI", "OLD", "NEW", "CHANGE", "PERCENTAGE"]);
	for (var i = 0; i < changes.length; i++) {
		var d = changes[i];
		p.printTableRow([d.wiki, d.old, d.new, d.change, d.percentage]);
	}
	p.printTableFooter();
}

// Dump stats for each high-priority category
highPriorityCats.forEach(function(cat) {
	printStatsForCategory(cat, printer);
});

// If count is below this threshold for all high priority categories,
// we deem those wikis remex-ready. For now, hard-coded to zero, but
// could potentially rely on a CLI option.
var maxCountPerHighPriorityCategory = parseInt(argv.baseline_count, 10);
var remexReadyWikis = [];
wikis.forEach(function(w) {
	if (!newResults[w]) {
		return;
	}

	// Check if this wiki is remex-ready
	var remexReady = highPriorityCats.every(function(c) {
		return newResults[w].linter_info[c] <= maxCountPerHighPriorityCategory;
	});
	if (remexReady) {
		remexReadyWikis.push({
			name: w,
			changed: highPriorityCats.some(function(c) {
				return oldResults[w].linter_info[c] > maxCountPerHighPriorityCategory;
			}),
		});
	}
});

if (remexReadyWikis.length > 0) {
	console.log('\n');
	printer.printSectionHeader('Wikis with < ' + argv.baseline_count + ' errors in all high priority categories');
	printer.printTableHeader(['New', 'Changed?']);
	for (var i = 0; i < remexReadyWikis.length; i++) {
		printer.printTableRow([remexReadyWikis[i].name, remexReadyWikis[i].changed]);
	}
	printer.printTableFooter();
}
