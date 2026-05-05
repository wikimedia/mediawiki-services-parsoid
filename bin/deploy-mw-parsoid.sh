#!/bin/bash

set -eu -o pipefail

if [ $# -lt 1 ]
then
	echo "USAGE: deploy-mw-parsoid.sh <uid>"
	echo " - <uid> is your bastion uid you use to log in to deployment.eqiad.wmnet"
	exit 1
fi

uid=$1
deploy_host="deployment.eqiad.wmnet"

echo "---- Running helmfile apply on $deploy_host ----"
ssh "$uid"@"$deploy_host" <<'EOF'
set -eu -o pipefail

cd /srv/deployment-charts/helmfile.d/services/mw-parsoid/
helmfile -e eqiad apply
helmfile -e codfw apply
EOF
