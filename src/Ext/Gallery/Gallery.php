<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Gallery;

use DOMDocument;
use DOMElement;

use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Tokens\DomSourceRange;
use Parsoid\Tokens\KV;
use Parsoid\Tokens\SourceRange;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\TokenUtils;

use stdClass;
use Wikimedia\Assert\Assert;

/**
 * Implements the php parser's `renderImageGallery` natively.
 *
 * Params to support (on the extension tag):
 * - showfilename
 * - caption
 * - mode
 * - widths
 * - heights
 * - perrow
 *
 * A proposed spec is at: https://phabricator.wikimedia.org/P2506
 */
class Gallery extends ExtensionTag implements Extension {

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'gallery',
			'tags' => [
				[
					'name' => 'gallery',
					'class' => self::class,
				]
			],
			'styles' => [ 'mediawiki.page.gallery.styles' ]
		];
	}

	/**
	 * Parse the gallery caption.
	 * @param ParsoidExtensionAPI $extApi
	 * @param KV[] $options
	 * @return DOMElement|null
	 */
	private function pCaption(
		ParsoidExtensionAPI $extApi, array $options
	): ?DOMElement {
		$caption = null;
		foreach ( $options as $kv ) {
			if ( $kv->k === 'caption' ) {
				$caption = $kv;
				break;
			}
		}
		if ( $caption === null || !$caption->v ) {
			return null;
		}
		// `normalizeExtOptions` messes up src offsets, so we do our own
		// normalization to avoid parsing sol blocks
		$capV = preg_replace( '/[\t\r\n ]/', ' ', $caption->vsrc );
		$doc = $extApi->parseWikitextToDOM(
			$capV,
			[
				'pipelineOpts' => [
					'extTag' => 'gallery',
					'inTemplate' => $extApi->parseContext['inTemplate'],
					// FIXME: This needs more analysis.  Maybe it's inPHPBlock
					'inlineContext' => true
				],
				'srcOffsets' => $caption->valueOffset(),
			],
			false// Gallery captions are deliberately not parsed in SOL context
		);
		$body = DOMCompat::getBody( $doc );
		// Store before `migrateChildrenBetweenDocs` in render
		DOMDataUtils::visitAndStoreDataAttribs( $body );
		return $body;
	}

	/**
	 * Parse a single line of the gallery.
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $line
	 * @param int $lineStartOffset
	 * @param Opts $opts
	 * @return ParsedLine|null
	 */
	private static function pLine(
		ParsoidExtensionAPI $extApi, string $line, int $lineStartOffset,
		Opts $opts
	): ?ParsedLine {
		$env = $extApi->getEnv();

		// Regexp from php's `renderImageGallery`
		if ( !preg_match( '/^([^|]+)(\|(?:.*))?$/D', $line, $matches ) ) {
			return null;
		}

		$text = $matches[1];
		$caption = $matches[2] ?? '';

		// TODO: % indicates rawurldecode.

		$title = $env->makeTitleFromText(
			$text,
			$env->getSiteConfig()->canonicalNamespaceId( 'file' ),
			true /* no exceptions */
		);

		if ( $title === null || !$title->getNamespace()->isFile() ) {
			return null;
		}

		// FIXME: Try to confirm `file` isn't going to break WikiLink syntax.
		// See the check for 'FIGURE' below.
		$file = $title->getPrefixedDBKey();

		$mode = Mode::byName( $opts->mode );

		// NOTE: We add "none" here so that this renders in the block form
		// (ie. figure) for an easier structure to manipulate.
		$start = '[[';
		$middle = '|' . $mode->dimensions( $opts ) . '|none';
		$end = ']]';
		$wt = $start . $file . $middle . $caption . $end;

		// This is all in service of lining up the caption
		$shiftOffset = function ( $offset ) use (
			$lineStartOffset, $text, $caption, $file, $start, $middle
		) {
			$offset -= strlen( $start );
			if ( $offset <= 0 ) {
				return null;
			}
			if ( $offset <= strlen( $file ) ) {
				// Align file part
				return $lineStartOffset + $offset;
			}
			$offset -= strlen( $file );
			$offset -= strlen( $middle );
			if ( $offset <= 0 ) {
				return null;
			}
			if ( $offset <= strlen( $caption ) ) {
				// Align caption part
				return $lineStartOffset + strlen( $text ) + $offset;
			}
			return null;
		};

		$parentFrame = $extApi->getFrame();
		$newFrame = $parentFrame->newChild( $parentFrame->getTitle(), [], $wt );

		$doc = $extApi->parseWikitextToDOM(
			$wt,
			[
				'pipelineOpts' => [
					'extTag' => 'gallery',
					'inTemplate' => $extApi->parseContext['inTemplate'],
					// FIXME: This needs more analysis.  Maybe it's inPHPBlock
					'inlineContext' => true
				],
				'frame' => $newFrame,
				'srcOffsets' => new SourceRange( 0, strlen( $wt ) ),
			],
			true // sol
		);

		$body = DOMCompat::getBody( $doc );

		// Now shift the DSRs in the DOM by startOffset, and strip DSRs
		// for bits which aren't the caption or file, since they
		// don't refer to actual source wikitext
		ContentUtils::shiftDSR(
			$env,
			$body,
			function ( DomSourceRange $dsr ) use ( $shiftOffset ) {
				$start = $shiftOffset( $dsr->start );
				$end = $shiftOffset( $dsr->end );
				// If either offset is invalid, remove entire DSR
				if ( $start === null || $end === null ) {
					return null;
				}
				return new DomSourceRange(
					$start, $end, $dsr->openWidth, $dsr->closeWidth
				);
			}
		);

		$thumb = $body->firstChild;
		if ( $thumb->nodeName !== 'figure' ) {
			return null;
		}
		DOMUtils::assertElt( $thumb );

		$rdfaType = $thumb->getAttribute( 'typeof' );

		// Detach from document
		DOMCompat::remove( $thumb );

		// Detach figcaption as well
		$figcaption = DOMCompat::querySelector( $thumb, 'figcaption' );
		if ( !$figcaption ) {
			$figcaption = $doc->createElement( 'figcaption' );
		} else {
			DOMCompat::remove( $figcaption );
		}

		if ( $opts->showfilename ) {
			$galleryfilename = $doc->createElement( 'a' );
			$galleryfilename->setAttribute( 'href', $env->makeLink( $title ) );
			$galleryfilename->setAttribute( 'class', 'galleryfilename galleryfilename-truncate' );
			$galleryfilename->setAttribute( 'title', $file );
			$galleryfilename->appendChild( $doc->createTextNode( $file ) );
			$figcaption->insertBefore( $galleryfilename, $figcaption->firstChild );
		}

		$gallerytext = null;
		for ( $capChild = $figcaption->firstChild;
			 $capChild !== null;
			 $capChild = $capChild->nextSibling ) {
			if (
				DOMUtils::isText( $capChild ) &&
				preg_match( '/^\s*$/D', $capChild->nodeValue )
			) {
				// skip blank text nodes
				continue;
			}
			// Found a non-blank node!
			$gallerytext = $figcaption;
			break;
		}

		if ( $gallerytext ) {
			// Store before `migrateChildrenBetweenDocs` in render
			DOMDataUtils::visitAndStoreDataAttribs( $gallerytext );
		}
		return new ParsedLine( $thumb, $gallerytext, $rdfaType );
	}

	/** @inheritDoc */
	public function toDOM(
		ParsoidExtensionAPI $extApi, string $content, array $args
	): DOMDocument {
		$attrs = TokenUtils::kvToHash( $args, true );
		$opts = new Opts( $extApi->getEnv(), $attrs );

		$offset = $extApi->getExtTagOffsets()->innerStart();

		// Prepare the lines for processing
		$lines = explode( "\n", $content );
		$lines = array_map( function ( $line ) use ( &$offset ) {
				$lineObj = [ 'line' => $line, 'offset' => $offset ];
				$offset += strlen( $line ) + 1; // For the nl
				return $lineObj;
		}, $lines );

		$caption = $opts->caption ? $this->pCaption( $extApi, $args ) : null;
		$lines = array_map( function ( $lineObj ) use ( $extApi, $opts ) {
			return $this->pLine(
				$extApi, $lineObj['line'], $lineObj['offset'], $opts
			);
		}, $lines );

		// Drop invalid lines like "References: 5."
		$lines = array_filter( $lines, function ( $lineObj ) {
			return $lineObj !== null;
		} );

		$mode = Mode::byName( $opts->mode );
		$doc = $mode->render( $extApi->getEnv(), $opts, $caption, $lines );
		// Reload now that `migrateChildrenBetweenDocs` is done
		DOMDataUtils::visitAndLoadDataAttribs( DOMCompat::getBody( $doc ) );
		return $doc;
	}

	private function contentHandler(
		DOMElement $node, SerializerState $state
	): string {
		$content = "\n";
		for ( $child = $node->firstChild; $child; $child = $child->nextSibling ) {
			switch ( $child->nodeType ) {
			case XML_ELEMENT_NODE:
				DOMUtils::assertElt( $child );
				// Ignore if it isn't a "gallerybox"
				if (
					$child->nodeName !== 'li' ||
					$child->getAttribute( 'class' ) !== 'gallerybox'
				) {
					break;
				}
				$thumb = DOMCompat::querySelector( $child, '.thumb' );
				if ( !$thumb ) {
					break;
				}
				// FIXME: The below would benefit from a refactoring that
				// assumes the figure structure, as in the link handler.
				$elt = DOMUtils::selectMediaElt( $thumb );
				if ( $elt ) {
					// FIXME: Should we preserve the original namespace?  See T151367
					if ( $elt->hasAttribute( 'resource' ) ) {
						$resource = $elt->getAttribute( 'resource' );
						$content .= preg_replace( '#^\./#', '', $resource, 1 );
						// FIXME: Serializing of these attributes should
						// match the link handler so that values stashed in
						// data-mw aren't ignored.
						if ( $elt->hasAttribute( 'alt' ) ) {
							$alt = $elt->getAttribute( 'alt' );
							$content .= '|alt=' .
								$state->serializer->wteHandlers->escapeLinkContent(
									$state, $alt, false, $child, true
								);
						}
						// The first "a" is for the link, hopefully.
						$a = DOMCompat::querySelector( $thumb, 'a' );
						if ( $a && $a->hasAttribute( 'href' ) ) {
							$href = $a->getAttribute( 'href' );
							if ( $href !== $resource ) {
								$href = preg_replace( '#^\./#', '', $href, 1 );
								$content .= '|link=' .
										$state->serializer->wteHandlers->escapeLinkContent(
											$state, $href, false, $child, true
										);
							}
						}
					}
				} else {
					// TODO: Previously (<=1.5.0), we rendered valid titles
					// returning mw:Error (apierror-filedoesnotexist) as
					// plaintext.  Continue to serialize this content until
					// that version is no longer supported.
					$content .= $thumb->textContent;
				}
				$gallerytext = DOMCompat::querySelector( $child, '.gallerytext' );
				if ( $gallerytext ) {
					$showfilename = DOMCompat::querySelector( $gallerytext, '.galleryfilename' );
					if ( $showfilename ) {
						DOMCompat::remove( $showfilename ); // Destructive to the DOM!
					}
					$state->singleLineContext->enforce();
					$caption = $state->serializeCaptionChildrenToString(
						$gallerytext,
						[ $state->serializer->wteHandlers, 'wikilinkHandler' ]
					);
					$state->singleLineContext->pop();
					// Drop empty captions
					if ( !preg_match( '/^\s*$/D', $caption ) ) {
						$content .= '|' . $caption;
					}
				}
				$content .= "\n";
				break;
			case XML_TEXT_NODE:
			case XML_COMMENT_NODE:
				// Ignore it
				break;
			default:
				Assert::invariant( false, 'Should not be here!' );
				break;
			}
		}
		return $content;
	}

	/** @inheritDoc */
	public function fromHTML(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified
	): string {
		$dataMw = DOMDataUtils::getDataMw( $node );
		$dataMw->attrs = $dataMw->attrs ?? new stdClass;
		// Handle the "gallerycaption" first
		$galcaption = DOMCompat::querySelector( $node, 'li.gallerycaption' );
		if (
			$galcaption &&
			// FIXME: VE should signal to use the HTML by removing the
			// `caption` from data-mw.
			!is_string( $dataMw->attrs->caption ?? null )
		) {
			$dataMw->attrs->caption = $state->serializeCaptionChildrenToString(
				$galcaption,
				[ $state->serializer->wteHandlers, 'mediaOptionHandler' ]
			);
		}
		$startTagSrc = $state->serializer->serializeExtensionStartTag(
			$node, $state
		);

		if ( !$dataMw->body ) {
			return $startTagSrc; // We self-closed this already.
		} else {
			// FIXME: VE should signal to use the HTML by removing the
			// `extsrc` from the data-mw.
			if ( is_string( $dataMw->body->extsrc ?? null ) ) {
				$content = $dataMw->body->extsrc;
			} else {
				$content = $this->contentHandler( $node, $state );
			}
			return $startTagSrc . $content . '</' . $dataMw->name . '>';
		}
	}

	/** @inheritDoc */
	public function modifyArgDict(
		ParsoidExtensionAPI $extApi, object $argDict
	): void {
		// FIXME: Only remove after VE switches to editing HTML.
		if ( $extApi->getEnv()->getSiteConfig()->nativeGalleryEnabled() ) {
			// Remove extsrc from native extensions
			unset( $argDict->body->extsrc );

			// Remove the caption since it's redundant with the HTML
			// and we prefer editing it there.
			unset( $argDict->attrs->caption );
		}
	}
}
