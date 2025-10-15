<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\NodeData\TemplateInfo;

class CompoundTemplateInfo {
	public function __construct(
		public DomSourceRange $dsr,
		public TemplateInfo $info,
		public bool $isParam,
		/**
		 * For a parser function which uses a colon to separate the first
		 * argument, this argument gives the string value of the colon
		 * character used (Japanese can use a double-wide colon); otherwise
		 * this is null.
		 */
		public ?string $colon,
	) {
	}
}
