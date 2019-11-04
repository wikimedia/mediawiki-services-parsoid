<?php
declare( strict_types = 1 );

namespace Parsoid\Logger;

use Wikimedia\Assert\Assert;

use Parsoid\Config\Env;

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

		// if (
		// 	$env->getPageConfig()->getPageId() %
		// 		$env->getSiteConfig()->linter->apiSampling !== 0
		// ) {
		// 	return;
		// }

		// Skip linting if we cannot lint it
		if ( !$env->getPageConfig()->hasLintableContentModel() ) {
			return;
		}

		// if ( !$env->pageWithOldid ) {
		// 	// We only want to send to the MW API if this was a request to
		// 	// parse the full page.
		// 	return;
		// }

		// Only send the request if it the latest revision
		// if ( $env->page->meta->revision->revid === $env->page->latest ) {
			if ( !$env->noDataAccess() ) {
				$env->getDataAccess()->logLinterData( $enabledBuffer );
			}
		// }
	}

}
