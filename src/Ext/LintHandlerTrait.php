<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMElement;
use DOMNode;
use Parsoid\Config\ParsoidExtensionAPI;

/**
 * Most native extensions probably won't support linting
 * and can simply include this trait to avoid boilerplate.
 */
trait LintHandlerTrait {
	/** @inheritDoc */
	public function hasLintHandler(): bool {
		return false;
	}

	/** @inheritDoc */
	public function lintHandler(
		ParsoidExtensionAPI $extApi, DOMElement $rootNode, callable $defaultHandler
	): ?DOMNode {
		throw new \BadMethodCallException( 'Unexpected call.'
			. get_class( $this ) . ' does not support linting.' );
	}
}
