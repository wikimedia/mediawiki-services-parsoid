'use strict';

/* global describe, it, Promise */
require('chai').should();

const Promise = require('../../lib/utils/promise.js');

const childProcess = require('pn/child_process');
const path = require('path');

const PARSOID_TEST_FOMA = process.env.PARSOID_TEST_FOMA || false;

const langs = [
	{
		base: 'crh',
		variants: [
			['crh-latn', 'crh-cyrl'],
			['crh-cyrl', 'crh-latn'],
		],
		examples: true,
	},
	{
		base: 'en',
		variants: [
			['en', 'en-x-piglatin'],
			['en-x-piglatin', 'en'],
		],
		examples: true,
	},
	{
		base: 'ku',
		variants: [
			['ku-latn', 'ku-arab'],
			['ku-arab', 'ku-latn'],
		],
		examples: true,
	},
	{
		base: 'sr',
		variants: [
			['sr-el', 'sr-ec'],
			['sr-ec', 'sr-el'],
		],
		examples: true,
	},
	{
		base: 'zh',
		variants: [
			['zh-tw','zh-cn','zh-hans'],
			['zh-hk','zh-hans'],
			['zh-mo','zh-hans'],
			['zh-hant','zh-hans'],
			['zh-cn','zh-tw','zh-hant'],
			['zh-sg','zh-hant'],
			['zh-my','zh-hant'],
			['zh-hans','zh-hant'],
		],
	},
];

describe('Foma FST verification', function() {
	// These tests are expensive (generating the FST via foma takes a
	// while) so only run them if the environment variable
	// PARSOID_TEST_FOMA is set.
	if (!PARSOID_TEST_FOMA) {
		it.skip("PARSOID_TEST_FOMA is not set, skipping");
		return;
	}

	const rootDir = path.resolve(__dirname, '../..');
	const fstDir = path.resolve(rootDir, 'lib/language/fst');
	const toolsDir = path.resolve(rootDir, 'tools');
	langs.forEach((l) => {
		describe(`Compiling ${l.base}.foma`, function() {
			this.timeout(100000); /* compilation can take a while */
			const fomaFile = `${l.base}${l.examples ? '-examples' : ''}.foma`;
			// This has to be sync, since we're going to create test cases
			// based on the result of this, and mocha doesn't support async
			// test case generation.
			// XXX skip this if `foma` isn't on the path.
			let result = childProcess.execFileSync('foma', ['-f', fomaFile], {
				cwd: fstDir,
				encoding: 'utf8',
			});
			// Count the number of tests expected
			let expectedTests = 0;
			result = result.replace(
				/^EXPECT\s+(\d+)\s*$/mg,
				(m, num) => {
					expectedTests += Number.parseInt(num, 10);
					return '';
				});

			// EXPECT: is a shorthand for one-line tests
			result = result.replace(
				/^EXPECT(?:\[(.*)\])?: (.*)$/mg,
				(m, name, out) => `<EXPECT ${name || out}>\n${out}\n</EXPECT>`
			);

			// Split on <EXPECT>
			const tests = result.split(/^<EXPECT(.*)>\n/mg);
			describe('Checking expectations', function() {
				let lineNum = tests[0].split(/^/mg).length;
				let cnt = 0;
				for (let i = 1; i < tests.length; i += 2) {
					let name = tests[i].trim();
					name = `line ${lineNum + 1}${name ? ': ' + name : ''}`;
					let [part1, part2] = tests[i + 1].split('</EXPECT>\n', 2);
					part1 = part1.split(/^/mg);
					part2 = part2.split(/^/mg);
					lineNum += part1.length + part2.length + 2;
					part2 = part2.slice(0, part1.length).join('');
					part1 = part1.join('');
					// Create a test case to separately report each part.
					it(name, function() {
						part2.should.equal(part1, "Expectation not met.");
					});
					cnt++;
				}
				// Sanity check: this ensures that our output wasn't truncated
				// (eg, due to a foma syntax error which caused an abort).
				it('Total number of tests should match expected', function() {
					cnt.should.equal(expectedTests);
				});
			});

			// Now compile the .att files to .json files
			describe("Building .pfst files", function() {
				l.variants.forEach(args => it(args.join(' '), function() {
					const cp = childProcess.fork(
						path.resolve(toolsDir, 'build-langconv-fst.js'),
						['-l'].concat(args),
						{
							cwd: fstDir,
						}
					);
					return new Promise((resolve,reject) => {
						cp.on('error', reject);
						cp.on('exit', (code, signal) => {
							if (code === 0) { resolve(); } else { reject(new Error("Bad exit code: " + code)); }
						});
					});
				}));
			});
		});
	});
});
