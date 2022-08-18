<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * Part of a language variant rule token.
 */
class VariantOption {
	public function __construct(
		/**
		 * @var array{tokens:array,srcOffsets:SourceRange} The text
		 */
		public ?array $textTokens = null,
		/** The name of an attribute holding the text tokens */
		public ?string $text = null,
		/** A semicolon marker */
		public readonly ?bool $semi = null,
		/** @var list<string> An array of strings containing spaces */
		public readonly ?array $sp = null,
		/** A one-way rule definition */
		public readonly ?bool $oneway = null,
		/** A two-way rule definition */
		public readonly ?bool $twoway = null,
		/**
		 * @var array{tokens:array,srcOffsets:SourceRange} An associative array
		 *   giving source text for a one-way rule
		 */
		public ?array $fromTokens = null,
		/** The name of an attribute holding the from tokens */
		public ?string $from = null,
		/**
		 * @var array{tokens:array,srcOffsets:SourceRange} An associative array
		 *   giving destination text for a one-way rule
		 */
		public ?array $toTokens = null,
		/** The name of an attribute holding the to tokens */
		public ?string $to = null,
		/** Language code */
		public readonly ?string $lang = null,
	) {
	}
}
