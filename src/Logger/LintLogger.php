<?php
declare( strict_types = 1 );

namespace Parsoid\Logger;

use Wikimedia\Assert\Assert;

use Parsoid\Config\Env;
use Parsoid\Utils\TokenUtils;
use Parsoid\Utils\Timing;

/**
 * Logger backend for linter.
 * This backend filters out logging messages with Logtype "lint/*" and
 * logs them (console, external service).
 */
class LintLogger {

	/** @var Env */
	private $env;

	/**
	 * @param Env $env
	 */
	public function __construct( Env $env ) {
		$this->env = $env;
	}

	/**
	 * Convert DSR offsets in collected lints
	 *
	 * Linter offsets should always be ucs2 if the lint viewer is client-side JavaScript.
	 * But, added conversion args in case callers wants some other conversion for other
	 * use cases.
	 *
	 * @param Env $env
	 * @param array &$lints
	 * @param string $from
	 * @param string $to
	 */
	public static function convertDSROffsets(
		Env $env, array &$lints, string $from = 'byte', string $to = 'ucs2'
	): void {
		$metrics = $env->getSiteConfig()->metrics();
		$timer = null;
		if ( $metrics ) {
			$timer = Timing::start( $metrics );
		}

		// Accumulate offsets + convert widths to pseudo-offsets
		$offsets = [];
		foreach ( $lints as &$lint ) {
			$dsr = &$lint['dsr'];
			$offsets[] = &$dsr[0];
			$offsets[] = &$dsr[1];

			// dsr[2] is a width. Convert it to an offset pointer.
			if ( ( $dsr[2] ?? 0 ) > 1 ) { // widths 0,1,null are fine
				$dsr[2] = $dsr[0] + $dsr[2];
				$offsets[] = &$dsr[2];
			}

			// dsr[3] is a width. Convert it to an offset pointer.
			if ( ( $dsr[3] ?? 0 ) > 1 ) { // widths 0,1,null are fine
				$dsr[3] = $dsr[1] - $dsr[3];
				$offsets[] = &$dsr[3];
			}
		}

		TokenUtils::convertOffsets( $env->topFrame->getSrcText(), $from, $to, $offsets );

		// Undo the conversions of dsr[2], dsr[3]
		foreach ( $lints as &$lint ) {
			$dsr = &$lint['dsr'];
			if ( ( $dsr[2] ?? 0 ) > 1 ) { // widths 0,1,null are fine
				$dsr[2] = $dsr[2] - $dsr[0];
			}
			if ( ( $dsr[3] ?? 0 ) > 1 ) { // widths 0,1,null are fine
				$dsr[3] = $dsr[1] - $dsr[3];
			}
		}

		if ( $metrics ) {
			$timer->end( "lint.offsetconversion" );
		}
	}

	/**
	 *
	 */
	public function logLintOutput() {
		$env = $this->env;
		$linting = $env->getSiteConfig()->linting();
		$enabledBuffer = null;

		if ( $linting === true ) {
			$enabledBuffer = $env->getLints(); // Everything is enabled
		} else {
			if ( is_array( $linting ) ) {
				$enabledBuffer = array_filter( $env->getLints(), function ( $item ) use ( &$linting ) {
					return array_search( $item['type'], $linting, true ) !== false;
				} );
			} else {
				Assert::invariant( false, 'Why are we here? Linting is disabled.' );
			}
		}
		/* This is no longer supported in ParsoidPHP according to Subbu
		if ( $env->getPageConfig()->getPageId() %
				 $env->getSiteConfig()->linter->apiSampling !== 0 ) {
			return;
		} */

		// Skip linting if we cannot lint it
		if ( !$env->getPageConfig()->hasLintableContentModel() ) {
			return;
		}

		if ( !$env->noDataAccess() ) {
			$env->getDataAccess()->logLinterData( $env, $enabledBuffer );
		}
	}

}
