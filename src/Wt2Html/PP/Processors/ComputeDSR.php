<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\PP\Processors;

use DOMNode;
use \stdClass as StdClass;

use Parsoid\Config\Env;
use Parsoid\Config\WikitextConstants as Consts;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\WTUtils;

class ComputeDSR {
	/**
	 * For an explanation of what TSR is, see dom.computeDSR.js
	 *
	 * TSR info on all these tags are only valid for the opening tag.
	 * (closing tags dont have attrs since tree-builder strips them
	 * and adds meta-tags tracking the corresponding TSR)
	 *
	 * On other tags, a, hr, br, meta-marker tags, the tsr spans
	 * the entire DOM, not just the tag.
	 *
	 * This code is not in WikitextConstants.php because this
	 * information is Parsoid-implementation-specific.
	 */
	private static $WtTagsWithLimitedTSR = [
		"b"  => true,
		"i"  => true,
		"h1" => true,
		"h2" => true,
		"h3" => true,
		"h4" => true,
		"h5" => true,
		"ul" => true,
		"ol" => true,
		"dl" => true,
		"li" => true,
		"dt" => true,
		"dd" => true,
		"table" => true,
		"caption" => true,
		"tr" => true,
		"td" => true,
		"th" => true,
		"hr" => true, // void element
		"br" => true, // void element
		"pre" => true,
	];

	/**
	 * Do $parsoidData->tsr values span the entire DOM subtree rooted at $n?
	 *
	 * @param DOMNode $n
	 * @param StdClass $parsoidData
	 * @return bool
	 */
	private function tsrSpansTagDOM( DOMNode $n, StdClass $parsoidData ): bool {
		// - tags known to have tag-specific tsr
		// - html tags with 'stx' set
		$name = $n->nodeName;
		return !(
			isset( self::$WtTagsWithLimitedTSR[$name] ) ||
			WTUtils::hasLiteralHTMLMarker( $parsoidData )
		);
	}

	/**
	 * Is the inconsistency between two different ways of computing
	 * start offset ($cs, $s) explainable and acceptable?
	 * If so, we can suppress warnings.
	 *
	 * @param array $opts
	 * @param DOMNode $node
	 * @param int $cs
	 * @param int $s
	 * @return bool
	 */
	private function acceptableInconsistency( array $opts, DOMNode $node, int $cs, int $s ): bool {
		/**
		 * 1. For wikitext URL links, suppress cs-s diff warnings because
		 *    the diffs can come about because of various reasons since the
		 *    canonicalized/decoded href will become the a-link text whose width
		 *    will not match the tsr width of source wikitext
		 *
		 *    (a) urls with encoded chars (ex: 'http://example.com/?foo&#61;bar')
		 *    (b) non-canonical spaces (ex: 'RFC  123' instead of 'RFC 123')
		 *
		 * 2. We currently dont have source offsets for attributes.
		 *    So, we get a lot of spurious complaints about cs/s mismatch
		 *    when DSR computation hit the <body> tag on this attribute.
		 *    $opts['attrExpansion'] tell us when we are processing an attribute
		 *    and let us suppress the mismatch warning on the <body> tag.
		 *
		 * 3. Other scenarios .. to be added
		 */
		if ( $node->nodeName === 'a' && (
				WTUtils::usesURLLinkSyntax( $node, null ) ||
				WTUtils::usesMagicLinkSyntax( $node, null )
			)
		) {
			return true;
		} elseif ( isset( $opts['attrExpansion'] ) && DOMUtils::isBody( $node ) ) {
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Compute wikitext string length that contributes to this
	 * list item's open tag. Closing tag width is always 0 for lists.
	 *
	 * @param DOMNode $li
	 * @return int
	 */
	private function computeListEltWidth( DOMNode $li ): int {
		if ( !$li->previousSibling && $li->firstChild ) {
			if ( DOMUtils::isList( $li->firstChild ) ) {
				// Special case!!
				// First child of a list that is on a chain
				// of nested lists doesn't get a width.
				return 0;
			}
		}

		// count nest listing depth and assign
		// that to the opening tag width.
		$depth = 0;
		while ( $li->nodeName === 'li' || $li->nodeName === 'dd' ) {
			$depth++;
			$li = $li->parentNode->parentNode;
		}

		return $depth;
	}

	/**
	 * Compute wikitext string lengths that contribute to this
	 * anchor's opening (<a>) and closing (</a>) tags.
	 *
	 * @param DOMNode $node
	 * @param StdClass|null $dp
	 * @return int[]
	 */
	private function computeATagWidth( DOMNode $node, ?StdClass $dp ): ?array {
		/* -------------------------------------------------------------
		 * Tag widths are computed as per this logic here:
		 *
		 * 1. [[Foo|bar]] <-- piped mw:WikiLink
		 *     -> start-tag: "[[Foo|"
		 *     -> content  : "bar"
		 *     -> end-tag  : "]]"
		 *
		 * 2. [[Foo]] <-- non-piped mw:WikiLink
		 *     -> start-tag: "[["
		 *     -> content  : "Foo"
		 *     -> end-tag  : "]]"
		 *
		 * 3. [[{{echo|Foo}}|Foo]] <-- tpl-attr mw:WikiLink
		 *    Dont bother setting tag widths since dp->sa['href'] will be
		 *    the expanded target and won't correspond to original source.
		 *    We dont always have access to the meta-tag that has the source.
		 *
		 * 4. [http://wp.org foo] <-- mw:ExtLink
		 *     -> start-tag: "[http://wp.org "
		 *     -> content  : "foo"
		 *     -> end-tag  : "]"
		 * -------------------------------------------------------------- */
		if ( !$dp ) {
			return null;
		} else {
			if ( WTUtils::usesWikiLinkSyntax( $node, $dp ) && !WTUtils::hasExpandedAttrsType( $node ) ) {
				if ( isset( $dp->stx ) && $dp->stx === "piped" ) {
					$href = $dp->sa->href ?? null;
					if ( $href ) {
						return [ mb_strlen( $href ) + 3, 2 ];
					} else {
						return null;
					}
				} else {
					return [ 2, 2 ];
				}
			} elseif ( isset( $dp->tsr ) && WTUtils::usesExtLinkSyntax( $node, $dp ) ) {
				return [ $dp->targetOff - $dp->tsr[0], 1 ];
			} elseif ( WTUtils::usesURLLinkSyntax( $node, $dp ) ||
				WTUtils::usesMagicLinkSyntax( $node, $dp )
			) {
				return [ 0, 0 ];
			} else {
				return null;
			}
		}
	}

	/**
	 * Compute wikitext string lengths that contribute to this
	 * node's opening and closing tags.
	 *
	 * @param int[] $widths
	 * @param DOMNode $node
	 * @param StdClass $dp
	 * @return int[]
	 */
	private function computeTagWidths( array $widths, DOMNode $node, StdClass $dp ): array {
		if ( isset( $dp->tagWidths ) ) {
			return $dp->tagWidths;
		}

		$stWidth = $widths[0];
		$etWidth = $widths[1];

		if ( WTUtils::hasLiteralHTMLMarker( $dp ) ) {
			if ( isset( $dp->selfClose ) ) {
				$etWidth = 0;
			}
		} else {
			$nodeName = $node->nodeName;
			// 'tr' tags not in the original source have zero width
			if ( $nodeName === 'tr' && !isset( $dp->startTagSrc ) ) {
				$stWidth = 0;
				$etWidth = 0;
			} else {
				$wtTagWidth = Consts::$WtTagWidths[$nodeName] ?? null;
				if ( $stWidth === null ) {
					// we didn't have a tsr to tell us how wide this tag was.
					if ( $nodeName === 'a' ) {
						$wtTagWidth = $this->computeATagWidth( $node, $dp );
						$stWidth = $wtTagWidth ? $wtTagWidth[0] : null;
					} elseif ( $nodeName === 'li' || $nodeName === 'dd' ) {
						$stWidth = $this->computeListEltWidth( $node );
					} elseif ( $wtTagWidth ) {
						$stWidth = $wtTagWidth[0];
					}
				}

				if ( $etWidth === null && $wtTagWidth ) {
					$etWidth = $wtTagWidth[1];
				}
			}
		}

		return [ $stWidth, $etWidth ];
	}

	private function trace( $env, ...$args ): void {
		$env->log( "trace/dsr", function () use ( $args ) {
			$buf = '';
			foreach ( $args as $arg ) {
				$buf .= ( gettype( $arg ) === 'string' ? $arg : PHPUtils::jsonEncode( $arg ) );
			}
			return $buf;
		} );
	}

	/**
	 * TSR = "Tag Source Range".  Start and end offsets giving the location
	 * where the tag showed up in the original source.
	 *
	 * DSR = "DOM Source Range".  [0] and [1] are open and end,
	 * [2] and [3] are widths of the container tag.
	 *
	 * TSR is set by the tokenizer. In most cases, it only applies to the
	 * specific tag (opening or closing).  However, for self-closing
	 * tags that the tokenizer generates, the TSR values applies to the entire
	 * DOM subtree (opening tag + content + closing tag).
	 *
	 * Ex: So [[foo]] will get tokenized to a SelfClosingTagTk(...) with a TSR
	 * value of [0,7].  The DSR algorithm will then use that info and assign
	 * the a-tag rooted at the <a href='...'>foo</a> DOM subtree a DSR value of
	 * [0,7,2,2], where 2 and 2 refer to the opening and closing tag widths.
	 *
	 * [s,e) -- if defined, start/end position of wikitext source that generated
	 *          node's subtree
	 *
	 * @param Env $env
	 * @param DOMNode $node node to process
	 * @param int|null $s start position, inclusive
	 * @param int|null $e end position, exclusive
	 * @param int $dsrCorrection
	 * @param array $opts
	 * @return int[]
	 */
	private function computeNodeDSR(
		Env $env, DOMNode $node, ?int $s, ?int $e, int $dsrCorrection, array $opts
	): array {
		if ( $e === null && !$node->hasChildNodes() ) {
			$e = $s;
		}

		$this->trace( $env, "BEG: ", $node->nodeName, " with [s, e]=", [ $s, $e ] );

		$savedEndTagWidth = null;
		$ce = $e;
		// Initialize $cs to $ce to handle the zero-children case properly
		// if this $node has no child content, then the start and end for
		// the child dom are indeed identical.  Alternatively, we could
		// explicitly code this check before everything and bypass this.
		$cs = $ce;
		$rtTestMode = $env->getSiteConfig()->rtTestMode();

		$child = $node->lastChild;
		while ( $child !== null ) {
			$prevChild = $child->previousSibling;
			$isMarkerTag = false;
			$origCE = $ce;
			$cType = $child->nodeType;
			$endTagInfo = null;
			$fosteredNode = false;
			$cs = null;

			// In edit mode, StrippedTag marker tags will be removed and wont
			// be around to miss in the filling gap.  So, absorb its width into
			// the DSR of its previous sibling.  Currently, this fix is only for
			// B and I tags where the fix is clear-cut and obvious.
			if ( !$rtTestMode ) {
				$next = $child->nextSibling;
				if ( $next && DOMUtils::isElt( $next ) ) {
					$ndp = DOMDataUtils::getDataParsoid( $next );
					if ( isset( $ndp->src ) &&
						preg_match( '#(?:^|\s)mw:Placeholder/StrippedTag(?=$|\s)#', $next->getAttribute( "typeof" ) )
					) {
						if ( isset( Consts::$WTQuoteTags[$ndp->name] ) &&
							isset( Consts::$WTQuoteTags[$child->nodeName] ) ) {
							$correction = mb_strlen( $ndp->src );
							$ce += $correction;
							$dsrCorrection = $correction;
							# if (Util::isValidDSR($ndp->dsr))
							if ( DOMUtils::isValidDSR( $ndp->dsr ) ) {
								// Record original DSR for the meta tag
								// since it will now get corrected to zero width
								// since child acquires its width->
								if ( !$ndp->tmp ) {
									$ndp->tmp = [];
								}
								$ndp->tmp->origDSR = [ $ndp->dsr[0], $ndp->dsr[1], null, null ];
							}
						}
					}
				}
			}

			$env->log( "trace/dsr", function () use ( $child, $cs, $ce ) {
				// slow, for debugging only
				$i = 0;
				foreach ( $child->parentNode->childNodes as $x ) {
					if ( $x === $child ) {
						break;
					}
					$i++;
				}
				return "     CHILD: <" . $child->parentNode->nodeName . ":" . $i .
					">=" .
					( DOMUtils::isElt( $child ) ? '' : ( DOMUtils::isText( $child ) ? '#' : '!' ) ) .
					( DOMUtils::isElt( $child ) ?
						// PORT-FIXME: PHP DOM does not have an outerHTML property
						( $child->nodeName === 'meta' ? $child->outerHTML : $child->nodeName ) :
						PHPUtils::jsonEncode( $child->data )
					) . " with " . PHPUtils::jsonEncode( [ $cs, $ce ] );
			} );

			if ( $cType === XML_TEXT_NODE ) {
				if ( $ce !== null ) {
					// This code is replicated below. Keep both in sync.
					$cs = $ce - mb_strlen( $child->textContent ) - WTUtils::indentPreDSRCorrection( $child );
				}
			} elseif ( $cType === XML_COMMENT_NODE ) {
				if ( $ce !== null ) {
					// Decode HTML entities & re-encode as wikitext to find length
					$cs = $ce - WTUtils::decodedCommentLength( $child );
				}
			} elseif ( $cType === XML_ELEMENT_NODE ) {
				$cTypeOf = $child->getAttribute( "typeof" );
				$dp = DOMDataUtils::getDataParsoid( $child );
				$tsr = isset( $dp->tsr ) ? $dp->tsr : null;
				$oldCE = $tsr ? $tsr[1] : null;
				$propagateRight = false;
				$stWidth = null;
				$etWidth = null;

				$fosteredNode = $dp->fostered ?? false;

				// In edit-mode, we are making dsr corrections to account for
				// stripped tags (end tags usually). When stripping happens,
				// in most common use cases, a corresponding end tag is added
				// back elsewhere in the DOM.
				//
				// So, when an autoInsertedEnd tag is encountered and a matching
				// dsr-correction is found, make a 1-time correction in the
				// other direction.
				//
				// Currently, this fix is only for
				// B and I tags where the fix is clear-cut and obvious.
				if ( !$rtTestMode && $ce !== null && isset( $dp->autoInsertedEnd ) &&
					DOMUtils::isQuoteElt( $child )
				) {
					$correction = 3 + mb_strlen( $child->nodeName );
					if ( $correction === $dsrCorrection ) {
						$ce -= $correction;
						$dsrCorrection = 0;
					}
				}

				if ( $child->nodeName === "meta" ) {
					// Unless they have been foster-parented,
					// meta marker tags have valid tsr info->
					if ( $cTypeOf === "mw:EndTag" || $cTypeOf === "mw:TSRMarker" ) {
						if ( $cTypeOf === "mw:EndTag" ) {
							// FIXME: This seems like a different function that is
							// tacked onto DSR computation, but there is no clean place
							// to do this one-off thing without doing yet another pass
							// over the DOM -- maybe we need a 'do-misc-things-pass'.
							//
							// Update table-end syntax using info from the meta tag
							$prev = $child->previousSibling;
							if ( $prev && $prev->nodeName === "table" ) {
								$prevDP = DOMDataUtils::getDataParsoid( $prev );
								if ( !WTUtils::hasLiteralHTMLMarker( $prevDP ) ) {
									if ( isset( $dp->endTagSrc ) ) {
										$prevDP->endTagSrc = $dp->endTagSrc;
									}
								}
							}
						}

						$isMarkerTag = true;
						// TSR info will be absent if the tsr-marker came
						// from a template since template tokens have all
						// their tsr info-> stripped->
						if ( $tsr ) {
							$endTagInfo = [
								'width' => $tsr[1] - $tsr[0],
								'nodeName' => $child->getAttribute( "data-etag" ),
							];
							$cs = $tsr[1];
							$ce = $tsr[1];
							$propagateRight = true;
						}
					} elseif ( $tsr ) {
						if ( WTUtils::isTplMetaType( $cTypeOf ) ) {
							// If this is a meta-marker tag (for templates, extensions),
							// we have a new valid '$cs'. This marker also effectively resets tsr
							// back to the top-level wikitext source range from nested template
							// source range.
							$cs = $tsr[0];
							$ce = $tsr[1];
							$propagateRight = true;
						} else {
							// All other meta-tags: <includeonly>, <noinclude>, etc.
							$cs = $tsr[0];
							$ce = $tsr[1];
						}
					} elseif ( preg_match( '#^mw:Placeholder(/\w*)?$#', $cTypeOf ) &&
						$ce !== null && $dp->src
					) {
						$cs = $ce - mb_strlen( $dp->src );
					} else {
						$property = $child->getAttribute( "property" );
						if ( $property && preg_match( '/mw:objectAttr/', $property ) ) {
							$cs = $ce;
						}
					}
					if ( isset( $dp->tagWidths ) ) {
						$stWidth = $dp->tagWidths[0];
						$etWidth = $dp->tagWidths[1];
						$dp->tagWidths = null;
					}
				} elseif ( $cTypeOf === "mw:Entity" && $ce !== null && $dp->src ) {
					$cs = $ce - mb_strlen( $dp->src );
				} else {
					if ( preg_match( '/^mw:Placeholder(\/\w*)?$/', $cTypeOf ) &&
						$ce !== null && $dp->src
					) {
						$cs = $ce - mb_strlen( $dp->src );
					} else {
						// Non-meta tags
						if ( $tsr && !isset( $dp->autoInsertedStart ) ) {
							$cs = $tsr[0];
							if ( $this->tsrSpansTagDOM( $child, $dp ) ) {
								if ( !$ce || $tsr[1] > $ce ) {
									$ce = $tsr[1];
									$propagateRight = true;
								}
							} else {
								$stWidth = $tsr[1] - $tsr[0];
							}

							$this->trace( $env, "     TSR: ", $tsr, "; cs: ", $cs, "; ce: ", $ce );
						} elseif ( $s && $child->previousSibling === null ) {
							$cs = $s;
						}
					}

					// Compute width of opening/closing tags for this dom $node
					$tagWidths = $this->computeTagWidths( [ $stWidth, $savedEndTagWidth ], $child, $dp );
					$stWidth = $tagWidths[0];
					$etWidth = $tagWidths[1];

					if ( isset( $dp->autoInsertedStart ) ) {
						$stWidth = 0;
					}
					if ( isset( $dp->autoInsertedEnd ) ) {
						$etWidth = 0;
					}

					$ccs = $cs !== null && $stWidth !== null ? $cs + $stWidth : null;
					$cce = $ce !== null && $etWidth !== null ? $ce - $etWidth : null;

					/* -----------------------------------------------------------------
					 * Process DOM rooted at '$child'.
					 *
					 * NOTE: You might wonder why we are not checking for the zero-$children
					 * case. It is strictly not necessary and you can set newDsr directly.
					 *
					 * But, you have 2 options: [$ccs, $ccs] or [$cce, $cce]. Setting it to
					 * [$cce, $cce] would be consistent with the RTL approach. We should
					 * then compare $ccs and $cce and verify that they are identical.
					 *
					 * But, if we handled the zero-child case like the other scenarios,
					 * we don't have to worry about the above decisions and checks.
					 * ----------------------------------------------------------------- */

					if ( WTUtils::isDOMFragmentWrapper( $child ) ) {
						// Eliminate artificial $cs/s mismatch warnings since this is
						// just a wrapper token with the right DSR but without any
						// nested subtree that could account for the DSR span.
						$newDsr = [ $ccs, $cce ];
					} elseif ( $child->nodeName === 'a'
						&& WTUtils::usesWikiLinkSyntax( $child, $dp )
						&& ( !isset( $dp->stx ) || $dp->stx !== "piped" ) ) {
						/* -------------------------------------------------------------
						 * This check here eliminates artificial DSR mismatches on content
						 * text of the A-node because of entity expansion, etc.
						 *
						 * Ex: [[7%25 solution]] will be rendered as:
						 *    <a href=....>7% solution</a>
						 * If we descend into the text for the a-node, we'll have a 2-char
						 * DSR mismatch which will trigger artificial error warnings.
						 *
						 * In the non-piped link scenario, all dsr info is already present
						 * in the link target and so we get nothing new by processing
						 * content.
						 * ------------------------------------------------------------- */
						$newDsr = [ $ccs, $cce ];
					} else {
						$env->log( "trace/dsr", function () use ( $env, $cs, $ce, $stWidth, $etWidth, $ccs, $cce ) {
							return "     before-recursing:" .
								"[cs,ce]=" . PHPUtils::jsonEncode( [ $cs, $ce ] ) .
								"; [sw,ew]=" . PHPUtils::jsonEncode( [ $stWidth, $etWidth ] ) .
								"; subtree-[cs,ce]=" . PHPUtils::jsonEncode( [ $ccs,$cce ] );
						} );

						$this->trace( $env, "<recursion>" );
						$newDsr = $this->computeNodeDSR( $env, $child, $ccs, $cce, $dsrCorrection, $opts );
						$this->trace( $env, "</recursion>" );
					}

					// $cs = min($child-dom-tree dsr[0] - tag-width, current dsr[0])
					if ( $stWidth !== null && $newDsr[0] !== null ) {
						$newCs = $newDsr[0] - $stWidth;
						if ( $cs === null || ( !$tsr && $newCs < $cs ) ) {
							$cs = $newCs;
						}
					}

					// $ce = max($child-dom-tree dsr[1] + tag-width, current dsr[1])
					if ( $etWidth !== null && $newDsr[1] !== null ) {
						$newCe = $newDsr[1] + $etWidth;
						if ( $newCe > $ce ) {
							$ce = $newCe;
						}
					}
				}

				if ( $cs !== null || $ce !== null ) {
					if ( $ce < 0 ) {
						if ( !$fosteredNode ) {
							$env->log( "warn/dsr/negative",
								"Negative DSR for node: " . $node->nodeName . "; resetting to zero" );
						}
						$ce = 0;
					}

					// Fostered $nodes get a zero-dsr width range.
					if ( $fosteredNode ) {
						// Reset to 0, if necessary.
						// This is critical to avoid duplication of fostered content in selser mode.
						if ( $origCE < 0 ) {
							$origCE = 0;
						}
						$dp->dsr = [ $origCE, $origCE ];
					} else {
						$dp->dsr = [ $cs, $ce, $stWidth, $etWidth ];
					}

					$env->log( "trace/dsr", function () use ( $env, $child, $cs, $ce, $cTypeOf ) {
						$str = "     UPDATING " . $child->nodeName .
							" with " . PHPUtils::jsonEncode( [ $cs, $ce ] ) .
							"; typeof: " . ( $cTypeOf ? $cTypeOf : "null" );
						// Set up 'dbsrc' so we can debug this
						$dp->dbsrc = mb_substr( $env->getPageMainContent(), $cs, $ce - $cs );
						return $str;
					} );
				}

				// Propagate any required changes to the right
				// taking care not to cross-over into template content
				if ( $ce !== null &&
					( $propagateRight || $oldCE !== $ce || $e === null ) &&
					!WTUtils::isTplStartMarkerMeta( $child )
				) {
					$sibling = $child->nextSibling;
					$newCE = $ce;
					while ( $newCE !== null && $sibling && !WTUtils::isTplStartMarkerMeta( $sibling ) ) {
						$nType = $sibling->nodeType;
						if ( $nType === XML_TEXT_NODE ) {
							$newCE = $newCE + mb_strlen( $sibling->textContent ) +
								WTUtils::indentPreDSRCorrection( $sibling );
						} elseif ( $nType === XML_COMMENT_NODE ) {
							$newCE += WTUtils::decodedCommentLength( $sibling );
						} elseif ( $nType === XML_ELEMENT_NODE ) {
							$siblingDP = DOMDataUtils::getDataParsoid( $sibling );

							if ( !isset( $siblingDP->dsr ) ) {
								$siblingDP->dsr = [ null, null ];
							}

							if ( isset( $siblingDP->fostered ) ||
								( $siblingDP->dsr[0] !== null && $siblingDP->dsr[0] === $newCE ) ||
								( $siblingDP->dsr[0] !== null && isset( $siblingDP->tsr ) &&
									$siblingDP->dsr[0] < $newCE )
							) {
								// $sibling is fostered
								// => nothing to propagate past it
								// $sibling's dsr[0] matches what we might propagate
								// => nothing will change
								// $sibling's dsr value came from tsr and it is not outside expected range
								// => stop propagation so you don't overwrite it
								break;
							}

							// Update and move right
							$env->log( "trace/dsr", function () use ( $env, $ce, $newCE, $sibling, $siblingDP ) {
								$str = "     CHANGING $ce->start of " . $sibling->nodeName .
									" from " . $siblingDP->dsr[0] . " to " . $newCE;
								// debug info
								if ( $siblingDP->dsr[1] ) {
									$siblingDP->dbsrc =
										mb_substr( $env->getPageMainContent(), $newCE, $siblingDP->dsr[1] - $newCE );
								}
								return $str;
							} );

							$siblingDP->dsr[0] = $newCE;
							// If we have a dsr[1] as well and since we updated
							// dsr[0], we have to ensure that the two values don't
							// introduce an inconsistency where dsr[0] > dsr[1].
							// Since we are in a LTR pass and are pushing updates
							// forward, we are resolving it by updating dsr[1] as
							// well. There could be scenarios where this would be
							// incorrect, but there is no universal fix here.
							if ( $siblingDP->dsr[1] !== null && $newCE > $siblingDP->dsr[1] ) {
								$siblingDP->dsr[1] = $newCE;
							}
							$newCE = $siblingDP->dsr[1];

						} else {
							break;
						}
						$sibling = $sibling->nextSibling;
					}

					// Propagate new end information
					if ( !$sibling ) {
						$e = $newCE;
					}
				}
			}

			// Dont change state if we processed a fostered $node
			if ( $fosteredNode ) {
				$ce = $origCE;
			} else {
				// $ce for next $child = $cs of current $child
				$ce = $cs;

				// Save end-tag width from marker meta tag
				if ( $endTagInfo && $child->previousSibling &&
					$endTagInfo['nodeName'] === $child->previousSibling->nodeName ) {
					$savedEndTagWidth = $endTagInfo['width'];
				} else {
					$savedEndTagWidth = null;
				}
			}

			// No use for this marker tag after this.
			// Looks like DSR computation assumes that
			// these meta tags will be removed.
			if ( $isMarkerTag ) {
				// Collapse text $nodes to prevent n^2 effect in the LTR propagation pass
				// Example: enwiki:Colonization?oldid=718468597
				$nextChild = $child->nextSibling;
				if ( DOMUtils::isText( $prevChild ) && DOMUtils::isText( $nextChild ) ) {
					$prevText = $prevChild->nodeValue;
					$nextText = $nextChild->nodeValue;

					// Process prevText in place
					if ( $ce !== null ) {
						// indentPreDSRCorrection is not required here since
						// we'll never come down this branch (mw:TSRMarker won't exist
						// in indent-pres, and mw:EndTag markers won't have a text $node
						// for its previous sibling), but, for sake of maintenance sanity,
						// replicating code from above.
						$cs = $ce - mb_strlen( $prevText ) - WTUtils::indentPreDSRCorrection( $prevChild );
						$ce = $cs;
					}

					// Update DOM
					$newNode = $node->ownerDocument->createTextNode( $prevText . $nextText );
					$node->replaceChild( $newNode, $prevChild );
					$node->removeChild( $nextChild );
					$prevChild = $newNode->previousSibling;
				}
				$node->removeChild( $child );
			}

			$child = $prevChild;
		}

		if ( $cs === null ) {
			$cs = $s;
		}

		// Detect errors
		if ( $s !== null && $cs !== $s && !$this->acceptableInconsistency( $opts, $node, $cs, $s ) ) {
			$env->log( "warn/dsr/inconsistent", "DSR inconsistency: cs/s mismatch for node:",
				$node->nodeName, "s:", $s, "; cs:", $cs );
		}

		$this->trace( $env, "END: ", $node->nodeName, ", returning: ", $cs, ", ", $e );

		return [ $cs, $e ];
	}

	/**
	 * Computes DSR ranges for every node of a DOM tree.
	 *
	 * @param DOMNode $rootNode The root of the tree for which DSR has to be computed
	 * @param Env $env The environment/context for the parse pipeline
	 * @param array|null $options Options governing DSR computation
	 * - sourceOffsets: [start, end] source offset. If missing, this defaults to
	 *                  [0, $env->getPageMainContent()->length]
	 * - attrExpansion: Is this an attribute expansion pipeline?
	 */
	public function run( DOMNode $rootNode, Env $env, ?array $options = [] ): void {
		$startOffset = isset( $options['sourceOffsets'] ) ? $options['sourceOffsets'][0] : 0;
		$endOffset = isset( $options['sourceOffsets'] ) ? $options['sourceOffsets'][1] :
			mb_strlen( $env->getPageMainContent() );

		// The actual computation buried in trace/debug stmts.
		$opts = [ 'attrExpansion' => $options['attrExpansion'] ?? false ];
		$this->computeNodeDSR( $env, $rootNode, $startOffset, $endOffset, 0, $opts );

		$dp = DOMDataUtils::getDataParsoid( $rootNode );
		$dp->dsr = [ $startOffset, $endOffset, 0, 0 ];
	}
}
