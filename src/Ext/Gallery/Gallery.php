<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Gallery;

use stdClass;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Core\MediaStructure;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\Ext\DOMDataUtils;
use Wikimedia\Parsoid\Ext\DOMUtils;
use Wikimedia\Parsoid\Ext\ExtensionModule;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\WTSUtils;
use Wikimedia\Parsoid\Ext\WTUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\PHPUtils;

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
class Gallery extends ExtensionTagHandler implements ExtensionModule {

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'Gallery',
			'tags' => [
				[
					'name' => 'gallery',
					'handler' => self::class,
					'options' => [
						'outputHasCoreMwDomSpecMarkup' => true
					],
				]
			],
		];
	}

	/**
	 * Parse the gallery caption.
	 * @param ParsoidExtensionAPI $extApi
	 * @param array $extArgs
	 * @return ?DocumentFragment
	 */
	private function pCaption(
		ParsoidExtensionAPI $extApi, array $extArgs
	): ?DocumentFragment {
		return $extApi->extArgToDOM( $extArgs, 'caption' );
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
		// Regexp from php's `renderImageGallery`
		if ( !preg_match( '/^([^|]+)(\|(?:.*))?$/D', $line, $matches ) ) {
			return null;
		}

		$oTitleStr = $matches[1];
		$imageOptStr = $matches[2] ?? '';

		// TODO: % indicates rawurldecode.

		$mode = Mode::byName( $opts->mode );

		$imageOpts = [
			"|{$mode->dimensions( $opts )}",
			[ $imageOptStr, $lineStartOffset + strlen( $oTitleStr ) ],
		];

		$fileNs = $extApi->getSiteConfig()->canonicalNamespaceId( 'file' );

		$noPrefix = false;
		$title = $extApi->makeTitle( $oTitleStr, 0 );
		if ( $title === null || $title->getNamespaceId() !== $fileNs ) {
			// Try again, this time with a default namespace
			$title = $extApi->makeTitle( $oTitleStr, $fileNs );
			$noPrefix = true;
		}
		if ( $title === null || $title->getNamespaceId() !== $fileNs ) {
			return null;
		}

		if ( $noPrefix ) {
			// Take advantage of $fileNs to give us the right namespace, since,
			// the explicit prefix isn't necessary in galleries but for the
			// wikilink syntax it is.  Ex,
			//
			// <gallery>
			// Test.png
			// </gallery>
			//
			// vs [[File:Test.png]], here the File: prefix is necessary
			//
			// Note, this is no longer from source now
			$titleStr = $title->getPrefixedDBKey();
		} else {
			$titleStr = $oTitleStr;
		}

		$thumb = $extApi->renderMedia(
			$titleStr, $imageOpts, $error,
			// Force block for an easier structure to manipulate, otherwise
			// we have to pull the caption out of the data-mw
			true
		);
		if ( !$thumb || DOMCompat::nodeName( $thumb ) !== 'figure' ) {
			return null;
		}

		if ( $noPrefix ) {
			// Fiddling with the shadow attribute below, rather than using
			// DOMDataUtils::setShadowInfoIfModified, since WikiLinkHandler::renderFile
			// always sets a shadow (at minimum for the relative './') and that
			// method preserves the original source from the first time it's called,
			// though there's a FIXME to remove that behaviour.
			$media = $thumb->firstChild->firstChild;
			$dp = DOMDataUtils::getDataParsoid( $media );
			$dp->sa['resource'] = $oTitleStr;
		}

		$doc = $thumb->ownerDocument;
		$rdfaType = $thumb->getAttribute( 'typeof' ) ?? '';

		// T214601: Account for a format being set in $imageOptStr
		$rdfaType = preg_replace( '#mw:File(/\w+)?\b#', 'mw:File', $rdfaType, 1 );

		// Detach figcaption as well
		$figcaption = DOMCompat::querySelector( $thumb, 'figcaption' );
		DOMCompat::remove( $figcaption );

		if ( $opts->showfilename ) {
			$file = $title->getPrefixedDBKey();
			$galleryfilename = $doc->createElement( 'a' );
			$galleryfilename->setAttribute( 'href', $extApi->getTitleUri( $title ) );
			$galleryfilename->setAttribute( 'class', 'galleryfilename galleryfilename-truncate' );
			$galleryfilename->setAttribute( 'title', $file );
			$galleryfilename->appendChild( $doc->createTextNode( $file ) );
			$figcaption->insertBefore( $galleryfilename, $figcaption->firstChild );
		}

		$gallerytext = null;
		for (
			$capChild = $figcaption->firstChild;
			$capChild !== null;
			$capChild = $capChild->nextSibling
		) {
			if (
				$capChild instanceof Text &&
				preg_match( '/^\s*$/D', $capChild->nodeValue )
			) {
				// skip blank text nodes
				continue;
			}
			// Found a non-blank node!
			$gallerytext = $figcaption;
			break;
		}

		return new ParsedLine( $thumb, $gallerytext, $rdfaType );
	}

	/** @inheritDoc */
	public function sourceToDom(
		ParsoidExtensionAPI $extApi, string $content, array $args
	): DocumentFragment {
		$attrs = $extApi->extArgsToArray( $args );
		$opts = new Opts( $extApi, $attrs );

		$offset = $extApi->extTag->getOffsets()->innerStart();

		// Prepare the lines for processing
		$lines = explode( "\n", $content );
		$lines = array_map( static function ( $line ) use ( &$offset ) {
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
		$lines = array_filter( $lines, static function ( $lineObj ) {
			return $lineObj !== null;
		} );

		$mode = Mode::byName( $opts->mode );
		$extApi->getMetadata()->addModules( $mode->getModules() );
		$extApi->getMetadata()->addModuleStyles( $mode->getModuleStyles() );
		return $mode->render( $extApi, $opts, $caption, $lines );
	}

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $node
	 * @return string
	 */
	private function contentHandler(
		ParsoidExtensionAPI $extApi, Element $node
	): string {
		$content = "\n";
		for ( $child = $node->firstChild; $child; $child = $child->nextSibling ) {
			switch ( $child->nodeType ) {
			case XML_ELEMENT_NODE:
				DOMUtils::assertElt( $child );
				// Ignore if it isn't a "gallerybox"
				if (
					DOMCompat::nodeName( $child ) !== 'li' ||
					$child->getAttribute( 'class' ) !== 'gallerybox'
				) {
					break;
				}
				$thumb = DOMCompat::querySelector( $child, '.thumb' );
				if ( !$thumb ) {
					break;
				}
				$gallerytext = DOMCompat::querySelector( $child, '.gallerytext' );
				if ( $gallerytext ) {
					$showfilename = DOMCompat::querySelector( $gallerytext, '.galleryfilename' );
					if ( $showfilename ) {
						DOMCompat::remove( $showfilename ); // Destructive to the DOM!
					}
				}
				$ms = MediaStructure::parse( DOMUtils::firstNonSepChild( $thumb ) );
				if ( $ms ) {
					// FIXME: Dry all this out with T252246 / T262833
					if ( $ms->hasResource() ) {
						$resource = $ms->getResource();
						$rs = WTSUtils::getShadowInfo( $ms->mediaElt, 'resource', $resource );
						if ( $rs['fromsrc'] ) {
							$content .= $rs['value'];
						} else {
							$content .= PHPUtils::stripPrefix( $resource, './' );
						}
						// FIXME: Serializing of these attributes should
						// match the link handler so that values stashed in
						// data-mw aren't ignored.
						if ( $ms->hasAlt() ) {
							$altOnElt = trim( $ms->getAlt() );
							$altFromCaption = $gallerytext ?
								trim( WTUtils::textContentFromCaption( $gallerytext ) ) : '';
							// The first condition is to support an empty \alt=\ option
							// when no caption is present
							if ( !$altOnElt || ( $altOnElt !== $altFromCaption ) ) {
								$content .= '|alt=' .
									$extApi->escapeWikitext( $altOnElt, $child, $extApi::IN_MEDIA );
							}
						}
						// FIXME: Handle missing media
						if ( $ms->hasMediaUrl() && !$ms->isRedLink() ) {
							$href = $ms->getMediaUrl();
							if ( $href !== $resource ) {
								$href = PHPUtils::stripPrefix( $href, './' );
								$content .= '|link=' .
									$extApi->escapeWikitext( $href, $child, $extApi::IN_MEDIA );
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
				if ( $gallerytext ) {
					$caption = $extApi->domChildrenToWikitext(
						$gallerytext, $extApi::IN_IMG_CAPTION
					);
					// Drop empty captions
					if ( !preg_match( '/^\s*$/D', $caption ) ) {
						// Ensure that this only takes one line since gallery
						// tag content is split by line
						$caption = str_replace( "\n", ' ', $caption );
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
				throw new UnreachableException( 'should not be here!' );
			}
		}
		return $content;
	}

	/** @inheritDoc */
	public function domToWikitext(
		ParsoidExtensionAPI $extApi, Element $node, bool $wrapperUnmodified
	) {
		$dataMw = DOMDataUtils::getDataMw( $node );
		$dataMw->attrs ??= new stdClass;
		$nativeGalleryEnabled = $extApi->getSiteConfig()->nativeGalleryEnabled();
		// Handle the "gallerycaption" first
		$galcaption = DOMCompat::querySelector( $node, 'li.gallerycaption' );
		if (
			$galcaption && ( $nativeGalleryEnabled ||
				// FIXME: VE should signal to use the HTML by removing the
				// `caption` from data-mw.
				!is_string( $dataMw->attrs->caption ?? null )
		) ) {
			$dataMw->attrs->caption = $extApi->domChildrenToWikitext(
				$galcaption, $extApi::IN_IMG_CAPTION | $extApi::IN_OPTION
			);
		}
		$startTagSrc = $extApi->extStartTagToWikitext( $node );

		if ( !isset( $dataMw->body ) ) {
			return $startTagSrc; // We self-closed this already.
		} else {
			// FIXME: VE should signal to use the HTML by removing the
			// `extsrc` from the data-mw.
			if (
				!$nativeGalleryEnabled &&
				is_string( $dataMw->body->extsrc ?? null )
			) {
				$content = $dataMw->body->extsrc;
			} else {
				$content = $this->contentHandler( $extApi, $node );
			}
			return $startTagSrc . $content . '</' . $dataMw->name . '>';
		}
	}

	/** @inheritDoc */
	public function modifyArgDict(
		ParsoidExtensionAPI $extApi, object $argDict
	): void {
		// FIXME: Only remove after VE switches to editing HTML.
		if ( $extApi->getSiteConfig()->nativeGalleryEnabled() ) {
			// Remove extsrc from native extensions
			unset( $argDict->body->extsrc );

			// Remove the caption since it's redundant with the HTML
			// and we prefer editing it there.
			unset( $argDict->attrs->caption );
		}
	}

	/** @inheritDoc */
	public function diffHandler(
		ParsoidExtensionAPI $extApi, callable $domDiff, Element $origNode,
		Element $editedNode
	): bool {
		return call_user_func( $domDiff, $origNode, $editedNode );
	}
}
