#!/bin/bash

set -eu -o pipefail

uid=""
changeid=""
testid=""
checkout_cmd=""
restart_fpm=true
parsoid_host="parsoidtest1001.eqiad.wmnet"
testreduce_host="testreduce1002.eqiad.wmnet"
deploy_mw_parsoid=false

usage() {
	echo "USAGE: start-rt-test.sh [-u <uid>] [--parsoid-host <host>] [--testreduce-host <host>] [--no-restart-fpm] <rt-test-id>"
	echo "   or: start-rt-test.sh [-u <uid>] [--parsoid-host <host>] [--testreduce-host <host>] [--no-restart-fpm] --gerrit <changeid>"
	echo " - -u <uid> is your bastion uid you use to log in to the parsoid and testreduce hosts"
	echo " - <rt-test-id> is the test id to show up in the testreduce web UI (usually a 8-char prefix of a git hash)"
	echo " - <changeid> is a numeric gerrit change id for a parsoid patch"
	echo " - --parsoid-host hostname running the Parsoid REST API (default: parsoidtest1001.eqiad.wmnet)"
	echo " - --testreduce-host hostname running the testreduce service (default: testreduce1002.eqiad.wmnet)"
	echo " - --no-restart-fpm skip restarting php8.3-fpm on the parsoid host"
	echo " - --deploy-mw-parsoid deploy mw-parsoid via helmfile before starting the test (default: skip)"
	exit 1
}

# --- parse args ---
while [[ $# -gt 0 ]]; do
	case "$1" in
		-u)
			uid="$2@"
			shift 2
			;;
		--gerrit)
			changeid="$2"
			shift 2
			;;
		--parsoid-host)
			parsoid_host="$2"
			shift 2
			;;
		--testreduce-host)
			testreduce_host="$2"
			shift 2
			;;
		--no-restart-fpm)
			restart_fpm=false
			shift
			;;
		--deploy-mw-parsoid)
			deploy_mw_parsoid=true
			shift
			;;
		-*)
			echo "Unknown option: $1"
			usage
			;;
		*)
			testid="$1"
			shift
			;;
	esac
done

# Require at least one of testid or gerrit changeid
if [[ -z "$testid" && -z "$changeid" ]]; then
	usage
fi

# --- decide checkout command ---
if [[ -n "$changeid" ]]; then
	if ! command -v jq >/dev/null 2>&1; then
		echo "Error: 'jq' (jqlang.org) is required for the --gerrit option," >&2
		echo "but it is not installed or not in your PATH." >&2
		echo "Install it and try again (e.g., 'sudo apt install jq' or 'brew install jq')." >&2
		exit 1
	fi
	echo "Fetching Gerrit checkout command for change $changeid..."
	gerrit_json=$(mktemp)
	trap 'rm -f "$gerrit_json"' EXIT

	curl -s "https://gerrit.wikimedia.org/r/changes/$changeid?o=DOWNLOAD_COMMANDS&o=CURRENT_REVISION" \
		| tail -n +2 > "$gerrit_json"

	testid=$(jq -r '.revisions | to_entries[0].key' "$gerrit_json")
	checkout_cmd=$(jq -r '.revisions | to_entries[0].value | .fetch["anonymous http"].commands["Checkout"]' "$gerrit_json")
	echo "Using checkout command: $checkout_cmd"
	echo "Using testid: $testid"
fi

# By convention we truncate testids to 8 characters, but some users
# copy-and-paste full git hashes on the command line.  Normalize.
testid=$(echo -n "$testid" | head -c 8)

if $deploy_mw_parsoid; then
	echo "---- Deploying mw-parsoid ----"
	"$(dirname "$0")/deploy-mw-parsoid.sh" "$uid"
fi

# Update code on parsoid host since RT testing scripts will hit the Parsoid REST API there
echo "---- Updating code on $parsoid_host ----"
ssh "${uid}${parsoid_host}" <<EOF
# No unset vars + early exit on error
set -eu -o pipefail

umask 0002 # Make sure everyone in wikidev group can write
cd /srv/parsoid-testing
git fetch
if [[ \$(git diff --stat) != '' ]]; then
  echo "Tree is dirty!\nCleanup before starting rt."
  exit 1
fi
$checkout_cmd
git checkout $testid
git log --oneline -n 1
if $restart_fpm; then
  sudo systemctl restart php8.3-fpm.service
fi
EOF

echo "---- Starting test run $testid on $testreduce_host ----"
ssh "${uid}${testreduce_host}" <<EOF
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
$checkout_cmd
git checkout $testid
git log --oneline -n 1

echo 'Adding new test id ...'
echo $testid > /srv/parsoid-testing/tests/testreduce/parsoid.rt-test.ids

echo 'Starting parsoid-rt clients ...'
sudo service parsoid-rt-client restart

echo "---- Tailing logs from parsoid-rt (^C when you are satisfied) ----"
sudo journalctl -f -u parsoid-rt
EOF
