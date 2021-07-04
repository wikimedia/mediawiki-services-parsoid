<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\ConstrainedText;

use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Utils\DOMUtils;

/**
 * Language Variant markup, like `-{ ... }-`.
 */
class LanguageVariantText extends RegExpConstrainedText {
	/**
	 * @param string $text
	 * @param Element $node
	 */
	public function __construct( string $text, Element $node ) {
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
	 * @param Element $node
	 * @param stdClass $dataParsoid
	 * @param Env $env
	 * @param array $opts
	 * @return ?LanguageVariantText
	 */
	protected static function fromSelSerImpl(
		string $text, Element $node, stdClass $dataParsoid,
		Env $env, array $opts
	): ?LanguageVariantText {
		if ( DOMUtils::hasTypeOf( $node, 'mw:LanguageVariant' ) ) {
			return new LanguageVariantText( $text, $node );
		}
		return null;
	}
}
