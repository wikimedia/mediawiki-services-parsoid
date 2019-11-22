<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Cite;

use DOMElement;
use DOMNode;
use Exception;
use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\WTUtils;

/**
 * Simple token transform version of the Ref extension tag.
 */
class Ref extends ExtensionTag {

	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ) {
		// Drop nested refs entirely, unless we've explicitly allowed them
		if ( ( $extApi->parseContext['extTag'] ?? null ) === 'ref' &&
			empty( $extApi->parseContext['extTagOpts']['allowNestedRef'] )
		) {
			return null;
		}

		// The one supported case for nested refs is from the {{#tag:ref}} parser
		// function.  However, we're overly permissive here since we can't
		// distinguish when that's nested in another template.
		// The php preprocessor did our expansion.
		$allowNestedRef = !empty( $extApi->parseContext['inTemplate'] ) &&
			( $extApi->parseContext['extTag'] ?? null ) !== 'ref';

		return $extApi->parseTokenContentsToDOM(
			$extArgs,
			'',
			$txt,
			[
				// NOTE: sup's content model requires it only contain phrasing
				// content, not flow content. However, since we are building an
				// in-memory DOM which is simply a tree data structure, we can
				// nest flow content in a <sup> tag.
				'wrapperTag' => 'sup',
				'pipelineOpts' => [
					'extTag' => 'ref',
					'extTagOpts' => [ 'allowNestedRef' => $allowNestedRef ],
					'inTemplate' => $extApi->parseContext['inTemplate'] ?? null,
					// FIXME: One-off PHP parser state leak.
					// This needs a better solution.
					'inPHPBlock' => true,
				],
			]
		);
	}

	/** @inheritDoc */
	public function lintHandler(
		ParsoidExtensionAPI $extApi, DOMElement $ref, callable $defaultHandler
	): ?DOMNode {
		// Don't lint the content of ref in ref, since it can lead to cycles
		// using named refs
		if ( WTUtils::fromExtensionContent( $ref, 'references' ) ) {
			return $ref->nextSibling;
		}

		$refFirstChild = $ref->firstChild;
		DOMUtils::assertElt( $refFirstChild );
		$linkBackId = preg_replace( '/[^#]*#/', '', $refFirstChild->getAttribute( 'href' ), 1 );
		$refNode = $ref->ownerDocument->getElementById( $linkBackId );
		if ( $refNode ) {
			// Ex: Buggy input wikitext without ref content
			$defaultHandler( $refNode->lastChild );
		}
		return $ref->nextSibling;
	}

	/** @inheritDoc */
	public function fromHTML(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified
	): string {
		$startTagSrc = $state->serializer->serializeExtensionStartTag( $node, $state );
		$dataMw = DOMDataUtils::getDataMw( $node );
		$env = $state->getEnv();
		$html = null;
		if ( !isset( $dataMw->body ) ) {
			return $startTagSrc; // We self-closed this already.
		} else { // We self-closed this already.
			if ( is_string( $dataMw->body->html ?? null ) ) {
				// First look for the extension's content in data-mw.body.html
				$html = $dataMw->body->html;
			} elseif ( is_string( $dataMw->body->id ?? null ) ) {
				// If the body isn't contained in data-mw.body.html, look if
				// there's an element pointed to by body.id.
				$bodyElt = DOMCompat::getElementById( $node->ownerDocument, $dataMw->body->id );
				$editedDoc = $env->getPageConfig()->editedDoc ?? null;
				if ( !$bodyElt && $editedDoc ) {
					// Try to get to it from the main page.
					// This can happen when the <ref> is inside another
					// extension, most commonly inside a <references>.
					// The recursive call to serializeDOM puts us inside
					// inside a new document.
					$bodyElt = DOMCompat::getElementById( $editedDoc, $dataMw->body->id );
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
					$firstA = DOMCompat::querySelector( $node, 'a[href]' );
					$href = $firstA->getAttribute( 'href' );
					if ( $firstA && preg_match( '/^#/', $href ) ) {
						try {
							$ref = DOMCompat::querySelector( $node->ownerDocument, $href );
							if ( $ref ) {
								$extraDebug .= ' [own doc: ' . DOMCompat::getOuterHTML( $ref ) . ']';
							}
							$ref = DOMCompat::querySelector( $env->getPageConfig()->editedDoc, $href );
							if ( $ref ) {
								$extraDebug .= ' [main doc: ' . DOMCompat::getOuterHTML( $ref ) . ']';
							}
						} catch ( Exception $e ) {
							// We are just providing VE with debugging info.
							// So, ignore all exceptions / errors in this code.
						}

						if ( !$extraDebug ) {
							$extraDebug = ' [reference ' . $href . ' not found]';
						}
					}
					$env->log(
						'error/' . $dataMw->name,
						'extension src id ' . $dataMw->body->id . ' points to non-existent element for:',
						DOMCompat::getOuterHTML( $node ),
						'. More debug info: ',
						$extraDebug
					);
					return ''; // Drop it!
				}
			} else { // Drop it!
				$env->log( 'error', 'Ref body unavailable for: ' . DOMCompat::getOuterHTML( $node ) );
				return ''; // Drop it!
			} // Drop it!
		}

		$src = $state->serializer->serializeHTML(
			[
				'env' => $state->getEnv(),
				'extName' => $dataMw->name, // FIXME: One-off PHP parser state leak.
				// This needs a better solution.
				'inPHPBlock' => true
			],
			$html
		);
		return $startTagSrc . $src . '</' . $dataMw->name . '>';
	}
}
