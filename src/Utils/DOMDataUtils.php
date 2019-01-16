<?php

// Port based on git-commit: <423eb7f04eea94b69da1cefe7bf0b27385781371>
// Initial porting, partially complete
// Not tested, all code that is not ported has Exception or PORT-FIXME

namespace Parsoid\Utils;

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
	 * @param DOMNode $node node
	 * @return object
	 */
	public static function getNodeData( $node ) {
		if ( !isset( $node->dataobject ) ) {
			$node->dataobject = [];
		}
		return $node->dataobject;
	}

	/**
	 * Get data parsoid info from a node.
	 *
	 * @param DOMNode $node node
	 * @return object
	 */
	public static function getDataParsoid( $node ) {
		$data = self::getNodeData( $node );
		if ( !isset( $data['parsoid'] ) ) {
			$data['parsoid'] = [];
		}
		if ( !isset( $data['parsoid']['tmp'] ) ) {
			$data['parsoid']['tmp'] = [];
		}
		return $data['parsoid'];
	}

	/**
	 * Get data meta wiki info from a node.
	 *
	 * @param DOMNode $node node
	 * @return object
	 */
	public static function getDataMw( $node ) {
		$data = self::getNodeData( $node );
		if ( !isset( $data['mw'] ) ) {
			$data['mw'] = [];
		}
		return $data['mw'];
	}

	/**
	 * Check if there is meta wiki info in a node.
	 *
	 * @param DOMNode $node node
	 * @return bool
	 */
	public static function validDataMw( $node ) {
		return self::getDataMw( $node ) !== [];
	}

	/** Set data parsoid info from a node.
	 *
	 * @param DOMNode $node node
	 * @param object $dpObj dpObj
	 * @return object
	 */
	public static function setDataParsoid( $node, $dpObj ) {
		$data = self::getNodeData( $node );
		$data['parsoid'] = $dpObj;
		return $data['parsoid'];
	}

	/** Set data meta wiki info from a node.
	 *
	 * @param DOMNode $node node
	 * @param object $dmObj dmObj
	 * @return object
	 */
	public static function setDataMw( $node, $dmObj ) {
		$data = self::getNodeData( $node );
		$data['mw'] = $dmObj;
		return $data['mw'];
	}

	/** Set node data.
	 *
	 * @param DOMNode $node node
	 * @param object $data data
	 */
	public static function setNodeData( $node, $data ) {
		$node->dataobject = $data;
	}

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param DOMNode $node node
	 * @param string $name name
	 * @param mixed $defaultVal
	 * @return mixed
	 */
	public static function getJSONAttribute( $node, $name, $defaultVal ) {
		if ( !DOMUtils::isElt( $node ) ) {
			return $defaultVal;
		}
		$attVal = $node->getAttribute( $name );
		if ( !$attVal ) {
			return $defaultVal;
		}
		try {
			return PHPUtils::json_decode( $attVal );
		} catch ( Exception $e ) {
			error_log( 'ERROR: Could not decode attribute-val ' . $attVal .
				' for ' . $name . ' on node ' . $node->outerHTML );
			return $defaultVal;
		}
	}

	/**
	 * Set a attribute on a node with a JSON-encoded object.
	 *
	 * @param DOMNode $node node
	 * @param string $name Name of the attribute.
	 * @param object $obj object
	 */
	public static function setJSONAttribute( $node, $name, $obj ) {
		$node->setAttribute( $name, PHPUtils::json_encode( $obj ) );
	}

	/**
	 * Set shadow info on a node.
	 * Similar to the method on tokens
	 *
	 * @param DOMNode $node node
	 * @param string $name Name of the attribute.
	 * @param string $val val
	 * @param string $origVal original value
	 */
	public static function setShadowInfo( $node, $name, $val, $origVal ) {
		if ( $val === $origVal || $origVal === null ) {
			return;
		}
		$dp = self::getDataParsoid( $node );
		if ( !$dp->a ) {
			$dp->a = [];
		}
		if ( !$dp->sa ) {
			$dp->sa = [];
		}
		if ( isset( $origVal ) &&
			// FIXME: This is a hack to not overwrite already shadowed info.
			// We should either fix the call site that depends on this
			// behaviour to do an explicit check, or double down on this
			// by porting it to the token method as well.
			!$dp->a->hasOwnProperty( $name )
		) {
			$dp->sa[$name] = $origVal;
		}
		$dp->a[$name] = $val;
	}

	/**
	 * Add attributes to a node element.
	 *
	 * @param object $elt element
	 * @param object $attrs attributes
	 */
	public static function addAttributes( $elt, $attrs ) {
/*		Object.keys(attrs).forEach(function(k) {
			if (attrs[k] !== null && attrs[k] !== undefined) {
				elt.setAttribute(k, attrs[k]);
			}
		}); */
		foreach ( $attrs as $key => $value ) {
			// FIXME: original check was value !== undefined .. isset($value) doesn't work
			if ( $key !== null && isset( $value ) ) {
				$elt->setAttribute( $key, $value );
			}
		}
	}

	/**
	 * Set an attribute and shadow info to a node.
	 * Similar to the method on tokens
	 *
	 * @param DOMNode $node node
	 * @param string $name Name of the attribute.
	 * @param object $val value
	 * @param object $origVal original value
	 */
	public static function addNormalizedAttribute( $node, $name, $val, $origVal ) {
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
	public static function hasTypeOf( $node, $type ) {
		if ( !$node->getAttribute ) {
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
	 * @param DOMNode $node node
	 * @param string $type type
	 */
	public static function addTypeOf( $node, $type ) {
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
	 * @param DOMNode $node node
	 * @param string $type type
	 * @return boolean
	 */
	public static function removeTypeOf( $node, $type ) {
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
	 * @param DOMNode $node node
	 * @param object $env environment
	 * @param object $data data
	 */
	public static function storeInPageBundle( $node, $env, $data ) {
		$uid = $node->getAttribute( 'id' );
		$document = $node->ownerDocument;
		$pb = self::getDataParsoid( $document )->pagebundle;
		$docDp = $pb->parsoid;
		$origId = $uid || null;
		if ( $docDp->ids->hasOwnProperty( $uid ) ) {
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
		$docDp->ids[$uid] = $data['parsoid'];
		if ( $data->hasOwnProperty( 'mw' ) ) {
			$pb->mw->ids[$uid] = $data['mw'];
		}
	}

	/**
	 * @param doc $doc doc
	 * @param object $obj object
	 */
	public static function injectPageBundle( $doc, $obj ) {
		// $pb = JSON->stringify($obj);
		$pb = PHPUtils::json_encode( $obj );
		$script = $doc->createElement( 'script' );
		self::addAttributes( $script, [
			'id' => 'mw-pagebundle',
			'type' => 'application/x-mw-pagebundle'
		] );
		$script->appendChild( $doc->createTextNode( $pb ) );
		$doc->head->appendChild( $script );
	}

	/**
	 * @param doc $doc doc
	 * @return Object|null
	 */
	public static function extractPageBundle( $doc ) {
		$pb = null;
		$dpScriptElt = $doc->getElementById( 'mw-pagebundle' );
		if ( $dpScriptElt ) {
			$dpScriptElt->parentNode->removeChild( $dpScriptElt );
		// pb = JSON.parse(dpScriptElt.text);
			$pb = PHPUtils::json_decode( $dpScriptElt->text );
		}
		return $pb;
	}

	/**
	 * Applies the `data-*` attributes JSON structure to the document.
	 * Leaves `id` attributes behind -- they are used by citation
	 * code to extract `<ref>` body from the DOM.
	 *
	 * @param doc $doc doc
	 * @param object $pb page bundle
	 */
	public static function applyPageBundle( $doc, $pb ) {
		throw new BadMethodCallException( 'Not yet ported' );
	}

	/**
	 * Walk DOM from node downward calling loadDataAttribs
	 *
	 * @param DOMNode $node node
	 * @param object $markNew markNew
	 */
	public static function visitAndLoadDataAttribs( $node, $markNew ) {
		// PORT-FIXME: the passing or calling of function loadDataAttribs in PHP may not be correct
		DOMUtils::visitDOM( $node, 'DOMDataUtils::loadDataAttribs', $markNew );
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
	 * @param object $markNew markNew
	 */
	public static function loadDataAttribs( $node, $markNew ) {
		if ( !DOMUtils::isElt( $node ) ) {
			return;
		}
		$dp = self::getJSONAttribute( $node, 'data-parsoid', [] );
		if ( $markNew ) {
			if ( !$dp->tmp ) {
				$dp->tmp = object();
			}
			$dp->tmp->isNew = $node->getAttribute( 'data-parsoid' ) === null;
		}
		self::setDataParsoid( $node, $dp );
		$node->removeAttribute( 'data-parsoid' );
		self::setDataMw( $node, self::getJSONAttribute( $node, 'data-mw', undefined ) );
		$node->removeAttribute( 'data-mw' );
	}

	/**
	 * Walk DOM from node downward calling storeDataAttribs
	 *
	 * @param DOMNode $node node
	 * @param object $options options
	 */
	public static function visitAndStoreDataAttribs( $node, $options ) {
		// PORT-FIXME: the passing or calling of function loadDataAttribs in PHP may not be correct
		DOMUtils::visitDOM( $node, 'DOMDataUtils::storeDataAttribs', $options );
	}

	/**
	 * PORT_FIXME This function needs an accurate description
	 *
	 * @param DOMNode $node node
	 * @param object $options options
	 */
	public static function storeDataAttribs( $node, $options ) {
		if ( is_set( $node ) ) { throw new Exception( 'Not yet ported' );
		}
		if ( !DOMUtils::isElt( $node ) ) { return;
		}
		$options = $options || [];
		if ( !( $options->discardDataParsoid && $options->keepTmp ) ) { // A sanity check
			throw new Exception( 'Sanity check failed' );
		}
		$dp = self::getDataParsoid( $node );
		// Don't modify `options`, they're reused.
		$discardDataParsoid = $options->discardDataParsoid;
		if ( $dp->tmp->isNew ) {
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
		// if (!$options->keepTmp) { $dp->tmp = undefined; }
			if ( !$options->keepTmp ) { $dp->tmp = null;
			}
			if ( $options->storeInPageBundle ) {
				$data = $data || [];
				$data['parsoid'] = $dp;
			} else {
				self::setJSONAttribute( $node, 'data-parsoid', $dp );
			}
		}
		// Strip invalid data-mw attributes
		if ( self::validDataMw( $node ) ) {
			if ( $options->storeInPageBundle && $options->env &&
				// The pagebundle didn't have data-mw before 999.x
				// PORT-FIXME - semver equivalent code required
				$semver->satisfies( $options->env->outputContentVersion, '^999.0.0' ) ) {
				$data = $data || [];
				$data['mw'] = self::getDataMw( $node );
			} else {
				self::setJSONAttribute( $node, 'data-mw', self::getDataMw( $node ) );
			}
		}
		// Store pagebundle
		if ( $data !== null ) {
			self::storeInPageBundle( $node, $options->env, $data );
		}
	}
}
