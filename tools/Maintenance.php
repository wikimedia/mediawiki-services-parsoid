<?php

namespace Parsoid\Tools;

// Hacky preprocessing of command-line arguments: look for
// --integrated and/or --standalone flags.
$parsoidMode = null;
for ( $arg = reset( $argv ); $arg !== false; $arg = next( $argv ) ) {
	if ( $arg === '--' ) {
		# end of options
		break;
	} elseif ( $arg === '--integrated' || $arg === '--standalone' ) {
		$parsoidMode = substr( $arg, 2 );
		break;
	}
}

// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
if ( $parsoidMode === 'integrated' ) {
	/* Is MW installed w/ Parsoid?  Then use core's copy of Maintenance.php. */
	if ( strval( getenv( 'MW_INSTALL_PATH' ) ) !== '' ) {
		require_once getenv( 'MW_INSTALL_PATH' ) . '/maintenance/Maintenance.php';
	} else {
		error_log( 'MW_INSTALL_PATH environment variable must be defined.' );
	}
	abstract class Maintenance extends \Maintenance {
		public function __construct() {
			parent::__construct();
			$this->requireExtension( 'Parsoid-testing' );
		}

		public function addDefaultParams(): void {
			$this->addOption(
				'integrated',
				'Run parsoid integrated with a host MediaWiki installation ' .
				'at MW_INSTALL_PATH'
			);
			$this->addOption(
				'standalone',
				'Run parsoid standalone, communicating with a host MediaWiki ' .
				'using network API (see --domain option)'
			);
			parent::addDefaultParams();
		}

		/**
		 * Make the protected method from the superclass into a public method
		 * so we can use this from TestUtils.php.
		 */
		public function addOption(
			$name, $description, $required = false,
			$withArg = false, $shortName = false,
			$multiOccurrence = false
		) {
			parent::addOption(
				$name, $description, $required, $withArg, $shortName,
				$multiOccurrence
			);
		}

		/** Make the options array available to ExtendedOptsProcessor */
		protected function getOptions() {
			return $this->mOptions;
		}
	}

	define( 'PARSOID_RUN_MAINTENANCE_IF_MAIN', RUN_MAINTENANCE_IF_MAIN );

	// XXX There's probably a better way to ensure that Parsoid's loaded
	require_once __DIR__ . '/../vendor/autoload.php';
} else {
	/* Use Parsoid's stand-alone clone of the Maintenance framework */
	require_once __DIR__ . '/../vendor/autoload.php';

	abstract class Maintenance extends OptsProcessor {
		public function addDefaultParams(): void {
			$this->addOption(
				'integrated',
				'Run parsoid integrated with a host MediaWiki installation ' .
				'at MW_INSTALL_PATH'
			);
			$this->addOption(
				'standalone',
				'Run parsoid standalone, communicating with a host MediaWiki ' .
				'using network API (see --domain option)'
			);
			parent::addDefaultParams();
		}

		/** Make the options array available to ExtendedOptsProcessor */
		protected function getOptions() {
			return $this->options;
		}

		public function setup() {
			# Abort if called from a web server
			# wfIsCLI() is not available yet
			if ( PHP_SAPI !== 'cli' && PHP_SAPI !== 'phpdbg' ) {
				$this->fatalError( 'This script must be run from the command line' );
			}
			# Make sure we can handle script parameters
			if ( !defined( 'HPHP_VERSION' ) && !ini_get( 'register_argc_argv' ) ) {
				$this->fatalError( 'Cannot get command line arguments, register_argc_argv is set to false' );
			}

			// Send PHP warnings and errors to stderr instead of stdout.
			// This aids in diagnosing problems, while keeping messages
			// out of redirected output.
			if ( ini_get( 'display_errors' ) ) {
				ini_set( 'display_errors', 'stderr' );
			}

			$this->loadParamsAndArgs();

			# Set max execution time to 0 (no limit). PHP.net says that
			# "When running PHP from the command line the default setting is 0."
			# But sometimes this doesn't seem to be the case.
			ini_set( 'max_execution_time', 0 );

			# Turn off output buffering if it's on
			while ( ob_get_level() > 0 ) {
				ob_end_flush();
			}
		}

		/** For compatibility with core. */
		public static function requireTestsAutoloader() {
			/* do nothing, for compatibility only */
		}

		/** For compatibility with core */
		public function finalSetup() {
			if ( ob_get_level() ) {
				ob_end_flush();
			}
		}
	}

	define( 'PARSOID_RUN_MAINTENANCE_IF_MAIN', __DIR__ . '/doMaintenance.php' );
}
