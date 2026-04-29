#!/bin/bash

set -eu -o pipefail

restart_fpm=true
args=()
for arg in "$@"; do
	if [ "$arg" = "--no-restart-fpm" ]; then
		restart_fpm=false
	else
		args+=("$arg")
	fi
done
set -- "${args[@]}"

if [ $# -lt 2 ]
then
	echo "USAGE: start-rt-test.sh <uid> <rt-test-id> [parsoid-host] [testreduce-host] [--no-restart-fpm]"
	echo " - <uid> is your bastion uid you use to log in to the parsoid and testreduce hosts"
	echo " - <rt-test-id> is the test id to show up in the testreduce web UI (usually a 8-char prefix of a git hash)"
	echo " - <parsoid-host> hostname running the Parsoid REST API (default: parsoidtest1001.eqiad.wmnet)"
	echo " - <testreduce-host> hostname running the testreduce service (default: testreduce1002.eqiad.wmnet)"
	echo " - --no-restart-fpm skip restarting php8.3-fpm on the parsoid host"
	exit 1
fi

uid=$1
testid=$2
parsoid_host=${3:-parsoidtest1001.eqiad.wmnet}
testreduce_host=${4:-testreduce1002.eqiad.wmnet}

# By convention we truncate testids to 8 characters, but some users
# copy-and-paste full git hashes on the command line.  Normalize.
testid=$(echo -n "$testid" | head -c 8)

# Update code on parsoid host since RT testing scripts will hit the Parsoid REST API there
echo "---- Updating code on $parsoid_host ----"
ssh "$uid"@"$parsoid_host" <<EOF
# No unset vars + early exit on error
set -eu -o pipefail

umask 0002 # Make sure everyone in wikidev group can write
cd /srv/parsoid-testing
git fetch
if [[ \$(git diff --stat) != '' ]]; then
  echo "Tree is dirty!\nCleanup before starting rt."
  exit 1
fi
git checkout $testid
git log --oneline -n 1
if $restart_fpm; then
  sudo systemctl restart php8.3-fpm.service
fi
EOF

echo "---- Starting test run $testid on $testreduce_host ----"
ssh "$uid"@"$testreduce_host" <<EOF
# No unset vars + early exit on error
set -eu -o pipefail

# Check if we need to free disk space
df /srv/data --output=pcent | tail -n 1 | awk '0+\$1 > 80 {print; print "Free disk space to continue!\nSee https://wikitech.wikimedia.org/wiki/Parsoid/Common_Tasks#Freeing_disk_space"; exit 1}'

echo 'Stopping parsoid-rt clients ...'
sudo service parsoid-rt-client stop

echo 'Updating deploy repo checkout ...'
cd /srv/parsoid-testing

# Strictly speaking, it is not necessary to update code on testreduce1002
# It is only needed if rt-testing related code is updated.
# But, it is simpler to just update it every single time.
umask 0002 # Make sure everyone in wikidev group can write
git fetch
git checkout $testid
git log --oneline -n 1

echo 'Adding new test id ...'
echo $testid > /srv/parsoid-testing/tests/testreduce/parsoid.rt-test.ids

echo 'Starting parsoid-rt clients ...'
sudo service parsoid-rt-client restart

echo "---- Tailing logs from parsoid-rt (^C when you are satisfied) ----"
sudo journalctl -f -u parsoid-rt
EOF
