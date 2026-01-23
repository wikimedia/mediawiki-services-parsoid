<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\Core\DomSourceRange;

/**
 * An empty Arguments which returns zero-length arrays.
 */
class EmptyArguments implements Arguments {
	public function __construct(
		private ?DomSourceRange $srcOffsets
	) {
	}

	/** @inheritDoc */
	public function getSrcOffsets(): ?DomSourceRange {
		return $this->srcOffsets;
	}

	/** @inheritDoc */
	public function getOrderedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array {
		return [];
	}

	/** @inheritDoc */
	public function getNamedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array {
		return [];
	}
}
