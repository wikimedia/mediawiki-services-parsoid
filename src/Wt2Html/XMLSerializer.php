<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Stand-alone XMLSerializer for DOM3 documents
 *
 * The output is identical to standard XHTML5 DOM serialization, as given by
 * http://www.w3.org/TR/html-polyglot/
 * and
 * https://html.spec.whatwg.org/multipage/syntax.html#serialising-html-fragments
 * except that we may quote attributes with single quotes, *only* where that would
 * result in more compact output than the standard double-quoted serialization.
 * @module
 */

namespace Parsoid;

$DOMUtils = require '../utils/DOMUtils.js'::DOMUtils;
$JSUtils = require '../utils/jsutils.js'::JSUtils;
$WTUtils = require '../utils/WTUtils.js'::WTUtils;

// nodeType constants
$ELEMENT_NODE = 1;
$TEXT_NODE = 3;
$COMMENT_NODE = 8;
$DOCUMENT_NODE = 9;
$DOCUMENT_FRAGMENT_NODE = 11;

/**
 * HTML5 void elements
 * @namespace
 * @private
 */
$emptyElements = [
	'area' => true,
	'base' => true,
	'basefont' => true,
	'bgsound' => true,
	'br' => true,
	'col' => true,
	'command' => true,
	'embed' => true,
	'frame' => true,
	'hr' => true,
	'img' => true,
	'input' => true,
	'keygen' => true,
	'link' => true,
	'meta' => true,
	'param' => true,
	'source' => true,
	'track' => true,
	'wbr' => true
];

/**
 * HTML5 elements with raw (unescaped) content
 * @namespace
 * @private
 */
$hasRawContent = [
	'style' => true,
	'script' => true,
	'xmp' => true,
	'iframe' => true,
	'noembed' => true,
	'noframes' => true,
	'plaintext' => true,
	'noscript' => true
];

/**
 * Elements that strip leading newlines
 * http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#html-fragment-serialization-algorithm
 * @namespace
 * @private
 */
$newlineStrippingElements = [
	'pre' => true,
	'textarea' => true,
	'listing' => true
];

function serializeToString( $node, $options, $accum ) {
	global $ELEMENT_NODE;
	global $emptyElements;
	global $hasRawContent;
	global $newlineStrippingElements;
	global $TEXT_NODE;
	global $DOCUMENT_NODE;
	global $DOCUMENT_FRAGMENT_NODE;
	global $COMMENT_NODE;
	$child = null;
	switch ( $node->nodeType ) {
		case $ELEMENT_NODE:
		$child = $node->firstChild;
		$attrs = $node->attributes;
		$len = count( $attrs );
		$nodeName = strtolower( $node->tagName );
		$localName = $node->localName;
		$accum( '<' . $localName, $node );
		for ( $i = 0;  $i < $len;  $i++ ) {
			$attr = $attrs->item( $i );
			if ( $options->smartQuote
&& // More double quotes than single quotes in value?
					count( preg_match_all( '/"/', $attr->value, $FIXME ) || [] )
> count( preg_match_all( "/'/", $attr->value, $FIXME ) || [] )
			) {
				// use single quotes
				$accum( ' ' . $attr->name . "='"
. preg_replace( "/[<&']/", $entities->encodeHTML5, $attr->value ) . "'",
					$node
				);
			} else {
				// use double quotes
				$accum( ' ' . $attr->name . '="'
. preg_replace( '/[<&"]/', $entities->encodeHTML5, $attr->value ) . '"',
					$node
				);
			}
		}
		if ( $child || !$emptyElements[ $nodeName ] ) {
			$accum( '>', $node, 'start' );
			// if is cdata child node
			if ( $hasRawContent[ $nodeName ] ) {
				// TODO: perform context-sensitive escaping?
				// Currently this content is not normally part of our DOM, so
				// no problem. If it was, we'd probably have to do some
				// tag-specific escaping. Examples:
				// * < to \u003c in <script>
				// * < to \3c in <style>
				// ...
				if ( $child ) {
					$accum( $child->data, $node );
				}
			} else {
				if ( $child && $newlineStrippingElements[ $localName ]
&& $child->nodeType === $TEXT_NODE && preg_match( '/^\n/', $child->data )
				) {
					/* If current node is a pre, textarea, or listing element,
					 * and the first child node of the element, if any, is a
					 * Text node whose character data has as its first
					 * character a U+000A LINE FEED (LF) character, then
					 * append a U+000A LINE FEED (LF) character. */
					$accum( "\n", $node );
				}
				while ( $child ) {
					serializeToString( $child, $options, $accum );
					$child = $child->nextSibling;
				}
			}
			$accum( '</' . $localName . '>', $node, 'end' );
		} else {
			$accum( '/>', $node, 'end' );
		}
		return;
		case $DOCUMENT_NODE:

		case $DOCUMENT_FRAGMENT_NODE:
		$child = $node->firstChild;
		while ( $child ) {
			serializeToString( $child, $options, $accum );
			$child = $child->nextSibling;
		}
		return;
		case $TEXT_NODE:
		return $accum( preg_replace( '/[<&]/', $entities->encodeHTML5, $node->data ), $node );
		case $COMMENT_NODE:
		// According to
		// http://www.w3.org/TR/DOM-Parsing/#dfn-concept-serialize-xml
		// we could throw an exception here if node.data would not create
		// a "well-formed" XML comment.  But we use entity encoding when
		// we create the comment node to ensure that node.data will always
		// be okay; see DOMUtils.encodeComment().
		return $accum( '<!--' . $node->data . '-->', $node );
		default:
		$accum( '??' . $node->nodeName, $node );
	}
}

$accumOffsets = function ( $out, $bit, $node, $flag ) use ( &$DOMUtils, &$WTUtils, &$JSUtils ) {
	if ( DOMUtils::isBody( $node ) ) {
		$out->html += $bit;
		if ( $flag === 'start' ) {
			$out->start = count( $out->html );
		} elseif ( $flag === 'end' ) {
			$out->start = null;
			$out->uid = null;
		}
	} elseif ( !DOMUtils::isElt( $node ) || $out->start === null || !DOMUtils::isBody( $node->parentNode ) ) {
		// In case you're wondering, out.start may never be set if body
		// isn't a child of the node passed to serializeToString, or if it
		// is the node itself but options.innerXML is true.
		$out->html += $bit;
		if ( $out->uid !== null ) {
			$out->offsets[ $out->uid ]->html[ 1 ] += count( $bit );
		}
	} else {
		$newUid = $node->getAttribute( 'id' );
		// Encapsulated siblings don't have generated ids (but may have an id),
		// so associate them with preceding content.
		if ( $newUid && $newUid !== $out->uid && !$out->last ) {
			if ( !WTUtils::isEncapsulationWrapper( $node ) ) {
				$out->uid = $newUid;
			} elseif ( WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
				$about = $node->getAttribute( 'about' );
				$out->last = JSUtils::lastItem( WTUtils::getAboutSiblings( $node, $about ) );
				$out->uid = $newUid;
			}
		}
		if ( $out->last === $node && $flag === 'end' ) {
			$out->last = null;
		}
		Assert::invariant( $out->uid !== null );
		if ( !$out->offsets->hasOwnProperty( $out->uid ) ) {
			$dt = count( $out->html ) - $out->start;
			$out->offsets[ $out->uid ] = [ 'html' => [ $dt, $dt ] ];
		}
		$out->html += $bit;
		$out->offsets[ $out->uid ]->html[ 1 ] += count( $bit );
	}
};

/**
 * @namespace
 */
$XMLSerializer = [];

/**
 * Serialize an HTML DOM3 node to XHTML.
 *
 * @param {Node} node
 * @param {Object} [options]
 * @param {boolean} [options.smartQuote=true]
 * @param {boolean} [options.innerXML=false]
 * @param {boolean} [options.captureOffsets=false]
 */
XMLSerializer::serialize = function ( $node, $options ) use ( &$accumOffsets ) {
	if ( !$options ) { $options = [];
 }
	if ( !$options->hasOwnProperty( 'smartQuote' ) ) {
		$options->smartQuote = true;
	}
	if ( $node->nodeName === '#document' ) {
		$node = $node->documentElement;
	}
	$out = [ 'html' => '', 'offsets' => [], 'start' => null, 'uid' => null, 'last' => null ];
	$accum = ( $options->captureOffsets ) ?
	function ( $bit, $node, $flag ) use ( &$node, &$accumOffsets, &$out ) {return $accumOffsets( $out, $bit, $node, $flag );
 } : function ( $bit ) use ( &$out ) { $out->html += $bit;
 };
	if ( $options->innerXML ) {
		for ( $child = $node->firstChild;  $child;  $child = $child->nextSibling ) {
			serializeToString( $child, $options, $accum );
		}
	} else {
		serializeToString( $node, $options, $accum );
	}
	// Ensure there's a doctype for documents.
	if ( !$options->innerXML && preg_match( '/^html$/', $node->nodeName ) ) {
		$out->html = "<!DOCTYPE html>\n" . $out->html;
	}
	// Drop the bookkeeping
	Object::assign( $out, [ 'start' => null, 'uid' => null, 'last' => null ] );
	return $out;
};

$module->exports = $XMLSerializer;
