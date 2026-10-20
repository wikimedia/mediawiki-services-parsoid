#!/bin/bash

set -eu -o pipefail

usage() {
	echo "USAGE: deploy-mw-parsoid.sh [-u <uid>] [--datacenter <dc>]"
	echo " - <uid> is your bastion uid you use to log in to deployment.eqiad.wmnet"
	echo " - <dc> is eqiad or codfw; only that datacenter's mw-parsoid is deployed (default: both)"
	exit 1
}

# --- parse args ---
uid=""
datacenters="eqiad codfw"
while [[ $# -gt 0 ]]; do
	case "$1" in
		-u)
			uid="$2@"
			shift 2
			;;
		--datacenter)
			datacenters="$2"
			shift 2
			;;
		*)
			echo "Unknown option: $1"
			usage
			;;
	esac
done

for dc in $datacenters; do
	case "$dc" in
		eqiad|codfw) ;;
		*)
			echo "Unknown datacenter: $dc"
			usage
			;;
	esac
done

deploy_host="deployment.eqiad.wmnet"

echo "---- Running helmfile apply ($datacenters) on $deploy_host ----"
ssh "${uid}${deploy_host}" <<EOF
set -eu -o pipefail

cd /srv/deployment-charts/helmfile.d/services/mw-parsoid/
for dc in $datacenters; do
	helmfile -e \$dc apply
done
EOF
