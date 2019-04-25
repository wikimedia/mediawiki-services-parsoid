<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Definitions of what's loosely defined as the `domHandler` interface.
 *
 * FIXME: Solidify the interface in code.
 * ```
 *   var domHandler = {
 *     handle: Promise.async(function *(node, state, wrapperUnmodified) { ... }),
 *     sepnls: {
 *       before: (node, otherNode, state) => { min: 1, max: 2 },
 *       after: (node, otherNode, state) => { ... },
 *       firstChild: (node, otherNode, state) => { ... },
 *       lastChild: (node, otherNode, state) => { ... },
 *     },
 *   };
 * ```
 * @module
 */

namespace Parsoid;

$Consts = require '../config/WikitextConstants.js'::WikitextConstants;
$DOMDataUtils = require '../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../utils/DOMUtils.js'::DOMUtils;
$JSUtils = require '../utils/jsutils.js'::JSUtils;
$Promise = require '../utils/promise.js';
$TokenUtils = require '../utils/TokenUtils.js'::TokenUtils;
$Util = require '../utils/Util.js'::Util;
$WTUtils = require '../utils/WTUtils.js'::WTUtils;
$WTSUtils = require './WTSUtils.js'::WTSUtils;

// Forward declarations
$_htmlElementHandler = null;
$htmlElementHandler = null;

function id( $v ) {
	return function () use ( &$v ) { return $v;
 };
}

$genContentSpanTypes = new Set( [
		'mw:Nowiki',
		'mw:Image',
		'mw:Image/Frameless',
		'mw:Image/Frame',
		'mw:Image/Thumb',
		'mw:Video',
		'mw:Video/Frameless',
		'mw:Video/Frame',
		'mw:Video/Thumb',
		'mw:Audio',
		'mw:Audio/Frameless',
		'mw:Audio/Frame',
		'mw:Audio/Thumb',
		'mw:Entity',
		'mw:Placeholder'
	]
);

function isRecognizedSpanWrapper( $type ) {
	global $genContentSpanTypes;
	return $type && preg_split( '/\s+/', $type )->find( function ( $t ) use ( &$genContentSpanTypes ) {
				return $genContentSpanTypes->has( $t );
	}
		) !== null;
}

function getLeadingSpace( $state, $node, $newEltDefault ) {
	global $DOMUtils;
	global $WTUtils;
	global $DOMDataUtils;
	global $Util;
	$space = '';
	$fc = DOMUtils::firstNonDeletedChild( $node );
	if ( WTUtils::isNewElt( $node ) ) {
		if ( $fc && ( !DOMUtils::isText( $fc ) || !preg_match( '/^\s/', $fc->nodeValue ) ) ) {
			$space = $newEltDefault;
		}
	} elseif ( $state->useWhitespaceHeuristics && $state->selserMode && ( !$fc || !DOMUtils::isElt( $fc ) ) ) {
		$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
		if ( Util::isValidDSR( $dsr, true ) ) {
			$offset = $dsr[ 0 ] + $dsr[ 2 ];
			$space = ( $offset < ( $dsr[ 1 ] - $dsr[ 3 ] ) ) ? $state->getOrigSrc( $offset, $offset + 1 ) : '';
			if ( !preg_match( '/[ \t]/', $space ) ) {
				$space = '';
			}
		}
	}
	return $space;
}

function getTrailingSpace( $state, $node, $newEltDefault ) {
	global $DOMUtils;
	global $WTUtils;
	global $DOMDataUtils;
	global $Util;
	$space = '';
	$lc = DOMUtils::lastNonDeletedChild( $node );
	if ( WTUtils::isNewElt( $node ) ) {
		if ( $lc && ( !DOMUtils::isText( $lc ) || !preg_match( '/\s$/', $lc->nodeValue ) ) ) {
			$space = $newEltDefault;
		}
	} elseif ( $state->useWhitespaceHeuristics && $state->selserMode && ( !$lc || !DOMUtils::isElt( $lc ) ) ) {
		$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
		if ( Util::isValidDSR( $dsr, true ) ) {
			$offset = $dsr[ 1 ] - $dsr[ 3 ] - 1;
			// The > instead of >= is to deal with an edge case
			// = = where that single space is captured by the
			// getLeadingSpace case above
			$space = ( $offset > ( $dsr[ 0 ] + $dsr[ 2 ] ) ) ? $state->getOrigSrc( $offset, $offset + 1 ) : '';
			if ( !preg_match( '/[ \t]/', $space ) ) {
				$space = '';
			}
		}
	}

	return $space;
}

function buildHeadingHandler( $headingWT ) {
	global $DOMUtils;
	global $WTUtils;
	return [
		'forceSOL' => true,
		'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$headingWT, &$DOMUtils ) {
			// For new elements, for prettier wikitext serialization,
			// emit a space after the last '=' char.
			$space = getLeadingSpace( $state, $node, ' ' );
			$state->emitChunk( $headingWT + $space, $node );
			$state->singleLineContext->enforce();

			if ( $node->hasChildNodes() ) {
				/* await */ $state->serializeChildren( $node, null, DOMUtils::firstNonDeletedChild( $node ) );
			} else {
				// Deal with empty headings
				$state->emitChunk( '<nowiki/>', $node );
			}

			// For new elements, for prettier wikitext serialization,
			// emit a space before the first '=' char.
			// For new elements, for prettier wikitext serialization,
			// emit a space before the first '=' char.
			$space = getTrailingSpace( $state, $node, ' ' );
			$state->emitChunk( $space + $headingWT, $node ); // Why emitChunk here??
			// Why emitChunk here??
			array_pop( $state->singleLineContext );
		}

		,
		'sepnls' => [
			'before' => function ( $node, $otherNode ) use ( &$WTUtils, &$DOMUtils ) {
				if ( WTUtils::isNewElt( $node ) && DOMUtils::previousNonSepSibling( $node ) ) {
					// Default to two preceding newlines for new content
					return [ 'min' => 2, 'max' => 2 ];
				} elseif ( WTUtils::isNewElt( $otherNode )
&& DOMUtils::previousNonSepSibling( $node ) === $otherNode
				) {
					// T72791: The previous node was newly inserted, separate
					// them for readability
					return [ 'min' => 2, 'max' => 2 ];
				} else {
					return [ 'min' => 1, 'max' => 2 ];
				}
			},
			'after' => id( [ 'min' => 1, 'max' => 2 ] )
		]
	];
}

/**
 * List helper: DOM-based list bullet construction.
 * @private
 */
function getListBullets( $state, $node ) {
	global $DOMDataUtils;
	$parentTypes = [
		'ul' => '*',
		'ol' => '#'
	];
	$listTypes = [
		'ul' => '',
		'ol' => '',
		'dl' => '',
		'li' => '',
		'dt' => ';',
		'dd' => ':'
	];

	// For new elements, for prettier wikitext serialization,
	// emit a space after the last bullet (if required)
	$space = getLeadingSpace( $state, $node, ' ' );

	$dp = null;
$nodeName = null;
$parentName = null;
	$res = '';
	while ( $node ) {
		$nodeName = strtolower( $node->nodeName );
		$dp = DOMDataUtils::getDataParsoid( $node );

		if ( $dp->stx !== 'html' && isset( $listTypes[ $nodeName ] ) ) {
			if ( $nodeName === 'li' ) {
				$parentNode = $node->parentNode;
				while ( $parentNode && !( isset( $parentTypes[ strtolower( $parentNode->nodeName ) ] ) ) ) {
					$parentNode = $parentNode->parentNode;
				}

				if ( $parentNode ) {
					$parentName = strtolower( $parentNode->nodeName );
					$res = $parentTypes[ $parentName ] + $res;
				} else {
					$state->env->log( 'error/html2wt', 'Input DOM is not well-formed.',
						"Top-level <li> found that is not nested in <ol>/<ul>\n LI-node:",
						$node->outerHTML
					);
				}
			} else {
				$res = $listTypes[ $nodeName ] + $res;
			}
		} elseif ( $dp->stx !== 'html' || !$dp->autoInsertedStart || !$dp->autoInsertedEnd ) {
			break;
		}

		$node = $node->parentNode;
	}

	// Don't emit a space if we aren't returning any bullets.
	return ( count( $res ) ) ? $res + $space : '';
}

function wtListEOL( $node, $otherNode ) {
	global $DOMUtils;
	global $WTUtils;
	global $DOMDataUtils;
	if ( !DOMUtils::isElt( $otherNode ) || DOMUtils::isBody( $otherNode ) ) {
		return [ 'min' => 0, 'max' => 2 ];
	}

	if ( WTUtils::isFirstEncapsulationWrapperNode( $otherNode ) ) {
		return [ 'min' => ( DOMUtils::isList( $node ) ) ? 1 : 0, 'max' => 2 ];
	}

	$nextSibling = DOMUtils::nextNonSepSibling( $node );
	$dp = DOMDataUtils::getDataParsoid( $otherNode );
	if ( $nextSibling === $otherNode && $dp->stx === 'html' || $dp->src !== null ) {
		return [ 'min' => 0, 'max' => 2 ];
	} elseif ( $nextSibling === $otherNode && DOMUtils::isListOrListItem( $otherNode ) ) {
		if ( DOMUtils::isList( $node ) && $otherNode->nodeName === $node->nodeName ) {
			// Adjacent lists of same type need extra newline
			return [ 'min' => 2, 'max' => 2 ];
		} elseif ( DOMUtils::isListItem( $node ) || isset( [ 'LI' => 1, 'DD' => 1 ][ $node->parentNode->nodeName ] ) ) {
			// Top-level list
			return [ 'min' => 1, 'max' => 1 ];
		} else {
			return [ 'min' => 1, 'max' => 2 ];
		}
	} elseif ( DOMUtils::isList( $otherNode )
|| ( DOMUtils::isElt( $otherNode ) && $dp->stx === 'html' )
	) {
		// last child in ul/ol (the list element is our parent), defer
		// separator constraints to the list.
		return [];
		// A list in a block node (<div>, <td>, etc) doesn't need a trailing empty line
		// if it is the last non-separator child (ex: <div>..</ul></div>)
	} elseif ( DOMUtils::isBlockNode( $node->parentNode ) && DOMUtils::lastNonSepChild( $node->parentNode ) === $node ) {
		return [ 'min' => 1, 'max' => 2 ];
	} elseif ( DOMUtils::isFormattingElt( $otherNode ) ) {
		return [ 'min' => 1, 'max' => 1 ];
	} else {
		return [ 'min' => 2, 'max' => 2 ];
	}
}

// Normally we wait until hitting the deepest nested list element before
// emitting bullets. However, if one of those list elements is about-id
// marked, the tag handler will serialize content from data-mw parts or src.
// This is a problem when a list wasn't assigned the shared prefix of bullets.
// For example,
//
// ** a
// ** b
//
// Will assign bullets as,
//
// <ul><li-*>
// <ul>
// <li-*> a</li>   <!-- no shared prefix  -->
// <li-**> b</li>  <!-- gets both bullets -->
// </ul>
// </li></ul>
//
// For the b-li, getListsBullets will walk up and emit the two bullets it was
// assigned. If it was about-id marked, the parts would contain the two bullet
// start tag it was assigned. However, for the a-li, only one bullet is
// associated. When it's about-id marked, serializing the data-mw parts or
// src would miss the bullet assigned to the container li.
function isTplListWithoutSharedPrefix( $node ) {
	global $WTUtils;
	global $DOMDataUtils;
	if ( !WTUtils::isEncapsulationWrapper( $node ) ) {
		return false;
	}

	$typeOf = $node->getAttribute( 'typeof' ) || '';

	if ( preg_match( '/(?:^|\s)mw:Transclusion(?=$|\s)/', $typeOf ) ) {
		// If the first part is a string, template ranges were expanded to
		// include this list element. That may be trouble. Otherwise,
		// containers aren't part of the template source and we should emit
		// them.
		$dataMw = DOMDataUtils::getDataMw( $node );
		if ( !$dataMw->parts || gettype( $dataMw->parts[ 0 ] ) !== 'string' ) {
			return true;
		}
		// Less than two bullets indicates that a shared prefix was not
		// assigned to this element. A safe indication that we should call
		// getListsBullets on the containing list element.
		return !preg_match( '/^[*#:;]{2,}$/', $dataMw->parts[ 0 ] );
	} elseif ( preg_match( '/(?:^|\s)mw:(Extension|Param)/', $typeOf ) ) {
		// Containers won't ever be part of the src here, so emit them.
		return true;
	} else {
		return false;
	}
}

function isBuilderInsertedElt( $node ) {
	global $DOMUtils;
	global $DOMDataUtils;
	if ( !DOMUtils::isElt( $node ) ) { return false;
 }
	$dp = DOMDataUtils::getDataParsoid( $node );
	return $dp && $dp->autoInsertedStart && $dp->autoInsertedEnd;
}

function buildListHandler( $firstChildNames ) {
	global $DOMUtils;
	global $WTUtils;
	return [
		'forceSOL' => true,
		'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMUtils, &$firstChildNames, &$WTUtils ) {
			// Disable single-line context here so that separators aren't
			// suppressed between nested list elements.
			$state->singleLineContext->disable();

			$firstChildElt = DOMUtils::firstNonSepChild( $node );

			// Skip builder-inserted wrappers
			// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
			// output from: <s>\n*a\n*b\n*c</s>
			// Skip builder-inserted wrappers
			// Ex: <ul><s auto-inserted-start-and-end-><li>..</li><li>..</li></s>...</ul>
			// output from: <s>\n*a\n*b\n*c</s>
			while ( $firstChildElt && isBuilderInsertedElt( $firstChildElt ) ) {
				$firstChildElt = DOMUtils::firstNonSepChild( $firstChildElt );
			}

			if ( !$firstChildElt || !( isset( $firstChildNames[ $firstChildElt->nodeName ] ) )
|| WTUtils::isLiteralHTMLNode( $firstChildElt )
			) {
				$state->emitChunk( getListBullets( $state, $node ), $node );
			}

			$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
			};
			/* await */ $state->serializeChildren( $node, $liHandler );
			array_pop( $state->singleLineContext );
		}

		,
		'sepnls' => [
			'before' => function ( $node, $otherNode ) use ( &$DOMUtils ) {
				if ( DOMUtils::isBody( $otherNode ) ) {
					return [ 'min' => 0, 'max' => 0 ];
				}

				// node is in a list & otherNode has the same list parent
				// => exactly 1 newline
				if ( DOMUtils::isListItem( $node->parentNode ) && $otherNode->parentNode === $node->parentNode ) {
					return [ 'min' => 1, 'max' => 1 ];
				}

				// A list in a block node (<div>, <td>, etc) doesn't need a leading empty line
				// if it is the first non-separator child (ex: <div><ul>...</div>)
				if ( DOMUtils::isBlockNode( $node->parentNode ) && DOMUtils::firstNonSepChild( $node->parentNode ) === $node ) {
					return [ 'min' => 1, 'max' => 2 ];
				} elseif ( DOMUtils::isFormattingElt( $otherNode ) ) {
					return [ 'min' => 1, 'max' => 1 ];
				} else {
					return [ 'min' => 2, 'max' => 2 ];
				}
			},
			'after' => $wtListEOL
		]
	];
}

function buildDDHandler( $stx ) {
	global $DOMUtils;
	global $WTUtils;
	return [
		'forceSOL' => $stx !== 'row',
		'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMUtils, &$stx, &$WTUtils ) {
			$firstChildElement = DOMUtils::firstNonSepChild( $node );
			$chunk = ( $stx === 'row' ) ? ':' : getListBullets( $state, $node );
			if ( !DOMUtils::isList( $firstChildElement )
|| WTUtils::isLiteralHTMLNode( $firstChildElement )
			) {
				$state->emitChunk( $chunk, $node );
			}
			$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
			};
			$state->singleLineContext->enforce();
			/* await */ $state->serializeChildren( $node, $liHandler );
			array_pop( $state->singleLineContext );
		}

		,
		'sepnls' => [
			'before' => function ( $node, $othernode ) use ( &$stx ) {
				if ( $stx === 'row' ) {
					return [ 'min' => 0, 'max' => 0 ];
				} else {
					return [ 'min' => 1, 'max' => 2 ];
				}
			},
			'after' => $wtListEOL,
			'firstChild' => function ( $node, $otherNode ) use ( &$DOMUtils ) {
				if ( !DOMUtils::isList( $otherNode ) ) {
					return [ 'min' => 0, 'max' => 0 ];
				} else {
					return [];
				}
			}
		]
	];
}

// IMPORTANT: Do not start walking from line.firstNode forward. Always
// walk backward from node. This is because in selser mode, it looks like
// line.firstNode doesn't always correspond to the wikitext line that is
// being processed since the previous emitted node might have been an unmodified
// DOM node that generated multiple wikitext lines.
function currWikitextLineHasBlockNode( $line, $node, $skipNode ) {
	global $DOMUtils;
	global $WTUtils;
	$parentNode = $node->parentNode;
	if ( !$skipNode ) {
		// If this node could break this wikitext line and emit
		// non-ws content on a new line, the P-tag will be on that new line
		// with text content that needs P-wrapping.
		if ( preg_match( '/\n[^\s]/', $node->textContent ) ) {
			return false;
		}
	}
	$node = DOMUtils::previousNonDeletedSibling( $node );
	while ( !$node || !DOMUtils::atTheTop( $node ) ) {
		while ( $node ) {
			// If we hit a block node that will render on the same line, we are done!
			if ( WTUtils::isBlockNodeWithVisibleWT( $node ) ) {
				return true;
			}

			// If this node could break this wikitext line, we are done.
			// This is conservative because textContent could be looking at descendents
			// of 'node' that may not have been serialized yet. But this is safe.
			if ( preg_match( '/\n/', $node->textContent ) ) {
				return false;
			}

			$node = DOMUtils::previousNonDeletedSibling( $node );

			// Don't go past the current line in any case.
			if ( $line->firstNode && DOMUtils::isAncestorOf( $node, $line->firstNode ) ) {
				return false;
			}
		}
		$node = $parentNode;
		$parentNode = $node->parentNode;
	}

	return false;
}

function newWikitextLineMightHaveBlockNode( $node ) {
	global $DOMUtils;
	global $Consts;
	global $WTUtils;
	$node = DOMUtils::nextNonDeletedSibling( $node );
	while ( $node ) {
		if ( DOMUtils::isText( $node ) ) {
			// If this node will break this wikitext line, we are done!
			if ( preg_match( '/\n/', $node->nodeValue ) ) {
				return false;
			}
		} elseif ( DOMUtils::isElt( $node ) ) {
			// These tags will always serialize onto a new line
			if ( Consts\HTMLTagsRequiringSOLContext::has( $node->nodeName )
&& !WTUtils::isLiteralHTMLNode( $node )
			) {
				return false;
			}

			// We hit a block node that will render on the same line
			if ( WTUtils::isBlockNodeWithVisibleWT( $node ) ) {
				return true;
			}

			// Go conservative
			return false;
		}

		$node = DOMUtils::nextNonDeletedSibling( $node );
	}
	return false;
}

function precedingQuoteEltRequiresEscape( $node ) {
	global $DOMUtils;
	// * <i> and <b> siblings don't need a <nowiki/> separation
	// as long as quote chars in text nodes are always
	// properly escaped -- which they are right now.
	//
	// * Adjacent quote siblings need a <nowiki/> separation
	// between them if either of them will individually
	// generate a sequence of quotes 4 or longer. That can
	// only happen when either prev or node is of the form:
	// <i><b>...</b></i>
	//
	// For new/edited DOMs, this can never happen because
	// wts.minimizeQuoteTags.js does quote tag minimization.
	//
	// For DOMs from existing wikitext, this can only happen
	// because of auto-inserted end/start tags. (Ex: ''a''' b ''c''')
	$prev = DOMUtils::previousNonDeletedSibling( $node );
	return $prev && DOMUtils::isQuoteElt( $prev )
&& DOMUtils::isQuoteElt( DOMUtils::lastNonDeletedChild( $prev ) )
|| DOMUtils::isQuoteElt( DOMUtils::firstNonDeletedChild( $node ) );
}

function buildQuoteHandler( $quotes ) {
	global $WTSUtils;
	return [
		'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$WTSUtils, &$quotes ) {
			if ( precedingQuoteEltRequiresEscape( $node ) ) {
				WTSUtils::emitStartTag( '<nowiki/>', $node, $state );
			}
			WTSUtils::emitStartTag( $quotes, $node, $state );

			if ( !$node->hasChildNodes() ) {
				// Empty nodes like <i></i> or <b></b> need
				// a <nowiki/> in place of the empty content so that
				// they parse back identically.
				if ( WTSUtils::emitEndTag( $quotes, $node, $state, true ) ) {
					WTSUtils::emitStartTag( '<nowiki/>', $node, $state );
					WTSUtils::emitEndTag( $quotes, $node, $state );
				}
			} else {
				/* await */ $state->serializeChildren( $node );
				WTSUtils::emitEndTag( $quotes, $node, $state );
			}
		}

	];
}

$serializeTableElement = /* async */function ( $symbol, $endSymbol, $state, $node ) use ( &$WTSUtils ) {
	$token = WTSUtils::mkTagTk( $node );
	$sAttribs = /* await */ $state->serializer->_serializeAttributes( $node, $token );
	if ( count( $sAttribs ) > 0 ) {
		// IMPORTANT: 'endSymbol !== null' NOT 'endSymbol' since the
		// '' string is a falsy value and we want to treat it as a
		// truthy value.
		return $symbol . ' ' . $sAttribs
. ( ( $endSymbol !== null ) ? $endSymbol : ' |' );
	} else {
		return $symbol + ( $endSymbol || '' );
	}
};

$serializeTableTag = /* async */function ( $symbol, $endSymbol, $state, $node, $wrapperUnmodified ) use ( &$DOMDataUtils, &$serializeTableElement ) { // eslint-disable-line require-yield
	if ( $wrapperUnmodified ) {
		$dsr = DOMDataUtils::getDataParsoid( $node )->dsr;
		return $state->getOrigSrc( $dsr[ 0 ], $dsr[ 0 ] + $dsr[ 2 ] );
	} else {
		return ( /* await */ $serializeTableElement( $symbol, $endSymbol, $state, $node ) );
	}
};

// Just serialize the children, ignore the (implicit) tag
$justChildren = [
	'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
		/* await */ $state->serializeChildren( $node );
	}

];

function stxInfoValidForTableCell( $state, $node ) {
	global $DOMDataUtils;
	global $DOMUtils;
	// If row syntax is not set, nothing to worry about
	if ( DOMDataUtils::getDataParsoid( $node )->stx !== 'row' ) {
		return true;
	}

	// If we have an identical previous sibling, nothing to worry about
	$prev = DOMUtils::previousNonDeletedSibling( $node );
	return $prev !== null && $prev->nodeName === $node->nodeName;
}

// node is being serialized before/after a P-tag.
// While computing newline constraints, this function tests
// if node should be treated as a P-wrapped node
function treatAsPPTransition( $node ) {
	global $DOMUtils;
	global $WTUtils;
	// Treat text/p similar to p/p transition
	// If an element, it should not be a:
	// * block node or literal HTML node
	// * template wrapper
	// * mw:Includes meta or a SOL-transparent link
	return DOMUtils::isText( $node )
|| !DOMUtils::isBody( $node )
&& !DOMUtils::isBlockNode( $node )
&& !WTUtils::isLiteralHTMLNode( $node )
&& !WTUtils::isEncapsulationWrapper( $node )
&& !WTUtils::isSolTransparentLink( $node )
&& !( preg_match( '/^mw:Includes\//', $node->getAttribute( 'typeof' ) || '' ) );
}

function isPPTransition( $node ) {
	global $DOMDataUtils;
	return $node
&& ( ( $node->nodeName === 'P' && DOMDataUtils::getDataParsoid( $node )->stx !== 'html' )
|| treatAsPPTransition( $node ) );
}

// Uneditable forms wrapped with mw:Placeholder tags OR unedited nowikis
// N.B. We no longer emit self-closed nowikis as placeholders, so remove this
// once all our stored content is updated.
function emitPlaceholderSrc( $node, $state ) {
	global $DOMDataUtils;
	$dp = DOMDataUtils::getDataParsoid( $node );
	if ( preg_match( '/<nowiki\s*\/>/', $dp->src ) ) {
		$state->hasSelfClosingNowikis = true;
	}
	// FIXME: Should this also check for tabs and plain space
	// chars interspersed with newlines?
	if ( preg_match( '/^\n+$/', $dp->src ) ) {
		$state->appendSep( $dp->src );
	} else {
		$state->serializer->emitWikitext( $dp->src, $node );
	}
}

function trWikitextNeeded( $node, $dp ) {
	global $DOMUtils;
	// If the token has 'startTagSrc' set, it means that the tr
	// was present in the source wikitext and we emit it -- if not,
	// we ignore it.
	// ignore comments and ws
	if ( $dp->startTagSrc || DOMUtils::previousNonSepSibling( $node ) ) {
		return true;
	} else {
		// If parent has a thead/tbody previous sibling, then
		// we need the |- separation. But, a caption preceded
		// this node's parent, all is good.
		$parentSibling = DOMUtils::previousNonSepSibling( $node->parentNode );

		// thead/tbody/tfoot is always present around tr tags in the DOM.
		return $parentSibling && $parentSibling->nodeName !== 'CAPTION';
	}
}

function maxNLsInTable( $node, $origNode ) {
	global $WTUtils;
	return ( WTUtils::isNewElt( $node ) || WTUtils::isNewElt( $origNode ) ) ? 1 : 2;
}

function isPbr( $br ) {
	global $DOMDataUtils;
	global $DOMUtils;
	return DOMDataUtils::getDataParsoid( $br )->stx !== 'html' && $br->parentNode->nodeName === 'P' && DOMUtils::firstNonSepChild( $br->parentNode ) === $br;
}

function isPbrP( $br ) {
	global $DOMUtils;
	return isPbr( $br ) && DOMUtils::nextNonSepSibling( $br ) === null;
}

/**
 * A map of `domHandler`s keyed on nodeNames.
 *
 * Includes specialized keys of the form: `nodeName + '_' + dp.stx`
 * @namespace
 */
$tagHandlers = JSUtils::mapObject( [
		'audio' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				/* await */ $state->serializer->figureHandler( $node );
			}

		]
		,

		'b' => buildQuoteHandler( "'''" ),
		'i' => buildQuoteHandler( "''" ),

		'dl' => buildListHandler( [ 'DT' => 1, 'DD' => 1 ] ),
		'ul' => buildListHandler( [ 'LI' => 1 ] ),
		'ol' => buildListHandler( [ 'LI' => 1 ] ),

		'li' => [
			'forceSOL' => true,
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMUtils, &$WTUtils ) {
				$firstChildElement = DOMUtils::firstNonSepChild( $node );
				if ( !DOMUtils::isList( $firstChildElement )
|| WTUtils::isLiteralHTMLNode( $firstChildElement )
				) {
					$state->emitChunk( getListBullets( $state, $node ), $node );
				}
				$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
				};
				$state->singleLineContext->enforce();
				/* await */ $state->serializeChildren( $node, $liHandler );
				array_pop( $state->singleLineContext );
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) use ( &$DOMUtils, &$DOMDataUtils ) {
					if ( ( $otherNode === $node->parentNode && isset( [ 'UL' => 1, 'OL' => 1 ][ $otherNode->nodeName ] ) )
|| ( DOMUtils::isElt( $otherNode ) && DOMDataUtils::getDataParsoid( $otherNode )->stx === 'html' )
					) {
						return [];
					} else {
						return [ 'min' => 1, 'max' => 2 ];
					}
				},
				'after' => $wtListEOL,
				'firstChild' => function ( $node, $otherNode ) use ( &$DOMUtils ) {
					if ( !DOMUtils::isList( $otherNode ) ) {
						return [ 'min' => 0, 'max' => 0 ];
					} else {
						return [];
					}
				}
			]
		],

		'dt' => [
			'forceSOL' => true,
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMUtils, &$WTUtils ) {
				$firstChildElement = DOMUtils::firstNonSepChild( $node );
				if ( !DOMUtils::isList( $firstChildElement )
|| WTUtils::isLiteralHTMLNode( $firstChildElement )
				) {
					$state->emitChunk( getListBullets( $state, $node ), $node );
				}
				$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
				};
				$state->singleLineContext->enforce();
				/* await */ $state->serializeChildren( $node, $liHandler );
				array_pop( $state->singleLineContext );
			}

			,
			'sepnls' => [
				'before' => id( [ 'min' => 1, 'max' => 2 ] ),
				'after' => function ( $node, $otherNode ) use ( &$DOMDataUtils ) {
					if ( $otherNode->nodeName === 'DD'
&& DOMDataUtils::getDataParsoid( $otherNode )->stx === 'row'
					) {
						return [ 'min' => 0, 'max' => 0 ];
					} else {
						return wtListEOL( $node, $otherNode );
					}
				},
				'firstChild' => function ( $node, $otherNode ) use ( &$DOMUtils ) {
					if ( !DOMUtils::isList( $otherNode ) ) {
						return [ 'min' => 0, 'max' => 0 ];
					} else {
						return [];
					}
				}
			]
		],

		'dd_row' => buildDDHandler( 'row' ), // single-line dt/dd
		'dd' => buildDDHandler(), // multi-line dt/dd

		// XXX: handle options
		'table' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$DOMUtils, &$serializeTableTag, &$WTUtils, &$WTSUtils ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				$wt = $dp->startTagSrc || '{|';
				$indentTable = $node->parentNode->nodeName === 'DD'
&& DOMUtils::previousNonSepSibling( $node ) === null;
				if ( $indentTable ) {
					$state->singleLineContext->disable();
				}
				$state->emitChunk(
					/* await */ $serializeTableTag( $wt, '', $state, $node, $wrapperUnmodified ),
					$node
				);
				if ( !WTUtils::isLiteralHTMLNode( $node ) ) {
					$state->wikiTableNesting++;
				}
				/* await */ $state->serializeChildren( $node );
				if ( !WTUtils::isLiteralHTMLNode( $node ) ) {
					$state->wikiTableNesting--;
				}
				if ( !$state->sep->constraints ) {
					// Special case hack for "{|\n|}" since state.sep is
					// cleared in SSP.emitSep after a separator is emitted.
					// However, for {|\n|}, the <table> tag has no element
					// children which means lastchild -> parent constraint
					// is never computed and set here.
					$state->sep->constraints = [ 'a' => [], 'b' => [], 'min' => 1, 'max' => 2 ];
				}
				WTSUtils::emitEndTag( $dp->endTagSrc || '|}', $node, $state );
				if ( $indentTable ) {
					array_pop( $state->singleLineContext );
				}
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) {
					// Handle special table indentation case!
					if ( $node->parentNode === $otherNode
&& $otherNode->nodeName === 'DD'
					) {
						return [ 'min' => 0, 'max' => 2 ];
					} else {
						return [ 'min' => 1, 'max' => 2 ];
					}
				},
				'after' => function ( $node, $otherNode ) use ( &$WTUtils, &$DOMUtils ) {
					if ( ( WTUtils::isNewElt( $node ) || WTUtils::isNewElt( $otherNode ) ) && !DOMUtils::isBody( $otherNode ) ) {
						return [ 'min' => 1, 'max' => 2 ];
					} else {
						return [ 'min' => 0, 'max' => 2 ];
					}
				},
				'firstChild' => function ( $node, $otherNode ) {
					return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
				},
				'lastChild' => function ( $node, $otherNode ) {
					return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
				}
			]
		],
		'tbody' => $justChildren,
		'thead' => $justChildren,
		'tfoot' => $justChildren,
		'tr' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$WTSUtils, &$serializeTableTag ) {
				$dp = DOMDataUtils::getDataParsoid( $node );

				if ( trWikitextNeeded( $node, $dp ) ) {
					WTSUtils::emitStartTag(
						/* await */ $serializeTableTag(
							$dp->startTagSrc || '|-', '', $state,
							$node, $wrapperUnmodified
						),
						$node, $state
					);
				}

				/* await */ $state->serializeChildren( $node );
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) use ( &$DOMDataUtils ) {
					if ( trWikitextNeeded( $node, DOMDataUtils::getDataParsoid( $node ) ) ) {
						return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
					} else {
						return [ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
					}
				},
				'after' => function ( $node, $otherNode ) {
					return [ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
				}
			]
		],
		'th' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$serializeTableTag, &$WTSUtils, &$DOMUtils ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				$usableDP = stxInfoValidForTableCell( $state, $node );
				$attrSepSrc = ( $usableDP ) ? ( $dp->attrSepSrc || null ) : null;
				$startTagSrc = ( $usableDP ) ? $dp->startTagSrc : '';
				if ( !$startTagSrc ) {
					$startTagSrc = ( $usableDP && $dp->stx === 'row' ) ? '!!' : '!';
				}

				// T149209: Special case to deal with scenarios
				// where the previous sibling put us in a SOL state
				// (or will put in a SOL state when the separator is emitted)
				// T149209: Special case to deal with scenarios
				// where the previous sibling put us in a SOL state
				// (or will put in a SOL state when the separator is emitted)
				if ( $state->onSOL || $state->sep->constraints->min > 0 ) {
					// You can use both "!!" and "||" for same-row headings (ugh!)
					$startTagSrc = preg_replace(

						'/{{!}}{{!}}/', '{{!}}', preg_replace(
							'/\|\|/', '!', preg_replace( '/!!/', '!', $startTagSrc, 1 ), 1 ),
						 1
					);
				}

				$thTag = /* await */ $serializeTableTag( $startTagSrc, $attrSepSrc, $state, $node, $wrapperUnmodified );
				$leadingSpace = getLeadingSpace( $state, $node, '' );
				// If the HTML for the first th is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				// If the HTML for the first th is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				WTSUtils::emitStartTag( $thTag + $leadingSpace,
					$node,
					$state
				);
				$thHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->thHandler( $node, $state, $text, $opts );
				};

				$nextTh = DOMUtils::nextNonSepSibling( $node );
				$nextUsesRowSyntax = DOMUtils::isElt( $nextTh ) && DOMDataUtils::getDataParsoid( $nextTh )->stx === 'row';

				// For empty cells, emit a single whitespace to make wikitext
				// more readable as well as to eliminate potential misparses.
				// For empty cells, emit a single whitespace to make wikitext
				// more readable as well as to eliminate potential misparses.
				if ( $nextUsesRowSyntax && !DOMUtils::firstNonDeletedChild( $node ) ) {
					$state->serializer->emitWikitext( ' ', $node );
					return;
				}

				/* await */ $state->serializeChildren( $node, $thHandler );

				if ( $nextUsesRowSyntax && !preg_match( '/\s$/', $state->currLine->text ) ) {
					$trailingSpace = getTrailingSpace( $state, $node, '' );
					if ( $trailingSpace ) {
						$state->appendSep( $trailingSpace );
					}
				}
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode, $state ) use ( &$DOMDataUtils ) {
					if ( $otherNode->nodeName === 'TH'
&& DOMDataUtils::getDataParsoid( $node )->stx === 'row'
					) {
						// force single line
						return [ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
					} else {
						return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
					}
				},
				'after' => function ( $node, $otherNode ) {
					if ( $otherNode->nodeName === 'TD' ) {
						// Force a newline break
						return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
					} else {
						return [ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
					}
				}
			]
		],
		'td' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$serializeTableTag, &$WTSUtils, &$DOMUtils ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				$usableDP = stxInfoValidForTableCell( $state, $node );
				$attrSepSrc = ( $usableDP ) ? ( $dp->attrSepSrc || null ) : null;
				$startTagSrc = ( $usableDP ) ? $dp->startTagSrc : '';
				if ( !$startTagSrc ) {
					$startTagSrc = ( $usableDP && $dp->stx === 'row' ) ? '||' : '|';
				}

				// T149209: Special case to deal with scenarios
				// where the previous sibling put us in a SOL state
				// (or will put in a SOL state when the separator is emitted)
				// T149209: Special case to deal with scenarios
				// where the previous sibling put us in a SOL state
				// (or will put in a SOL state when the separator is emitted)
				if ( $state->onSOL || $state->sep->constraints->min > 0 ) {
					$startTagSrc = preg_replace(
						'/{{!}}{{!}}/', '{{!}}', preg_replace( '/\|\|/', '|', $startTagSrc, 1 ), 1 );
				}

				// If the HTML for the first td is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				// If the HTML for the first td is not enclosed in a tr-tag,
				// we start a new line.  If not, tr will have taken care of it.
				$tdTag = /* await */ $serializeTableTag(
					$startTagSrc, $attrSepSrc,
					$state, $node, $wrapperUnmodified
				);
				$inWideTD = preg_match( '/\|\||^{{!}}{{!}}/', $tdTag );
				$leadingSpace = getLeadingSpace( $state, $node, '' );
				WTSUtils::emitStartTag( $tdTag + $leadingSpace, $node, $state );
				$tdHandler = function ( $state, $text, $opts ) use ( &$state, &$node, &$inWideTD ) {return $state->serializer->wteHandlers->tdHandler( $node, $inWideTD, $state, $text, $opts );
				};

				$nextTd = DOMUtils::nextNonSepSibling( $node );
				$nextUsesRowSyntax = DOMUtils::isElt( $nextTd ) && DOMDataUtils::getDataParsoid( $nextTd )->stx === 'row';

				// For empty cells, emit a single whitespace to make wikitext
				// more readable as well as to eliminate potential misparses.
				// For empty cells, emit a single whitespace to make wikitext
				// more readable as well as to eliminate potential misparses.
				if ( $nextUsesRowSyntax && !DOMUtils::firstNonDeletedChild( $node ) ) {
					$state->serializer->emitWikitext( ' ', $node );
					return;
				}

				/* await */ $state->serializeChildren( $node, $tdHandler );

				if ( $nextUsesRowSyntax && !preg_match( '/\s$/', $state->currLine->text ) ) {
					$trailingSpace = getTrailingSpace( $state, $node, '' );
					if ( $trailingSpace ) {
						$state->appendSep( $trailingSpace );
					}
				}
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode, $state ) use ( &$DOMDataUtils ) {
					if ( $otherNode->nodeName === 'TD'
&& DOMDataUtils::getDataParsoid( $node )->stx === 'row'
					) {
						// force single line
						return [ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
					} else {
						return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
					}
				},
				'after' => function ( $node, $otherNode ) {
					return [ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
				}
			]
		],
		'caption' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$serializeTableTag, &$WTSUtils ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				// Serialize the tag itself
				// Serialize the tag itself
				$tableTag = /* await */ $serializeTableTag(
					$dp->startTagSrc || '|+', null, $state, $node,
					$wrapperUnmodified
				);
				WTSUtils::emitStartTag( $tableTag, $node, $state );
				/* await */ $state->serializeChildren( $node );
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) {
					return ( $otherNode->nodeName !== 'TABLE' ) ?
					[ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ] :
					[ 'min' => 0, 'max' => maxNLsInTable( $node, $otherNode ) ];
				},
				'after' => function ( $node, $otherNode ) {
					return [ 'min' => 1, 'max' => maxNLsInTable( $node, $otherNode ) ];
				}
			]
		],
		// Insert the text handler here too?
		'#text' => [],
		'p' => [

			// Counterintuitive but seems right.
			// Otherwise the generated wikitext will parse as an indent-pre
			// escapeWikitext nowiking will deal with leading space for content
			// inside the p-tag, but forceSOL suppresses whitespace before the p-tag.
			'forceSOL' => true,
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				// XXX: Handle single-line mode by switching to HTML handler!
				/* await */ $state->serializeChildren( $node );
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode, $state ) use ( &$DOMUtils, &$DOMDataUtils, &$WTUtils ) {
					$otherNodeName = $otherNode->nodeName;
					$tableCellOrBody = new Set( [ 'TD', 'TH', 'BODY' ] );
					if ( $node->parentNode === $otherNode
&& ( DOMUtils::isListItem( $otherNode ) || $tableCellOrBody->has( $otherNodeName ) )
					) {
						if ( $tableCellOrBody->has( $otherNodeName ) ) {
							return [ 'min' => 0, 'max' => 1 ];
						} else {
							return [ 'min' => 0, 'max' => 0 ];
						}
					} elseif (
						$otherNode === DOMUtils::previousNonDeletedSibling( $node )
&& // p-p transition
							( $otherNodeName === 'P' && DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html' )
||
							treatAsPPTransition( $otherNode )
&& $otherNode === DOMUtils::previousNonSepSibling( $node )
&& // A new wikitext line could start at this P-tag. We have to figure out
								// if 'node' needs a separation of 2 newlines from that P-tag. Examine
								// previous siblings of 'node' to see if we emitted a block tag
								// there => we can make do with 1 newline separator instead of 2
								// before the P-tag.
								!currWikitextLineHasBlockNode( $state->currLine, $otherNode )
					) {

						return [ 'min' => 2, 'max' => 2 ];
					} elseif ( treatAsPPTransition( $otherNode )
|| ( DOMUtils::isBlockNode( $otherNode ) && $otherNode->nodeName !== 'BLOCKQUOTE' && $node->parentNode === $otherNode )
|| // new p-node added after sol-transparent wikitext should always
							// get serialized onto a new wikitext line.
							( WTUtils::emitsSolTransparentSingleLineWT( $otherNode ) && WTUtils::isNewElt( $node ) )
					) {
						if ( !DOMUtils::hasAncestorOfName( $otherNode, 'FIGCAPTION' ) ) {
							return [ 'min' => 1, 'max' => 2 ];
						} else {
							return [ 'min' => 0, 'max' => 2 ];
						}
					} else {
						return [ 'min' => 0, 'max' => 2 ];
					}
				},
				'after' => function ( $node, $otherNode, $state ) use ( &$DOMUtils ) {
					if ( !( $node->lastChild && $node->lastChild->nodeName === 'BR' )
&& isPPTransition( $otherNode )
						// A new wikitext line could start at this P-tag. We have to figure out
						// if 'node' needs a separation of 2 newlines from that P-tag. Examine
						// previous siblings of 'node' to see if we emitted a block tag
						// there => we can make do with 1 newline separator instead of 2
						// before the P-tag.
						 && !currWikitextLineHasBlockNode( $state->currLine, $node, true )
						// Since we are going to emit newlines before the other P-tag, we know it
						// is going to start a new wikitext line. We have to figure out if 'node'
						// needs a separation of 2 newlines from that P-tag. Examine following
						// siblings of 'node' to see if we might emit a block tag there => we can
						// make do with 1 newline separator instead of 2 before the P-tag.
						 && !newWikitextLineMightHaveBlockNode( $otherNode )
					) {
						return [ 'min' => 2, 'max' => 2 ];
					} elseif ( DOMUtils::isBody( $otherNode ) ) {
						return [ 'min' => 0, 'max' => 2 ];
					} elseif ( treatAsPPTransition( $otherNode )
|| ( DOMUtils::isBlockNode( $otherNode ) && $otherNode->nodeName !== 'BLOCKQUOTE' && $node->parentNode === $otherNode )
					) {
						if ( !DOMUtils::hasAncestorOfName( $otherNode, 'FIGCAPTION' ) ) {
							return [ 'min' => 1, 'max' => 2 ];
						} else {
							return [ 'min' => 0, 'max' => 2 ];
						}
					} else {
						return [ 'min' => 0, 'max' => 2 ];
					}
				}
			]
		],
		// Wikitext indent pre generated with leading space
		'pre' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$JSUtils, &$Util ) {
				// Handle indent pre

				// XXX: Use a pre escaper?
				$content = /* await */ $state->serializeIndentPreChildrenToString( $node );
				// Strip (only the) trailing newline
				// Strip (only the) trailing newline
				$trailingNL = preg_match( '/\n$/', $content );
				$content = preg_replace( '/\n$/', '', $content, 1 );

				// Insert indentation
				// Insert indentation
				$solRE = JSUtils::rejoin(
					'(\n(',
					// SSS FIXME: What happened to the includeonly seen
					// in wts.separators.js?
					Util\COMMENT_REGEXP,
					')*)',
					[ 'flags' => 'g' ]
				);
				$content = ' ' . str_replace( $solRE, '$1 ', $content );

				// But skip "empty lines" (lines with 1+ comment and
				// optional whitespace) since empty-lines sail through all
				// handlers without being affected.
				//
				// See empty_line_with_comments rule in pegTokenizer.pegjs
				//
				// We could use 'split' to split content into lines and
				// selectively add indentation, but the code will get
				// unnecessarily complex for questionable benefits. So, going
				// this route for now.
				// But skip "empty lines" (lines with 1+ comment and
				// optional whitespace) since empty-lines sail through all
				// handlers without being affected.
				//
				// See empty_line_with_comments rule in pegTokenizer.pegjs
				//
				// We could use 'split' to split content into lines and
				// selectively add indentation, but the code will get
				// unnecessarily complex for questionable benefits. So, going
				// this route for now.
				$emptyLinesRE = JSUtils::rejoin(
					// This space comes from what we inserted earlier
					/* RegExp */ '/(^|\n) /',
					'((?:',
					/* RegExp */ '/[ \t]*/',
					Util\COMMENT_REGEXP,
					/* RegExp */ '/[ \t]*/',
					')+)',
					/* RegExp */ '/(?=\n|$)/'
				);
				$content = str_replace( $emptyLinesRE, '$1$2', $content );

				$state->emitChunk( $content, $node );

				// Preserve separator source
				// Preserve separator source
				$state->appendSep( ( $trailingNL && $trailingNL[ 0 ] ) || '' );
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) use ( &$DOMDataUtils ) {
					if ( $otherNode->nodeName === 'PRE'
&& DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html'
					) {
						return [ 'min' => 2 ];
					} else {
						return [ 'min' => 1 ];
					}
				},
				'after' => function ( $node, $otherNode ) use ( &$DOMDataUtils ) {
					if ( $otherNode->nodeName === 'PRE'
&& DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html'
					) {
						return [ 'min' => 2 ];
					} else {
						return [ 'min' => 1 ];
					}
				},
				'firstChild' => id( [] ),
				'lastChild' => id( [] )
			]
		],
		// HTML pre
		'pre_html' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$_htmlElementHandler ) {
				/* await */ $_htmlElementHandler( $node, $state );
			}

			,
			'sepnls' => [
				'before' => id( [] ),
				'after' => id( [] ),
				'firstChild' => id( [ 'max' => Number\MAX_VALUE ] ),
				'lastChild' => id( [ 'max' => Number\MAX_VALUE ] )
			]
		],
		'meta' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$Util, &$WTUtils, &$_htmlElementHandler ) {
				$type = $node->getAttribute( 'typeof' ) || '';
				$property = $node->getAttribute( 'property' ) || '';
				$dp = DOMDataUtils::getDataParsoid( $node );
				$dmw = DOMDataUtils::getDataMw( $node );

				if ( $dp->src !== null
&& preg_match( '/(^|\s)mw:Placeholder(\/\w*)?$/', $type )
				) {
					return emitPlaceholderSrc( $node, $state );
				}

				// Check for property before type so that page properties with
				// templated attrs roundtrip properly.
				// Ex: {{DEFAULTSORT:{{echo|foo}} }}
				// Check for property before type so that page properties with
				// templated attrs roundtrip properly.
				// Ex: {{DEFAULTSORT:{{echo|foo}} }}
				if ( $property ) {
					$switchType = preg_match( '/^mw\:PageProp\/(.*)$/', $property );
					if ( $switchType ) {
						$out = $switchType[ 1 ];
						$cat = preg_match( '/^(?:category)?(.*)/', $out );
						if ( $cat && Util::magicMasqs::has( $cat[ 1 ] ) ) {
							$contentInfo =
							/* await */ $state->serializer->serializedAttrVal(
								$node, 'content', []
							);
							if ( WTUtils::hasExpandedAttrsType( $node ) ) {
								$out = '{{' . $contentInfo->value . '}}';
							} elseif ( $dp->src !== null ) {
								$out = preg_replace(
									'/^([^:]+:)(.*)$/',
									'$1' . $contentInfo->value . '}}', $dp->src, 1 );
							} else {
								$magicWord = strtoupper( $cat[ 1 ] );
								$state->env->log( 'warn', $cat[ 1 ]
. ' is missing source. Rendering as '
. $magicWord . ' magicword'
								);
								$out = '{{' . $magicWord . ':'
. $contentInfo->value . '}}';
							}
						} else {
							$out = $state->env->conf->wiki->getMagicWordWT(
								$switchType[ 1 ], $dp->magicSrc
							) || '';
						}
						$state->emitChunk( $out, $node );
					} else {
						/* await */ $_htmlElementHandler( $node, $state );
					}
				} elseif ( $type ) {
					switch ( $type ) {
						case 'mw:Includes/IncludeOnly':
						// Remove the dp.src when older revisions of HTML expire in RESTBase
						$state->emitChunk( $dmw->src || $dp->src || '', $node );
						break;
						case 'mw:Includes/IncludeOnly/End':
						// Just ignore.
						break;
						case 'mw:Includes/NoInclude':
						$state->emitChunk( $dp->src || '<noinclude>', $node );
						break;
						case 'mw:Includes/NoInclude/End':
						$state->emitChunk( $dp->src || '</noinclude>', $node );
						break;
						case 'mw:Includes/OnlyInclude':
						$state->emitChunk( $dp->src || '<onlyinclude>', $node );
						break;
						case 'mw:Includes/OnlyInclude/End':
						$state->emitChunk( $dp->src || '</onlyinclude>', $node );
						break;
						case 'mw:DiffMarker/inserted':

						case 'mw:DiffMarker/deleted':

						case 'mw:DiffMarker/moved':

						case 'mw:Separator':
						// just ignore it
						break;
						default:
						/* await */ $_htmlElementHandler( $node, $state );
					}
				} else {
					/* await */ $_htmlElementHandler( $node, $state );
				}
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) use ( &$DOMDataUtils, &$WTUtils ) {
					$type =
					( $node->hasAttribute( 'typeof' ) ) ? $node->getAttribute( 'typeof' ) :
					( $node->hasAttribute( 'property' ) ) ? $node->getAttribute( 'property' ) :
					null;
					if ( $type && preg_match( '/mw:PageProp\/categorydefaultsort/', $type ) ) {
						if ( $otherNode->nodeName === 'P' && DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html' ) {
							// Since defaultsort is outside the p-tag, we need 2 newlines
							// to ensure that it go back into the p-tag when parsed.
							return [ 'min' => 2 ];
						} else {
							return [ 'min' => 1 ];
						}
					} elseif ( WTUtils::isNewElt( $node )
&& // Placeholder metas don't need to be serialized on their own line
							( $node->nodeName !== 'META'
|| !preg_match( '/(^|\s)mw:Placeholder(\/|$)/', $node->getAttribute( 'typeof' ) || '' ) )
					) {
						return [ 'min' => 1 ];
					} else {
						return [];
					}
				},
				'after' => function ( $node, $otherNode ) use ( &$WTUtils ) {
					// No diffs
					if ( WTUtils::isNewElt( $node )
&& // Placeholder metas don't need to be serialized on their own line
							( $node->nodeName !== 'META'
|| !preg_match( '/(^|\s)mw:Placeholder(\/|$)/', $node->getAttribute( 'typeof' ) || '' ) )
					) {
						return [ 'min' => 1 ];
					} else {
						return [];
					}
				}
			]
		],
		'span' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$DOMUtils, &$Util, &$_htmlElementHandler, &$WTSUtils ) {
				$env = $state->env;
				$dp = DOMDataUtils::getDataParsoid( $node );
				$type = $node->getAttribute( 'typeof' ) || '';
				$contentSrc = $node->textContent || $node->innerHTML;
				if ( isRecognizedSpanWrapper( $type ) ) {
					if ( $type === 'mw:Nowiki' ) {
						$nativeExt = $env->conf->wiki->extConfig->tags->get( 'nowiki' );
						/* await */ $nativeExt->serialHandler->handle( $node, $state, $wrapperUnmodified );
					} elseif ( preg_match( '/(?:^|\s)mw:(?:Image|Video|Audio)(\/(Frame|Frameless|Thumb))?/', $type ) ) {
						// TODO: Remove when 1.5.0 content is deprecated,
						// since we no longer emit media in spans.  See the test,
						// "Serialize simple image with span wrapper"
						/* await */ $state->serializer->figureHandler( $node );
					} elseif ( preg_match( '/(?:^|\s)mw\:Entity/', $type ) && DOMUtils::hasNChildren( $node, 1 ) ) {
						// handle a new mw:Entity (not handled by selser) by
						// serializing its children
						if ( $dp->src !== null && $contentSrc === $dp->srcContent ) {
							$state->serializer->emitWikitext( $dp->src, $node );
						} elseif ( DOMUtils::isText( $node->firstChild ) ) {
							$state->emitChunk(
								Util::entityEncodeAll( $node->firstChild->nodeValue ),
								$node->firstChild
							);
						} else {
							/* await */ $state->serializeChildren( $node );
						}
					} elseif ( preg_match( '/(^|\s)mw:Placeholder(\/\w*)?/', $type ) ) {
						if ( $dp->src !== null ) {
							return emitPlaceholderSrc( $node, $state );
						} elseif ( /* RegExp */ '/(^|\s)mw:Placeholder(\s|$)/'
&& DOMUtils::hasNChildren( $node, 1 )
&& DOMUtils::isText( $node->firstChild )
&& // See the DisplaySpace hack in the urltext rule
								// in the tokenizer.
								preg_match( '/\u00a0+/', $node->firstChild->nodeValue )
						) {
							$state->emitChunk(
								' '->repeat( strlen( ' ' ) ),
								$node->firstChild
							);
						} else {
							/* await */ $_htmlElementHandler( $node, $state );
						}
					}
				} else {
					$kvs = WTSUtils::getAttributeKVArray( $node )->filter( function ( $kv ) use ( &$DOMDataUtils ) {
							return !preg_match( '/^data-parsoid/', $kv->k )
&& ( $kv->k !== DOMDataUtils\DataObjectAttrName() )
&& !( $kv->k === 'id' && preg_match( '/^mw[\w-]{2,}$/', $kv->v ) );
					}
					);
					if ( !$state->rtTestMode && $dp->misnested && $dp->stx !== 'html'
&& !count( $kvs )
					) {
						// Discard span wrappers added to flag misnested content.
						// Warn since selser should have reused source.
						$env->log( 'warn', 'Serializing misnested content: ' . $node->outerHTML );
						/* await */ $state->serializeChildren( $node );
					} else {
						// Fall back to plain HTML serialization for spans created
						// by the editor.
						/* await */ $_htmlElementHandler( $node, $state );
					}
				}
			}

		]
		,
		'figure' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				/* await */ $state->serializer->figureHandler( $node );
			}

			,
			'sepnls' => [
				// TODO: Avoid code duplication
				'before' => function ( $node ) use ( &$WTUtils, &$DOMUtils ) {
					if (
						WTUtils::isNewElt( $node )
&& $node->parentNode
&& DOMUtils::isBody( $node->parentNode )
					) {
						return [ 'min' => 1 ];
					}
					return [];
				},
				'after' => function ( $node ) use ( &$WTUtils, &$DOMUtils ) {
					if (
						WTUtils::isNewElt( $node )
&& $node->parentNode
&& DOMUtils::isBody( $node->parentNode )
					) {
						return [ 'min' => 1 ];
					}
					return [];
				}
			]
		],
		'figure-inline' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				/* await */ $state->serializer->figureHandler( $node );
			}

		]
		,
		'img' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				if ( $node->getAttribute( 'rel' ) === 'mw:externalImage' ) {
					$state->serializer->emitWikitext( $node->getAttribute( 'src' ) || '', $node );
				} else {
					/* await */ $state->serializer->figureHandler( $node );
				}
			}

		]
		,
		'video' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				/* await */ $state->serializer->figureHandler( $node );
			}

		]
		,
		'hr' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils ) { // eslint-disable-line require-yield
				$state->emitChunk( '-'->repeat( 4 + ( DOMDataUtils::getDataParsoid( $node )->extra_dashes || 0 ) ), $node );
			}

			,
			'sepnls' => [
				'before' => id( [ 'min' => 1, 'max' => 2 ] ),
				// XXX: Add a newline by default if followed by new/modified content
				'after' => id( [ 'min' => 0, 'max' => 2 ] )
			]
		],
		'h1' => buildHeadingHandler( '=' ),
		'h2' => buildHeadingHandler( '==' ),
		'h3' => buildHeadingHandler( '===' ),
		'h4' => buildHeadingHandler( '====' ),
		'h5' => buildHeadingHandler( '=====' ),
		'h6' => buildHeadingHandler( '======' ),
		'br' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils ) { // eslint-disable-line require-yield
				if ( $state->singleLineContext->enforced()
|| DOMDataUtils::getDataParsoid( $node )->stx === 'html'
|| $node->parentNode->nodeName !== 'P'
				) {
					// <br/> has special newline-based semantics in
					// parser-generated <p><br/>.. HTML
					$state->emitChunk( '<br />', $node );
				}

				// If P_BR (or P_BR_P), dont emit anything for the <br> so that
				// constraints propagate to the next node that emits content.
			}

			, // If P_BR (or P_BR_P), dont emit anything for the <br> so that
			// constraints propagate to the next node that emits content.

			'sepnls' => [
				'before' => function ( $node, $otherNode, $state ) {
					if ( $state->singleLineContext->enforced() || !isPbr( $node ) ) {
						return [];
					}

					$c = $state->sep->constraints || [ 'min' => 0 ];
					// <h2>..</h2><p><br/>..
					// <p>..</p><p><br/>..
					// In all cases, we need at least 3 newlines before
					// any content that follows the <br/>.
					// Whether we need 4 depends what comes after <br/>.
					// content or a </p>. The after handler deals with it.
					return [ 'min' => max( 3, $c->min + 1 ), 'force' => true ];
				},
				// NOTE: There is an asymmetry in the before/after handlers.
				'after' => function ( $node, $otherNode, $state ) use ( &$DOMUtils ) {
					// Note that the before handler has already forced 1 additional
					// newline for all <p><br/> scenarios which simplifies the work
					// of the after handler.
					//
					// Nothing changes with constraints if we are not
					// in a P-P transition. <br/> has special newline-based
					// semantics only in a parser-generated <p><br/>.. HTML.

					if ( $state->singleLineContext->enforced()
|| !isPPTransition( DOMUtils::nextNonSepSibling( $node->parentNode ) )
					) {
						return [];
					}

					$c = $state->sep->constraints || [ 'min' => 0 ];
					if ( isPbrP( $node ) ) {
						// The <br/> forces an additional newline when part of
						// a <p><br/></p>.
						//
						// Ex: <p><br/></p><p>..</p> => at least 4 newlines before
						// content of the *next* p-tag.
						return [ 'min' => max( 4, $c->min + 1 ), 'force' => true ];
					} elseif ( isPbr( $node ) ) {
						// Since the <br/> is followed by content, the newline
						// constraint isn't bumped.
						//
						// Ex: <p><br/>..<p><p>..</p> => at least 2 newlines after
						// content of *this* p-tag
						return [ 'min' => max( 2, $c->min ), 'force' => true ];
					}

					return [];
				}
			]
		],
		'a' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				/* await */ $state->serializer->linkHandler( $node );
			}

		]

		, // TODO: Implement link tail escaping with nowiki in DOM handler!

		'link' => [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) {
				/* await */ $state->serializer->linkHandler( $node );
			}

			,
			'sepnls' => [
				'before' => function ( $node, $otherNode ) use ( &$WTUtils ) {
					// sol-transparent link nodes are the only thing on their line.
					// But, don't force separators wrt to its parent (body, p, list, td, etc.)
					if ( $otherNode !== $node->parentNode
&& WTUtils::isSolTransparentLink( $node ) && !WTUtils::isRedirectLink( $node )
&& !WTUtils::isEncapsulationWrapper( $node )
					) {
						return [ 'min' => 1 ];
					} else {
						return [];
					}
				},
				'after' => function ( $node, $otherNode, $state ) use ( &$WTUtils ) {
					// sol-transparent link nodes are the only thing on their line
					// But, don't force separators wrt to its parent (body, p, list, td, etc.)
					if ( $otherNode !== $node->parentNode
&& WTUtils::isSolTransparentLink( $node ) && !WTUtils::isRedirectLink( $node )
&& !WTUtils::isEncapsulationWrapper( $node )
					) {
						return [ 'min' => 1 ];
					} else {
						return [];
					}
				}
			]
		],
		'body' => [
			'handle' => $justChildren->handle,
			'sepnls' => [
				'firstChild' => id( [ 'min' => 0, 'max' => 1 ] ),
				'lastChild' => id( [ 'min' => 0, 'max' => 1 ] )
			]
		]
	]
);

$parentMap = [
	'LI' => [ 'UL' => 1, 'OL' => 1 ],
	'DT' => [ 'DL' => 1 ],
	'DD' => [ 'DL' => 1 ]
];

function parentBulletsHaveBeenEmitted( $node ) {
	global $WTUtils;
	global $DOMUtils;
	global $parentMap;
	if ( WTUtils::isLiteralHTMLNode( $node ) ) {
		return true;
	} elseif ( DOMUtils::isList( $node ) ) {
		return !DOMUtils::isListItem( $node->parentNode );
	} else {
		Assert::invariant( DOMUtils::isListItem( $node ) );
		$parentNode = $node->parentNode;
		// Skip builder-inserted wrappers
		while ( isBuilderInsertedElt( $parentNode ) ) {
			$parentNode = $parentNode->parentNode;
		}
		return !( isset( $parentMap[ $node->nodeName ][ $parentNode->nodeName ] ) );
	}
}

function handleListPrefix( $node, $state ) {
	global $DOMUtils;
	global $DOMDataUtils;
	$bullets = '';
	if ( DOMUtils::isListOrListItem( $node )
&& !parentBulletsHaveBeenEmitted( $node )
&& !DOMUtils::previousNonSepSibling( $node ) && // Maybe consider parentNode.
			isTplListWithoutSharedPrefix( $node )
&& // Nothing to do for definition list rows,
			// since we're emitting for the parent node.
			!( $node->nodeName === 'DD'
&& DOMDataUtils::getDataParsoid( $node )->stx === 'row' )
	) {
		$bullets = getListBullets( $state, $node->parentNode );
	}
	return $bullets;
}

function ClientError( $message ) {
	Error::captureStackTrace( $this, $ClientError );
	$this->name = 'Bad Request';
	$this->message = $message || 'Bad Request';
	$this->httpStatus = 400;
	$this->suppressLoggingStack = true;
}
ClientError::prototype = Error::prototype;

/**
 * Function returning `domHandler`s for nodes with encapsulated content.
 */
$_getEncapsulatedContentHandler = function () use ( &$DOMDataUtils, &$WTUtils, &$tagHandlers, &$htmlElementHandler ) {
	return [
		'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$WTUtils ) {
			$env = $state->env;
			$self = $state->serializer;
			$dp = DOMDataUtils::getDataParsoid( $node );
			$dataMw = DOMDataUtils::getDataMw( $node );
			$typeOf = $node->getAttribute( 'typeof' ) || '';
			$src = null;
			if ( preg_match( '/(?:^|\s)(?:mw:Transclusion|mw:Param)(?=$|\s)/', $typeOf ) ) {
				if ( $dataMw->parts ) {
					$src = /* await */ $self->serializeFromParts( $state, $node, $dataMw->parts );
				} elseif ( $dp->src !== null ) {
					$env->log( 'error', 'data-mw missing in: ' . $node->outerHTML );
					$src = $dp->src;
				} else {
					throw new ClientError( 'Cannot serialize ' . $typeOf . ' without data-mw.parts or data-parsoid.src' );
				}
			} elseif ( preg_match( '/(?:^|\s)mw:Extension\//', $typeOf ) ) {
				if ( !$dataMw->name && $dp->src === null ) {
					// If there was no typeOf name, and no dp.src, try getting
					// the name out of the mw:Extension type. This will
					// generate an empty extension tag, but it's better than
					// just an error.
					$extGivenName = preg_replace( '/(?:^|\s)mw:Extension\/([^\s]+)/', '$1', $typeOf, 1 );
					if ( $extGivenName ) {
						$env->log( 'error', 'no data-mw name for extension in: ', $node->outerHTML );
						$dataMw->name = $extGivenName;
					}
				}
				if ( $dataMw->name ) {
					$nativeExt = $env->conf->wiki->extConfig->tags->get( strtolower( $dataMw->name ) );
					if ( $nativeExt && $nativeExt->serialHandler && $nativeExt->serialHandler->handle ) {
						$src = /* await */ $nativeExt->serialHandler->handle( $node, $state, $wrapperUnmodified );
					} else {
						$src = /* await */ $self->defaultExtensionHandler( $node, $state );
					}
				} elseif ( $dp->src !== null ) {
					$env->log( 'error', 'data-mw missing in: ' . $node->outerHTML );
					$src = $dp->src;
				} else {
					throw new ClientError( 'Cannot serialize extension without data-mw.name or data-parsoid.src.' );
				}
			} elseif ( preg_match( '/(?:^|\s)(?:mw:LanguageVariant)(?=$|\s)/', $typeOf ) ) {
				return ( /* await */ $state->serializer->languageVariantHandler( $node ) );
			} else {
				throw new Error( 'Should never reach here' );
			}
			$state->singleLineContext->disable();
			// FIXME: https://phabricator.wikimedia.org/T184779
			// FIXME: https://phabricator.wikimedia.org/T184779
			if ( $dataMw->extPrefix || $dataMw->extSuffix ) {
				$src = ( $dataMw->extPrefix || '' ) + $src + ( $dataMw->extSuffix || '' );
			}
			$self->emitWikitext( handleListPrefix( $node, $state ) + $src, $node );
			array_pop( $state->singleLineContext );
			return WTUtils::skipOverEncapsulatedContent( $node );
		}

		,
		'sepnls' => [
			// XXX: This is questionable, as the template can expand
			// to newlines too. Which default should we pick for new
			// content? We don't really want to make separator
			// newlines in HTML significant for the semantics of the
			// template content.
			'before' => function ( $node, $otherNode, $state ) use ( &$DOMDataUtils, &$tagHandlers, &$htmlElementHandler ) {
				$env = $state->env;
				$typeOf = $node->getAttribute( 'typeof' ) || '';
				$dataMw = DOMDataUtils::getDataMw( $node );
				$dp = DOMDataUtils::getDataParsoid( $node );

				// Handle native extension constraints.
				if ( preg_match( '/(?:^|\s)mw:Extension\//', $typeOf )
&& // Only apply to plain extension tags.
						!preg_match( '/(?:^|\s)mw:Transclusion(?:\s|$)/', $typeOf )
				) {
					if ( $dataMw->name ) {
						$nativeExt = $env->conf->wiki->extConfig->tags->get( strtolower( $dataMw->name ) );
						if ( $nativeExt && $nativeExt->serialHandler && $nativeExt->serialHandler->before ) {
							$ret = $nativeExt->serialHandler->before( $node, $otherNode, $state );
							if ( $ret !== null ) { return $ret;
				   }
						}
					}
				}

				// If this content came from a multi-part-template-block
				// use the first node in that block for determining
				// newline constraints.
				if ( $dp->firstWikitextNode ) {
					$nodeName = strtolower( $dp->firstWikitextNode );
					$h = $tagHandlers->get( $nodeName );
					if ( !$h && $dp->stx === 'html' && $nodeName !== 'a' ) {
						$h = $htmlElementHandler;
					}
					if ( $h && $h->sepnls && $h->sepnls->before ) {
						return $h->sepnls->before( $node, $otherNode, $state );
					}
				}

				// default behavior
				return [ 'min' => 0, 'max' => 2 ];
			}
		]
	];
};

/**
 * Just the handle for the htmlElementHandler defined below.
 * It's used as a fallback in some of the tagHandlers above.
 * @private
 */
$_htmlElementHandler = /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$WTSUtils, &$TokenUtils, &$DOMUtils, &$DOMDataUtils ) {
	$serializer = $state->serializer;

	// Wikitext supports the following list syntax:
	//
	// * <li class="a"> hello world
	//
	// The "LI Hack" gives support for this syntax, and we need to
	// specially reconstruct the above from a single <li> tag.
	// Wikitext supports the following list syntax:
	//
	// * <li class="a"> hello world
	//
	// The "LI Hack" gives support for this syntax, and we need to
	// specially reconstruct the above from a single <li> tag.
	$serializer->_handleLIHackIfApplicable( $node );

	$tag = /* await */ $serializer->_serializeHTMLTag( $node, $wrapperUnmodified );
	WTSUtils::emitStartTag( $tag, $node, $state );

	if ( $node->hasChildNodes() ) {
		$inPHPBlock = $state->inPHPBlock;
		if ( TokenUtils::tagOpensBlockScope( strtolower( $node->nodeName ) ) ) {
			$state->inPHPBlock = true;
		}

		// TODO(arlolra): As of 1.3.0, html pre is considered an extension
		// and wrapped in encapsulation.  When that version is no longer
		// accepted for serialization, we can remove this backwards
		// compatibility code.
		// TODO(arlolra): As of 1.3.0, html pre is considered an extension
		// and wrapped in encapsulation.  When that version is no longer
		// accepted for serialization, we can remove this backwards
		// compatibility code.
		if ( $node->nodeName === 'PRE' ) {
			// Handle html-pres specially
			// 1. If the node has a leading newline, add one like it (logic copied from VE)
			// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
			// This patched DOM will serialize html-pres correctly.

			$lostLine = '';
			$fc = $node->firstChild;
			if ( $fc && DOMUtils::isText( $fc ) ) {
				$m = preg_match( '/^\n/', $fc->nodeValue );
				$lostLine = $m && $m[ 0 ] || '';
			}

			if ( !$lostLine && DOMDataUtils::getDataParsoid( $node )->strippedNL ) {
				$lostLine = "\n";
			}

			$state->emitChunk( $lostLine, $node );
		}

		/* await */ $state->serializeChildren( $node );
		$state->inPHPBlock = $inPHPBlock;
	}

	$endTag = /* await */ $serializer->_serializeHTMLEndTag( $node, $wrapperUnmodified );
	WTSUtils::emitEndTag( $endTag, $node, $state );
};

/**
 * Used as a fallback in tagHandlers.
 * @namespace
 */
$htmlElementHandler = [ 'handle' => $_htmlElementHandler ];

if ( gettype( $module ) === 'object' ) {
	$module->exports->tagHandlers = $tagHandlers;
	$module->exports->htmlElementHandler = $htmlElementHandler;
	$module->exports->_getEncapsulatedContentHandler =
	$_getEncapsulatedContentHandler;
}
