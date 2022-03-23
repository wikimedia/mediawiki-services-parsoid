<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Wt2Html\XMLSerializer;

/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 */
class ContentUtils {
	/**
	 * XML Serializer.
	 *
	 * @param Node $node
	 * @param array $options XMLSerializer options.
	 * @return string
	 */
	public static function toXML( Node $node, array $options = [] ): string {
		return XMLSerializer::serialize( $node, $options )['html'];
	}

	/**
	 * dataobject aware XML serializer, to be used in the DOM post-processing phase.
	 *
	 * @param Node $node
	 * @param array $options
	 * @return string
	 */
	public static function ppToXML( Node $node, array $options = [] ): string {
		DOMDataUtils::visitAndStoreDataAttribs( $node, $options );
		return self::toXML( $node, $options );
	}

	/**
	 * XXX: Don't use this outside of testing.  It shouldn't be necessary
	 * to create new documents when parsing or serializing.  A document lives
	 * on the environment which can be used to create fragments.  The bag added
	 * as a dynamic property to the PHP wrapper around the libxml doc
	 * is at risk of being GC-ed.
	 *
	 * @param string $html
	 * @param bool $validateXMLNames
	 * @return Document
	 */
	public static function createDocument(
		string $html = '', bool $validateXMLNames = false
	): Document {
		$doc = DOMUtils::parseHTML( $html, $validateXMLNames );
		DOMDataUtils::prepareDoc( $doc );
		return $doc;
	}

	/**
	 * XXX: Don't use this outside of testing.  It shouldn't be necessary
	 * to create new documents when parsing or serializing.  A document lives
	 * on the environment which can be used to create fragments.  The bag added
	 * as a dynamic property to the PHP wrapper around the libxml doc
	 * is at risk of being GC-ed.
	 *
	 * @param string $html
	 * @param array $options
	 * @return Document
	 */
	public static function createAndLoadDocument(
		string $html, array $options = []
	): Document {
		$doc = self::createDocument( $html );
		DOMDataUtils::visitAndLoadDataAttribs(
			DOMCompat::getBody( $doc ), $options
		);
		return $doc;
	}

	/**
	 * @param Document $doc
	 * @param string $html
	 * @param array $options
	 * @return DocumentFragment
	 */
	public static function createAndLoadDocumentFragment(
		Document $doc, string $html, array $options = []
	): DocumentFragment {
		$domFragment = $doc->createDocumentFragment();
		DOMUtils::setFragmentInnerHTML( $domFragment, $html );
		DOMDataUtils::visitAndLoadDataAttribs( $domFragment, $options );
		return $domFragment;
	}

	/**
	 * Pull the data-parsoid script element out of the doc before serializing.
	 *
	 * @param Node $node
	 * @param array $options XMLSerializer options.
	 * @return array
	 */
	public static function extractDpAndSerialize( Node $node, array $options = [] ): array {
		$doc = DOMUtils::isBody( $node ) ? $node->ownerDocument : $node;
		$pb = DOMDataUtils::extractPageBundle( $doc );
		$out = XMLSerializer::serialize( $node, $options );
		$out['pb'] = $pb;
		return $out;
	}

	/**
	 * Strip Parsoid-inserted section, annotation wrappers, and fallback id spans with
	 * HTML4 ids for headings from the DOM.
	 *
	 * @param Element $node
	 */
	public static function stripUnnecessaryWrappersAndFallbackIds( Element $node ): void {
		$n = $node->firstChild;
		while ( $n ) {
			$next = $n->nextSibling;
			if ( $n instanceof Element ) {
				// Recurse into subtree before stripping this
				self::stripUnnecessaryWrappersAndFallbackIds( $n );

				// Strip <section> tags and synthetic extended-annotation-region wrappers
				if ( WTUtils::isParsoidSectionTag( $n ) ||
					WTUtils::isExtendedAnnotationWrapperTag( $n ) ) {
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

	/**
	 * Shift the DSR of a DOM fragment.
	 * @param Env $env
	 * @param Node $rootNode
	 * @param callable $dsrFunc
	 * @return Node Returns the $rootNode passed in to allow chaining.
	 */
	public static function shiftDSR( Env $env, Node $rootNode, callable $dsrFunc ): Node {
		$doc = $rootNode->ownerDocument;
		$convertString = static function ( $str ) {
			// Stub $convertString out to allow definition of a pair of
			// mutually-recursive functions.
			return $str;
		};
		$convertNode = static function ( Node $node ) use (
			$env, $dsrFunc, &$convertString, &$convertNode
		) {
			if ( !( $node instanceof Element ) ) {
				return;
			}
			$dp = DOMDataUtils::getDataParsoid( $node );
			if ( ( $dp->dsr ?? null ) !== null ) {
				$dp->dsr = $dsrFunc( clone $dp->dsr );
				// We don't need to setDataParsoid because dp is not a copy
			}
			$tmp = $dp->getTemp();
			if ( ( $tmp->origDSR ?? null ) !== null ) {
				// Even though tmp shouldn't escape Parsoid, go ahead and
				// convert to enable hybrid testing.
				$tmp->origDSR = $dsrFunc( clone $tmp->origDSR );
			}
			if ( ( $dp->extTagOffsets ?? null ) !== null ) {
				$dp->extTagOffsets = $dsrFunc( clone $dp->extTagOffsets );
			}

			// Handle embedded HTML in Language Variant markup
			$dmwv = DOMDataUtils::getJSONAttribute( $node, 'data-mw-variant', null );
			if ( $dmwv ) {
				if ( isset( $dmwv->disabled ) ) {
					$dmwv->disabled->t = $convertString( $dmwv->disabled->t );
				}
				if ( isset( $dmwv->twoway ) ) {
					foreach ( $dmwv->twoway as $l ) {
						$l->t = $convertString( $l->t );
					}
				}
				if ( isset( $dmwv->oneway ) ) {
					foreach ( $dmwv->oneway as $l ) {
						$l->f = $convertString( $l->f );
						$l->t = $convertString( $l->t );
					}
				}
				if ( isset( $dmwv->filter ) ) {
					$dmwv->filter->t = $convertString( $dmwv->filter->t );
				}
				DOMDataUtils::setJSONAttribute( $node, 'data-mw-variant', $dmwv );
			}

			if (
				DOMUtils::matchTypeOf( $node, '#^mw:Extension/(.+?)$#D' ) ||
				WTUtils::hasExpandedAttrsType( $node ) ||
				WTUtils::isInlineMedia( $node )
			) {
				$dmw = DOMDataUtils::getDataMw( $node );
				// Handle embedded HTML in template-affected attributes
				if ( $dmw->attribs ?? null ) {
					foreach ( $dmw->attribs as &$a ) {
						foreach ( $a as $kOrV ) {
							if ( gettype( $kOrV ) !== 'string' && isset( $kOrV->html ) ) {
								$kOrV->html = $convertString( $kOrV->html );
							}
						}
					}
				}
				// Handle embedded HTML in inline media captions
				if ( $dmw->caption ?? null ) {
					$dmw->caption = $convertString( $dmw->caption );
				}
				// FIXME: Cite-specific handling here maybe?
				if ( $dmw->body->html ?? null ) {
					$dmw->body->html = $convertString( $dmw->body->html );
				}
				DOMDataUtils::setDataMw( $node, $dmw );
			}

			// DOMFragments will have already been unpacked when DSR shifting is run
			if ( DOMUtils::hasTypeOf( $node, 'mw:DOMFragment' ) ) {
				PHPUtils::unreachable( "Shouldn't encounter these nodes here." );
			}

			// However, extensions can choose to handle sealed fragments whenever
			// they want and so may be returned in subpipelines which could
			// subsequently be shifted
			if ( DOMUtils::matchTypeOf( $node, '#^mw:DOMFragment/sealed/\w+$#D' ) ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				if ( $dp->html ?? null ) {
					$domFragment = $env->getDOMFragment( $dp->html );
					DOMPostOrder::traverse( $domFragment, $convertNode );
				}
			}
		};
		$convertString = function ( string $str ) use ( $doc, $env, $convertNode ): string {
			$node = self::createAndLoadDocumentFragment( $doc, $str );
			DOMPostOrder::traverse( $node, $convertNode );
			return self::ppToXML( $node, [ 'innerXML' => true ] );
		};
		DOMPostOrder::traverse( $rootNode, $convertNode );
		return $rootNode; // chainable
	}

	/**
	 * Convert DSR offsets in a Document between utf-8/ucs2/codepoint
	 * indices.
	 *
	 * Offset types are:
	 *  - 'byte': Bytes (UTF-8 encoding), e.g. PHP `substr()` or `strlen()`.
	 *  - 'char': Unicode code points (encoding irrelevant), e.g. PHP `mb_substr()` or `mb_strlen()`.
	 *  - 'ucs2': 16-bit code units (UTF-16 encoding), e.g. JavaScript `.substring()` or `.length`.
	 *
	 * @see TokenUtils::convertTokenOffsets for a related function on tokens.
	 *
	 * @param Env $env
	 * @param Document $doc The document to convert
	 * @param string $from Offset type to convert from.
	 * @param string $to Offset type to convert to.
	 */
	public static function convertOffsets(
		Env $env,
		Document $doc,
		string $from,
		string $to
	): void {
		$env->setCurrentOffsetType( $to );
		if ( $from === $to ) {
			return; // Hey, that was easy!
		}
		$offsetMap = [];
		$offsets = [];
		$collect = static function ( int $n ) use ( &$offsetMap, &$offsets ) {
			if ( !array_key_exists( $n, $offsetMap ) ) {
				$box = PHPUtils::arrayToObject( [ 'value' => $n ] );
				$offsetMap[$n] = $box;
				$offsets[] =& $box->value;
			}
		};
		// Collect DSR offsets throughout the document
		$collectDSR = static function ( DomSourceRange $dsr ) use ( $collect ) {
			if ( $dsr->start !== null ) {
				$collect( $dsr->start );
				$collect( $dsr->innerStart() );
			}
			if ( $dsr->end !== null ) {
				$collect( $dsr->innerEnd() );
				$collect( $dsr->end );
			}
			return $dsr;
		};
		$body = DOMCompat::getBody( $doc );
		self::shiftDSR( $env, $body, $collectDSR );
		if ( count( $offsets ) === 0 ) {
			return; /* nothing to do (shouldn't really happen) */
		}
		// Now convert these offsets
		TokenUtils::convertOffsets(
			$env->topFrame->getSrcText(), $from, $to, $offsets
		);
		// Apply converted offsets
		$applyDSR = static function ( DomSourceRange $dsr ) use ( $offsetMap ) {
			$start = $dsr->start;
			$openWidth = $dsr->openWidth;
			if ( $start !== null ) {
				$start = $offsetMap[$start]->value;
				$openWidth = $offsetMap[$dsr->innerStart()]->value - $start;
			}
			$end = $dsr->end;
			$closeWidth = $dsr->closeWidth;
			if ( $end !== null ) {
				$end = $offsetMap[$end]->value;
				$closeWidth = $end - $offsetMap[$dsr->innerEnd()]->value;
			}
			return new DomSourceRange(
				$start, $end, $openWidth, $closeWidth
			);
		};
		self::shiftDSR( $env, $body, $applyDSR );
	}

	/**
	 * @param Node $node
	 * @param array $options
	 * @return string
	 */
	private static function dumpNode( Node $node, array $options ): string {
		return self::toXML( $node, $options + [ 'saveData' => true ] );
	}

	/**
	 * Dump the DOM with attributes.
	 *
	 * @param Node $rootNode
	 * @param string $title
	 * @param array $options Associative array of options:
	 *   - dumpFragmentMap: Dump the fragment map from env
	 *   - quiet: Suppress separators
	 *
	 * storeDataAttribs options:
	 *   - discardDataParsoid
	 *   - keepTmp
	 *   - storeInPageBundle
	 *   - storeDiffMark
	 *   - env
	 *   - idIndex
	 *
	 * XMLSerializer options:
	 *   - smartQuote
	 *   - innerXML
	 *   - captureOffsets
	 *   - addDoctype
	 * @return string The dump result
	 */
	public static function dumpDOM(
		Node $rootNode, string $title = '', array $options = []
	): string {
		if ( !empty( $options['dumpFragmentMap'] ) ) {
			Assert::invariant( isset( $options['env'] ), "env should be set" );
		}

		$buf = '';
		if ( empty( $options['quiet'] ) ) {
			$buf .= "----- {$title} -----\n";
		}
		$buf .= self::dumpNode( $rootNode, $options ) . "\n";

		// Dump cached fragments
		if ( !empty( $options['dumpFragmentMap'] ) ) {
			foreach ( $options['env']->getDOMFragmentMap() as $k => $fragment ) {
				$buf .= str_repeat( '=', 15 ) . "\n";
				$buf .= "FRAGMENT {$k}\n";
				$buf .= self::dumpNode(
					is_array( $fragment ) ? $fragment[0] : $fragment,
					$options
				) . "\n";
			}
		}

		if ( empty( $options['quiet'] ) ) {
			$buf .= str_repeat( '-', mb_strlen( $title ) + 12 ) . "\n";
		}
		return $buf;
	}

}
