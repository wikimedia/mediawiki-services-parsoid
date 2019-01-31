<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$JSUtils = require '../utils/jsutils.js'::JSUtils;
$wtConsts = require '../config/WikitextConstants.js';
$Consts = $wtConsts::WikitextConstants;
$Util = require '../utils/Util.js'::Util;
$DOMDataUtils = require '../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../utils/DOMUtils.js'::DOMUtils;
$DiffUtils = require './DiffUtils.js'::DiffUtils;
$WTSUtils = require './WTSUtils.js'::WTSUtils;
$WTUtils = require '../utils/WTUtils.js'::WTUtils;

/**
 * Clean up the constraints object to prevent excessively verbose output
 * and clog up log files / test runs.
 * @private
 */
function loggableConstraints( $constraints ) {
	$c = [
		'a' => $constraints->a,
		'b' => $constraints->b,
		'min' => $constraints->min,
		'max' => $constraints->max,
		'force' => $constraints->force
	];
	if ( $constraints->constraintInfo ) {
		$c->constraintInfo = [
			'onSOL' => $constraints->constraintInfo->onSOL,
			'sepType' => $constraints->constraintInfo->sepType,
			'nodeA' => $constraints->constraintInfo->nodeA->nodeName,
			'nodeB' => $constraints->constraintInfo->nodeB->nodeName
		];
	}
	return $c;
}

function precedingSeparatorTxt( $n ) {
	global $DOMUtils;
	// Given the CSS white-space property and specifically,
	// "pre" and "pre-line" values for this property, it seems that any
	// sane HTML editor would have to preserve IEW in HTML documents
	// to preserve rendering. One use-case where an editor might change
	// IEW drastically would be when the user explicitly requests it
	// (Ex: pretty-printing of raw source code).
	//
	// For now, we are going to exploit this.  This information is
	// only used to extrapolate DSR values and extract a separator
	// string from source, and is only used locally.  In addition,
	// the extracted text is verified for being a valid separator.
	//
	// So, at worst, this can create a local dirty diff around separators
	// and at best, it gets us a clean diff.

	$buf = '';
	$orig = $n;
	while ( $n ) {
		if ( DOMUtils::isIEW( $n ) ) {
			$buf += $n->nodeValue;
		} elseif ( DOMUtils::isComment( $n ) ) {
			$buf += '<!--';
			$buf += $n->nodeValue;
			$buf += '-->';
		} elseif ( $n !== $orig ) { // dont return if input node!
			return null;
		}

		$n = $n->previousSibling;
	}

	return $buf;
}

/**
 * Helper for updateSeparatorConstraints.
 *
 * Collects, checks and integrates separator newline requirements to a simple
 * min, max structure.
 * @param {SerializerState} state
 * @param {Node} nodeA
 * @param {Function} sepNlsHandlerA
 * @param {Node} nodeB
 * @param {Function} sepNlsHandlerB
 * @return {Object}
 * @return {Object} [return.a]
 * @return {Object} [return.b]
 * @private
 */
function getSepNlConstraints( $state, $nodeA, $sepNlsHandlerA, $nodeB, $sepNlsHandlerB ) {
	$env = $state->env;
	$nlConstraints = [ 'a' => [], 'b' => [] ];

	if ( $sepNlsHandlerA ) {
		$nlConstraints->a = $sepNlsHandlerA( $nodeA, $nodeB, $state );
		$nlConstraints->min = $nlConstraints->a->min;
		$nlConstraints->max = $nlConstraints->a->max;
	}

	if ( $sepNlsHandlerB ) {
		$nlConstraints->b = $sepNlsHandlerB( $nodeB, $nodeA, $state );
		$b = $nlConstraints->b;

		// now figure out if this conflicts with the nlConstraints so far
		if ( $b->min !== null ) {
			if ( $nlConstraints->max !== null && $nlConstraints->max < $b->min ) {
				// Conflict, warn and let nodeB win.
				$env->log( 'info/html2wt', 'Incompatible constraints 1:', $nodeA->nodeName,
					$nodeB->nodeName, loggableConstraints( $nlConstraints )
				);
				$nlConstraints->min = $b->min;
				$nlConstraints->max = $b->min;
			} else {
				$nlConstraints->min = max( $nlConstraints->min || 0, $b->min );
			}
		}

		if ( $b->max !== null ) {
			if ( $nlConstraints->min !== null && $nlConstraints->min > $b->max ) {
				// Conflict, warn and let nodeB win.
				$env->log( 'info/html2wt', 'Incompatible constraints 2:', $nodeA->nodeName,
					$nodeB->nodeName, loggableConstraints( $nlConstraints )
				);
				$nlConstraints->min = $b->max;
				$nlConstraints->max = $b->max;
			} elseif ( $nlConstraints->max !== null ) {
				$nlConstraints->max = min( $nlConstraints->max, $b->max );
			} else {
				$nlConstraints->max = $b->max;
			}
		}
	}

	if ( $nlConstraints->max === null ) {
		// Anything more than two lines will trigger paragraphs, so default to
		// two if nothing is specified.
		$nlConstraints->max = 2;
	}

	$nlConstraints->force = $nlConstraints->a->force || $nlConstraints->b->force;

	return $nlConstraints;
}

/**
 * Create a separator given a (potentially empty) separator text and newline
 * constraints.
 * @return string
 * @private
 */
function makeSeparator( $state, $sep, $nlConstraints ) {
	global $DOMUtils;
	global $Consts;
	global $WTUtils;
	global $Util;
	$origSep = $sep;

	// Split on comment/ws-only lines, consuming subsequent newlines since
	// those lines are ignored by the PHP parser
	// Ignore lines with ws and a single comment in them
	$splitReString = implode(

		'', [
			"(?:\n(?:[ \t]*?",
			Util\COMMENT_REGEXP::source,
			"[ \t]*?)+(?=\n))+|",
			Util\COMMENT_REGEXP::source
		]
	);
	$splitRe = new RegExp( $splitReString );
	$sepMatch = preg_match_all( '/\n/', implode( '', explode( $splitRe, $sep ) ), $FIXME );
	$sepNlCount = $sepMatch && count( $sepMatch ) || 0;
	$minNls = $nlConstraints->min || 0;

	if ( $state->atStartOfOutput && !$nlConstraints->a->min && $minNls > 0 ) {
		// Skip first newline as we are in start-of-line context
		$minNls--;
	}

	if ( $minNls > 0 && $sepNlCount < $minNls ) {
		// Append newlines
		$nlBuf = [];
		for ( $i = 0;  $i < ( $minNls - $sepNlCount );  $i++ ) {
			$nlBuf[] = "\n";
		}

		/* ------------------------------------------------------------------
		 * The following two heuristics try to do a best-guess on where to
		 * add the newlines relative to nodeA and nodeB that best matches
		 * wikitext output expectations.
		 *
		 * 1. In a parent-child separator scenario, where the first child of
		 *    nodeA is not an element, it could have contributed to the separator.
		 *    In that case, the newlines should be prepended because they
		 *    usually correspond to the parent's constraints,
		 *    and the separator was plucked from the child.
		 *
		 *    Try html2wt on this snippet:
		 *
		 *    a<p><!--cmt-->b</p>
		 *
		 * 2. In a sibling scenario, if nodeB is a literal-HTML element, nodeA is
		 *    forcing the newline and hence the newline should be emitted right
		 *    after it.
		 *
		 *    Try html2wt on this snippet:
		 *
		 *    <p>foo</p>  <p data-parsoid='{"stx":"html"}'>bar</p>
		 * -------------------------------------------------------------------- */
		$constraintInfo = $nlConstraints->constraintInfo || [];
		$sepType = $constraintInfo->sepType;
		$nodeA = $constraintInfo->nodeA;
		$nodeB = $constraintInfo->nodeB;
		if ( $sepType === 'parent-child'
&& !DOMUtils::isContentNode( DOMUtils::firstNonDeletedChild( $nodeA ) )
&& !( Consts\HTML\ChildTableTags::has( $nodeB->nodeName )
&& !WTUtils::isLiteralHTMLNode( $nodeB ) )
		) {
			$sep = implode( '', $nlBuf ) + $sep;
		} elseif ( $sepType === 'sibling' && WTUtils::isLiteralHTMLNode( $nodeB ) ) {
			$sep = implode( '', $nlBuf ) + $sep;
		} else {
			$sep += implode( '', $nlBuf );
		}
	} elseif ( $nlConstraints->max !== null && $sepNlCount > $nlConstraints->max ) {
		// Strip some newlines outside of comments
		// Capture separators in a single array with a capturing version of
		// the split regexp, so that we can work on the non-separator bits
		// when stripping newlines.
		$allBits = explode( new RegExp( '(' . $splitReString . ')' ), $sep );
		$newBits = [];
		$n = $sepNlCount;

		while ( $n > $nlConstraints->max ) {
			$bit = array_pop( $allBits );
			while ( $bit && preg_match( $splitRe, $bit ) ) {
				// skip comments
				$newBits[] = $bit;
				$bit = array_pop( $allBits );
			}
			while ( $n > $nlConstraints->max && preg_match( '/\n/', $bit ) ) {
				$bit = preg_replace( '/\n([^\n]*)/', '$1', $bit, 1 );
				$n--;
			}
			$newBits[] = $bit;
		}
		array_reverse( $newBits );
		$newBits = $allBits->concat( $newBits );
		$sep = implode( '', $newBits );
	}

	$state->env->log( 'debug/wts/sep', 'make-new   |', function () use ( &$Util, &$nlConstraints, &$sepNlCount, &$minNls ) {
			$constraints = Util::clone( $nlConstraints );
			$constraints->constraintInfo = null;
			return json_encode( $sep ) . ', '
. json_encode( $origSep ) . ', '
. $minNls . ', ' . $sepNlCount . ', ' . json_encode( $constraints );
	}
	);

	return $sep;
}

/**
 * Merge two constraints.
 *
 * @private
 */
function mergeConstraints( $env, $oldConstraints, $newConstraints ) {
	$res = [ 'a' => $oldConstraints->a, 'b' => $newConstraints->b ];
	$res->min = max( $oldConstraints->min || 0, $newConstraints->min || 0 );
	$res->max = min( ( $oldConstraints->max !== null ) ? $oldConstraints->max : 2,
		( $newConstraints->max !== null ) ? $newConstraints->max : 2
	);
	if ( $res->min > $res->max ) {
		// If oldConstraints.force is set, older constraints win
		if ( !$oldConstraints->force ) {
			// let newConstraints win, but complain
			if ( $newConstraints->max !== null && $newConstraints->max > $res->min ) {
				$res->max = $newConstraints->max;
			} elseif ( $newConstraints->min && $newConstraints->min < $res->min ) {
				$res->min = $newConstraints->min;
			}
		}

		$res->max = $res->min;
		$env->log( 'info/html2wt', 'Incompatible constraints (merge):', $res,
			loggableConstraints( $oldConstraints ), loggableConstraints( $newConstraints )
		);
	}
	$res->force = $oldConstraints->force || $newConstraints->force;
	return $res;
}

$debugOut = function ( $node ) {
	return substr( json_encode( $node->outerHTML || $node->nodeValue || '' ), 0, 40 );
};

/**
 * Figure out separator constraints and merge them with existing constraints
 * in state so that they can be emitted when the next content emits source.
 * @param {Node} nodeA
 * @param {Function} handlerA
 * @param {Node} nodeB
 * @param {Function} handlerB
 */
$updateSeparatorConstraints = function ( $nodeA, $handlerA, $nodeB, $handlerB ) use ( &$debugOut ) {
	$nlConstraints = null;
	$state = $this->state;
	$sepHandlerA = $handlerA && $handlerA->sepnls || [];
	$sepHandlerB = $handlerB && $handlerB->sepnls || [];
	$sepType = null;

	if ( $nodeA->nextSibling === $nodeB ) {
		// sibling separator
		$sepType = 'sibling';
		$nlConstraints = getSepNlConstraints( $state, $nodeA, $sepHandlerA->after,
			$nodeB, $sepHandlerB->before
		);
	} elseif ( $nodeB->parentNode === $nodeA ) {
		$sepType = 'parent-child';
		// parent-child separator, nodeA parent of nodeB
		$nlConstraints = getSepNlConstraints( $state, $nodeA, $sepHandlerA->firstChild,
			$nodeB, $sepHandlerB->before
		);
	} elseif ( $nodeA->parentNode === $nodeB ) {
		$sepType = 'child-parent';
		// parent-child separator, nodeB parent of nodeA
		$nlConstraints = getSepNlConstraints( $state, $nodeA, $sepHandlerA->after,
			$nodeB, $sepHandlerB->lastChild
		);
	} else {
		// sibling separator
		$sepType = 'sibling';
		$nlConstraints = getSepNlConstraints( $state, $nodeA, $sepHandlerA->after,
			$nodeB, $sepHandlerB->before
		);
	}

	if ( $nodeA->nodeName === null ) {
		$console->trace();
	}

	if ( $state->sep->constraints ) {
		// Merge the constraints
		$state->sep->constraints = mergeConstraints( $this->env,
			$state->sep->constraints, $nlConstraints
		);
	} else {
		$state->sep->constraints = $nlConstraints;
	}

	$this->env->log( 'debug/wts/sep', function () use ( &$sepType, &$nodeA, &$nodeB, &$debugOut ) {
			return 'constraint'
. ' | ' . $sepType
. ' | <' . $nodeA->nodeName . ',' . $nodeB->nodeName . '>'
. ' | ' . json_encode( $state->sep->constraints )
. ' | ' . $debugOut( $nodeA )
. ' | ' . $debugOut( $nodeB );
	}
	);

	$state->sep->constraints->constraintInfo = [
		'onSOL' => $state->onSOL,
		// force SOL state when separator is built/emitted
		'forceSOL' => $handlerB && $handlerB->forceSOL,
		'sepType' => $sepType,
		'nodeA' => $nodeA,
		'nodeB' => $nodeB
	];
};

// spaces + (comments and anything but newline)?
$WS_COMMENTS_SEP_TEST_REGEXP = JSUtils::rejoin(
	/* RegExp */ '/( +)/',
	'(', Util\COMMENT_REGEXP, /* RegExp */ '/[^\n]*/', ')?$'
);

$WS_COMMENTS_SEP_REPLACE_REGEXP = new RegExp( WS_COMMENTS_SEP_TEST_REGEXP::source, 'g' );

// multiple newlines followed by spaces + (comments and anything but newline)?
$NL_WS_COMMENTS_SEP_REGEXP = JSUtils::rejoin(
	/* RegExp */ '/\n+/',
	$WS_COMMENTS_SEP_TEST_REGEXP
);

function makeSepIndentPreSafe( $state, $sep, $nlConstraints ) {
	global $NL_WS_COMMENTS_SEP_REGEXP;
	global $WS_COMMENTS_SEP_TEST_REGEXP;
	global $WTSUtils;
	global $DOMUtils;
	global $WTUtils;
	global $Consts;
	global $Util;
	$constraintInfo = $nlConstraints->constraintInfo || [];
	$sepType = $constraintInfo->sepType;
	$nodeA = $constraintInfo->nodeA;
	$nodeB = $constraintInfo->nodeB;
	$forceSOL = $constraintInfo->forceSOL && $sepType !== 'child-parent';
	$origNodeB = $nodeB;

	// Ex: "<div>foo</div>\n <span>bar</span>"
	//
	// We also should test for onSOL state to deal with HTML like
	// <ul> <li>foo</li></ul>
	// and strip the leading space before non-indent-pre-safe tags
	if ( !$state->inPHPBlock && !$state->inIndentPre
&& ( preg_match( $NL_WS_COMMENTS_SEP_REGEXP, $sep )
|| preg_match( $WS_COMMENTS_SEP_TEST_REGEXP, $sep ) && ( $constraintInfo->onSOL || $forceSOL ) )
	) {
		// 'sep' is the separator before 'nodeB' and it has leading spaces on a newline.
		// We have to decide whether that leading space will trigger indent-pres in wikitext.
		// The decision depends on where this separator will be emitted relative
		// to 'nodeA' and 'nodeB'.

		$isIndentPreSafe = false;

		// Example sepType scenarios:
		//
		// 1. sibling
		// <div>foo</div>
		// <span>bar</span>
		// The span will be wrapped in an indent-pre if the leading space
		// is not stripped since span is not a block tag
		//
		// 2. child-parent
		// <span>foo
		// </span>bar
		// The " </span>bar" will be wrapped in an indent-pre if the
		// leading space is not stripped since span is not a block tag
		//
		// 3. parent-child
		// <div>foo
		// <span>bar</span>
		// </div>
		//
		// In all cases, only block-tags prevent indent-pres.
		// (except for a special case for <br> nodes)
		if ( $nodeB && WTSUtils::precedingSpaceSuppressesIndentPre( $nodeB, $origNodeB ) ) {
			$isIndentPreSafe = true;
		} elseif ( $sepType === 'sibling' || $nodeA && DOMUtils::atTheTop( $nodeA ) ) {
			Assert::invariant( !DOMUtils::atTheTop( $nodeA ) || $sepType === 'parent-child' );

			// 'nodeB' is the first non-separator child of 'nodeA'.
			//
			// Walk past sol-transparent nodes in the right-sibling chain
			// of 'nodeB' till we establish indent-pre safety.
			while ( $nodeB && ( DOMUtils::isDiffMarker( $nodeB )
|| WTUtils::emitsSolTransparentSingleLineWT( $nodeB ) )
			) {
				$nodeB = $nodeB->nextSibling;
			}

			$isIndentPreSafe = !$nodeB || WTSUtils::precedingSpaceSuppressesIndentPre( $nodeB, $origNodeB );
		}

		// Check whether nodeB is nested inside an element that suppresses
		// indent-pres.
		//
		// 1. Walk up past zero-wikitext width nodes in the ancestor chain
		// of 'nodeB' till we establish indent-pre safety.
		// If nodeB uses HTML syntax, obviously it is not zero width!
		//
		// 2. Check if the ancestor is a weak/strong indent-pre suppressing tag.
		// - Weak indent-pre suppressing tags only suppress indent-pres
		// within immediate children.
		// - Strong indent-pre suppressing tags suppress indent-pres
		// in entire DOM subtree rooted at that node.

		if ( $nodeB && !DOMUtils::atTheTop( $nodeB ) ) {
			$parentB = $nodeB->parentNode; // could be nodeA
			while ( WTUtils::isZeroWidthWikitextElt( $parentB ) ) {
				$parentB = $parentB->parentNode;
			}

			if ( Consts\WeakIndentPreSuppressingTags::has( $parentB->nodeName ) ) {
				$isIndentPreSafe = true;
			} else {
				while ( !DOMUtils::atTheTop( $parentB ) ) {
					if ( Consts\StrongIndentPreSuppressingTags::has( $parentB->nodeName ) ) {
						$isIndentPreSafe = true;
					}
					$parentB = $parentB->parentNode;
				}
			}
		}

		$stripLeadingSpace = ( $constraintInfo->onSOL || $forceSOL ) && $nodeB && Consts\SolSpaceSensitiveTags::has( $nodeB->nodeName );
		if ( !$isIndentPreSafe || $stripLeadingSpace ) {
			// Wrap non-nl ws from last line, but preserve comments.
			// This avoids triggering indent-pres.
			$sep = str_replace( $WS_COMMENTS_SEP_REPLACE_REGEXP, function () {
					$rest = $arguments[ 2 ] || '';
					if ( $stripLeadingSpace ) {
						// No other option but to strip the leading space
						return $rest;
					} else {
						// Since we nowiki-ed, we are no longer in sol state
						$state->onSOL = false;
						$state->hasIndentPreNowikis = true;
						return '<nowiki>' . $arguments[ 1 ] . '</nowiki>' . $rest;
					}
			}, $sep );
		}
	}

	$state->env->log( 'debug/wts/sep', 'ipre-safe  |', function () use ( &$Util, &$nlConstraints ) {
			$constraints = Util::clone( $nlConstraints );
			$constraints->constraintInfo = null;
			return json_encode( $sep ) . ', ' . json_encode( $constraints );
	}
	);

	return $sep;
}

// Serializing auto inserted content should invalidate the original separator
$handleAutoInserted = function ( $node ) use ( &$DOMDataUtils, &$Util ) {
	$dp = DOMDataUtils::getDataParsoid( $node );
	$dsr = Util::clone( $dp->dsr );
	if ( $dp->autoInsertedStart ) { $dsr[ 2 ] = null;
 }
	if ( $dp->autoInsertedEnd ) { $dsr[ 3 ] = null;
 }
	return $dsr;
};

/**
 * Emit a separator based on the collected (and merged) constraints
 * and existing separator text. Called when new output is triggered.
 * @param {Node} node
 * @return {string}
 */
$buildSep = function ( $node ) use ( &$WTSUtils, &$DOMUtils, &$DOMDataUtils, &$handleAutoInserted, &$DiffUtils, &$WTUtils, &$Util ) {
	$state = $this->state;
	$origNode = $node;
	$prevNode = $state->sep->lastSourceNode;
	$sep = null;
$dsrA = null;
$dsrB = null;

	/* ----------------------------------------------------------------------
	 * Assuming we have access to the original source, we can use it only if:
	 * - If we are in selser mode AND
	 *   . this node is not part of a subtree that has been marked 'modified'
	 *     (massively edited, either in actuality or because DOMDiff is not smart enough).
	 *   . neither node is adjacent to a deleted block node
	 *     (see the extensive comment in SSP.emitChunk in wts.SerializerState.js)
	 *
	 * In other scenarios, DSR values on "adjacent" nodes in the edited DOM
	 * may not reflect deleted content between them.
	 * ---------------------------------------------------------------------- */
	$again = ( $node === $prevNode );
	$origSepUsable = !$again
&& $state->selserMode && !$state->inModifiedContent
&& !WTSUtils::nextToDeletedBlockNodeInWT( $prevNode, true )
&& !WTSUtils::nextToDeletedBlockNodeInWT( $node, false )
&& WTSUtils::origSrcValidInEditedContext( $state->env, $prevNode )
&& WTSUtils::origSrcValidInEditedContext( $state->env, $node );

	if ( $origSepUsable ) {
		if ( !DOMUtils::isElt( $prevNode ) ) {
			// Check if this is the last child of a zero-width element, and use
			// that for dsr purposes instead. Typical case: text in p.
			if ( !$prevNode->nextSibling
&& $prevNode->parentNode
&& $prevNode->parentNode !== $node
&& DOMDataUtils::getDataParsoid( $prevNode->parentNode )->dsr
&& DOMDataUtils::getDataParsoid( $prevNode->parentNode )->dsr[ 3 ] === 0
			) {
				$dsrA = $handleAutoInserted( $prevNode->parentNode );
			} elseif ( $prevNode->previousSibling
&& $prevNode->previousSibling->nodeType === $prevNode::ELEMENT_NODE
&& // FIXME: Not sure why we need this check because data-parsoid
					// is loaded on all nodes. mw:Diffmarker maybe? But, if so, why?
					// Should be fixed.
					DOMDataUtils::getDataParsoid( $prevNode->previousSibling )->dsr
&& // Don't extrapolate if the string was potentially changed
					!DiffUtils::directChildrenChanged( $node->parentNode, $this->env )
			) {
				$endDsr = DOMDataUtils::getDataParsoid( $prevNode->previousSibling )->dsr[ 1 ];
				$correction = null;
				if ( gettype( $endDsr ) === 'number' ) {
					if ( DOMUtils::isComment( $prevNode ) ) {
						$correction = WTUtils::decodedCommentLength( $prevNode );
					} else {
						$correction = count( $prevNode->nodeValue );
					}
					$dsrA = [ $endDsr, $endDsr + $correction + WTUtils::indentPreDSRCorrection( $prevNode ), 0, 0 ];
				}
			}
		} else {
			$dsrA = $handleAutoInserted( $prevNode );
		}

		if ( !$dsrA ) {

			// nothing to do -- no reason to compute dsrB if dsrA is null
		} elseif ( !DOMUtils::isElt( $node ) ) {
			// If this is the child of a zero-width element
			// and is only preceded by separator elements, we
			// can use the parent for dsr after correcting the dsr
			// with the separator run length.
			//
			// 1. text in p.
			// 2. ws-only child of a node with auto-inserted start tag
			// Ex: "<span> <s>x</span> </s>" --> <span> <s>x</s*></span><s*> </s>
			// 3. ws-only children of a node with auto-inserted start tag
			// Ex: "{|\n|-\n <!--foo--> \n|}"

			$npDP = DOMDataUtils::getDataParsoid( $node->parentNode );
			if ( $node->parentNode !== $prevNode && $npDP->dsr && $npDP->dsr[ 2 ] === 0 ) {
				$sepTxt = precedingSeparatorTxt( $node );
				if ( $sepTxt !== null ) {
					$dsrB = $npDP->dsr;
					if ( gettype( $dsrB[ 0 ] ) === 'number' && count( $sepTxt ) > 0 ) {
						$dsrB = Util::clone( $dsrB );
						$dsrB[ 0 ] += count( $sepTxt );
					}
				}
			}
		} else {
			if ( $prevNode->parentNode === $node ) {
				// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
				//
				// When we are in the lastChild sep scenario and the parent doesn't have
				// useable dsr, if possible, walk up the ancestor nodes till we find
				// a dsr-bearing node
				//
				// This fix is needed to handle trailing newlines in this wikitext:
				// [[File:foo.jpg|thumb|300px|foo\n{{echo|A}}\n{{echo|B}}\n{{echo|C}}\n\n]]
				while ( !$node->nextSibling && !DOMUtils::atTheTop( $node )
&& ( !DOMDataUtils::getDataParsoid( $node )->dsr
|| DOMDataUtils::getDataParsoid( $node )->dsr[ 0 ] === null
|| DOMDataUtils::getDataParsoid( $node )->dsr[ 1 ] === null )
				) {
					$node = $node->parentNode;
				}
			}

			// The top node could be a document fragment, which is not
			// an element, and so getDataParsoid will return `null`.
			$dsrB = ( DOMUtils::isElt( $node ) ) ? $handleAutoInserted( $node ) : null;
		}

		// FIXME: Maybe we shouldn't set dsr in the dsr pass if both aren't valid?
		if ( Util::isValidDSR( $dsrA ) && Util::isValidDSR( $dsrB ) ) {
			// Figure out containment relationship
			if ( $dsrA[ 0 ] <= $dsrB[ 0 ] ) {
				if ( $dsrB[ 1 ] <= $dsrA[ 1 ] ) {
					if ( $dsrA[ 0 ] === $dsrB[ 0 ] && $dsrA[ 1 ] === $dsrB[ 1 ] ) {
						// Both have the same dsr range, so there can't be any
						// separators between them
						$sep = '';
					} elseif ( $dsrA[ 2 ] !== null ) {
						// B in A, from parent to child
						$sep = $state->getOrigSrc( $dsrA[ 0 ] + $dsrA[ 2 ], $dsrB[ 0 ] );
					}
				} elseif ( $dsrA[ 1 ] <= $dsrB[ 0 ] ) {
					// B following A (siblingish)
					$sep = $state->getOrigSrc( $dsrA[ 1 ], $dsrB[ 0 ] );
				} elseif ( $dsrB[ 3 ] !== null ) {
					// A in B, from child to parent
					$sep = $state->getOrigSrc( $dsrA[ 1 ], $dsrB[ 1 ] - $dsrB[ 3 ] );
				}
			} elseif ( $dsrA[ 1 ] <= $dsrB[ 1 ] ) {
				if ( $dsrB[ 3 ] !== null ) {
					// A in B, from child to parent
					$sep = $state->getOrigSrc( $dsrA[ 1 ], $dsrB[ 1 ] - $dsrB[ 3 ] );
				}
			} else {
				$this->env->log( 'info/html2wt', 'dsr backwards: should not happen!' );
			}
		}
	}

	$this->env->log( 'debug/wts/sep', function () use ( &$prevNode, &$origNode ) {
			return 'maybe-sep  | '
. 'prev:' . ( ( $prevNode ) ? $prevNode->nodeName : '--none--' )
. ', node:' . ( ( $origNode ) ? $origNode->nodeName : '--none--' )
. ', sep: ' . json_encode( $sep ) . ', state.sep.src: ' . json_encode( $state->sep->src );
	}
	);

	// 1. Verify that the separator is really one (has to be whitespace and comments)
	// 2. If the separator is being emitted before a node that emits sol-transparent WT,
	// go through makeSeparator to verify indent-pre constraints are met.
	$sepConstraints = $state->sep->constraints || [ 'a' => [], 'b' => [], 'max' => 0 ];
	if ( $sep === null
|| !WTSUtils::isValidSep( $sep )
|| ( $state->sep->src && $state->sep->src !== $sep )
	) {
		if ( $state->sep->constraints || $state->sep->src ) {
			// TODO: set modified flag if start or end node (but not both) are
			// modified / new so that the selser can use the separator
			$sep = makeSeparator( $state, $state->sep->src || '', $sepConstraints );
		} else {
			$sep = null;
		}
	}

	if ( $sep !== null ) {
		$sep = makeSepIndentPreSafe( $state, $sep, $sepConstraints );
	}
	return $sep;
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->updateSeparatorConstraints = $updateSeparatorConstraints;
	$module->exports->buildSep = $buildSep;
}
