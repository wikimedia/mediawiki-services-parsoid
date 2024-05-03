<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use RuntimeException;

/**
 * Class RangeBuilderException
 * Thrown when a DOMRangeBuilder encounters an unexpected state
 * @package Wikimedia\Parsoid\Wt2Html\DOM\Processors
 */
class RangeBuilderException extends RuntimeException {
}
