"use strict";

var RH = require("./render.helpers.js").RenderHelpers,
	Diff = require('./diff.js').Diff;

var dbPagesWithRTSelserErrors =
	'SELECT pages.title, pages.prefix, commits.hash, ' +
	'stats.errors, stats.fails, stats.skips, stats.selser_errors ' +
	'FROM stats ' +
	'JOIN pages ON stats.page_id = pages.id ' +
	'JOIN commits ON stats.commit_hash = commits.hash ' +
	'WHERE commits.hash = ? AND ' +
		'stats.selser_errors > 0 ' +
	'ORDER BY stats.score DESC ' +
	'LIMIT 40 OFFSET ?';

var dbNumOneDiffRegressionsBetweenRevs =
	'SELECT count(*) AS numFlaggedRegressions ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s2.skips = 0 ' +
		'AND s1.fails = ? AND s1.skips = ? ';

var dbOneDiffRegressionsBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, ' +
	's2.commit_hash AS old_commit ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s2.skips = 0 ' +
		'AND s1.fails = ? AND s1.skips = ? ' +
	'ORDER BY s1.score - s2.score DESC ' +
	'LIMIT 40 OFFSET ?';

var dbNumNewFailsRegressionsBetweenRevs =
	'SELECT count(*) AS numFlaggedRegressions ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s1.fails > 0 ' +
		// exclude cases introducing exactly one skip/fail to a perfect
		'AND (s1.skips > 0 OR s1.fails <> 1 OR s2.skips > 0)';

var dbNewFailsRegressionsBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS errors, s1.fails AS fails, s1.skips AS skips, ' +
	's2.commit_hash AS old_commit, s2.errors AS old_errors, s2.fails AS old_fails, s2.skips AS old_skips ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s1.fails > 0 ' +
		// exclude cases introducing exactly one skip/fail to a perfect
		'AND (s1.skips > 0 OR s1.fails <> 1 OR s2.skips > 0) ' +
	'ORDER BY s1.score - s2.score DESC ' +
	'LIMIT 40 OFFSET ?';

var dbGetTwoResults =
	'SELECT result FROM results ' +
	'JOIN commits ON results.commit_hash = commits.hash ' +
	'JOIN pages ON pages.id = results.page_id ' +
	'WHERE pages.title = ? AND pages.prefix = ? ' +
	'AND (commits.hash = ? OR commits.hash = ?) ' +
	'ORDER BY commits.timestamp';

var makeOneDiffRegressionRow = function(row) {
	return [
		RH.pageTitleData(row),
		RH.oldCommitLinkData(row.old_commit, row.new_commit, row.title, row.prefix),
		RH.newCommitLinkData(row.old_commit, row.new_commit, row.title, row.prefix)
	];
};

function parseSelserStats(result) {
	var selserErrorCount = 0;
	var selserSuites = result.match(/<testsuite[^>]*\(selser\)[^>]*>[\s\S]*?<\/testsuite>/g);
	for (var selserSuite in selserSuites) {
		var matches = selserSuites[selserSuite].match(/<testcase/g);
		selserErrorCount += matches ? matches.length : 0;
	}

	return selserErrorCount;
}

function updateIndexData(data, row) {
	data.latestRevision.push({
		description: 'RT selser errors',
		value: row[0].rtselsererrors,
		url: '/rtselsererrors/' + row[0].maxhash
	});

	data.flaggedReg = [
		{ description: 'one fail',
			info: 'one new semantic diff, previously perfect',
			url: 'onefailregressions/between/' + row[0].secondhash + '/' + row[0].maxhash },
		{ description: 'one skip',
			info: 'one new syntactic diff, previously perfect',
			url: 'oneskipregressions/between/' + row[0].secondhash + '/' + row[0].maxhash },
		{ description: 'other new fails',
			info: 'other cases with semantic diffs, previously only syntactic diffs',
			url: 'newfailsregressions/between/' + row[0].secondhash + '/' + row[0].maxhash }
	];
}

function setupEndpoints(settings, app, mysql, db, hbs) {
	// SSS FIXME: this is awkward
	RH.settings = settings;
	var displayOneDiffRegressions = function(numFails, numSkips, subheading, headingLinkData, req, res) {
		var r1 = req.params[0];
		var r2 = req.params[1];
		var page = (req.params[2] || 0) - 0;
		var offset = page * 40;
		db.query (dbNumOneDiffRegressionsBetweenRevs, [r2, r1, numFails, numSkips], function(err, row) {
			if (err) {
				res.send(err.toString(), 500);
			} else {
				var headingLink = [
					{name: headingLinkData[0],
						info: headingLinkData[1],
						url: '/' + headingLinkData[2] + 'regressions/between/' + r1 + '/' + r2},
					{name: 'other new fails',
						info: 'other cases with semantic diffs, previously only syntactic diffs',
						url: '/newfailsregressions/between/' + r1 + '/' + r2}
				];
				var data = {
					page: page,
					urlPrefix: '/regressions/between/' + r1 + '/' + r2,
					urlSuffix: '',
					heading: 'Flagged regressions between selected revisions: ' +
						row[0].numFlaggedRegressions,
					subheading: subheading,
					headingLink: headingLink,
					header: ['Title', 'Old Commit', 'New Commit']
				};
				db.query(dbOneDiffRegressionsBetweenRevs, [r2, r1, numFails, numSkips, offset],
					RH.displayPageList.bind(null, hbs, res, data, makeOneDiffRegressionRow));
			}
		});
	};

	var GET_rtselsererrors = function(req, res) {
		var commit = req.params[0],
			page = (req.params[1] || 0) - 0,
			offset = page * 40,
			data = {
				page: page,
				urlPrefix: '/rtselsererrors/' + commit,
				urlSuffix: '',
				heading: 'Pages with rt selser errors',
				header: ['Title', 'Commit', 'Syntactic diffs', 'Semantic diffs', 'Errors']
			};
		var makeSelserErrorRow = function(row) {
			var prefix = encodeURIComponent(row.prefix),
				title = encodeURIComponent(row.title);

			var rowData = {
				title: row.prefix + ':' + row.title,
				latest: '/latestresult/' + prefix + '/' + title,
				perf: '/pageperfstats/' + prefix + '/' + title
			};

			if (RH.settings.resultServer) {
				rowData.remoteUrl = RH.settings.resultServer + '_rtselser/' + prefix + '/' + title;
			}
			if (RH.settings.localhostServer) {
				rowData.lhUrl = RH.settings.localhostServer + '/_rtselser/' + prefix + '/' + title;
			}

			return [
				rowData,
				RH.commitLinkData(row.hash, row.title, row.prefix),
				row.skips,
				row.fails,
				row.errors === null ? 0 : row.errors
			];
		};
		db.query(dbPagesWithRTSelserErrors, [commit, offset],
			RH.displayPageList.bind(null, hbs, res, data, makeSelserErrorRow));
	};

	var GET_oneFailRegressions = displayOneDiffRegressions.bind(
		null, 1, 0, 'Old Commit: perfect | New Commit: one semantic diff',
		['one skip regressions', 'one new syntactic diff, previously perfect', 'oneskip']
	);

	var GET_oneSkipRegressions = displayOneDiffRegressions.bind(
		null, 0, 1, 'Old Commit: perfect | New Commit: one syntactic diff',
		['one fail regressions', 'one new semantic diff, previously perfect', 'onefail']
	);

	var GET_newFailsRegressions = function(req, res) {
		var r1 = req.params[0];
		var r2 = req.params[1];
		var page = (req.params[2] || 0) - 0;
		var offset = page * 40;
		db.query(dbNumNewFailsRegressionsBetweenRevs, [r2, r1], function(err, row) {
			if (err) {
				res.send(err.toString(), 500);
			} else {
				var data = {
					page: page,
					urlPrefix: '/regressions/between/' + r1 + '/' + r2,
					urlSuffix: '',
					heading: 'Flagged regressions between selected revisions: ' +
						row[0].numFlaggedRegressions,
					subheading: 'Old Commit: only syntactic diffs | New Commit: semantic diffs',
					headingLink: [
						{name: 'one fail regressions',
							info: 'one new semantic diff, previously perfect',
							url: '/onefailregressions/between/' + r1 + '/' + r2},
						{name: 'one skip regressions',
							info: 'one new syntactic diff, previously perfect',
							url: '/oneskipregressions/between/' + r1 + '/' + r2}
					],
					header: RH.regressionsHeaderData
				};
				db.query(dbNewFailsRegressionsBetweenRevs, [r2, r1, offset],
					RH.displayPageList.bind(null, hbs, res, data, RH.makeRegressionRow));
			}
		});
	};

	var diffResultWebCallback = function(req, res, flag, err, row) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else if (row.length === 2) {
			var oldCommit = req.params[0].slice(0,10);
			var newCommit = req.params[1].slice(0,10);
			var oldResult = row[0].result;
			var newResult = row[1].result;
			var flagResult = Diff.resultFlagged(oldResult, newResult, oldCommit, newCommit, flag);
			res.setHeader( 'Content-Type', 'text/xml; charset=UTF-8' );
			res.status(200);
			res.write( '<?xml-stylesheet href="/static/result.css"?>\n' );
			res.end(flagResult);
		} else {
			var commit = flag === '+' ? req.params[1] : req.params[0];
			res.redirect('/result/' + commit + '/' + req.params[2] + '/' + req.params[3]);
		}
	};

	var resultFlagNewWebInterface = function(req, res) {
		var oldCommit = req.params[0];
		var newCommit = req.params[1];
		var prefix = req.params[2];
		var title = req.params[3];

		db.query(dbGetTwoResults, [ title, prefix, oldCommit, newCommit ],
			diffResultWebCallback.bind(null, req, res, '+'));
	};

	var resultFlagOldWebInterface = function(req, res) {
		var oldCommit = req.params[0];
		var newCommit = req.params[1];
		var prefix = req.params[2];
		var title = req.params[3];

		db.query(dbGetTwoResults, [ title, prefix, oldCommit, newCommit ],
			diffResultWebCallback.bind(null, req, res, '-'));
	};

	// Regressions between two revisions that introduce one semantic error to a perfect page.
	app.get(/^\/onefailregressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_oneFailRegressions );

	// Regressions between two revisions that introduce one syntactic error to a perfect page.
	app.get(/^\/oneskipregressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_oneSkipRegressions );

	// Regressions between two revisions that introduce senantic errors (previously only syntactic diffs).
	app.get(/^\/newfailsregressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_newFailsRegressions );

	// Results for a title on a commit, flag skips/fails new since older commit
	app.get( /^\/resultFlagNew\/([a-f0-9]*)\/([a-f0-9]*)\/([^\/]+)\/(.*)$/, resultFlagNewWebInterface );

	// Results for a title on a commit, flag skips/fails no longer in newer commit
	app.get( /^\/resultFlagOld\/([a-f0-9]*)\/([a-f0-9]*)\/([^\/]+)\/(.*)$/, resultFlagOldWebInterface );

	// Pages with rt selser errors
	app.get(/^\/rtselsererrors\/([^\/]+)(?:\/(\d+))?$/, GET_rtselsererrors);
}

if (typeof module === "object") {
	module.exports.parsoidRTConfig = {
		parseSelserStats: parseSelserStats,
		setupEndpoints: setupEndpoints,
		updateIndexPageUrls: function() {}, // Nothing to do
		updateIndexData: updateIndexData,
		updateTitleData:  function() {}, // Nothing to do
	};
}
