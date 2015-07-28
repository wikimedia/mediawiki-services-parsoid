"use strict";

var RH = require('./render.helpers.js').RenderHelpers;

var dbInsertPerfStatsStart =
	'INSERT INTO perfstats ' +
	'( page_id, commit_hash, type, value ) VALUES ';
var dbInsertPerfStatsEnd =
	' ON DUPLICATE KEY UPDATE value = VALUES( value )';

var dbPerfStatsTypes =
	'SELECT DISTINCT type FROM perfstats';

var dbLastPerfStatsStart =
	'SELECT prefix, title, ';

var dbLastPerfStatsEnd =
	' FROM pages JOIN perfstats ON pages.id = perfstats.page_id ' +
	'WHERE perfstats.commit_hash = ' +
		'(SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
	'GROUP BY pages.id ';

var dbPagePerfStatsStart =
	'SELECT commits.hash, commits.timestamp, ';

var dbPagePerfStatsEnd =
	' FROM (perfstats JOIN pages ON perfstats.page_id = pages.id) ' +
	'JOIN commits ON perfstats.commit_hash = commits.hash ' +
	'WHERE pages.prefix = ? AND pages.title = ? ' +
	'GROUP BY commits.hash ' +
	'ORDER BY commits.timestamp DESC ' +
	'LIMIT 0, ?';

var cachedPerfStatsTypes;

var perfStatsTypes = function(db, cb) {
	if (cachedPerfStatsTypes) {
		return cb(null, cachedPerfStatsTypes);
	}
	// As MySQL doesn't support PIVOT, we need to get all the perfstats types
	// first so we can get then as columns afterwards
	db.query(dbPerfStatsTypes, null, function(err, rows) {
		if (err) {
			cb(err, null);
		} else if (!rows || rows.length === 0) {
			cb("No performance stats found", null);
		} else {
			var types = [];
			for (var i = 0; i < rows.length; i++) {
				types.push(rows[i].type);
			}

			// Sort the profile types by name
			types.sort();
			cachedPerfStatsTypes = types;

			cb(null, types);
		}
	});
};

var parsePerfStats = function(text) {
	var regexp = /<perfstat[\s]+type="([\w\:]+)"[\s]*>([\d]+)/g;
	var perfstats = [];
	for (var match = regexp.exec(text); match !== null; match = regexp.exec(text)) {
		perfstats.push({ type: match[ 1 ], value: match[ 2 ] });
	}
	return perfstats;
};

var insertPerfStats = function(db, pageId, commitHash, perfstats, cb) {
	// If empty, just return
	if (!perfstats || perfstats.length === 0) {
		if (cb) {
			return cb(null, null);
		}
		return;
	}
	// Build the query to insert all the results in one go:
	var dbStmt = dbInsertPerfStatsStart;
	for (var i = 0; i < perfstats.length; i++) {
		if (i !== 0) {
			dbStmt += ", ";
		}
		dbStmt += "( " + pageId.toString() + ", '" + commitHash + "', '" +
			perfstats[i].type + "', " + perfstats[i].value + ' )';
	}
	dbStmt += dbInsertPerfStatsEnd;

	// Make the query using the db arg, which could be a transaction
	db.query(dbStmt, null, cb);
};

function updateIndexPageUrls(list) {
	list.push({ url: '/perfstats', title: 'Performance stats of last commit' });
}

function updateTitleData(data, prefix, title) {
	data.perf = '/pageperfstats/' + prefix + '/' + title;
}

function setupEndpoints(settings, app, mysql, db, hbs) {
	// SSS FIXME: this is awkward
	RH.settings = settings;
	var getPerfStats = function(req, res) {
		var page = (req.params[0] || 0) - 0;
		var offset = page * 40;
		var orderBy = 'prefix ASC, title ASC';
		var urlSuffix = '';

		if (req.query.orderby) {
			orderBy = mysql.escapeId(req.query.orderby) + ' DESC';
			urlSuffix = '?orderby=' + req.query.orderby;
		}

		perfStatsTypes(db, function(err, types) {
			if (err) {
				res.send(err.toString(), 500);
			} else {

				var makePerfStatRow = function(urlPrefix, row) {
					var result = [RH.pageTitleData(urlPrefix, row)];
					for (var j = 0; j < types.length; j++) {
						var type = types[j];
						var rowData = row[type] === null ? '' :
							{type: type, value: row[type], info: row[type]};
						result.push(rowData);
					}
					return result;
				};

				// Create the query to retrieve the stats per page
				var perfStatsHeader = ['Title'];
				var dbStmt = dbLastPerfStatsStart;
				for (var t = 0; t < types.length; t++) {
					if (t !== 0) {
						dbStmt += ", ";
					}
					dbStmt += "SUM( IF( TYPE='" + types[ t ] +
						"', value, NULL ) ) AS '" + types[ t ] + "'";
					perfStatsHeader.push({
						url: '/perfstats?orderby=' + types[t],
						name: types[t],
					});
				}
				dbStmt += dbLastPerfStatsEnd;
				dbStmt += 'ORDER BY ' + orderBy;
				dbStmt += ' LIMIT 40 OFFSET ' + offset.toString();

				var relativeUrlPrefix = (req.params[0] ? '../' : '');
				var data = {
					page: page,
					relativeUrlPrefix: relativeUrlPrefix,
					urlPrefix: relativeUrlPrefix + 'perfstats',
					urlSuffix: urlSuffix,
					heading: 'Performance stats',
					header: perfStatsHeader,
				};

				db.query(dbStmt, null,
					RH.displayPageList.bind(null, hbs, res, data, makePerfStatRow));
			}
		});
	};

	var getPagePerfStats = function(req, res) {
		if (req.params.length < 2) {
			res.send("No title given.", 404);
		}

		var prefix = req.params[0];
		var title = req.params[1];

		perfStatsTypes(db, function(err, types) {
			if (err) {
				res.send(err.toString(), 500);
			} else {
				var dbStmt = dbPagePerfStatsStart;
				for (var t = 0; t < types.length; t++) {
					if (t !== 0) {
						dbStmt += ", ";
					}

					dbStmt += "SUM( IF( type='" + types[t] +
						"', value, NULL ) ) AS '" + types[ t ] + "'";
				}
				dbStmt += dbPagePerfStatsEnd;

				// Get maximum the last 10 commits.
				db.query(dbStmt, [ prefix, title, 10 ], function(err, rows) {
					if (err) {
						res.send(err.toString(), 500);
					} else if (!rows || rows.length === 0) {
						res.send("No performance results found for page.", 200);
					} else {
						res.status(200);
						var tableHeaders = ['Commit'];
						for (t = 0; t < types.length; t++) {
							tableHeaders.push(types[t]);
						}

						// Show the results in order of timestamp.
						var tableRows = [];
						for (var r = rows.length - 1; r >= 0; r--) {
							var row = rows[r];
							var tableRow = [
								{
									url: '/result/' + row.hash + '/' + prefix + '/' + title,
									name: row.hash,
									info: row.timestamp.toString(),
								},
							];
							for (t = 0; t < types.length; t++) {
								var rowData = row[types[t]] === null ? '' :
									{type: types[t], value: row[types[t]], info: row[types[t]]};
								tableRow.push(rowData);
							}
							tableRows.push({tableData: tableRow});
						}

						var data = {
							heading: 'Performance results for ' + prefix + ':' + title,
							header: tableHeaders,
							row: tableRows,
						};
						res.render('table.html', data);
					}
				});
			}
		});
	};

	// Performance stats
	app.get(/^\/perfstats\/(\d+)$/, getPerfStats);
	app.get(/^\/perfstats$/, getPerfStats);
	app.get(/^\/pageperfstats\/([^\/]+)\/(.*)$/, getPagePerfStats);
}

if (typeof module === "object") {
	module.exports.perfConfig = {
		parsePerfStats: parsePerfStats,
		insertPerfStats: insertPerfStats,
		setupEndpoints: setupEndpoints,
		updateIndexPageUrls: updateIndexPageUrls,
		updateIndexData: function() {}, // Nothing to do
		updateTitleData: updateTitleData,
	};
}
