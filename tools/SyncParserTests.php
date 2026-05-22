#!/usr/bin/env php
<?php
declare( strict_types = 1 );

// phpcs:disable Generic.Files.LineLength.TooLong

namespace Wikimedia\Parsoid\Tools;

require_once __DIR__ . '/Maintenance.php';
require_once __DIR__ . '/ShellUtils.php';

/**
 * Synchronize Parsoid parser tests with parser tests in other repos.
 *
 * == USAGE ==
 *
 * $PARSOID is the path to a checked out git copy of Parsoid
 * $TARGET_REPO identifies which set of parserTests we're synchronizing.
 *   This should be one of the top-level keys in tests/parserTests.json,
 *   like 'core' or 'TMH'.
 *   The `path` key under that gives the gerrit project name for the repo; see
 *       https://gerrit.wikimedia.org/r/admin/repos/$project
 * $REPO_PATH is the path to a checked out git copy of the repo containing
 *   the parserTest file on your local machine.
 * $BRANCH is a branch name for the patch to $TARGET_REPO (ie, 'ptsync-<date>')
 * $BASE is typically 'master', but might be a release branch like 'REL1_47'
 *
 *   $ cd $PARSOID
 *   $ php tools/SyncParserTests.php $TARGET_REPO $REPO_PATH $BRANCH [$BASE]
 *   $ cd $REPO_PATH
 *   $ git rebase --keep-empty $BASE
 *     ... resolve conflicts, sigh ...
 *   $ php tests/parser/parserTests.php
 *     ... fix any failures by marking tests parsoid-only, etc ...
 *
 *   For extension repos, for every file with parsoid-compatible
 *   flags set, you may need to adjust tests appropriately in some cases
 *   and/or update known failures as below:
 *   $ php tests/parser/parserTests.php --updateKnownFailures --dir $PARSOID/tests/parser
 *
 *   $ git review  (only if the patch is not empty, see below)
 *
 *     ... time passes, eventually your patch is merged to $TARGET_REPO ...
 *
 *   (You might be tempted to skip the following step if the previous
 *   patch was empty, or the merged parser tests file is now identical
 *   to Parsoid's copy and you think "there is nothing to pull from
 *   core/the extension".  But don't; see "Empty Patches" below. On
 *   the other hand, if you need to sync core and multiple extensions,
 *   it's fine to do the steps above for them all and get them all
 *   merged before continuing.)
 *
 *   $ cd $PARSOID
 *   $ php tools/FetchParserTests.php $TARGET_REPO
 *   $ php bin/parserTests.php --updateKnownFailures
 *
 *   For the core repo, you also need to update integrated mode failures
 *   $ cd $TARGET_REPO
 *   $ php tests/parser/parserTests.php --parsoid --updateKnownFailures --dir $PARSOID/tests/parser
 *
 *   $ git add -u
 *   $ git commit -m "Sync parserTests with core"
 *   $ git review
 *
 *   Simple, right?
 *
 * == WHY ==
 *
 * There are two copies of parserTests files.
 *
 * Since Parsoid & core are in different repositories and both Parsoid
 * and the legacy parser are still operational, we need a parserTests
 * file in each repository. They are usually in sync but since folks
 * are hacking both wikitext engines simultaneously, the two copies
 * might be modified independently. So, we need to periodically sync
 * them (which is just a multi-repo rebase).
 *
 * We detect incompatible divergence of the two copies via CI. We run the
 * legacy parser against Parsoid's copy of the test file and test failures
 * indicate a divergence and necessitates a sync. Core also runs Parsoid
 * against core's copy of the test file in certain circumstances (and
 * this uses the version of Parsoid from mediawiki-vendor, which is
 * "the latest deployed version" not "the latest version").
 *
 * This discussion only touched upon tests/parser/parserTests.txt but
 * all of the same considerations apply to the parser test file for
 * extensions since we have a Parsoid-version and a legacy-parser version
 * of many extensions at this time.  When CI runs tests on extension
 * repositories it runs them through both the legacy parser and
 * Parsoid (but only if you opt-in by adding a 'parsoid-compatible'
 * flag to the parser test file).
 * https://codesearch.wmcloud.org/search/?q=parsoid-compatible&i=nope
 *
 * == THINKING ==
 *
 * The "thinking" part of the sync is to look at the patches created and
 * make sure that whatever change was made upstream (as shown in the diff
 * of the sync patch) doesn't require a corresponding change in Parsoid
 * and file a phab task and regenerate the known-differences list if that
 * happens to be the case.
 *
 * == EMPTY PATCHES ==
 *
 * If the patch to core (or to the extension) is empty, it's not
 * necessary to push it to Gerrit. (We use `--keep-empty` in the
 * suggested commands so that the process doesn't seem to "crash" in
 * this case, and because it's possible you still need to tweak tests
 * in order to make core happy after the sync.) Don't stop there,
 * though: you obviously don't need to wait for "time passes,
 * eventually your patch is merged to $REPO_PATH", but that means you can
 * and should just continue immediately to do the Parsoid side of the
 * sync. Just because core/the extension already had all Parsoid's
 * changes doesn't mean Parsoid has all of core's/the extension's, and
 * you'll need to update the commit hashes in Parsoid as well.
 *
 * In the other direction (when you pushed some Parsoid changes to
 * core/an extension, but the result is then identical to Parsoid's
 * copy of the parser tests), don't be tempted to skip the second half
 * of the sync either, because the Parsoid commit won't actually be
 * empty: it updates the commit hashes and effectively changes the
 * rebase source for the next sync. The sync point is recorded in
 * parserTests.json via the FetchParserTests.php tool. Since the
 * hash in the json file is checked out and rebased, without this
 * update, the next sync from Parsoid will start from an older
 * baseline and introduce pointless merge conflicts to resolve.
 */
class SyncParserTests extends Maintenance {
	use ExtendedOptsProcessor;
	use ShellUtils;

	/** @var string Absolute path to the target repo working directory */
	private string $mwpath;

	public function __construct() {
		parent::__construct();
		$this->addDescription(
			'Synchronize Parsoid parser tests with parser tests in other repos. ' .
			'See the script source for detailed usage.'
		);
		$this->addArg( 'target-repo-key', 'Key from parserTests.json (e.g. "core", "TMH"); default: "core"', false );
		$this->addArg( 'repo-path', 'Path to checked-out git copy of the target repo; defaults to $MW_CORE_REPO when target-repo-key is "core"', false );
		$this->addArg( 'branch', 'Branch name for the patch (default: "ptsync-YYYYMMDD")', false );
		$this->addArg( 'base', 'Base branch to rebase onto (default: master)', false );
	}

	public function execute(): void {
		$this->maybeHelp();

		$testFilesPath = realpath( self::$parsoidRoot . '/tests/parserTests.json' );
		$testFiles = json_decode(
			file_get_contents( $testFilesPath ), true, 512, JSON_THROW_ON_ERROR
		);

		$targetRepo = $this->getArg( 0, 'core' );
		if ( !isset( $testFiles[$targetRepo] ) ) {
			$this->fatalError( "$targetRepo not defined in parserTests.json\n" );
		}
		if ( $targetRepo === 'parsoid' ) {
			$this->fatalError( "Nothing to sync for Parsoid-only files.\n" );
		}

		$repoPathArg = $this->getArg( 1 );
		if ( $repoPathArg === null && $targetRepo === 'core' ) {
			$repoPathArg = getenv( 'MW_CORE_REPO' ) ?: null;
		}
		if ( $repoPathArg === null ) {
			$this->fatalError( "repo-path is required\n" );
		}
		$mwpath = realpath( $repoPathArg );
		if ( $mwpath === false || !is_dir( $mwpath ) ) {
			$this->fatalError( "repo-path does not exist: $repoPathArg\n" );
		}
		$this->mwpath = $mwpath;

		$branch = $this->getArg( 2, 'ptsync-' . date( 'Ymd' ) );
		$base = $this->getArg( 3, 'master' );

		$repoInfo = $testFiles[$targetRepo];
		$oldCommitHash = $repoInfo['latestCommit'];
		$targets = $repoInfo['targets'];

		$phash = null;
		$firstTarget = true;
		$changedFiles = [];

		foreach ( $targets as $targetName => $targetInfo ) {
			$this->output( "Processing $targetName\n" );

			if ( $firstTarget ) {
				// Fetch current Parsoid git hash.
				$phash = self::execCapture(
					[ 'git', 'log', '--max-count=1', '--pretty=format:%H' ],
				);
				$this->output( "Parsoid git HEAD is $phash\n" );
				$this->output( ">>> cd $this->mwpath\n" );
				self::exec( [ 'git', 'fetch', 'origin' ], $this->mwpath );

				// Create/checkout a branch, based on the previous sync point.
				self::exec( [ 'git', 'checkout', '-b', $branch, $oldCommitHash ], $this->mwpath );
			}

			$parsoidFile = realpath( self::$parsoidRoot . "/tests/parser/{$targetName}" );
			$targetFile = $this->mwpath . '/' . $targetInfo['path'];

			// Support file renaming: if an oldPath is set and the old file exists,
			// git-mv it to the new path before copying the Parsoid file over.
			if ( isset( $targetInfo['oldPath'] ) ) {
				$targetOldFile = $this->mwpath . '/' . $targetInfo['oldPath'];
				if ( file_exists( $targetOldFile ) ) {
					self::exec( [ 'git', 'mv', $targetInfo['oldPath'], $targetInfo['path'] ], $this->mwpath );
				}
			}

			try {
				$data = file_get_contents( $parsoidFile );
				if ( $data === false ) {
					throw new \RuntimeException( "Could not read $parsoidFile" );
				}
				$this->output( ">>> cp $parsoidFile $targetFile\n" );
				if ( file_put_contents( $targetFile, $data ) === false ) {
					throw new \RuntimeException( "Could not write $targetFile" );
				}
				$changedFiles[] = $targetInfo['path'];
				$firstTarget = false;
			} catch ( \RuntimeException $e ) {
				// cleanup: abandon the branch we created
				self::exec( [ 'git', 'checkout', "origin/$base" ], $this->mwpath );
				self::exec( [ 'git', 'branch', '-d', $branch ], $this->mwpath );
				throw $e;
			}
		}

		// Make a new commit with an appropriate message.
		// Note --allow-empty: sometimes there are no parsoid-side changes to merge.
		$commitmsg = "Sync up $targetRepo repo with Parsoid\n\nThis now aligns with Parsoid commit $phash";
		self::exec( [ 'git', 'add', ...$changedFiles ], $this->mwpath );
		self::exec( [ 'git', 'commit', '--allow-empty', '-m', $commitmsg ], $this->mwpath );

		// Give further instructions.
		$this->output( "\n" );
		$this->output( "Success!  Now:\n" );
		$this->output( " cd {$this->mwpath}\n" );
		$this->output( " git rebase --keep-empty origin/{$base}\n" );
		$this->output( " .. fix any conflicts .. \n" );
		$this->output( " php tests/parser/parserTests.php\n" );
		$this->output( " git review\n" );
	}
}

$maintClass = SyncParserTests::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
