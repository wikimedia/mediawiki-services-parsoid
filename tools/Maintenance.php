<?php

namespace Parsoid\Tools;

// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
if ( strval( getenv( 'MW_INSTALL_PATH' ) ) !== '' ) {
	require_once getenv( 'MW_INSTALL_PATH' ) . '/maintenance/Maintenance.php';
}
// Check whether Parsoid is installed as an extension or library of core
// XXX the class_exists('\Parsoid\...') test doesn't actually work, since
// setup and extension loading haven't been done yet.
if ( class_exists( '\Maintenance' ) && class_exists( '\Parsoid\Tools\OptsProcessor' ) ) {
	/* Is MW installed w/ Parsoid?  Then use core's copy of Maintenance.php. */
	abstract class Maintenance extends \Maintenance {
	}

	define( 'PARSOID_RUN_MAINTENANCE_IF_MAIN', RUN_MAINTENANCE_IF_MAIN );

	// XXX There's probably a better way to ensure that Parsoid's loaded
	require_once __DIR__ . '/../vendor/autoload.php';
} else {
	/* Use Parsoid's stand-alone clone */
	require_once __DIR__ . '/../vendor/autoload.php';

	abstract class Maintenance extends OptsProcessor {
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
	}

	define( 'PARSOID_RUN_MAINTENANCE_IF_MAIN', __DIR__ . '/doMaintenance.php' );
}
