<?php

require_once __DIR__ . '/../tools/Maintenance.php';

// phpcs:ignore MediaWiki.Files.ClassMatchesFilename.NotMatch
class RegressionTesting extends \Wikimedia\Parsoid\Tools\Maintenance {
	use \Wikimedia\Parsoid\Tools\ExtendedOptsProcessor;

	private $titlesPath = '/tmp/titles';

	public function __construct() {
		parent::__construct( false /* Doesn't actually require parsoid */ );
		$this->addDescription(
			"Validate round-trip testing results.\n" .
			"Typical usage:\n" .
			"\tphp " . basename( $this->getName() ) . " --uid <username> <knownGood> <maybeBad>\n" .
			"\n" .
			"You likely also need either the --url or --titles options.\n" .
			"See --help for detailed usage."
		);
		$this->addArg(
			'knownGood',
			"git commit hash to use as the oracle ('known good')"
		);
		$this->addArg(
			'maybeBad',
			"git commit hash to test ('maybe bad')"
		);
		$this->addOption(
			"uid",
			"The bastion username you use to login to scandium/testreduce1001",
			false, true, 'u'
		);
		$this->addOption(
			"contentVersion",
			"The outputContentVersion to use, if different from the default"
		);
		$this->addOption(
			"titles",
			"File containing list of pages to test, formatted as lines of dbname:title",
			false, true, 't'
		);
		$this->addOptionWithDefault(
			"url",
			"URL to use to fetch pages to test",
			'http://localhost:8003/regressions/between/<good>/<bad>'
		);
		$this->addOptionWithDefault(
			"nSem",
			"Number of semantic errors to check, -1 means 'all of them'",
			-1 /* default */, 'n' );
		$this->addOptionWithDefault(
			"nSyn",
			"Number of syntactic errors to check, -1 means 'all of them'",
			25 /* default */, 'm' );
		$this->setAllowUnregisteredOptions( true );
	}

	/**
	 * Safely execute a shell command.
	 * @param array $cmd The shell command to execute.
	 * @param bool $use_cwd Whether to execute command in "current working
	 *    directory" or else in a fixed directory (defaults to false).
	 * @throws Error if the command does not successfully execute
	 */
	private function sh( array $cmd, bool $use_cwd = false ): void {
		if ( !$this->hasOption( 'quiet' ) ) {
			error_log( implode( ' ', $cmd ) );
		}
		if ( PHP_VERSION_ID < 70400 ) {
			// Below PHP 7.4, proc_open only takes a string, not an array :(
			// Do a hacky job of escaping shell arguments
			$cmd = implode( ' ', array_map( function ( $a ) {
				return '"' . str_replace(
					[ '"', '$' ],
					[ '\"', '\$' ],
					$a
				) . '"';
			}, $cmd ) );
		}
		$descriptors = [ STDIN, STDOUT, STDERR ];
		if ( $this->hasOption( 'quiet' ) ) {
			$descriptors[1] = [ 'file', '/tmp/rt.out', 'a' ];
		}
		// phpcs:ignore MediaWiki.Usage.ForbiddenFunctions.proc_open
		$process = proc_open(
			$cmd, $descriptors, $pipes,
			$use_cwd ? null : __DIR__
		);
		if ( $process === false ) {
			throw new Error( "Command failed: " . implode( ' ', $cmd ) );
		}
		$return_value = proc_close( $process );
		if ( $return_value !== 0 ) {
			throw new Error( "Command returned non-zero status: $return_value" );
		}
	}

	/**
	 * Safely execute a command on another host, using ssh.
	 * @param array $cmd The shell command to execute.
	 * @param string|null $hostname The host on which to execute the command.
	 * @throws Error if the command does not successfully execute
	 */
	private function ssh( array $cmd, string $hostname = null ):void {
		array_unshift( $cmd, 'ssh', $this->hostname( $hostname ) );
		$this->sh( $cmd );
	}

	/**
	 * Helper function to glue strings and arrays together.
	 * Arguments passed as strings are automatically split on the space
	 * character.  Arguments passed as arrays are merged as-is, protecting
	 * any embedded spaces in the argument values.
	 * @param string|array<string> ...$commands
	 * @return array<string>
	 */
	private static function cmd( ...$commands ):array {
		return array_merge( ...array_map( function ( $item ) {
			return is_string( $item ) ? explode( ' ', $item ) : $item;
		}, $commands ) );
	}

	/**
	 * Returns $uid@$hostname
	 * @param string|null $host The hostname to use.
	 * @return string
	 */
	private function hostname( string $host = null ): string {
		if ( $host === null ) {
			// default hostname
			$host = 'testreduce1001.eqiad.wmnet';
		}
		if ( $this->hasOption( 'uid' ) ) {
			$host = $this->getOption( 'uid' ) . "@$host";
		}
		return $host;
	}

	/**
	 * Return the command-line argument fragment to use if an explicit
	 * content version was passed as a command-line option.
	 * @return string[]
	 */
	private function outputContentVersion(): array {
		if ( !$this->hasOption( 'contentVersion' ) ) {
			return [];
		}
		return [ '--outputContentVersion', $this->getOption( 'contentVersion' ) ];
	}

	/**
	 * Print out a heading on the console.
	 * @param string|null $heading The heading text, or null to print a line of dashes
	 * @param bool $force Whether to print the heading even if --quiet
	 */
	private function dashes( string $heading = null, bool $force = false ): void {
		if ( $this->hasOption( 'quiet' ) && !$force ) {
			return;
		}
		if ( $heading ) {
			echo( "----- $heading -----\n" );
		} else {
			echo( "---------------------\n" );
		}
	}

	/**
	 * Run tests on the given commit on the remote host.
	 * @param string $commit The commit to test
	 */
	public function runTest( $commit ): void {
		$cdDir = self::cmd( 'cd /srv/parsoid-testing' );
		$restartPHP = self::cmd( 'sudo systemctl restart php7.2-fpm.service' );
		$resultPath = "/tmp/results.$commit.json";
		$testScript = self::cmd(
			$cdDir, '&&',
			'node tools/runRtTests.js --proxyURL http://scandium.eqiad.wmnet:80 --parsoidURL http://DOMAIN/w/rest.php',
			$this->outputContentVersion(),
			[ '-f', $this->titlesPath ],
			[ '-o', $resultPath ]
		);

		$this->dashes( "Checking out $commit" );
		$this->ssh( self::cmd(
			$cdDir, '&&',
			'git checkout', [ $commit ], '&&',
			$restartPHP
		), 'scandium.eqiad.wmnet' );

		$this->dashes( "Running tests" );
		$this->ssh( self::cmd(
			'sudo rm -f', [ $resultPath ], '&&',
			$testScript
		) );
		$this->sh( self::cmd(
			'scp',
			$this->hasOption( 'quiet' ) ? '-q' : [],
			[ $this->hostname() . ":" . $resultPath ],
			'/tmp/'
		) );
	}

	/**
	 * Load the JSON-format results for the given commit.
	 * @param string $commit
	 * @return array
	 */
	public function readResults( string $commit ): array {
		$resultsPath = "/tmp/results.$commit.json";
		$result = [];
		foreach ( json_decode( file_get_contents( $resultsPath ), true ) as $r ) {
			$result[$r['prefix'] . ':' . $r['title']] = $r['results'];
		}
		return $result;
	}

	/**
	 * Helper function to do a 'deep' comparison on two array values.
	 * @param mixed $a
	 * @param mixed $b
	 * @return bool True iff the arrays contain the same contents
	 */
	private static function deepEquals( $a, $b ): bool {
		if ( is_array( $a ) && is_array( $b ) ) {
			// Are the keys the same?
			$ka = array_keys( $a );
			$kb = array_keys( $b );
			if ( count( $ka ) !== count( $kb ) ) {
				return false;
			}
			foreach ( $ka as $k ) {
				if ( !array_key_exists( $k, $b ) ) {
					return false;
				}
				if ( !self::deepEquals( $a[$k], $b[$k] ) ) {
					return false;
				}
			}
			return true;
		} elseif ( is_array( $a ) || is_array( $b ) ) {
			return false;
		} else {
			return $a === $b;
		}
	}

	/**
	 * Compare the results for the given titles.
	 * @param string[] $titles The titles to compare
	 * @param string $knownGood the oracle commit
	 * @param string $maybeBad the test commit
	 */
	public function compareResults( $titles, $knownGood, $maybeBad ):void {
		$this->dashes( "Comparing results" );
		$oracleResults = $this->readResults( $knownGood );
		$commitResults = $this->readResults( $maybeBad );

		$summary = [ 'degraded' => [], 'improved' => [] ];
		foreach ( $titles as $title ) {
			$oracleRes = $oracleResults[$title] ?? null;
			$commitRes = $commitResults[$title] ?? null;
			if ( self::deepEquals( $oracleRes, $commitRes ) ) {
				if ( !$this->hasOption( 'quiet' ) ) {
					echo( "$title\n" );
					echo( "No changes!\n" );
				}
			} else {
				// emit these differences even in 'quiet' mode
				echo( "$title\n" );
				echo( "$knownGood (known good) results:\n" );
				var_dump( $oracleRes );
				echo( "$maybeBad (maybe bad) results:\n" );
				var_dump( $commitRes );
				$degraded = function ( $newRes, $oldRes ) {
					// NOTE: We are conservatively assuming that even if semantic
					// errors go down but syntactic errors go up, it is a degradation.
					return ( $newRes['error'] ?? 0 ) > ( $oldRes['error'] ?? 0 ) ||
						( $newRes['semantic'] ?? 0 ) > ( $oldRes['semantic'] ?? 0 ) ||
						( $newRes['syntactic'] ?? 0 ) > ( $oldRes['syntactic'] ?? 0 );
				};
				if ( $degraded( $commitRes['html2wt'], $oracleRes['html2wt'] ) ||
					$degraded( $commitRes['selser'], $oracleRes['selser'] ) ) {
					$summary['degraded'][] = $title;
				} else {
					$summary['improved'][] = $title;
				}
			}
		}
		$this->dashes( null, true );
		if ( count( $summary['improved'] ) > 0 ) {
			echo( "Pages that seem to have improved (feel free to verify in other ways):\n" );
			echo( implode( "\n", $summary['improved'] ) );
			$this->dashes( null, true );
		}
		if ( count( $summary['degraded'] ) > 0 ) {
			echo( "Pages needing investigation:\n" );
			echo( implode( "\n", $summary['degraded'] ) );
		} else {
			echo( "*** No pages need investigation ***\n" );
		}
	}

	/** @inheritDoc */
	public function execute() {
		$this->maybeHelp();
		$knownGood = $this->getArg( 0 );
		$maybeBad = $this->getArg( 1 );
		$titles = [];

		if ( $this->hasOption( 'url' ) ) {
			$this->error( "Not yet implemented" );
		} elseif ( $this->hasOption( 'titles' ) ) {
			$this->ssh( self::cmd( 'sudo rm -f', [ $this->titlesPath ] ) );
			$this->sh( self::cmd(
				'scp',
				$this->hasOption( 'quiet' ) ? '-q' : [],
				[ $this->getOption( 'titles' ) ],
				[ $this->hostname() . ":" . $this->titlesPath ]
			), true );
			$lines = preg_split(
				'/\r\n?|\n/',
				file_get_contents( $this->getOption( 'titles' ) )
			);
			foreach ( $lines as $line ) {
				$line = preg_replace( '/ \|.*$/', '', $line );
				if ( $line !== '' ) {
					$titles[] = $line;
				}
			}
		} else {
			$this->error( "Either --titles or --url is required." );
		}

		$this->runTest( $knownGood );
		$this->runTest( $maybeBad );

		$this->compareResults( $titles, $knownGood, $maybeBad );
	}
}

$maintClass = RegressionTesting::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
