#!/bin/bash

if [ $# -lt 2 ]
then
	echo "USAGE: start-rt-test.sh <uid> <rt-test-id>"
	echo " - <uid> is your bastion uid you use to log in to scandium/testreduce1001"
	echo " - <rt-test-id> is the test id to show up in the testreduce web UI (usually a 8-char substring of a git hash)"
	exit 1
fi

uid=$1
testid=$2

# Update code on scandium since RT testing scripts will hit the Parsoid REST API on scandium
echo "---- Updating code on scandium ----"
ssh $uid@scandium.eqiad.wmnet <<EOF
# No unset vars + early exit on error
set -e
set -u

cd /srv/parsoid-testing
git checkout master
git pull
git log --oneline -n 1
sudo systemctl restart php7.2-fpm.service
EOF

echo "---- Starting test run $testid on testreduce1001 ----"
ssh $uid@testreduce1001.eqiad.wmnet <<EOF
# No unset vars + early exit on error
set -e
set -u

echo 'Stopping parsoid-rt clients ...'
sudo service parsoid-rt-client stop

echo 'Updating deploy repo checkout ...'
cd /srv/parsoid-testing

# Strictly speaking, it is not necessary to update code on testreduce1001
# It is only needed if rt-testing related code is updated.
# But, it is simpler to just update it every single time.
git checkout master
git pull
git log --oneline -n 1

# Temporary hack to get Parsoid's RT testing client (still written
# in node.js) linked up to its npm modules (still hanging out in
# an otherwise-obsolete deploy repo).
ln -s -f /srv/deployment/parsoid/deploy/node_modules

echo 'Adding new test id ...'
echo $testid > /srv/parsoid-testing/tests/testreduce/parsoid.rt-test.ids

echo 'Starting parsoid-rt clients ...'
sudo service parsoid-rt-client restart

echo "---- Tailing logs from parsoid-rt (^C when you are satisfied) ----"
sudo journalctl -f -u parsoid-rt
EOF
