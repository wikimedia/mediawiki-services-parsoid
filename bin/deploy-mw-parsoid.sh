#!/bin/bash

set -eu -o pipefail

usage() {
	echo "USAGE: deploy-mw-parsoid.sh [-u <uid>]"
	echo " - <uid> is your bastion uid you use to log in to deployment.eqiad.wmnet"
	exit 1
}

# --- parse args ---
uid=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-u)
			uid="$2@"
			shift 2
			;;
		*)
			echo "Unknown option: $1"
			usage
			;;
	esac
done

deploy_host="deployment.eqiad.wmnet"

echo "---- Running helmfile apply on $deploy_host ----"
ssh "${uid}${deploy_host}" <<'EOF'
set -eu -o pipefail

cd /srv/deployment-charts/helmfile.d/services/mw-parsoid/
helmfile -e eqiad apply
helmfile -e codfw apply
EOF
