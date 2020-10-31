#!/bin/bash

set -e
set -u

if [ $# -lt 4 ]
then
	echo "USAGE: $0 <uid> <oracle> <commit> <file>"
	echo " - <uid> is your bastion uid you use to log in to scandium/testreduce1001"
	echo " - <oracle> is the commit hash to use as the oracle"
	echo " - <commit> is the commit hash to test against"
	echo " - <file> has the list of pages to test (formatted as lines of dbname:title)"
	exit 1
fi

uid=$1
oracle=$2
commit=$3
file=$4

# Copy over test file
scp -q $file $uid@testreduce1001.eqiad.wmnet:/tmp/titles

function runTest() {
	local sha=$1

	cdDir="cd /srv/parsoid-testing"
	restartPHP="sudo systemctl restart php7.2-fpm.service"
	testScript="$cdDir && node tools/runRtTests.js --proxyURL http://scandium.eqiad.wmnet:80 --parsoidURL http://DOMAIN/w/rest.php -f /tmp/titles -o /tmp/results.$sha.json"

	echo "---- Checking out $sha ----"
	ssh $uid@scandium.eqiad.wmnet "$cdDir && git checkout $sha && $restartPHP"
	echo "---- Running tests ----"
	ssh $uid@testreduce1001.eqiad.wmnet "$testScript"
	scp $uid@testreduce1001.eqiad.wmnet:/tmp/results.$sha.json /tmp/
}

runTest $oracle
runTest $commit

echo "-------- Comparing results --------"
# Compare results
node <<EOF
const fs = require('fs');

const titles = fs.readFileSync("$file", 'utf8').trim().split('\n').map(function(l) {
	const ind = l.indexOf(':');
	return l.substr(0, ind) + ":" + l.substr(ind + 1).replace(/ \|.*$/, '');
});

let oracleResults = {};
let commitResults = {};
JSON.parse(fs.readFileSync("/tmp/results.$oracle.json", 'utf8')).forEach(function(r) {
	oracleResults[r.prefix + ":" + r.title] = r.results;
});

JSON.parse(fs.readFileSync("/tmp/results.$commit.json", 'utf8')).forEach(function(r) {
	commitResults[r.prefix + ":" + r.title] = r.results;
});

let summary = { degraded: [], improved: [] };

titles.forEach(function(title) {
	const oracleRes = oracleResults[title];
	const commitRes = commitResults[title];
	const oracleStr = JSON.stringify(oracleRes, null, '\t');
	const commitStr = JSON.stringify(commitRes, null, '\t');
	console.log(title);
	if (commitStr === oracleStr) {
		console.log('No changes!');
	} else {
		console.log("$oracle results:", oracleStr);
		console.log("$commit results:", commitStr);

		const degraded = function(newRes, oldRes) {
			// NOTE: We are conservatively assuming that even if semantic
			// errors go down but syntactic errors go up, it is a degradation.
			return (newRes.error || 0) > ( oldRes.error || 0) ||
				(newRes.semantic || 0) > (oldRes.semantic || 0) ||
				(newRes.syntactic || 0) > (oldRes.syntactic || 0);
		};
		if (degraded(commitRes.html2wt, oracleRes.html2wt) ||
			degraded(commitRes.selser, oracleRes.selser)
		) {
			summary.degraded.push(title);
		} else {
			summary.improved.push(title);
		}
	}
});
console.log('----------------------------');
if (summary.improved.length > 0) {
	console.log('Pages that seem to have improved (feel free to verify in other ways):');
	console.log(summary.improved);
	console.log('----------------------------');
}
console.log('Pages needing investigation:');
console.log(summary.degraded);
EOF
