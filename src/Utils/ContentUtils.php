<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use DOMNode;
use DOMElement;

use Parsoid\Config\Env;
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
	 * @param array|null $options
	 * @return DOMElement
	 */
	public static function ppToDOM( Env $env, string $html, array $options = [] ): DOMElement {
		$options += [
			'node' => null,
			'reinsertFosterableContent' => null,
		];
		$node = $options['node'];
		if ( $node === null ) {
			$node = DOMCompat::getBody( $env->createDocument( $html ) );
		} else {
			DOMUtils::assertElt( $node );
			DOMCompat::setInnerHTML( $node, $html );
		}

		if ( $options['reinsertFosterableContent'] ) {
			DOMUtils::visitDOM( $node, function ( $n, ...$args ) use ( $env ) {
				// untunnel fostered content
				$meta = WTUtils::reinsertFosterableContent( $env, $n, true );
				$n = ( $meta !== null ) ? $meta : $n;

				// load data attribs
				DOMDataUtils::loadDataAttribs( $n, ...$args );
			}, $options );
		} else {
			DOMDataUtils::visitAndLoadDataAttribs( $node, $options );
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
		$doc = DOMUtils::isBody( $node ) ? $node->ownerDocument : $node;
		$pb = DOMDataUtils::extractPageBundle( $doc );
		$out = XMLSerializer::serialize( $node, $options );
		$out['pb'] = $pb;
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
		DOMDataUtils::setNodeData( $clone,  Util::clone( $d ) );
		$node = $node->firstChild;
		$clone = $clone->firstChild;
		while ( $node ) {
			self::cloneData( $node, $clone, $options );
			$node = $node->nextSibling;
			$clone = $clone->nextSibling;
		}
	}

	private static function emit( array $buf, array &$opts ): void {
		$str = implode( "\n", $buf ) . "\n";
		if ( isset( $opts['outBuffer'] ) ) {
			$opts['outBuffer'] .= $str;
		} elseif ( isset( $opts['outStream'] ) ) {
			$opts['outStream']->write( $str . "\n" );
		} else {
			print $str;
		}
	}

	/**
	 * Shift the DSR of a DOM fragment.
	 * @param Env $env
	 * @param DOMNode $rootNode
	 * @param callable $dsrFunc
	 * @return DOMNode Returns the $rootNode passed in to allow chaining.
	 */
	public static function shiftDSR( Env $env, DOMNode $rootNode, callable $dsrFunc ): DOMNode {
		$doc = $rootNode->ownerDocument;
		$convertString = function ( $str ) {
			// Stub $convertString out to allow definition of a pair of
			// mutually-recursive functions.
			return $str;
		};
		$convertNode = function ( DOMNode $node ) use ( $dsrFunc, &$convertString ) {
			if ( !DOMUtils::isElt( $node ) ) {
				return;
			}
			DOMUtils::assertElt( $node );
			$dp = DOMDataUtils::getDataParsoid( $node );
			if ( ( $dp->dsr ?? null ) !== null ) {
				// Even though dsr is an object (a DomSourceRange), assign
				// the return value in case $dsrFunc wants to set it to null.
				$dp->dsr = $dsrFunc( $dp->dsr );
				// We don't need to setDataParsoid because dp is not a copy
			}

			// Handle embedded HTML in Language Variant markup
			$dmwv =
				DOMDataUtils::getJSONAttribute( $node, 'data-mw-variant', null );
			if ( $dmwv ) {
				if ( $dmwv->disabled ) {
					$dmwv->disabled->t = $convertString( $dmwv->disabled->t );
				}
				if ( $dmwv->twoway ) {
					foreach ( $dmwv->twoway as $l ) {
						$l->t = $convertString( $l->t );
					}
				}
				if ( $dmwv->oneway ) {
					foreach ( $dmwv->oneway as $l ) {
						$l->f = $convertString( $l->f );
						$l->t = $convertString( $l->t );
					}
				}
				if ( $dmwv->filter ) {
					$dmwv->filter->t = $convertString( $dmwv->filter->t );
				}
				DOMDataUtils::setJSONAttribute( $node, 'data-mw-variant', $dmwv );
			}

			if ( DOMUtils::matchTypeOf( $node, '/^mw:(Image|ExpandedAttrs)$/D' ) ) {
				$dmw = DOMDataUtils::getDataMw( $node );
				// Handle embedded HTML in template-affected attributes
				if ( $dmw->attribs ) {
					foreach ( $dmw->attribs as &$a ) {
						foreach ( $a as $kOrV ) {
							if ( gettype( $kOrV ) !== 'string' && $kOrV->html ) {
								$kOrV->html = $convertString( $kOrV->html );
							}
						}
					}
				}
				// Handle embedded HTML in figure-inline captions
				if ( $dmw->caption ) {
					$dmw->caption = $convertString( $dmw->caption );
				}
				DOMDataUtils::setDataMw( $node, $dmw );
			}
		};
		$convertString = function ( string $str ) use ( $doc, $env, $convertNode ): string {
			$parentNode = $doc->createElement( 'body' );
			$node = self::ppToDOM( $env, $str, [ 'node' => $parentNode ] );
			DOMPostOrder::traverse( $node, $convertNode );
			return self::ppToXML( $node, [ 'innerXML' => true ] );
		};
		DOMPostOrder::traverse( $rootNode, $convertNode );
		return $rootNode; // chainable
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
