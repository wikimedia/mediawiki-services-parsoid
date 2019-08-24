<?php
declare( strict_types = 1 );

namespace Parsoid\Html2Wt\ConstrainedText;

use DOMElement;
use stdClass;

use Parsoid\Config\Env;

/**
 * Language Variant markup, like `-{ ... }-`.
 */
class LanguageVariantText extends RegExpConstrainedText {
	/**
	 * @param string $text
	 * @param DOMElement $node
	 */
	public function __construct( string $text, DOMElement $node ) {
		parent::__construct( [
				'text' => $text,
				'node' => $node,
				// at sol vertical bars immediately preceding cause problems in tables
				'badPrefix' => /* RegExp */ '/^\|$/D'
			]
		);
	}

	/**
	 * @param string $text
	 * @param DOMElement $node
	 * @param stdClass $dataParsoid
	 * @param Env $env
	 * @param array $opts
	 * @return ?LanguageVariantText
	 */
	protected static function fromSelSerImpl(
		string $text, DOMElement $node, stdClass $dataParsoid,
		Env $env, array $opts
	): ?LanguageVariantText {
		if ( $node->getAttribute( 'typeof' ) === 'mw:LanguageVariant' ) {
			return new LanguageVariantText( $text, $node );
		}
		return null;
	}
}
