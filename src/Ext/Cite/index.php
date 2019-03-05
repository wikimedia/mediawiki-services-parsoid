<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * This module implements `<ref>` and `<references>` extension tag handling
 * natively in Parsoid.
 * @module ext/Cite
 */

namespace Parsoid;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 =

$ParsoidExtApi;
$ContentUtils = $temp0::ContentUtils; $DOMDataUtils = $temp0::
DOMDataUtils; $DOMUtils = $temp0::
DOMUtils; $TokenUtils = $temp0::
TokenUtils; $WTUtils = $temp0::
WTUtils; $Promise = $temp0::
Promise; $Sanitizer = $temp0::
Sanitizer;

/**
 * Simple token transform version of the Ref extension tag.
 *
 * @class
 */
function Ref( $cite ) {
	$this->cite = $cite;
}

function hasRef( $node ) {
	global $DOMUtils;
	global $WTUtils;
	$c = $node->firstChild;
	while ( $c ) {
		if ( DOMUtils::isElt( $c ) ) {
			if ( WTUtils::isSealedFragmentOfType( $c, 'ref' ) ) {
				return true;
			}
			if ( hasRef( $c ) ) {
				return true;
			}
		}
		$c = $c->nextSibling;
	}
	return false;
}

Ref::prototype::toDOM = function ( $state, $content, $args ) use ( &$ParsoidExtApi ) {
	// Drop nested refs entirely, unless we've explicitly allowed them
	if ( $state->parseContext->extTag === 'ref'
&& !( $state->parseContext->extTagOpts && $state->parseContext->extTagOpts->allowNestedRef )
	) {
		return null;
	}

	// The one supported case for nested refs is from the {{#tag:ref}} parser
	// function.  However, we're overly permissive here since we can't
	// distinguish when that's nested in another template.
	// The php preprocessor did our expansion.
	$allowNestedRef = $state->parseContext->inTemplate && $state->parseContext->extTag !== 'ref';

	return ParsoidExtApi::parseTokenContentsToDOM( $state, $args, '', $content, [
			// NOTE: sup's content model requires it only contain phrasing
			// content, not flow content. However, since we are building an
			// in-memory DOM which is simply a tree data structure, we can
			// nest flow content in a <sup> tag.
			'wrapperTag' => 'sup',
			'inTemplate' => $state->parseContext->inTemplate,
			'extTag' => 'ref',
			'extTagOpts' => [
				'allowNestedRef' => (bool)$allowNestedRef
			],
			// FIXME: One-off PHP parser state leak.
			// This needs a better solution.
			'inPHPBlock' => true
		]
	);
};

Ref::prototype::serialHandler = [
	'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils, &$ContentUtils ) {
		$startTagSrc = /* await */ $state->serializer->serializeExtensionStartTag( $node, $state );
		$dataMw = DOMDataUtils::getDataMw( $node );
		$env = $state->env;
		$html = null;
		if ( !$dataMw->body ) {
			return $startTagSrc; // We self-closed this already.
		} else { // We self-closed this already.
		if ( gettype( $dataMw->body->html ) === 'string' ) {
			// First look for the extension's content in data-mw.body.html
			$html = $dataMw->body->html;
		} elseif ( gettype( $dataMw->body->id ) === 'string' ) {
			// If the body isn't contained in data-mw.body.html, look if
			// there's an element pointed to by body.id.
			$bodyElt = $node->ownerDocument->getElementById( $dataMw->body->id );
			if ( !$bodyElt && $env->page->editedDoc ) {
				// Try to get to it from the main page.
				// This can happen when the <ref> is inside another
				// extension, most commonly inside a <references>.
				// The recursive call to serializeDOM puts us inside
				// inside a new document.
				$bodyElt = $env->page->editedDoc->getElementById( $dataMw->body->id );
			}
			if ( $bodyElt ) {
				// n.b. this is going to drop any diff markers but since
				// the dom differ doesn't traverse into extension content
				// none should exist anyways.
				DOMDataUtils::visitAndStoreDataAttribs( $bodyElt );
				$html = ContentUtils::toXML( $bodyElt, [ 'innerXML' => true ] );
				DOMDataUtils::visitAndLoadDataAttribs( $bodyElt );
			} else {
				// Some extra debugging for VisualEditor
				$extraDebug = '';
				$firstA = $node->querySelector( 'a[href]' );
				if ( $firstA && preg_match( '/^#/', $firstA->getAttribute( 'href' ) ) ) {
					$href = $firstA->getAttribute( 'href' );
					try {
						$ref = $node->ownerDocument->querySelector( $href );
						if ( $ref ) {
							$extraDebug += ' [own doc: ' . $ref->outerHTML . ']';
						}
						$ref = $env->page->editedDoc->querySelector( $href );
						if ( $ref ) {
							$extraDebug += ' [main doc: ' . $ref->outerHTML . ']';
						}
					} catch ( Exception $e ) {
		   }// eslint-disable-line
					// eslint-disable-line
					if ( !$extraDebug ) {
						$extraDebug = ' [reference ' . $href . ' not found]';
					}
				}
				$env->log( 'error/' . $dataMw->name,
					'extension src id ' . $dataMw->body->id
. ' points to non-existent element for:', $node->outerHTML,
					'. More debug info: ', $extraDebug
				);
				return ''; // Drop it!
			}
		} else { // Drop it!

			$env->log( 'error', 'Ref body unavailable for: ' . $node->outerHTML );
			return ''; // Drop it!
		}// Drop it!
		}

		$src = /* await */ $state->serializer->serializeHTML( [
				'env' => $state->env,
				'extName' => $dataMw->name,
				// FIXME: One-off PHP parser state leak.
				// This needs a better solution.
				'inPHPBlock' => true
			], $html
		);
		return $startTagSrc + $src . '</' . $dataMw->name . '>';
	}

];

Ref::prototype::lintHandler = function ( $ref, $env, $tplInfo, $domLinter ) use ( &$WTUtils ) {
	// Don't lint the content of ref in ref, since it can lead to cycles
	// using named refs
	if ( WTUtils::fromExtensionContent( $ref, 'references' ) ) { return $ref->nextNode;
 }

	$linkBackId = preg_replace( '/[^#]*#/', '', $ref->firstChild->getAttribute( 'href' ), 1 );
	$refNode = $ref->ownerDocument->getElementById( $linkBackId );
	if ( $refNode ) {
		// Ex: Buggy input wikitext without ref content
		$domLinter( $refNode->lastChild, $env, ( $tplInfo->isTemplated ) ? $tplInfo : null );
	}
	return $ref->nextNode;
};

/**
 * Helper class used by `<references>` implementation.
 * @class
 */
function RefGroup( $group ) {
	$this->name = $group || '';
	$this->refs = [];
	$this->indexByName = new Map();
}

function makeValidIdAttr( $val ) {
	global $Sanitizer;
	// Looks like Cite.php doesn't try to fix ids that already have
	// a "_" in them. Ex: name="a b" and name="a_b" are considered
	// identical. Not sure if this is a feature or a bug.
	// It also considers entities equal to their encoding
	// (i.e. '&' === '&amp;'), which is done:
	// in PHP: Sanitizer#decodeTagAttributes and
	// in Parsoid: ExtensionHandler#normalizeExtOptions
	return Sanitizer::escapeIdForAttribute( $val );
}

RefGroup::prototype::renderLine = function ( $env, $refsList, $ref ) use ( &$DOMDataUtils, &$DOMUtils ) {
	$ownerDoc = $refsList->ownerDocument;

	// Generate the li and set ref content first, so the HTML gets parsed.
	// We then append the rest of the ref nodes before the first node
	$li = $ownerDoc->createElement( 'li' );
	DOMDataUtils::addAttributes( $li, [
			'about' => '#' . $ref->target,
			'id' => $ref->target,
			'class' => ( [ 'rtl', 'ltr' ]->includes( $ref->dir ) ) ? 'mw-cite-dir-' . $ref->dir : null
		]
	);
	$reftextSpan = $ownerDoc->createElement( 'span' );
	DOMDataUtils::addAttributes( $reftextSpan, [
			'id' => 'mw-reference-text-' . $ref->target,
			'class' => 'mw-reference-text'
		]
	);
	if ( $ref->content ) {
		$content = $env->fragmentMap->get( $ref->content )[ 0 ];
		DOMUtils::migrateChildrenBetweenDocs( $content, $reftextSpan );
		DOMDataUtils::visitAndLoadDataAttribs( $reftextSpan );
	}
	$li->appendChild( $reftextSpan );

	// Generate leading linkbacks
	$createLinkback = function ( $href, $group, $text ) use ( &$ownerDoc, &$env ) {
		$a = $ownerDoc->createElement( 'a' );
		$s = $ownerDoc->createElement( 'span' );
		$textNode = $ownerDoc->createTextNode( $text . ' ' );
		$a->setAttribute( 'href', $env->page->titleURI . '#' . $href );
		$s->setAttribute( 'class', 'mw-linkback-text' );
		if ( $group ) {
			$a->setAttribute( 'data-mw-group', $group );
		}
		$s->appendChild( $textNode );
		$a->appendChild( $s );
		return $a;
	};
	if ( count( $ref->linkbacks ) === 1 ) {
		$linkback = $createLinkback( $ref->id, $ref->group, "↑" );
		$linkback->setAttribute( 'rel', 'mw:referencedBy' );
		$li->insertBefore( $linkback, $reftextSpan );
	} else {
		// 'mw:referencedBy' span wrapper
		$span = $ownerDoc->createElement( 'span' );
		$span->setAttribute( 'rel', 'mw:referencedBy' );
		$li->insertBefore( $span, $reftextSpan );

		$ref->linkbacks->forEach( function ( $lb, $i ) use ( &$span, &$createLinkback, &$ref ) {
				$span->appendChild( $createLinkback( $lb, $ref->group, $i + 1 ) );
		}
		);
	}

	// Space before content node
	$li->insertBefore( $ownerDoc->createTextNode( ' ' ), $reftextSpan );

	// Add it to the ref list
	$refsList->appendChild( $li );
};

/**
 * @class
 */
function ReferencesData( $env ) {
	$this->index = 0;
	$this->env = $env;
	$this->refGroups = new Map();
}

ReferencesData::prototype::getRefGroup = function ( $groupName, $allocIfMissing ) {
	$groupName = $groupName || '';
	if ( !$this->refGroups->has( $groupName ) && $allocIfMissing ) {
		$this->refGroups->set( $groupName, new RefGroup( $groupName ) );
	}
	return $this->refGroups->get( $groupName );
};

ReferencesData::prototype::removeRefGroup = function ( $groupName ) {
	if ( $groupName !== null && $groupName !== null ) {
		// '' is a valid group (the default group)
		$this->refGroups->delete( $groupName );
	}
};

ReferencesData::prototype::add = function ( $env, $groupName, $refName, $about, $skipLinkback ) use ( &$ContentUtils ) {
	$group = $this->getRefGroup( $groupName, true );
	$refName = makeValidIdAttr( $refName );

	$ref = null;
	if ( $refName && $group->indexByName->has( $refName ) ) {
		$ref = $group->indexByName->get( $refName );
		if ( $ref->content && !$ref->hasMultiples ) {
			$ref->hasMultiples = true;
			// Use the non-pp version here since we've already stored attribs
			// before putting them in the map.
			$ref->cachedHtml = ContentUtils::toXML( $env->fragmentMap->get( $ref->content )[ 0 ], [ 'innerXML' => true ] );
		}
	} else {
		// The ids produced Cite.php have some particulars:
		// Simple refs get 'cite_ref-' + index
		// Refs with names get 'cite_ref-' + name + '_' + index + (backlink num || 0)
		// Notes (references) whose ref doesn't have a name are 'cite_note-' + index
		// Notes whose ref has a name are 'cite_note-' + name + '-' + index
		$n = $this->index;
		$refKey = ( 1 + $n ) . '';
		$refIdBase = 'cite_ref-' . ( ( $refName ) ? $refName . '_' . $refKey : $refKey );
		$noteId = 'cite_note-' . ( ( $refName ) ? $refName . '-' . $refKey : $refKey );

		// bump index
		$this->index += 1;

		$ref = [
			'about' => $about,
			'content' => null,
			'dir' => '',
			'group' => $group->name,
			'groupIndex' => count( $group->refs ) + 1,
			'index' => $n,
			'key' => $refIdBase,
			'id' => ( ( $refName ) ? $refIdBase . '-0' : $refIdBase ),
			'linkbacks' => [],
			'name' => $refName,
			'target' => $noteId,
			'hasMultiples' => false,
			// Just used for comparison when we have multiples
			'cachedHtml' => ''
		];
		$group->refs[] = $ref;
		if ( $refName ) {
			$group->indexByName->set( $refName, $ref );
		}
	}

	if ( !$skipLinkback ) {
		$ref->linkbacks[] = $ref->key . '-' . count( $ref->linkbacks );
	}
	return $ref;
};

/**
 * @class
 */
function References( $cite ) {
	$this->cite = $cite;
}

$createReferences = function ( $env, $doc, $body, $refsOpts, $modifyDp, $autoGenerated ) use ( &$DOMUtils, &$DOMDataUtils ) {
	$ol = $doc->createElement( 'ol' );
	$ol->classList->add( 'mw-references' );
	$ol->classList->add( 'references' );

	if ( $body ) {
		DOMUtils::migrateChildren( $body, $ol );
	}

	// Support the `responsive` parameter
	$rrOpts = $env->conf->wiki->responsiveReferences;
	$responsiveWrap = $rrOpts->enabled;
	if ( $refsOpts->responsive !== null ) {
		$responsiveWrap = $refsOpts->responsive !== '0';
	}

	$frag = null;
	if ( $responsiveWrap ) {
		$div = $doc->createElement( 'div' );
		$div->classList->add( 'mw-references-wrap' );
		$div->appendChild( $ol );
		$frag = $div;
	} else {
		$frag = $ol;
	}

	if ( $autoGenerated ) {
		DOMDataUtils::addAttributes( $frag, [
				'typeof' => 'mw:Extension/references',
				'about' => $env->newAboutId()
			]
		);
	}

	$dp = DOMDataUtils::getDataParsoid( $frag );
	if ( $refsOpts->group ) { // No group for the empty string either
		$dp->group = $refsOpts->group;
		$ol->setAttribute( 'data-mw-group', $refsOpts->group );
	}
	if ( gettype( $modifyDp ) === 'function' ) {
		$modifyDp( $dp );
	}

	return $frag;
};

References::prototype::toDOM = function ( $state, $content, $args ) use ( &$ParsoidExtApi, &$TokenUtils, &$createReferences ) {
	return ParsoidExtApi::parseTokenContentsToDOM( $state, $args, '', $content, [
			'wrapperTag' => 'div',
			'extTag' => 'references',
			'inTemplate' => $state->parseContext->inTemplate
		]
	)->then( function ( $doc ) use ( &$TokenUtils, &$args, &$createReferences, &$state ) {
			$refsOpts = Object::assign( [
					'group' => null,
					'responsive' => null
				], TokenUtils::kvToHash( $args, true )
			);

			$frag = $createReferences( $state->env, $doc, $doc->body, $refsOpts, function ( $dp ) use ( &$state ) {
					$dp->src = $state->extToken->getAttribute( 'source' );
					// Redundant - also present on doc.body.firstChild, but feels cumbersome to use
					$dp->selfClose = $state->extToken->dataAttribs->selfClose;
			}
			);
			$doc->body->appendChild( $frag );

			return $doc;
	}
	);
};

$_processRefs = null;

References::prototype::extractRefFromNode = function ( $node, $refsData, $cite,
	$referencesAboutId, $referencesGroup, $nestedRefsHTML
) use ( &$DOMDataUtils, &$_processRefs, &$ContentUtils ) {
	$env = $refsData->env;
	$doc = $node->ownerDocument;
	$nestedInReferences = $referencesAboutId !== null;

	// This is data-parsoid from the dom fragment node that's gone through
	// dsr computation and template wrapping.
	$nodeDp = DOMDataUtils::getDataParsoid( $node );
	$typeOf = $node->getAttribute( 'typeof' );
	$isTplWrapper = preg_match( '/\bmw:Transclusion\b/', $typeOf );
	$nodeType = preg_replace( '/mw:DOMFragment\/sealed\/ref/', '', ( $typeOf || '' ), 1 );
	$content = $nodeDp->html;
	$tplDmw = ( $isTplWrapper ) ? DOMDataUtils::getDataMw( $node ) : null;

	// This is the <sup> that's the meat of the sealed fragment
	$c = $env->fragmentMap->get( $content )[ 0 ];
	// All the actions that require loaded data-attributes on `c` are done
	// here so that we can quickly store those away for later.
	DOMDataUtils::visitAndLoadDataAttribs( $c );
	$cDp = DOMDataUtils::getDataParsoid( $c );
	$refDmw = DOMDataUtils::getDataMw( $c );
	if ( !$cDp->empty && hasRef( $c ) ) { // nested ref-in-ref
		$_processRefs( $env, $cite, $refsData, $c );
	}
	DOMDataUtils::visitAndStoreDataAttribs( $c );

	// Use the about attribute on the wrapper with priority, since it's
	// only added when the wrapper is a template sibling.
	$about = $node->getAttribute( 'about' ) || $c->getAttribute( 'about' );

	// FIXME(SSS): Need to clarify semantics here.
	// If both the containing <references> elt as well as the nested <ref>
	// elt has a group attribute, what takes precedence?
	$group = $refDmw->attrs->group || $referencesGroup || '';
	$refName = $refDmw->attrs->name || '';
	$ref = $refsData->add( $env, $group, $refName, $about, $nestedInReferences );

	// Add ref-index linkback
	$linkBack = $doc->createElement( 'sup' );

	// FIXME: Lot of useless work for an edge case
	if ( $cDp->empty ) {
		// Discard wrapper if there was no input wikitext
		$content = null;
		if ( $cDp->selfClose ) {
			$refDmw->body = null;
		} else {
			$refDmw->body = [ 'html' => '' ];
		}
	} else {
		// If there are multiple <ref>s with the same name, but different content,
		// the content of the first <ref> shows up in the <references> section.
		// in order to ensure lossless RT-ing for later <refs>, we have to record
		// HTML inline for all of them.
		$html = '';
		$contentDiffers = false;
		if ( $ref->hasMultiples ) {
			// Use the non-pp version here since we've already stored attribs
			// before putting them in the map.
			$html = ContentUtils::toXML( $c, [ 'innerXML' => true ] );
			$contentDiffers = $html !== $ref->cachedHtml;
		}
		if ( $contentDiffers ) {
			$refDmw->body = [ 'html' => $html ];
		} else {
			$refDmw->body = [ 'id' => 'mw-reference-text-' . $ref->target ];
		}
	}

	DOMDataUtils::addAttributes( $linkBack, [
			'about' => $about,
			'class' => 'mw-ref',
			'id' => ( $nestedInReferences ) ? null :
			( ( $ref->name ) ? $ref->linkbacks[ count( $ref->linkbacks ) - 1 ] : $ref->id ),
			'rel' => 'dc:references',
			'typeof' => $nodeType
		]
	);
	DOMDataUtils::addTypeOf( $linkBack, 'mw:Extension/ref' );
	$dataParsoid = [
		'src' => $nodeDp->src,
		'dsr' => $nodeDp->dsr,
		'pi' => $nodeDp->pi
	];
	DOMDataUtils::setDataParsoid( $linkBack, $dataParsoid );
	if ( $isTplWrapper ) {
		DOMDataUtils::setDataMw( $linkBack, $tplDmw );
	} else {
		DOMDataUtils::setDataMw( $linkBack, $refDmw );
	}

	// refLink is the link to the citation
	$refLink = $doc->createElement( 'a' );
	DOMDataUtils::addAttributes( $refLink, [
			'href' => $env->page->titleURI . '#' . $ref->target,
			'style' => 'counter-reset: mw-Ref ' . $ref->groupIndex . ';'
		]
	);
	if ( $ref->group ) {
		$refLink->setAttribute( 'data-mw-group', $ref->group );
	}

	// refLink-span which will contain a default rendering of the cite link
	// for browsers that don't support counters
	$refLinkSpan = $doc->createElement( 'span' );
	$refLinkSpan->setAttribute( 'class', 'mw-reflink-text' );
	$refLinkSpan->appendChild( $doc->createTextNode( '['
. ( ( $ref->group ) ? $ref->group . ' ' : '' ) . $ref->groupIndex . ']'
		)
	);
	$refLink->appendChild( $refLinkSpan );
	$linkBack->appendChild( $refLink );

	if ( !$nestedInReferences ) {
		$node->parentNode->replaceChild( $linkBack, $node );
	} else {
		// We don't need to delete the node now since it'll be removed in
		// `insertReferencesIntoDOM` when all the children all cleaned out.
		array_push( $nestedRefsHTML, ContentUtils::ppToXML( $linkBack ), "\n" );
	}

	// Keep the first content to compare multiple <ref>s with the same name.
	if ( !$ref->content ) {
		$ref->content = $content;
		$ref->dir = strtolower( $refDmw->attrs->dir || '' );
	}
};

References::prototype::insertReferencesIntoDOM = function ( $refsNode, $refsData, $nestedRefsHTML, $autoGenerated ) use ( &$DOMDataUtils ) {
	$env = $refsData->env;
	$isTplWrapper = preg_match( '/\bmw:Transclusion\b/', $refsNode->getAttribute( 'typeof' ) );
	$dp = DOMDataUtils::getDataParsoid( $refsNode );
	$group = $dp->group || '';
	if ( !$isTplWrapper ) {
		$dataMw = DOMDataUtils::getDataMw( $refsNode );
		if ( !count( Object::keys( $dataMw ) ) ) {
			// FIXME: This can be moved to `insertMissingReferencesIntoDOM`
			Assert::invariant( $autoGenerated );
			$dataMw = [
				'name' => 'references',
				'attrs' => [
					'group' => $group || null
				]
			]; // Dont emit empty keys

			DOMDataUtils::setDataMw( $refsNode, $dataMw );
		}

		// Mark this auto-generated so that we can skip this during
		// html -> wt and so that clients can strip it if necessary.
		if ( $autoGenerated ) {
			$dataMw->autoGenerated = true;
		} elseif ( count( $nestedRefsHTML ) > 0 ) {
			$dataMw->body = [ 'html' => "\n" . implode( '', $nestedRefsHTML ) ];
		} elseif ( !$dp->selfClose ) {
			$dataMw->body = [ 'html' => '' ];
		} else {
			$dataMw->body = null;
		}
		$dp->selfClose = null;
	}

	$refGroup = $refsData->getRefGroup( $group );

	// Deal with responsive wrapper
	if ( $refsNode->classList->contains( 'mw-references-wrap' ) ) {
		$rrOpts = $env->conf->wiki->responsiveReferences;
		if ( $refGroup && count( $refGroup->refs ) > $rrOpts->threshold ) {
			$refsNode->classList->add( 'mw-references-columns' );
		}
		$refsNode = $refsNode->firstChild;
	}

	// Remove all children from the references node
	//
	// Ex: When {{Reflist}} is reused from the cache, it comes with
	// a bunch of references as well. We have to remove all those cached
	// references before generating fresh references.
	while ( $refsNode->firstChild ) {
		$refsNode->removeChild( $refsNode->firstChild );
	}

	if ( $refGroup ) {
		$refGroup->refs->forEach( function ( $ref ) use ( &$refGroup, &$env, &$refsNode ) {return $refGroup->renderLine( $env, $refsNode, $ref );
  } );
	}

	// Remove the group from refsData
	$refsData->removeRefGroup( $group );
};

/**
 * Process `<ref>`s left behind after the DOM is fully processed.
 * We process them as if there was an implicit `<references />` tag at
 * the end of the DOM.
 */
References::prototype::insertMissingReferencesIntoDOM = function ( $refsData, $node ) use ( &$createReferences ) {
	$env = $refsData->env;
	$doc = $node->ownerDocument;

	$refsData->refGroups->forEach( function ( $refsValue, $refsGroup ) use ( &$createReferences, &$env, &$doc, &$node, &$refsData ) {
			$frag = $createReferences( $env, $doc, null, [
					'group' => $refsGroup,
					'responsive' => null
				], function ( $dp ) {
					// The new references come out of "nowhere", so to make selser work
					// propertly, add a zero-sized DSR pointing to the end of the document.
					$dp->dsr = [ count( $env->page->src ), count( $env->page->src ), 0, 0 ];
				}, true
			);

			// Add a \n before the <ol> so that when serialized to wikitext,
			// each <references /> tag appears on its own line.
			$node->appendChild( $doc->createTextNode( "\n" ) );
			$node->appendChild( $frag );

			$this->insertReferencesIntoDOM( $frag, $refsData, [ '' ], true );
	}
	);
};

References::prototype::serialHandler = [
	'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils ) {
		$dataMw = DOMDataUtils::getDataMw( $node );
		if ( $dataMw->autoGenerated && $state->rtTestMode ) {
			// Eliminate auto-inserted <references /> noise in rt-testing
			return '';
		} else {
			$startTagSrc = /* await */ $state->serializer->serializeExtensionStartTag( $node, $state );
			if ( !$dataMw->body ) {
				return $startTagSrc; // We self-closed this already.
			} else { // We self-closed this already.
			if ( gettype( $dataMw->body->html ) === 'string' ) {
				$src = /* await */ $state->serializer->serializeHTML( [
						'env' => $state->env,
						'extName' => $dataMw->name
					], $dataMw->body->html
				);
				return $startTagSrc + $src . '</' . $dataMw->name . '>';
			} else {
				$state->env->log( 'error',
					'References body unavailable for: ' . $node->outerHTML
				);
				return ''; // Drop it!
			}
			}
		}
	}

	, // Drop it!

	// FIXME: LEAKY -- Should we expose newline constraints to extensions?
	'before' => function ( $node, $otherNode, $state ) use ( &$WTUtils ) {
		// Serialize new references tags on a new line.
		if ( WTUtils::isNewElt( $node ) ) {
			return [ 'min' => 1, 'max' => 2 ];
		} else {
			return null;
		}
	}
];

References::prototype::lintHandler = function ( $refs, $env, $tplInfo, $domLinter ) {
	// Nothing to do
	//
	// FIXME: Not entirely true for scenarios where the <ref> tags
	// are defined in the references section that is itself templated.
	//
	// {{1x|<references>\n<ref name='x'><b>foo</ref>\n</references>}}
	//
	// In this example, the references tag has the right tplInfo and
	// when the <ref> tag is processed in the body of the article where
	// it is accessed, there is no relevant template or dsr info available.
	//
	// Ignoring for now.
	return $refs->nextNode;
};

/**
 * This handles wikitext like this:
 * ```
 *   <references> <ref>foo</ref> </references>
 *   <references> <ref>bar</ref> </references>
 * ```
 * @private
 */
$_processRefsInReferences = function ( $cite, $refsData, $node, $referencesId,
	$referencesGroup, $nestedRefsHTML
) use ( &$DOMUtils, &$WTUtils, &$_processRefsInReferences ) {
	$child = $node->firstChild;
	while ( $child !== null ) {
		$nextChild = $child->nextSibling;
		if ( DOMUtils::isElt( $child ) ) {
			if ( WTUtils::isSealedFragmentOfType( $child, 'ref' ) ) {
				$cite->references->extractRefFromNode( $child, $refsData, $cite,
					$referencesId, $referencesGroup, $nestedRefsHTML
				);
			} elseif ( $child->hasChildNodes() ) {
				$_processRefsInReferences( $cite, $refsData,
					$child, $referencesId, $referencesGroup, $nestedRefsHTML
				);
			}
		}
		$child = $nextChild;
	}
};

$_processRefs = function ( $env, $cite, $refsData, $node ) use ( &$DOMUtils, &$WTUtils, &$DOMDataUtils, &$_processRefsInReferences, &$ContentUtils, &$_processRefs ) {
	$child = $node->firstChild;
	while ( $child !== null ) {
		$nextChild = $child->nextSibling;
		if ( DOMUtils::isElt( $child ) ) {
			if ( WTUtils::isSealedFragmentOfType( $child, 'ref' ) ) {
				$cite->references->extractRefFromNode( $child, $refsData, $cite );
			} elseif ( preg_match( ( '/(?:^|\s)mw:Extension\/references(?=$|\s)/' ), $child->getAttribute( 'typeOf' ) ) ) {
				$referencesId = $child->getAttribute( 'about' );
				$referencesGroup = DOMDataUtils::getDataParsoid( $child )->group;
				$nestedRefsHTML = [];
				$_processRefsInReferences( $cite, $refsData,
					$child, $referencesId, $referencesGroup, $nestedRefsHTML
				);
				$cite->references->insertReferencesIntoDOM( $child, $refsData, $nestedRefsHTML );
			} else {
				// inline media -- look inside the data-mw attribute
				if ( WTUtils::isInlineMedia( $child ) ) {
					/* -----------------------------------------------------------------
					 * FIXME(subbu): This works but feels very special-cased in 2 ways:
					 *
					 * 1. special cased to images vs. any node that might have
					 *    serialized HTML embedded in data-mw
					 * 2. special cased to global cite handling -- the general scenario
					 *    is DOM post-processors that do different things on the
					 *    top-level vs not.
					 *    - Cite needs to process these fragments in the context of the
					 *      top-level page, and has to be done in order of how the nodes
					 *      are encountered.
					 *    - DOM cleanup can be done on embedded fragments without
					 *      any page-level context and in any order.
					 *    - So, some variability here.
					 *
					 * We should be running dom.cleanup.js passes on embedded html
					 * in data-mw and other attributes. Since correctness doesn't
					 * depend on that cleanup, I am not adding more special-case
					 * code in dom.cleanup.js.
					 *
					 * Doing this more generically will require creating a DOMProcessor
					 * class and adding state to it.
					 *
					 * See T214994
					 * ----------------------------------------------------------------- */
					$dmw = DOMDataUtils::getDataMw( $child );
					$caption = $dmw->caption;
					if ( $caption ) {
						// Extract the caption HTML, build the DOM, process refs,
						// serialize to HTML, update the caption HTML.
						$captionDOM = ContentUtils::ppToDOM( $env, $caption );
						$_processRefs( $env, $cite, $refsData, $captionDOM );
						$dmw->caption = ContentUtils::ppToXML( $captionDOM, [ 'innerXML' => true ] );
					}
				}
				if ( $child->hasChildNodes() ) {
					$_processRefs( $env, $cite, $refsData, $child );
				}
			}
		}
		$child = $nextChild;
	}
};

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together `<ref>` and `<references>`.
 */
$Cite = function () {
	$this->ref = new Ref( $this );
	$this->references = new References( $this );
	$this->config = [
		'name' => 'cite',
		'domProcessors' => [
			'wt2htmlPostProcessor' => function ( ...$args ) {return $this->_wt2htmlPostProcessor( ...$args );
   },
			'html2wtPreProcessor' => function ( ...$args ) {return $this->_html2wtPreProcessor( ...$args );
   }
		],
		'tags' => [
			[
				'name' => 'ref',
				'toDOM' => function ( ...$args ) {return $this->ref->toDOM( ...$args );
	   },
				'fragmentOptions' => [
					'unwrapFragment' => false
				],
				'serialHandler' => $this->ref->serialHandler, // FIXME: Rename to toWikitext
				'lintHandler' => $this->ref->lintHandler
			]
			, // FIXME: Do we need (a) domDiffHandler (b) ... others ...
			[
				'name' => 'references',
				'toDOM' => function ( ...$args ) {return $this->references->toDOM( ...$args );
	   },
				'serialHandler' => $this->references->serialHandler,
				'lintHandler' => $this->references->lintHandler
			]
		],
		'styles' => [
			'ext.cite.style',
			'ext.cite.styles'
		]
	];
};

/**
 * wt -> html DOM PostProcessor
 */
Cite::prototype::_wt2htmlPostProcessor = function ( $body, $env, $options, $atTopLevel ) use ( &$_processRefs ) {
	if ( $atTopLevel ) {
		$refsData = new ReferencesData( $env );
		$_processRefs( $env, $this, $refsData, $body );
		$this->references->insertMissingReferencesIntoDOM( $refsData, $body );
	}
};

/**
 * html -> wt DOM PreProcessor
 *
 * This is to reconstitute page-level information from local annotations
 * left behind by editing clients.
 *
 * Editing clients add inserted: true or deleted: true properties to a <ref>'s
 * data-mw object. These are no-ops for non-named <ref>s. For named <ref>s,
 * - for inserted refs, we might want to de-duplicate refs.
 * - for deleted refs, if the primary ref was deleted, we have to transfer
 *   the primary ref designation to another instance of the named ref.
 */
Cite::prototype::_html2wtPreProcessor = function ( $env, $body ) {
	// TODO
};

if ( gettype( $module ) === 'object' ) {
	$module->exports = $Cite;
}
