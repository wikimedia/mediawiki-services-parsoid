#!/usr/bin/env php
<?php
declare( strict_types = 1 );

// phpcs:disable Generic.Files.LineLength.TooLong

namespace Wikimedia\Parsoid\Tools;

require_once __DIR__ . '/Maintenance.php';

/**
 * Fetch new sync'ed parserTests from upstream repositories.
 *
 * UPDATE parserTests.json when upstream repository includes new parsoid-relevant tests.
 * This ensures that our knownFailures list is in sync.
 *
 * Usage:
 *   $ cd $PARSOID
 *   $ php tools/fetch-parserTests.php <repo-key>
 *   $ php tools/fetch-parserTests.php --all
 *   $ php tools/fetch-parserTests.php --all --branch=REL1_43
 *
 * Set the GERRITUA environment variable to a User-Agent string to avoid
 * throttling by Gerrit.  WMF staff may use the UA string at
 * https://office.wikimedia.org/wiki/Team_interfaces/Content_Transform/Setup_information
 */
class FetchParserTests extends Maintenance {
	use ExtendedOptsProcessor;
	use ShellUtils;

	private string $testDir;
	private string $testFilesPath;
	private object $testFiles;
	private string $userAgent;

	public function __construct() {
		parent::__construct();
		$this->addDescription(
			'Fetch new sync\'ed parserTests from upstream repositories. ' .
			'Updates parserTests.json with new commit hashes and SHA1 checksums.'
		);
		$this->addOption(
			'all',
			'Fetch files for all targets defined in the parserTests.json.'
		);
		$this->addOptionWithDefault(
			'branch',
			'Branch on which to fetch the latest parserTests files.',
			'master'
		);
		$this->addArg( 'repo-key', 'Key from parserTests.json (e.g. "core", "TMH")', false );
	}

	public function suppressParsoidModeOptions(): bool {
		return true;
	}

	public function execute(): void {
		$ua = getenv( 'GERRITUA' );
		if ( !$ua ) {
			$this->error( "WARNING: gerrit scraping may be throttled without a User-Agent\n" );
			$this->error( "Set GERRITUA to set an appropriate user agent, and contact someone from\n" );
			$this->error( "Content Transform Team (https://www.mediawiki.org/wiki/Content_Transform_Team)\n" );
			$this->error( "to get it whitelisted.  WMF staff may use the UA string at\n" );
			$this->error( "https://office.wikimedia.org/wiki/Team_interfaces/Content_Transform/Setup_information\n" );
			$ua = 'wikimedia-parsoid-fetch';
		}
		$this->userAgent = $ua;

		$parsoidRoot = realpath( self::$parsoidRoot );
		$this->testDir = "{$parsoidRoot}/tests/parser";
		$this->testFilesPath = "{$parsoidRoot}/tests/parserTests.json";
		$this->testFiles = json_decode(
			file_get_contents( $this->testFilesPath ),
			false, 512,
			JSON_THROW_ON_ERROR
		);

		$hasAll = $this->hasOption( 'all' );
		$hasArg = $this->hasArg( 0 );

		if ( $this->hasOption( 'help' ) || ( !$hasAll && !$hasArg ) ) {
			$this->maybeHelp( true );
			return;
		}

		$targetRepos = $hasAll ? array_keys( (array)$this->testFiles ) : [ $this->getArg( 0 ) ];
		$branch = $this->getOption( 'branch' );

		foreach ( $targetRepos as $targetRepo ) {
			if ( !isset( $this->testFiles->$targetRepo ) ) {
				$this->error( "$targetRepo not defined in parserTests.json\n" );
				continue;
			}
			if ( $targetRepo === 'parsoid' ) {
				$this->error( "Nothing to sync for parsoid files\n" );
				continue;
			}
			if ( $this->isUpToDate( $targetRepo ) ) {
				$this->output( "Files not locally modified.\n" );
			}
			$this->forceUpdate( $targetRepo, $branch );
		}
	}

	private function computeSHA1( string $targetName ): ?string {
		$targetPath = $this->testDir . '/' . $targetName;
		if ( !file_exists( $targetPath ) ) {
			return null;
		}
		return sha1_file( $targetPath ) ?: null;
	}

	private function gerritFetch( string $path ): string {
		$url = "https://gerrit.wikimedia.org{$path}";
		return self::fetchUrl( $url, userAgent: $this->userAgent );
	}

	private function fetchFile(
		string $repo, string $targetName, string $gitCommit, bool $skipCheck
	): void {
		$repoInfo = $this->testFiles->$repo;
		$file = $repoInfo->targets->$targetName;
		$filePath = "/r/plugins/gitiles/{$repoInfo->project}/+/" .
			"{$gitCommit}/{$file->path}?format=TEXT";

		$this->output( "Fetching $targetName history from $filePath\n" );

		$content = $this->gerritFetch( $filePath );
		// Gitiles raw files are base64 encoded
		$decoded = base64_decode( $content, true );
		if ( $decoded === false ) {
			throw new \RuntimeException( "Failed to base64-decode response for $targetName" );
		}

		$targetPath = $this->testDir . '/' . $targetName;
		file_put_contents( $targetPath, $decoded );

		if ( !$skipCheck ) {
			$sha1 = $this->computeSHA1( $targetName );
			$expected = $file->expectedSHA1 ?? null;
			if ( $expected !== null && $expected !== $sha1 ) {
				$this->error(
					"Parsoid expected sha1sum $expected but got $sha1\n"
				);
			}
		}
	}

	private function isUpToDate( string $targetRepo ): bool {
		$targets = $this->testFiles->$targetRepo->targets;
		foreach ( (array)$targets as $targetName => $info ) {
			$expected = $info->expectedSHA1 ?? null;
			if ( $expected === null || $expected !== $this->computeSHA1( $targetName ) ) {
				return false;
			}
		}
		return true;
	}

	private function forceUpdate( string $targetRepo, string $branch ): void {
		$repoInfo = $this->testFiles->$targetRepo;
		$gerritPath = "/r/plugins/gitiles/{$repoInfo->project}" .
			"/+log/refs/heads/{$branch}?format=JSON";

		$this->output( "Fetching $targetRepo history from $gerritPath\n" );

		$raw = $this->gerritFetch( $gerritPath );
		// Gitiles prepends ")]}'\n" to JSON responses
		$data = json_decode( substr( $raw, 5 ), true, 512, JSON_THROW_ON_ERROR );
		$gitCommit = $data['log'][0]['commit'];

		foreach ( array_keys( (array)$repoInfo->targets ) as $targetName ) {
			$this->fetchFile( $targetRepo, $targetName, $gitCommit, true );
			$sha1 = $this->computeSHA1( $targetName );
			$this->testFiles->$targetRepo->targets->$targetName->expectedSHA1 = $sha1;
		}
		$this->testFiles->$targetRepo->latestCommit = $gitCommit;

		file_put_contents(
			$this->testFilesPath,
			self::formatJson( $this->testFiles )
		);
		$this->output( "Updated {$this->testFilesPath}\n" );
	}

	/**
	 * JSON-encode with tab indentation to match existing parserTests.json.
	 */
	private static function formatJson( mixed $data ): string {
		$json = json_encode(
			$data,
			JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
		);
		// JSON_PRETTY_PRINT uses 4 spaces per level; convert to tabs
		$json = preg_replace_callback( '/^( {4})+/m', static function ( array $m ): string {
			return str_repeat( "\t", (int)( strlen( $m[0] ) / 4 ) );
		}, $json );
		return $json . "\n";
	}
}

$maintClass = FetchParserTests::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
