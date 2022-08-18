<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * Language Variant rule information stored in a token.
 */
class VariantInfo {
	public function __construct(
		/** @var array<string,true> Flag set (short names) */
		public readonly array $flags,
		/** @var array<string,true> Variant set */
		public readonly array $variants,
		/** @var list<string> The original ordered list of flags (or variants) */
		public readonly array $original,
		/** @var list<string> Spaces around flags (or variants), uncompressed */
		public readonly array $flagSp,
		/** @var list<VariantOption> Parts of the variant rule */
		public readonly array $texts,
	) {
	}
}
