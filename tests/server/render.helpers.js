"use strict";

var RenderHelpers = {};
var RH = RenderHelpers;

RenderHelpers.pageTitleData = function(row) {
	var settings = RH.settings;
	var prefix = encodeURIComponent( row.prefix ),
		title = encodeURIComponent( row.title );

	var data = {
		title: row.prefix + ':' + row.title,
		latest: '/latestresult/' + prefix + '/' + title
	};

	if (settings.resultServer) {
		data.remoteUrl = settings.generateTitleUrl(settings.resultServer, prefix, title);
	}

	if (settings.localhostServer) {
		data.lhUrl = settings.generateTitleUrl(settings.localhostServer, prefix, title);
	}

	// Let each of the "plugins" to do their thing
	if (settings.perfConfig) {
		settings.perfConfig.updateTitleData(data, prefix, title);
	}
	if (settings.parsoidRTConfig) {
		settings.parsoidRTConfig.updateTitleData(data, prefix, title);
	}

	return data;
};

RenderHelpers.commitLinkData = function(commit, title, prefix) {
	return {
		url: '/result/' + commit + '/' + prefix + '/' + title,
		name: commit.substr( 0, 7 )
	};
};

RenderHelpers.newCommitLinkData = function(oldCommit, newCommit, title, prefix) {
	return {
		url: '/resultFlagNew/' + oldCommit + '/' + newCommit + '/' + prefix + '/' + title,
		name: newCommit.substr(0,7)
	};
};

RenderHelpers.oldCommitLinkData = function(oldCommit, newCommit, title, prefix) {
	return {
		url: '/resultFlagOld/' + oldCommit + '/' + newCommit + '/' + prefix + '/' + title,
		name: oldCommit.substr(0,7)
	};
};

RenderHelpers.regressionsHeaderData = ['Title', 'Old Commit', 'Errors|Fails|Skips', 'New Commit', 'Errors|Fails|Skips'];

RenderHelpers.makeRegressionRow = function(row) {
	return [
		RH.pageTitleData(row),
		RH.oldCommitLinkData(row.old_commit, row.new_commit, row.title, row.prefix),
		row.old_errors + "|" + row.old_fails + "|" + row.old_skips,
		RH.newCommitLinkData(row.old_commit, row.new_commit, row.title, row.prefix),
		row.errors + "|" + row.fails + "|" + row.skips
	];
};

RenderHelpers.pageStatus = function(row) {
	var hasStatus = row.hasOwnProperty( 'skips' ) &&
		row.hasOwnProperty( 'fails' ) &&
		row.hasOwnProperty( 'errors' );

	if (hasStatus) {
		if ( row.skips === 0 && row.fails === 0 && row.errors === 0 ) {
			return 'perfect';
		} else if ( row.errors > 0 || row.fails > 0 ) {
			return 'fail';
		} else {
			return 'skip';
		}
	}
	return null;
};

RenderHelpers.displayPageList = function(hbs, res, data, makeRow, err, rows){
	console.log( "GET " + data.urlPrefix + "/" + data.page + data.urlSuffix );
	if ( err ) {
		res.send( err.toString(), 500 );
	} else {
		res.status( 200 );
		var tableData = data;
		if (rows.length === 0) {
			tableData.header = undefined;
		} else {
			var tableRows = [];
			for (var i = 0; i < rows.length; i++) {
				var row = rows[i];
				var tableRow = {status: RH.pageStatus(row), tableData: makeRow(row)};
				tableRows.push(tableRow);
			}
			tableData.paginate = true;
			tableData.row = tableRows;
			tableData.prev = data.page > 0;
			tableData.next = rows.length === 40;
		}
		hbs.registerHelper('prevUrl', function (urlPrefix, urlSuffix, page) {
			return urlPrefix + "/" + ( page - 1 ) + urlSuffix;
		});
		hbs.registerHelper('nextUrl', function (urlPrefix, urlSuffix, page) {
			return urlPrefix + "/" + ( page + 1 ) + urlSuffix;
		});
		res.render('table.html', tableData);
	}
};

if (typeof module === "object") {
	module.exports.RenderHelpers = RenderHelpers;
}
