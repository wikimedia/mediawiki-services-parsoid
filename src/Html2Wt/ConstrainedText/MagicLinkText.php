<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\ConstrainedText;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\NodeData\DataParsoid;

/**
 * An autolink to an RFC/PMID/ISBN, like `RFC 1234`.
 */
class MagicLinkText extends RegExpConstrainedText {
	/**
	 * @param string $text
	 * @param Element $node
	 */
	public function __construct( string $text, Element $node ) {
		parent::__construct( [
			'text' => $text,
			'node' => $node,
			// there are \b boundaries on either side, and first/last characters
			// are word characters.
			'badPrefix' => /* RegExp */ '/\w$/uD',
			'badSuffix' => /* RegExp */ '/^\w/u'
		] );
	}

	/**
	 * @param string $text
	 * @param Element $node
	 * @param DataParsoid $dataParsoid
	 * @param Env $env
	 * @param array $opts
	 * @return ?MagicLinkText
	 */
	protected static function fromSelSerImpl(
		string $text, Element $node, DataParsoid $dataParsoid,
		Env $env, array $opts ) {
		$stx = $dataParsoid->stx ?? null;
		if ( $stx === 'magiclink' ) {
			return new MagicLinkText( $text, $node );
		}
		return null;
	}
}
