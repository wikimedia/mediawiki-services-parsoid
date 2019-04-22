<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
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
 * @module ext/Gallery
 */

namespace Parsoid;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 =

$ParsoidExtApi;
$DOMDataUtils = $temp0::DOMDataUtils; $DOMUtils = $temp0::
DOMUtils; $parseWikitextToDOM = $temp0->
parseWikitextToDOM; $Promise = $temp0::
Promise; $Sanitizer = $temp0::
Sanitizer; $TokenUtils = $temp0::
TokenUtils; $Util = $temp0::
Util;

$modes = require './modes.js';

/**
 * @class
 */
class Opts {
	public function __construct( $env, $attrs ) {
		Object::assign( $this, $env->conf->wiki->siteInfo->general->galleryoptions );

		$perrow = intval( $attrs->perrow, 10 );
		if ( !Number::isNaN( $perrow ) ) { $this->imagesPerRow = $perrow;
  }

		$maybeDim = Util::parseMediaDimensions( String( $attrs->widths ), true );
		if ( $maybeDim && Util::validateMediaParam( $maybeDim->x ) ) {
			$this->imageWidth = $maybeDim->x;
		}

		$maybeDim = Util::parseMediaDimensions( String( $attrs->heights ), true );
		if ( $maybeDim && Util::validateMediaParam( $maybeDim->x ) ) {
			$this->imageHeight = $maybeDim->x;
		}

		$mode = strtolower( $attrs->mode || '' );
		if ( $modes->has( $mode ) ) { $this->mode = $mode;
  }

		$this->showfilename = ( $attrs->showfilename !== null );
		$this->showthumbnails = ( $attrs->showthumbnails !== null );
		$this->caption = $attrs->caption;

		// TODO: Good contender for T54941
		$validUlAttrs = Sanitizer::attributeWhitelist( 'ul' );
		$this->attrs = array_reduce( Object::keys( $attrs )->
			filter( function ( $k ) { return $validUlAttrs->has( $k );
   } ),
			function ( $o, $k ) {
				$o[ $k ] = ( $k === 'style' ) ? Sanitizer::checkCss( $attrs[ $k ] ) : $attrs[ $k ];
				return $o;
			}, []
		);
	}
	public $attrs;
	public $imagesPerRow;

	public $imageWidth;

	public $imageHeight;

	public $mode;

	public $showfilename;
	public $showthumbnails;
	public $caption;

}

/**
 * Native Parsoid implementation of the Gallery extension.
 */
class Gallery {
	public function __construct() {
		$this->config = [
			'tags' => [
				[
					'name' => 'gallery',
					'toDOM' => self::toDOM,
					'modifyArgDict' => self::modifyArgDict,
					'serialHandler' => self::serialHandler()
				]
			],
			'styles' => [ 'mediawiki.page.gallery.styles' ]
		];
	}
	public $config;

	public static function pCaption( $data ) {
		$temp1 = $data;
$state = $temp1->state;
		$options = $state->extToken->getAttribute( 'options' );
		$caption = $options->find( function ( $kv ) {
				return $kv->k === 'caption';
		}
		);
		if ( $caption === null || !$caption->v ) { return null;
  }
		// `normalizeExtOptions` messes up src offsets, so we do our own
		// normalization to avoid parsing sol blocks
		$capV = preg_replace( '/[\t\r\n ]/', ' ', $caption->vsrc );
		$doc = /* await */ $parseWikitextToDOM(
			$state,
			$capV,
			array_slice( $caption->srcOffsets, 2 ),
			[
				'extTag' => 'gallery',
				'expandTemplates' => true,
				'inTemplate' => $state->parseContext->inTemplate,
				// FIXME: This needs more analysis.  Maybe it's inPHPBlock
				'inlineContext' => true
			],
			false// Gallery captions are deliberately not parsed in SOL context
		);
		// Store before `migrateChildrenBetweenDocs` in render
		DOMDataUtils::visitAndStoreDataAttribs( $doc->body );
		return $doc->body;
	}

	public static function pLine( $data, $obj ) {
		$temp2 = $data;
$state = $temp2->state;
$opts = $temp2->opts;
		$env = $state->env;

		// Regexp from php's `renderImageGallery`
		$matches = preg_match( '/^([^|]+)(\|(?:.*))?$/', $obj->line );
		if ( !$matches ) { return null;
  }

		$text = $matches[ 1 ];
		$caption = $matches[ 2 ] || '';

		// TODO: % indicates rawurldecode.

		$title = $env->makeTitleFromText( $text,
			$env->conf->wiki->canonicalNamespaces->file, true
		);

		if ( $title === null || !$title->getNamespace()->isFile() ) {
			return null;
		}

		// FIXME: Try to confirm `file` isn't going to break WikiLink syntax.
		// See the check for 'FIGURE' below.
		$file = $title->getPrefixedDBKey();

		$mode = $modes->get( $opts->mode );

		// NOTE: We add "none" here so that this renders in the block form
		// (ie. figure) for an easier structure to manipulate.
		$start = '[[';
		$middle = '|' . $mode->dimensions( $opts ) . '|none';
		$end = ']]';
		$wt = $start + $file + $middle + $caption + $end;

		// This is all in service of lining up the caption
		$diff = count( $file ) - count( $matches[ 1 ] );
		$startOffset = $obj->offset - strlen( $start ) - $diff - count( $middle );
		$srcOffsets = [ $startOffset, $startOffset + count( $wt ) ];

		$doc = /* await */ $parseWikitextToDOM(
			$state,
			$wt,
			$srcOffsets,
			[
				'extTag' => 'gallery',
				'expandTemplates' => true,
				'inTemplate' => $state->parseContext->inTemplate,
				// FIXME: This needs more analysis.  Maybe it's inPHPBlock
				'inlineContext' => true
			],
			true// sol
		);

		$body = $doc->body;

		$thumb = $body->firstChild;
		if ( $thumb->nodeName !== 'FIGURE' ) {
			return null;
		}

		$rdfaType = $thumb->getAttribute( 'typeof' );

		// Clean it out for reuse later
		while ( $body->firstChild ) { $body->firstChild->remove();
  }

		$figcaption = $thumb->querySelector( 'figcaption' );
		if ( !$figcaption ) {
			$figcaption = $doc->createElement( 'figcaption' );
		} else {
			$figcaption->remove();
		}

		if ( $opts->showfilename ) {
			$galleryfilename = $doc->createElement( 'a' );
			$galleryfilename->setAttribute( 'href', $env->makeLink( $title ) );
			$galleryfilename->setAttribute( 'class', 'galleryfilename galleryfilename-truncate' );
			$galleryfilename->setAttribute( 'title', $file );
			$galleryfilename->appendChild( $doc->createTextNode( $file ) );
			$figcaption->insertBefore( $galleryfilename, $figcaption->firstChild );
		}

		$gallerytext = !preg_match( '/^\s*$/', $figcaption->innerHTML ) && $figcaption;
		if ( $gallerytext ) {
			// Store before `migrateChildrenBetweenDocs` in render
			DOMDataUtils::visitAndStoreDataAttribs( $gallerytext );
		}
		return [ 'thumb' => $thumb, 'gallerytext' => $gallerytext, 'rdfaType' => $rdfaType ];
	}

	public static function toDOM( $state, $content, $args ) {
		$attrs = TokenUtils::kvToHash( $args, true );
		$opts = new Opts( $state->env, $attrs );

		// Pass this along the promise chain ...
		$data = [
			'state' => $state,
			'opts' => $opts
		];

		$dataAttribs = $state->extToken->dataAttribs;
		$offset = $dataAttribs->tsr[ 0 ] + $dataAttribs->tagWidths[ 0 ];

		// Prepare the lines for processing
		$lines = array_map( explode( "\n", $content ),
			function ( $line, $ind ) {
				$obj = [ 'line' => $line, 'offset' => $offset ];
				$offset += count( $line ) + 1; // For the nl
				// For the nl
				return $obj;
			}
		)

		->
		filter( function ( $obj, $ind, $arr ) {
				return !( ( $ind === 0 || $ind === count( $arr ) - 1 ) && preg_match( '/^\s*$/', $obj->line ) );
		}
		);

		return Promise::join(
			( $opts->caption === null ) ? null : self::pCaption( $data ),
			Promise::map( $lines, function ( $line ) use ( &$data ) {return Gallery::pLine( $data, $line );
   } )
		)->
		then( function ( $ret ) use ( &$modes, &$opts, &$state, &$DOMDataUtils ) {
				// Drop invalid lines like "References: 5."
				$oLines = $ret[ 1 ]->filter( function ( $o ) {
						return $o !== null;
				}
				);
				$mode = $modes->get( $opts->mode );
				$doc = $mode->render( $state->env, $opts, $ret[ 0 ], $oLines );
				// Reload now that `migrateChildrenBetweenDocs` is done
				DOMDataUtils::visitAndLoadDataAttribs( $doc->body );
				return $doc;
		}
		);
	}

	public static function contentHandler( $node, $state ) {
		$content = "\n";
		for ( $child = $node->firstChild;  $child;  $child = $child->nextSibling ) {
			switch ( $child->nodeType ) {
				case $child::ELEMENT_NODE:
				// Ignore if it isn't a "gallerybox"
				if ( $child->nodeName !== 'LI'
|| $child->getAttribute( 'class' ) !== 'gallerybox'
				) {
					break;
				}
				$thumb = $child->querySelector( '.thumb' );
				if ( !$thumb ) { break;
	   }
				// FIXME: The below would benefit from a refactoring that
				// assumes the figure structure, as in the link handler.
				$elt = DOMUtils::selectMediaElt( $thumb );
				if ( $elt ) {
					// FIXME: Should we preserve the original namespace?  See T151367
					$resource = $elt->getAttribute( 'resource' );
					if ( $resource !== null ) {
						$content += preg_replace( '/^\.\//', '', $resource, 1 );
						// FIXME: Serializing of these attributes should
						// match the link handler so that values stashed in
						// data-mw aren't ignored.
						$alt = $elt->getAttribute( 'alt' );
						if ( $alt !== null ) {
							$content += '|alt=' . $state->serializer->wteHandlers->escapeLinkContent( $state, $alt, false, $child, true );
						}
						// The first "a" is for the link, hopefully.
						$a = $thumb->querySelector( 'a' );
						if ( $a ) {
							$href = $a->getAttribute( 'href' );
							if ( $href !== null && $href !== $resource ) {
								$content += '|link=' . $state->serializer->wteHandlers->escapeLinkContent( $state, preg_replace( '/^\.\//', '', $href, 1 ), false, $child, true );
							}
						}
					}
				} else {
					// TODO: Previously (<=1.5.0), we rendered valid titles
					// returning mw:Error (apierror-filedoesnotexist) as
					// plaintext.  Continue to serialize this content until
					// that version is no longer supported.
					$content += $thumb->textContent;
				}
				$gallerytext = $child->querySelector( '.gallerytext' );
				if ( $gallerytext ) {
					$showfilename = $gallerytext->querySelector( '.galleryfilename' );
					if ( $showfilename ) {
						$showfilename->remove(); // Destructive to the DOM!
					}
					$state->singleLineContext->enforce();
					$caption =
					/* await */ $state->serializeCaptionChildrenToString(
						$gallerytext,
						$state->serializer->wteHandlers->wikilinkHandler
					);
					array_pop( $state->singleLineContext );
					// Drop empty captions
					if ( !preg_match( '/^\s*$/', $caption ) ) {
						$content += '|' . $caption;
					}
				}
				$content += "\n";
				break;
				case $child::TEXT_NODE:

				case $child::COMMENT_NODE:
				// Ignore it
				break;
				default:
				Assert::invariant( false, 'Should not be here!' );
				break;
			}
		}
		return $content;
	}

	public static function serialHandler() {
		return [
			'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils ) {
				$dataMw = DOMDataUtils::getDataMw( $node );
				$dataMw->attrs = $dataMw->attrs || [];
				// Handle the "gallerycaption" first
				// Handle the "gallerycaption" first
				$galcaption = $node->querySelector( 'li.gallerycaption' );
				if ( $galcaption
&& // FIXME: VE should signal to use the HTML by removing the
						// `caption` from data-mw.
						gettype( $dataMw->attrs->caption ) !== 'string'
				) {
					$dataMw->attrs->caption =
					/* await */ $state->serializeCaptionChildrenToString(
						$galcaption,
						$state->serializer->wteHandlers->mediaOptionHandler
					);
				}
				$startTagSrc =
				/* await */ $state->serializer->serializeExtensionStartTag( $node, $state );

				if ( !$dataMw->body ) {
					return $startTagSrc; // We self-closed this already.
				} else { // We self-closed this already.

					$content = null;
					// FIXME: VE should signal to use the HTML by removing the
					// `extsrc` from the data-mw.
					// FIXME: VE should signal to use the HTML by removing the
					// `extsrc` from the data-mw.
					if ( gettype( $dataMw->body->extsrc ) === 'string' ) {
						$content = $dataMw->body->extsrc;
					} else {
						$content = /* await */ Gallery::contentHandler( $node, $state );
					}
					return $startTagSrc + $content . '</' . $dataMw->name . '>';
				}
			}

		];
	}

	public static function modifyArgDict( $env, $argDict ) {
		// FIXME: Only remove after VE switches to editing HTML.
		if ( $env->conf->parsoid->nativeGallery ) {
			// Remove extsrc from native extensions
			$argDict->body->extsrc = null;

			// Remove the caption since it's redundant with the HTML
			// and we prefer editing it there.
			$argDict->attrs->caption = null;
		}
	}
}

Gallery::pLine = /* async */Gallery::pLine;
Gallery::pCaption = /* async */Gallery::pCaption;
Gallery::contentHandler = /* async */Gallery::contentHandler;

if ( gettype( $module ) === 'object' ) {
	$module->exports = $Gallery;
}
