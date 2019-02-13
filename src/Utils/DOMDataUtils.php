<?php
declare( strict_types = 1 );

// Not tested, all code that is not ported throws Exception or has PORT-FIXME

namespace Parsoid\Utils;

use Parsoid\Tests\MockEnv;

use DOMDocument;
use DOMElement;
use DOMNode;

/**
 * These helpers pertain to HTML and data attributes of a node.
 */
class DOMDataUtils {
	// The following getters and setters load from the .dataobject store,
	// with the intention of eventually moving them off the nodes themselves.

	/**
	 * Get data object from a node.
	 *
	 * @param DOMElement $node node
	 * @return object
	 */
	public static function getNodeData( DOMElement $node ) {
		if ( !isset( $node->dataobject ) ) {
			$node->dataobject = (object)[];
		}
		return $node->dataobject;
	}

	/**
	 * Get data parsoid info from a node.
	 *
	 * @param DOMElement $node node
	 * @return object
	 */
	public static function getDataParsoid( DOMElement $node ) {
		$data = self::getNodeData( $node );
		if ( !isset( $data->parsoid ) ) {
			$data->parsoid = (object)[];
		}
		if ( !isset( $data->parsoid->tmp ) ) {
			$data->parsoid->tmp = (object)[];
		}
		return $data->parsoid;
	}

	/**
	 * Get data meta wiki info from a node.
	 *
	 * @param DOMElement $node node
	 * @return object
	 */
	public static function getDataMw( DOMElement $node ) {
		$data = self::getNodeData( $node );
		if ( !isset( $data->mw ) ) {
			$data->mw = (object)[];
		}
		return $data->mw;
	}

	/**
	 * Check if there is meta wiki info in a node.
	 *
	 * @param DOMElement $node node
	 * @return bool
	 */
	public static function validDataMw( DOMElement $node ): bool {
		return (array)self::getDataMw( $node ) !== [];
	}

	/** Set data parsoid info from a node.
	 *
	 * @param DOMElement $node node
	 * @param object $dp data-parsoid
	 */
	public static function setDataParsoid( DOMElement $node, $dp ) {
		$data = self::getNodeData( $node );
		$data->parsoid = $dp;
	}

	/** Set data meta wiki info from a node.
	 *
	 * @param DOMElement $node node
	 * @param object $dmw data-mw
	 */
	public static function setDataMw( DOMElement $node, $dmw ) {
		$data = self::getNodeData( $node );
		$data->mw = $dmw;
	}

	/** Set node data.
	 *
	 * @param DOMElement $node node
	 * @param object $data data
	 */
	public static function setNodeData( DOMElement $node, $data ) {
		$node->dataobject = $data;
	}

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param DOMElement $node node
	 * @param string $name name
	 * @param mixed $defaultVal
	 * @return mixed
	 */
	public static function getJSONAttribute( DOMElement $node, string $name, $defaultVal ) {
		$attVal = $node->getAttribute( $name );
		if ( !$attVal ) {
			return $defaultVal;
		}
		try {
			return PHPUtils::jsonDecode( $attVal, true );
		} catch ( Exception $e ) {
			error_log( 'ERROR: Could not decode attribute-val ' . $attVal .
				' for ' . $name . ' on node ' . $node->outerHTML );
			return $defaultVal;
		}
	}

	/**
	 * Set a attribute on a node with a JSON-encoded object.
	 *
	 * @param DOMElement $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $obj value of the attribute to
	 */
	public static function setJSONAttribute( DOMElement $node, string $name, $obj ) {
		$val = $obj === [] ? '{}' : PHPUtils::jsonEncode( $obj );
		$node->setAttribute( $name, $val );
	}

	/**
	 * Set shadow info on a node; similar to the method on tokens.
	 * Records a key = value pair in data-parsoid['a'] property.
	 *
	 * This is effectively a call of 'setShadowInfoIfModified' except
	 * there is no original value, so by definition, $val is modified.
	 *
	 * @param DOMElement $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $val val
	 */
	public static function setShadowInfo( DOMElement $node, string $name, $val ) {
		$dp = self::getDataParsoid( $node );
		if ( !isset( $dp->a ) ) {
			$dp->a = [];
		}
		if ( !isset( $dp->sa ) ) {
			$dp->sa = [];
		}
		$dp->a[$name] = $val;
	}

	/**
	 * Set shadow info on a node; similar to the method on tokens.
	 *
	 * If the new value ($val) for the key ($name) is different from the
	 * original value ($origVal):
	 * - the new value is recorded in data-parsoid->a and
	 * - the original value is recorded in data-parsoid->sa
	 *
	 * @param DOMElement $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $val val
	 * @param mixed $origVal original value (null is a valid value)
	 */
	public static function setShadowInfoIfModified( DOMElement $node, string $name, $val, $origVal ) {
		if ( $val === $origVal || $origVal === null ) {
			return;
		}
		$dp = self::getDataParsoid( $node );
		if ( !isset( $dp->a ) ) {
			$dp->a = [];
		}
		if ( !isset( $dp->sa ) ) {
			$dp->sa = [];
		}
		// FIXME: This is a hack to not overwrite already shadowed info.
		// We should either fix the call site that depends on this
		// behaviour to do an explicit check, or double down on this
		// by porting it to the token method as well.
		if ( !array_key_exists( $name, $dp->a ) ) {
			$dp->sa[$name] = $origVal;
		}
		$dp->a[$name] = $val;
	}

	/**
	 * Add attributes to a node element.
	 *
	 * @param DOMElement $elt element
	 * @param array $attrs attributes
	 */
	public static function addAttributes( DOMElement $elt, array $attrs ) {
		foreach ( $attrs as $key => $value ) {
			if ( $value !== null ) {
				$elt->setAttribute( $key, $value );
			}
		}
	}

	/**
	 * Set an attribute and shadow info to a node.
	 * Similar to the method on tokens
	 *
	 * @param DOMElement $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $val value
	 * @param mixed $origVal original value
	 */
	public static function addNormalizedAttribute( DOMElement $node, string $name, $val, $origVal ) {
		$node->setAttribute( $name, $val );
		self::setShadowInfo( $node, $name, $val, $origVal );
	}

	/**
	 * Test if a node matches a given typeof.
	 *
	 * @param DOMNode $node node
	 * @param string $type type
	 * @return bool
	 */
	public static function hasTypeOf( DOMNode $node, string $type ): bool {
		if ( !DOMUtils::isElt( $node ) ) {
			return false;
		}
		$typeOfs = $node->getAttribute( 'typeof' );
		if ( !$typeOfs ) {
			return false;
		}
		$types = explode( ' ', $typeOfs );
		return array_search( $type, $types ) !== false;
	}

	/**
	 * Add a type to the typeof attribute. This method works for both tokens
	 * and DOM nodes as it only relies on getAttribute and setAttribute, which
	 * are defined for both.
	 *
	 * @param DOMElement $node node
	 * @param string $type type
	 */
	public static function addTypeOf( DOMElement $node, string $type ) {
		$typeOf = $node->getAttribute( 'typeof' );
		if ( $typeOf ) {
			$types = explode( ' ', $typeOf );
			if ( array_search( $type, $types ) !== false ) {
				// not in type set yet, so add it.
				$types[] = $type;
			}
			$node->setAttribute( 'typeof', implode( ' ', $types ) );
		} else {
			$node->setAttribute( 'typeof', $type );
		}
	}

	/**
	 * Remove a type from the typeof attribute. This method works on both
	 * tokens and DOM nodes as it only relies on
	 * getAttribute/setAttribute/removeAttribute.
	 *
	 * @param DOMElement $node node
	 * @param string $type type
	 * @return boolean
	 */
	public static function removeTypeOf( DOMElement $node, string $type ) {
		$typeOf = $node->getAttribute( 'typeof' );
		$notType = function ( $t ) use( $type ) {
			return $t !== $type;
		};
		if ( $typeOf ) {
			$types = array_filter( explode( ' ', $typeOf ), "notType" );

			if ( $types->length ) {
				$node->setAttribute( 'typeof', implode( ' ', $types ) );
			} else {
				$node->removeAttribute( 'typeof' );
			}
		}
	}

	/**
	 * Removes the `data-*` attribute from a node, and migrates the data to the
	 * document's JSON store. Generates a unique id with the following format:
	 * ```
	 * mw<base64-encoded counter>
	 * ```
	 * but attempts to keep user defined ids.
	 *
	 * @param DOMElement $node node
	 * @param MockEnv $env environment
	 * @param object $data data
	 */
	public static function storeInPageBundle( DOMElement $node, MockEnv $env, $data ) {
		$uid = $node->getAttribute( 'id' );
		$document = $node->ownerDocument;
		$dp = self::getDataParsoid( $document );
		$pb = $dp->pagebundle;
		$docDp = $pb->parsoid;
		$origId = $uid;
		if ( array_key_exists( $uid, $docDp->ids ) ) {
			$uid = null;
			// FIXME: Protect mw ids while tokenizing to avoid false positives.
			$env->log( 'info', 'Wikitext for this page has duplicate ids: ' . $origId );
		}
		if ( !$uid ) {
			do {
				$docDp->counter += 1;
				$uid = 'mw' . PHPUtils::counterToBase64( $docDp->counter );
			} while ( $document->getElementById( $uid ) );
			self::addNormalizedAttribute( $node, 'id', $uid, $origId );
		}
		$docDp->ids[$uid] = $data->parsoid;
		if ( isset( $data->mw ) ) {
			$pb->mw->ids[$uid] = $data->mw;
		}
	}

	/**
	 * @param DOMDocument $doc doc
	 * @param object $obj object
	 */
	public static function injectPageBundle( DOMDocument $doc, $obj ) {
		$pb = $obj === [] ? '{}' : PHPUtils::jsonEncode( $obj );
		$script = $doc->createElement( 'script' );
		self::addAttributes( $script, [
			'id' => 'mw-pagebundle',
			'type' => 'application/x-mw-pagebundle'
		] );
		$script->appendChild( $doc->createTextNode( $pb ) );
		$doc->head->appendChild( $script );
	}

	/**
	 * @param DOMDocument $doc doc
	 * @return array|null
	 */
	public static function extractPageBundle( DOMDocument $doc ) {
		$pb = null;
		$dpScriptElt = $doc->getElementById( 'mw-pagebundle' );
		if ( $dpScriptElt ) {
			$dpScriptElt->parentNode->removeChild( $dpScriptElt );
			$pb = PHPUtils::jsonDecode( $dpScriptElt->text, true );
		}
		return $pb;
	}

	/**
	 * Applies the `data-*` attributes JSON structure to the document.
	 * Leaves `id` attributes behind -- they are used by citation
	 * code to extract `<ref>` body from the DOM.
	 *
	 * @param DOMDocument $doc doc
	 * @param array $pb page bundle
	 */
	public static function applyPageBundle( DOMDocument $doc, array $pb ) {
		throw new BadMethodCallException( 'Not yet ported' );
	}

	/**
	 * Walk DOM from node downward calling loadDataAttribs
	 *
	 * @param DOMElement $node node
	 * @param bool $markNew identify and mark newly inserted elements
	 */
	public static function visitAndLoadDataAttribs( DOMElement $node, bool $markNew = false ) {
		DOMUtils::visitDOM( $node, [ self::class, 'loadDataAttribs' ], $markNew );
	}

	/**
	 * These are intended be used on a document after post-processing, so that
	 * the underlying .dataobject is transparently applied (in the store case)
	 * and reloaded (in the load case), rather than worrying about keeping
	 * the attributes up-to-date throughout that phase.  For the most part,
	 * using this.ppTo* should be sufficient and using these directly should be
	 * avoided.
	 *
	 * @param DOMNode $node node
	 * @param bool $markNew markNew
	 */
	public static function loadDataAttribs( DOMNode $node, bool $markNew ) {
		if ( !DOMUtils::isElt( $node ) ) {
			return;
		}
		$dp = (object)self::getJSONAttribute( $node, 'data-parsoid', [] );
		if ( $markNew ) {
			$dp->tmp = (object)( $dp->tmp ?? [] );
			$dp->tmp->isNew = $node->getAttribute( 'data-parsoid' ) === null;
		}
		self::setDataParsoid( $node, $dp );
		// PORT-FIXME: Disable till we get T204608 implemented
		// $node->removeAttribute( 'data-parsoid' );
		$dmw = (object)self::getJSONAttribute( $node, 'data-mw', [] );
		self::setDataMw( $node, $dmw );
		// PORT-FIXME: Disable till we get T204608 implemented
		// $node->removeAttribute( 'data-mw' );
	}

	/**
	 * Walk DOM from node downward calling storeDataAttribs
	 *
	 * @param DOMElement $node node
	 * @param array $options options
	 */
	public static function visitAndStoreDataAttribs( DOMElement $node, array $options = [] ) {
		DOMUtils::visitDOM( $node, [ self::class, 'storeDataAttribs' ], $options );
	}

	/**
	 * PORT_FIXME This function needs an accurate description
	 *
	 * @param DOMNode $node node
	 * @param array $options options
	 */
	public static function storeDataAttribs( DOMNode $node, array $options = [] ) {
		if ( !DOMUtils::isElt( $node ) ) {
			return;
		}
		if ( !empty( $options['discardDataParsoid'] ) && !empty( $options['keepTmp'] ) ) {
			// A sanity check
			throw new \Exception( 'Sanity check failed' );
		}
		$dp = self::getDataParsoid( $node );
		// Don't modify `options`, they're reused.
		$discardDataParsoid = !empty( $options['discardDataParsoid'] );
		if ( !empty( $dp->tmp->isNew ) ) {
			// Only necessary to support the cite extension's getById,
			// that's already been loaded once.
			//
			// This is basically a hack to ensure that DOMUtils.isNewElt
			// continues to work since we effectively rely on the absence
			// of data-parsoid to identify new elements. But, loadDataAttribs
			// creates an empty {} if one doesn't exist. So, this hack
			// ensures that a loadDataAttribs + storeDataAttribs pair don't
			// dirty the node by introducing an empty data-parsoid attribute
			// where one didn't exist before.
			//
			// Ideally, we'll find a better solution for this edge case later.
			$discardDataParsoid = true;
		}
		$data = null;
		if ( !$discardDataParsoid ) {
			// WARNING: keeping tmp might be a bad idea.  It can have DOM
			// nodes, which aren't going to serialize well.  You better know
			// of what you do.
			if ( empty( $options['keepTmp'] ) ) {
				unset( $dp->tmp );
			}
			if ( !empty( $options['storeInPageBundle'] ) ) {
				$data = (object)[ 'parsoid' => $dp ];
			} else {
				self::setJSONAttribute( $node, 'data-parsoid', $dp );
			}
		}
		// Strip invalid data-mw attributes
		if ( self::validDataMw( $node ) ) {
			if ( !empty( $options['storeInPageBundle'] ) && isset( $options['env'] ) &&
				// The pagebundle didn't have data-mw before 999.x
				// PORT-FIXME - semver equivalent code required
				$semver->satisfies( $options['env']->outputContentVersion, '^999.0.0' ) ) {
				$data = $data ?: (object)[];
				$data->mw = self::getDataMw( $node );
			} else {
				self::setJSONAttribute( $node, 'data-mw', self::getDataMw( $node ) );
			}
		}
		// Store pagebundle
		if ( $data !== null ) {
			self::storeInPageBundle( $node, $options['env'], $data );
		}
	}
}
