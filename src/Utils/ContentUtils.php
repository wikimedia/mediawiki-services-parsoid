<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use DOMNode;
use DOMElement;

use Parsoid\Config\Env;
use Parsoid\Html2Wt\DiffUtils;
use Parsoid\Wt2Html\XMLSerializer;
use Wikimedia\Assert\Assert;

/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 */
class ContentUtils {
	/**
	 * XML Serializer.
	 *
	 * @param DOMNode $node
	 * @param array $options XMLSerializer options.
	 * @return string
	 */
	public static function toXML( DOMNode $node, array $options = [] ): string {
		return XMLSerializer::serialize( $node, $options )['html'];
	}

	/**
	 * dataobject aware XML serializer, to be used in the DOM post-processing phase.
	 *
	 * @param DOMNode $node
	 * @param array $options
	 * @return string
	 */
	public static function ppToXML( DOMNode $node, array $options = [] ): string {
		// We really only want to pass along `$options['keepTmp']`
		DOMDataUtils::visitAndStoreDataAttribs( $node, $options );
		return self::toXML( $node, $options );
	}

	/**
	 * .dataobject aware HTML parser, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param Env $env
	 * @param string $html
	 * @param array $options
	 * @return DOMNode
	 */
	public static function ppToDOM( Env $env, string $html, array $options = [] ): DOMNode {
		$options = $options ?? [];
		$node = $options['node'] ?? null;
		if ( $node === null ) {
			$node = DOMCompat::getBody( $env->createDocument( $html ) );
		} else {
			DOMUtils::assertElt( $node );
			DOMCompat::setInnerHTML( $node, $html );
		}

		$markNew = $options['markNew'] ?? false;
		if ( $options['reinsertFosterableContent'] ?? false ) {
			DOMUtils::visitDOM( $node, function ( $n, ...$args ) use ( $env ) {
				// untunnel fostered content
				$meta = WTUtils::reinsertFosterableContent( $env, $n, true );
				$n = ( $meta !== null ) ? $meta : $n;

				// load data attribs
				DOMDataUtils::loadDataAttribs( $n, ...$args );
			}, $markNew );
		} else {
			DOMDataUtils::visitAndLoadDataAttribs( $node, $markNew );
		}
		return $node;
	}

	/**
	 * Pull the data-parsoid script element out of the doc before serializing.
	 *
	 * @param DOMNode $node
	 * @param array $options XMLSerializer options.
	 * @return array
	 */
	public static function extractDpAndSerialize( DOMNode $node, array $options = [] ): array {
		$options = $options ?? [];
		$options['captureOffsets'] = true;

		$doc = DOMUtils::isBody( $node ) ? $node->ownerDocument : $node;
		$pb = DOMDataUtils::extractPageBundle( $doc );
		$out = XMLSerializer::serialize( $node, $options );

		// Add the wt offsets.
		foreach ( $out['offsets'] as $key => &$value ) {
			$dp = $pb->parsoid->ids[ $key ];
			if ( Util::isValidDSR( $dp->dsr ) ) {
				$value['wt'] = array_slice( $dp->dsr, 0, 2 );
			}
		}

		$pb->parsoid->sectionOffsets = &$out['offsets'];
		$out['pb'] = $pb;
		unset( $out['offsets'] );

		return $out;
	}

	/**
	 * Strip Parsoid-inserted section wrappers and fallback id spans with
	 * HTML4 ids for headings from the DOM.
	 *
	 * @param DOMElement $node
	 */
	public static function stripSectionTagsAndFallbackIds( DOMElement $node ): void {
		$n = $node->firstChild;
		while ( $n ) {
			$next = $n->nextSibling;
			if ( $n instanceof DOMElement ) {
				// Recurse into subtree before stripping this
				self::stripSectionTagsAndFallbackIds( $n );

				// Strip <section> tags
				if ( WTUtils::isParsoidSectionTag( $n ) ) {
					DOMUtils::migrateChildren( $n, $n->parentNode, $n );
					$n->parentNode->removeChild( $n );
				}

				// Strip <span typeof='mw:FallbackId' ...></span>
				if ( WTUtils::isFallbackIdSpan( $n ) ) {
					$n->parentNode->removeChild( $n );
				}
			}
			$n = $next;
		}
	}

	private static function cloneData( DOMNode $node, DOMNode $clone, array $options ): void {
		if ( !DOMUtils::isElt( $node ) ) {
			return;
		}
		DOMUtils::assertElt( $node );
		DOMUtils::assertElt( $clone );

		$d = DOMDataUtils::getNodeData( $node );
		DOMDataUtils::setNodeData( $clone,  clone $d );
		if ( !empty( $options['storeDiffMark'] ) ) {
			DiffUtils::storeDiffMark( $clone, $options['env'] );
		}
		$node = $node->firstChild;
		$clone = $clone->firstChild;
		while ( $node ) {
			self::cloneData( $node, $clone, $options );
			$node = $node->nextSibling;
			$clone = $clone->nextSibling;
		}
	}

	private static function emit( array $buf, array &$opts ): void {
		$str = implode( "\n", $buf );
		if ( isset( $opts['outBuffer'] ) ) {
			$opts['outBuffer'] .= $str;
		} elseif ( isset( $opts['outStream'] ) ) {
			$opts['outStream']->write( $str . "\n" );
		} else {
			print $str;
		}
	}

	/**
	 * Dump the DOM with attributes.
	 *
	 * @param DOMElement $rootNode
	 * @param string $title
	 * @param array &$options
	 */
	public static function dumpDOM(
		DOMElement $rootNode, string $title, array &$options = []
	): void {
		$options = $options ?? [];
		if ( !empty( $options['storeDiffMark'] ) || !empty( $options['dumpFragmentMap'] ) ) {
			Assert::invariant( isset( $options['env'] ), "env should be set" );
		}

		// cloneNode doesn't clone data => walk DOM to clone it
		$clonedRoot = $rootNode->cloneNode( true );
		self::cloneData( $rootNode, $clonedRoot, $options );

		$buf = [];
		if ( empty( $options['quiet'] ) ) {
			$buf[] = '----- ' . $title . ' -----';
		}

		$buf[] = self::ppToXML( $clonedRoot, $options );
		self::emit( $buf, $options );

		// Dump cached fragments
		if ( !empty( $options['dumpFragmentMap'] ) ) {
			foreach ( $options['env']->getFragmentMap() as $k => $fragment ) {
				$buf = [];
				$buf[] = str_repeat( '=', 15 );
				$buf[] = 'FRAGMENT ' . $k;
				$buf[] = '';
				self::emit( $buf, $options );

				$newOpts = $options;
				$newOpts['dumpFragmentMap'] = false;
				$newOpts['quiet'] = true;
				self::dumpDOM( is_array( $fragment ) ? $fragment[ 0 ] : $fragment, '', $newOpts );
			}
		}

		if ( empty( $options['quiet'] ) ) {
			self::emit( [ str_repeat( '-', mb_strlen( $title ) + 12 ) ], $options );
		}
	}

}
