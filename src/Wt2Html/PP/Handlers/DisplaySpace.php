<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Handlers;

use DOMElement;
use DOMText;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Wt2Html\TT\Sanitizer;

/**
 * Apply french space armoring.
 *
 * FIXME(T254500): Parsoid's spec needs updating for mw:DisplaySpace
 */
class DisplaySpace {

	/**
	 * @param DOMText $node
	 * @param int $offset
	 */
	private static function insertDisplaySpace(
		DOMText $node, int $offset
	): void {
		$str = $str = $node->nodeValue;

		$prefix = substr( $str, 0, $offset );
		$suffix = substr( $str, $offset + 1 );

		$node->nodeValue = $prefix;

		$doc = $node->ownerDocument;
		$post = $doc->createTextNode( $suffix );
		$node->parentNode->insertBefore( $post, $node->nextSibling );

		$span = $doc->createElement( 'span' );
		$span->appendChild( $doc->createTextNode( "\u{00A0}" ) );
		// FIXME(T254502): Do away with the mw:Placeholder and the associated
		// data-parsoid.src
		$span->setAttribute( 'typeof', 'mw:DisplaySpace mw:Placeholder' );
		DOMDataUtils::setDataParsoid( $span, (object)[ 'src' => ' ' ] );
		$node->parentNode->insertBefore( $span, $post );
	}

	/**
	 * French spaces, Guillemet-left
	 *
	 * @param DOMText $node
	 * @param Env $env
	 * @return bool|DOMElement
	 */
	public static function leftHandler( DOMText $node, Env $env ) {
		$key = array_key_first( array_slice( Sanitizer::FIXTAGS, 0, 1 ) );
		if ( preg_match( $key, $node->nodeValue, $matches, PREG_OFFSET_CAPTURE ) ) {
			$offset = $matches[0][1];
			self::insertDisplaySpace( $node, $offset );
			return true;
		}
		return true;
	}

	/**
	 * French spaces, Guillemet-right
	 *
	 * @param DOMText $node
	 * @param Env $env
	 * @return bool|DOMElement
	 */
	public static function rightHandler( DOMText $node, Env $env ) {
		$key = array_key_first( array_slice( Sanitizer::FIXTAGS, 1, 1 ) );
		if ( preg_match( $key, $node->nodeValue, $matches, PREG_OFFSET_CAPTURE ) ) {
			$offset = $matches[1][1] + strlen( $matches[1][0] );
			self::insertDisplaySpace( $node, $offset );
			return true;
		}
		return true;
	}

}
