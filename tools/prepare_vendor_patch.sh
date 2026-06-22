#!/bin/bash

set -eu -o pipefail

if [ $# -lt 2 ]; then
	echo "USAGE: $0 <old-git-tag> <new-git-tag> <task-id> [<git-sha-of-new-tag> <vendor-repo> <core-repo>]"
	echo "If git-sha is omitted, HEAD is used by default"
	echo "If repo args are omitted, MW_VENDOR_REPO and MW_CORE_REPO environment variables are used"
	echo "Ex: $0 v0.19.0-a6 v0.19.0-a7 TXXXXXX HEAD ../repos/vendor ../core"
	echo "Ex: $0 v0.19.0-a6 v0.19.0-a7 TXXXXXX HEAD"
	echo "Ex: $0 v0.19.0-a6 v0.19.0-a7 TXXXXXX"
	echo "You have to skip OR provide both repo values on the CLI"
	echo "The task id refers to the associated release phab task."
	exit 1
fi

waitForConfirmation() {
	while true; do
		# Don't accept from a file
		read -r -n 1 -p "Enter y/Y to continue or n/N to exit: " confirm < /dev/tty
		echo
		if [ "$confirm" == "y" ] || [ "$confirm" == "Y" ]; then
			break
		fi
		if [ "$confirm" == "n" ] || [ "$confirm" == "N" ]; then
			exit 1
		fi
	done
}

pwd="$PWD"
newTagSha=$(git rev-list -n 1 "HEAD") # DEFAULT

if [ $# -gt 3 ]; then
	newTagSha=$4
	if [ $# -gt 4 ]; then
		vendorRepo="$5"
		coreRepo="$6"
	fi
fi

if [ "${vendorRepo:-foo}" == "foo" ]; then
	if [ "${MW_VENDOR_REPO:-foo}" == "foo" ]; then
		echo "Please provide vendor repo on CLI or set MW_VENDOR_REPO environment variable"
		exit 1
	fi
	vendorRepo="$MW_VENDOR_REPO"
fi
if [ ! -d "$vendorRepo" ]; then
	echo "Vendor repo $vendorRepo doesn't exist. Please verify and try again."
	exit 1
fi
if [ "${coreRepo:-foo}" == "foo" ]; then
	if [ "${MW_CORE_REPO:-foo}" == "foo" ]; then
		echo "Please provide core repo on CLI or set MW_CORE_REPO environment variable"
		exit 1
	fi
	coreRepo="$MW_CORE_REPO"
fi
if [ ! -d "$coreRepo" ]; then
	echo "Core repo $coreRepo doesn't exist. Please verify and try again."
	exit 1
fi

# Resolve relative paths
vendorRepo=$(realpath -- "$vendorRepo")
coreRepo=$(realpath -- "$coreRepo")

# Extract docker image from vendor README and build the composer command
dockerImage=$(grep 'docker run' "$vendorRepo/README.md" | grep 'update --no-dev' \
	| sed -e 's/ update --no-dev.*//' | awk '{print $NF}')
if [ -z "$dockerImage" ] || [[ "$dockerImage" != "docker-registry.wikimedia.org/"* ]]; then
	echo "Could not extract valid docker image from $vendorRepo/README.md — check for format changes."
	exit 1
fi
echo "Using docker image from vendor README: $dockerImage"

# Sanity check: verify the docker image entrypoint runs composer
if ! docker inspect "$dockerImage" > /dev/null 2>&1; then
	echo "Pulling docker image for sanity check..."
	docker pull "$dockerImage"
fi
entrypoint=$(docker inspect --format '{{json .Config.Entrypoint}}' "$dockerImage")
if ! echo "$entrypoint" | grep -qE '(^|["/])composer"'; then
	echo "Sanity check failed: $dockerImage entrypoint does not appear to run composer."
	echo "Entrypoint: $entrypoint"
	exit 1
fi
composer="docker run --rm -it -u $(id -u):$(id -g) -v $vendorRepo/.git:/src/.git:ro -v $vendorRepo:/src -w /src $dockerImage"

# lower-case tag names
oldTag=$(echo "$1" | tr '[:upper:]' '[:lower:]')
newTag=$(echo "$2" | tr '[:upper:]' '[:lower:]')

if [[ $1 == V* ]]; then
	echo "Lowercased tag from $1 to $oldTag"
	echo ""
fi

if [[ $oldTag != v* ]]; then
	echo "Tag names should start with 'v' which $oldTag does not."
	exit 1
fi

if [[ $2 == V* ]]; then
	echo "Lowercased tag from $2 to $newTag"
	echo ""
fi

if [[ $newTag != v* ]]; then
	echo "Tag names should start with 'v' which $newTag does not."
	exit 1
fi

# Generate deploy log
deployLog=$(bash ./tools/gen_deploy_log.sh "$oldTag" "$newTagSha")

echo "{{tracked|$3}}
$deployLog" > deploy.log.txt

echo "$deployLog"
echo "-----------------------------------------------"
echo "^^^ These patches will be part of the new tag."
waitForConfirmation
echo

tagCount=$(git tag -l "$newTag" | wc -l | xargs)
if [ "$tagCount" != "0" ]; then
	existingTagSha=$(git rev-list -n 1 "$newTag")
	if [[ "$existingTagSha" != "$newTagSha"* ]]; then
		echo "Tag $newTag already exists but does not point to $newTagSha."
		exit 1
	fi
else
	# Tag & push new version
	echo "Creating new tag $newTag"
	git tag "$newTag" "$newTagSha"
fi

echo "Ready to push tag $newTag (commit $newTagSha) to origin"
waitForConfirmation
echo
git push origin "$newTag"
echo "Pushed new tag $newTag to origin"
echo

# Identify fixed bugs
fixedbugs=$(git log "$oldTag".."$newTag" | (grep -E "^\s*Bug:" || echo "") | sed 's/^[[:blank:]]*//g;' | sort | uniq)

# --- Prepare vendor patch ---
# Update composer.json
cd "$vendorRepo"

## checkout master branch and update
git checkout master
git pull origin master --rebase
vstring="${newTag//v/}"
sed -i.bak "s/wikimedia\/parsoid.*/wikimedia\/parsoid\": \"$vstring\",/g;" composer.json
rm composer.json.bak

# Wait for new tag to propagate to packagist
echo "Waiting for $newTag to appear on packagist (this can take ~15 min)..."
startTime=$SECONDS
while true; do
	elapsed=$(( SECONDS - startTime ))
	mins=$(( elapsed / 60 ))
	secs=$(( elapsed % 60 ))
	if $composer show -a wikimedia/parsoid "$newTag" > /dev/null 2>&1; then
		printf '\nTag %s found on packagist! (waited %dm%02ds)\n' "$newTag" "$mins" "$secs"
		break
	fi
	printf '\r  Not yet available (we'\''ve waited %dm%02ds)...' "$mins" "$secs"
	sleep 30
done
echo

# update packages
echo "Running composer update"
$composer update --no-dev
echo

# Generate commit
echo "Preparing vendor patch"
git checkout -B "$3"
git add -A wikimedia/parsoid composer.lock composer.json composer
git commit -m "Bump wikimedia/parsoid to $vstring

$fixedbugs
Bug: $3"
changeid=$(git log -1 | grep "Change-Id" | sed 's/.*: //g;')

# --- Prepare core patch that depends on the vendor patch ---
cd "$pwd" # $5 could be relative or absolute - so go back to original dir first
cd "$coreRepo"
## checkout master branch and update
git checkout master
git pull origin master --rebase

echo
echo "Bumping Parsoid version in core and preparing patch"

sed -i.bak "s/wikimedia\/parsoid.*/wikimedia\/parsoid\": \"$vstring\",/g;" composer.json
rm composer.json.bak
git checkout -B "$3"
git commit composer.json -m "Bump wikimedia/parsoid to $vstring

Bug: $3
Depends-On: $changeid"
echo

# Add instructions
echo "------ Followup needed ------"
echo "* Please add contents of $pwd/deploy.log.txt to [[mw:Parsoid/Deployments]]"
echo "* Please verify new patch in vendor repo ($vendorRepo) and upload to gerrit for review"
echo "* Please verify new patch in core repo ($coreRepo) and upload to gerrit for review"
echo "* Please +2 the uploaded core patch to ensure that when the vendor patch is +2ed, they merge together"
