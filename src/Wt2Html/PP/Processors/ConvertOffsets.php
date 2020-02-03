<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use DOMElement;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Logger\LintLogger;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMDataUtils;

/**
 * Very thin shim to call ContentUtils::convertOffsets where requested
 * in the environment.
 */
class ConvertOffsets {
	/**
	 * DOM Postprocessor entry function to walk DOM rooted at $rootNode
	 * and convert the DSR offsets as needed.
	 * @see ConvertUtils::convertOffsets
	 *
	 * @param DOMElement $rootNode
	 * @param Env $env
	 * @param array|null $options
	 */
	public function run( DOMElement $rootNode, Env $env, ?array $options = [] ) {
		$doc = $rootNode->ownerDocument;
		$offsetType = $env->getRequestOffsetType();
		ContentUtils::convertOffsets(
			$env, $doc, 'byte', $offsetType
		);
		// Because linter runs before this DOM pass, we need to convert offsets
		// of collected lints from 'byte' to the requested type
		if ( $offsetType !== 'byte' ) {
			$lints = $env->getLints();
			LintLogger::convertDSROffsets( $env, $lints, 'byte', $offsetType );
			$env->setLints( $lints );
		}
		DOMDataUtils::getPageBundle( $doc )->parsoid->offsetType = $offsetType;
	}
}
