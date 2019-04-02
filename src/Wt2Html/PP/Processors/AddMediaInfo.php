<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\Promise as Promise;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTSUtils as WTSUtils;
use Parsoid\Sanitizer as Sanitizer;
use Parsoid\PegTokenizer as PegTokenizer;

class AddMediaInfo {
	/**
	 * Extract the dimensions for media.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Object} attrs
	 * @param {Object} info
	 * @return {Object}
	 */
	public static function handleSize( $env, $attrs, $info ) {
		$height = $info->height;
		$width = $info->width;

		Assert::invariant( gettype( $height ) === 'number' && !Number::isNaN( $height ) );
		Assert::invariant( gettype( $width ) === 'number' && !Number::isNaN( $width ) );

		if ( $info->thumburl && $info->thumbheight ) {
			$height = $info->thumbheight;
		}

		if ( $info->thumburl && $info->thumbwidth ) {
			$width = $info->thumbwidth;
		}

		// Audio files don't have dimensions, so we fallback to these arbitrary
		// defaults, and the "mw-default-audio-height" class is added.
		if ( $info->mediatype === 'AUDIO' ) {
			$height = /* height || */32; // Arguably, audio should respect a defined height
			$width = $width || $env->conf->wiki->widthOption;
		}

		$mustRender = null;
		if ( $info->mustRender !== null ) {
			$mustRender = $info->mustRender;
		} else {
			$mustRender = $info->mediatype !== 'BITMAP';
		}

		// Handle client-side upscaling (including 'border')

		// Calculate the scaling ratio from the user-specified width and height
		$ratio = null;
		if ( $attrs->size->height && $info->height ) {
			$ratio = $attrs->size->height / $info->height;
		}
		if ( $attrs->size->width && $info->width ) {
			$r = $attrs->size->width / $info->width;
			$ratio = ( $ratio === null || $r < $ratio ) ? $r : $ratio;
		}

		if ( $ratio !== null && $ratio > 1 ) {
			// If the user requested upscaling, then this is denied in the thumbnail
			// and frameless format, except for files with mustRender.
			if ( !$mustRender && ( $attrs->format === 'Thumb' || $attrs->format === 'Frameless' ) ) {
				// Upscaling denied
				$height = $info->height;
				$width = $info->width;
			} else {
				// Upscaling allowed
				// In the batch API, these will already be correct, but the non-batch
				// API returns the source width and height whenever client-side scaling
				// is requested.
				if ( !$env->conf->parsoid->useBatchAPI ) {
					$height = round( $info->height * $ratio );
					$width = round( $info->width * $ratio );
				}
			}
		}

		return [ 'height' => $height, 'width' => $width ];
	}

	/**
	 * This is a port of TMH's parseTimeString()
	 *
	 * @param {string} timeString
	 * @param {number} [length]
	 * @return {number}
	 */
	public static function parseTimeString( $timeString, $length ) {
		$time = 0;
		$parts = explode( ':', $timeString );
		if ( count( $parts ) > 3 ) {
			return false;
		}
		for ( $i = 0;  $i < count( $parts );  $i++ ) {
			$num = intval( $parts[ $i ], 10 );
			if ( Number::isNaN( $num ) ) {
				return false;
			}
			$time += $num * pow( 60, count( $parts ) - 1 - $i );
		}
		if ( $time < 0 ) {
			$time = 0;
		} elseif ( $length !== null ) {
			Assert::invariant( gettype( $length ) === 'number' );
			if ( $time > $length ) { $time = $length - 1;  }
		}
		return $time;
	}

	/**
	 * Handle media fragments
	 * https://www.w3.org/TR/media-frags/
	 *
	 * @param {Object} info
	 * @param {Object} dataMw
	 * @return {string}
	 */
	public static function parseFrag( $info, $dataMw ) {
		$time = null;
		$frag = '';
		$starttime = WTSUtils::getAttrFromDataMw( $dataMw, 'starttime', true );
		$endtime = WTSUtils::getAttrFromDataMw( $dataMw, 'endtime', true );
		if ( $starttime || $endtime ) {
			$frag += '#t=';
			if ( $starttime ) {
				$time = AddMediaInfo::parseTimeString( $starttime[ 1 ]->txt, $info->duration );
				if ( $time !== false ) {
					$frag += $time;
				}
			}
			if ( $endtime ) {
				$time = AddMediaInfo::parseTimeString( $endtime[ 1 ]->txt, $info->duration );
				if ( $time !== false ) {
					$frag += ',' . $time;
				}
			}
		}
		return $frag;
	}

	/**
	 * @param {Node} elt
	 * @param {Object} info
	 * @param {Object} attrs
	 * @param {Object} dataMw
	 * @param {boolean} hasDimension
	 */
	public static function addSources( $elt, $info, $attrs, $dataMw, $hasDimension ) {
		$doc = $elt->ownerDocument;
		$frag = AddMediaInfo::parseFrag( $info, $dataMw );

		$derivatives = null;
		$dataFromTMH = true;
		if ( $info->thumbdata && is_array( $info->thumbdata->derivatives ) ) {
			// BatchAPI's `getAPIData`
			$derivatives = $info->thumbdata->derivatives;
		} elseif ( is_array( $info->derivatives ) ) {
			// "videoinfo" prop
			$derivatives = $info->derivatives;
		} else {
			$derivatives = [
				[
					'src' => $info->url,
					'type' => $info->mime,
					'width' => String( $info->width ),
					'height' => String( $info->height )
				]
			];
			$dataFromTMH = false;
		}

		$derivatives->forEach( function ( $o ) use ( &$doc, &$frag, &$undefined, &$hasDimension, &$dataFromTMH, &$elt ) {
				$source = $doc->createElement( 'source' );
				$source->setAttribute( 'src', $o->src + $frag );
				$source->setAttribute( 'type', $o->type );
				$fromFile = ( $o->transcodekey !== null ) ? '' : '-file';
				if ( $hasDimension ) {
					$source->setAttribute( 'data' . $fromFile . '-width', $o->width );
					$source->setAttribute( 'data' . $fromFile . '-height', $o->height );
				}
				if ( $dataFromTMH ) {
					$source->setAttribute( 'data-title', $o->title );
					$source->setAttribute( 'data-shorttitle', $o->shorttitle );
				}
				$elt->appendChild( $source );
			}
		);
	}

	/**
	 * @param {Node} elt
	 * @param {Object} info
	 */
	public static function addTracks( $elt, $info ) {
		$doc = $elt->ownerDocument;
		$timedtext = null;
		if ( $info->thumbdata && is_array( $info->thumbdata->timedtext ) ) {
			// BatchAPI's `getAPIData`
			$timedtext = $info->thumbdata->timedtext;
		} elseif ( is_array( $info->timedtext ) ) {
			// "videoinfo" prop
			$timedtext = $info->timedtext;
		} else {
			$timedtext = [];
		}
		$timedtext->forEach( function ( $o ) use ( &$doc, &$elt ) {
				$track = $doc->createElement( 'track' );
				$track->setAttribute( 'kind', $o->kind );
				$track->setAttribute( 'type', $o->type );
				$track->setAttribute( 'src', $o->src );
				$track->setAttribute( 'srclang', $o->srclang );
				$track->setAttribute( 'label', $o->label );
				$track->setAttribute( 'data-mwtitle', $o->title );
				$track->setAttribute( 'data-dir', $o->dir );
				$elt->appendChild( $track );
			}
		);
	}

	/**
	 * Abstract way to get the path for an image given an info object.
	 *
	 * @private
	 * @param {Object} info
	 * @param {string|null} info.thumburl The URL for a thumbnail.
	 * @param {string} info.url The base URL for the image.
	 * @return {string}
	 */
	public static function getPath( $info ) {
		$path = '';
		if ( $info->thumburl ) {
			$path = $info->thumburl;
		} elseif ( $info->url ) {
			$path = $info->url;
		}
		return preg_replace( '/^https?:\/\//', '//', $path, 1 );
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} info
	 * @param {Object|null} manualinfo
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	public static function handleAudio( $env, $container, $attrs, $info, $manualinfo, $dataMw ) {
		$doc = $container->ownerDocument;
		$audio = $doc->createElement( 'audio' );

		$audio->setAttribute( 'controls', '' );
		$audio->setAttribute( 'preload', 'none' );

		$size = AddMediaInfo::handleSize( $env, $attrs, $info );
		DOMDataUtils::addNormalizedAttribute( $audio, 'height', String( $size->height ) );
		DOMDataUtils::addNormalizedAttribute( $audio, 'width', String( $size->width ) );

		// Hardcoded until defined heights are respected.
		// See `AddMediaInfo.handleSize`
		$container->classList->add( 'mw-default-audio-height' );

		AddMediaInfo::copyOverAttribute( $audio, $container, 'resource' );

		if ( $container->firstChild->firstChild->hasAttribute( 'lang' ) ) {
			AddMediaInfo::copyOverAttribute( $audio, $container, 'lang' );
		}

		AddMediaInfo::addSources( $audio, $info, $attrs, $dataMw, false );
		AddMediaInfo::addTracks( $audio, $info );

		return [ 'rdfaType' => 'mw:Audio', 'elt' => $audio ];
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} info
	 * @param {Object|null} manualinfo
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	public static function handleVideo( $env, $container, $attrs, $info, $manualinfo, $dataMw ) {
		$doc = $container->ownerDocument;
		$video = $doc->createElement( 'video' );

		if ( $manualinfo || $info->thumburl ) {
			$video->setAttribute( 'poster', AddMediaInfo::getPath( $manualinfo || $info ) );
		}

		$video->setAttribute( 'controls', '' );
		$video->setAttribute( 'preload', 'none' );

		$size = AddMediaInfo::handleSize( $env, $attrs, $info );
		DOMDataUtils::addNormalizedAttribute( $video, 'height', String( $size->height ) );
		DOMDataUtils::addNormalizedAttribute( $video, 'width', String( $size->width ) );

		AddMediaInfo::copyOverAttribute( $video, $container, 'resource' );

		if ( $container->firstChild->firstChild->hasAttribute( 'lang' ) ) {
			AddMediaInfo::copyOverAttribute( $video, $container, 'lang' );
		}

		AddMediaInfo::addSources( $video, $info, $attrs, $dataMw, true );
		AddMediaInfo::addTracks( $video, $info );

		return [ 'rdfaType' => 'mw:Video', 'elt' => $video ];
	}

	/**
	 * Set up the actual image structure, attributes, etc.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} info
	 * @param {Object|null} manualinfo
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	public static function handleImage( $env, $container, $attrs, $info, $manualinfo, $dataMw ) {
		$doc = $container->ownerDocument;
		$img = $doc->createElement( 'img' );

		AddMediaInfo::addAttributeFromDateMw( $img, $dataMw, 'alt' );

		if ( $manualinfo ) { $info = $manualinfo;  }

		AddMediaInfo::copyOverAttribute( $img, $container, 'resource' );

		$img->setAttribute( 'src', AddMediaInfo::getPath( $info ) );

		if ( $container->firstChild->firstChild->hasAttribute( 'lang' ) ) {
			AddMediaInfo::copyOverAttribute( $img, $container, 'lang' );
		}

		// Add (read-only) information about original file size (T64881)
		$img->setAttribute( 'data-file-width', String( $info->width ) );
		$img->setAttribute( 'data-file-height', String( $info->height ) );
		$img->setAttribute( 'data-file-type', $info->mediatype && strtolower( $info->mediatype ) );

		$size = AddMediaInfo::handleSize( $env, $attrs, $info );
		DOMDataUtils::addNormalizedAttribute( $img, 'height', String( $size->height ) );
		DOMDataUtils::addNormalizedAttribute( $img, 'width', String( $size->width ) );

		// Handle "responsive" images, i.e. srcset
		if ( $info->responsiveUrls ) {
			$candidates = [];
			Object::keys( $info->responsiveUrls )->forEach( function ( $density ) use ( &$candidates ) {
					$candidates[] =
					preg_replace( '/^https?:\/\//', '//', $info->responsiveUrls[ $density ], 1 )
.						' ' . $density . 'x';

					;
				}
			);
			if ( count( $candidates ) > 0 ) {
				$img->setAttribute( 'srcset', implode( ', ', $candidates ) );
			}
		}

		return [ 'rdfaType' => 'mw:Image', 'elt' => $img ];
	}

	/**
	 * FIXME: this is more complicated than it ought to be because
	 * we're trying to handle more than one different data format:
	 * batching returns one, videoinfo returns another, imageinfo
	 * returns a third.  We should fix this!  If we need to do
	 * conversions, they should probably live inside Batcher, since
	 * all of these results ultimately come from the Batcher.imageinfo
	 * method (no one calls ImageInfoRequest directly any more).
	 *
	 * @param {MWParserEnvironment} env
	 * @param {string} key
	 * @param {Object} data
	 * @return {Object}
	 */
	public static function extractInfo( $env, $key, $data ) {
		if ( $env->conf->parsoid->useBatchAPI ) {
			return $data->batchResponse;
		} else {
			$ns = $data->imgns;
			// `useVideoInfo` is for legacy requests; batching returns thumbdata.
			$prop = ( $env->conf->wiki->useVideoInfo ) ? 'videoinfo' : 'imageinfo';
			// title is guaranteed to be not null here
			$image = $data->pages[ $ns . ':' . $key ];
			if ( !$image || !$image[ $prop ] || !$image[ $prop ][ 0 ]
||					// Fallback to adding mw:Error
					( $image->missing !== null && $image->known === null )
			) {
				return null;
			} else {
				return $image[ $prop ][ 0 ];
			}
		}
	}

	/**
	 * Use sane defaults
	 *
	 * @param {MWParserEnvironment} env
	 * @param {string} key
	 * @param {Object} dims
	 * @return {Object}
	 */
	public static function errorInfo( $env, $key, $dims ) {
		$widthOption = $env->conf->wiki->widthOption;
		return [
			'url' => "./Special:FilePath/{Sanitizer::sanitizeTitleURI( $key, false )}",
			// Preserve width and height from the wikitext options
			// even if the image is non-existent.
			'width' => $dims->width || $widthOption,
			'height' => $dims->height || $dims->width || $widthOption
		];
	}

	/**
	 * @param {string} key
	 * @param {string} message
	 * @param {Object} [params]
	 * @return {Object}
	 */
	public static function makeErr( $key, $message, $params ) {
		$e = [ 'key' => $key, 'message' => $message ];
		// Additional error info for clients that could fix the error.
		if ( $params !== null ) { $e->params = $params;  }
		return $e;
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {string} key
	 * @param {Object} dims
	 * @return {Object}
	 */
	public static function requestInfo( $env, $key, $dims ) {
		$err = null;
		$info = null;
		try {
			$data = /* await */ $env->batcher->imageinfo( $key, $dims );
			$info = AddMediaInfo::extractInfo( $env, $key, $data );
			if ( !$info ) {
				$info = AddMediaInfo::errorInfo( $env, $key, $dims );
				$err = AddMediaInfo::makeErr( 'apierror-filedoesnotexist', 'This image does not exist.' );
			} elseif ( $info->hasOwnProperty( 'thumberror' ) ) {
				$err = AddMediaInfo::makeErr( 'apierror-unknownerror', $info->thumberror );
			}
		} catch ( Exception $e ) {
			$info = AddMediaInfo::errorInfo( $env, $key, $dims );
			$err = AddMediaInfo::makeErr( 'apierror-unknownerror', $e );
		}
		return [ 'err' => $err, 'info' => $info ];
	}

	/**
	 * @param {Node} container
	 * @param {Array} errs
	 * @param {Object} dataMw
	 */
	public static function addErrors( $container, $errs, $dataMw ) {
		if ( !DOMUtils::hasTypeOf( $container, 'mw:Error' ) ) {
			$typeOf = $container->getAttribute( 'typeof' ) || '';
			$typeOf = "mw:Error{( count( $typeOf ) ) ? ' ' : ''}{$typeOf}";
			$container->setAttribute( 'typeof', $typeOf );
		}
		if ( is_array( $dataMw->errors ) ) {
			$errs = $dataMw->errors->concat( $errs );
		}
		$dataMw->errors = $errs;
	}

	/**
	 * @param {Node} elt
	 * @param {Node} container
	 * @param {string} attribute
	 */
	public static function copyOverAttribute( $elt, $container, $attribute ) {
		$span = $container->firstChild->firstChild;
		DOMDataUtils::addNormalizedAttribute(
			$elt, $attribute, $span->getAttribute( $attribute ),
			WTSUtils::getAttributeShadowInfo( $span, $attribute )->value
		);
	}

	/**
	 * If this is a manual thumbnail, fetch the info for that as well
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Object} attrs
	 * @param {Object} dims
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	public static function manualInfo( $env, $attrs, $dims, $dataMw ) {
		$attr = WTSUtils::getAttrFromDataMw( $dataMw, 'manualthumb', true );
		if ( $attr === null ) { return [ 'err' => null, 'info' => null ];  }

		$val = $attr[ 1 ]->txt;
		$title = $env->makeTitleFromText( $val, $attrs->title->getNamespace(), true );
		if ( $title === null ) {
			return [
				'info' => AddMediaInfo::errorInfo( $env, /* That right? */$attrs->title->getKey(), $dims ),
				'err' => AddMediaInfo::makeErr( 'apierror-invalidtitle', 'Invalid thumbnail title.', [ 'name' => $val ] )
			];
		}

		return /* await */ AddMediaInfo::requestInfo( $env, $title->getKey(), $dims );
	}

	/**
	 * @param {Node} elt
	 * @param {Object} dataMw
	 * @param {string} key
	 */
	public static function addAttributeFromDateMw( $elt, $dataMw, $key ) {
		$attr = WTSUtils::getAttrFromDataMw( $dataMw, $key, false );
		if ( $attr === null ) { return;  }

		$elt->setAttribute( $key, $attr[ 1 ]->txt );
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Object} urlParser
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} dataMw
	 * @param {boolean} isImage
	 */
	public static function handleLink( $env, $urlParser, $container, $attrs, $dataMw, $isImage ) {
		$doc = $container->ownerDocument;
		$attr = WTSUtils::getAttrFromDataMw( $dataMw, 'link', true );

		$anchor = $doc->createElement( 'a' );
		if ( $isImage ) {
			if ( $attr !== null ) {
				$discard = true;
				$val = $attr[ 1 ]->txt;
				if ( $val === '' ) {
					// No href if link= was specified
					$anchor = $doc->createElement( 'span' );
				} elseif ( $urlParser->tokenizesAsURL( $val ) ) {
					// an external link!
					$anchor->setAttribute( 'href', $val );
				} else {
					$link = $env->makeTitleFromText( $val, null, true );
					if ( $link !== null ) {
						$anchor->setAttribute( 'href', $env->makeLink( $link ) );
					} else {
						// Treat same as if link weren't present
						$anchor->setAttribute( 'href', $env->makeLink( $attrs->title ) );
						// but preserve for roundtripping
						$discard = false;
					}
				}
				if ( $discard ) {
					WTSUtils::getAttrFromDataMw( $dataMw, 'link', /* keep */false );
				}
			} else {
				$anchor->setAttribute( 'href', $env->makeLink( $attrs->title ) );
			}
		} else {
			$anchor = $doc->createElement( 'span' );
		}

		if ( $anchor->nodeName === 'A' ) {
			$href = Sanitizer::cleanUrl( $env, $anchor->getAttribute( 'href' ), 'external' );
			$anchor->setAttribute( 'href', $href );
		}

		$container->replaceChild( $anchor, $container->firstChild );
	}

	/**
	 * @param {Node} rootNode
	 * @param {MWParserEnvironment} env
	 * @param {Object} options
	 */
	public static function addMediaInfo( $rootNode, $env, $options ) {
		$urlParser = new PegTokenizer( $env );
		$doc = $rootNode->ownerDocument;
		$containers = Array::from( $doc->querySelectorAll( 'figure,figure-inline' ) );

		// Try to ensure `addMediaInfo` is idempotent based on finding the
		// structure unaltered from the emitted tokens.  Note that we may hit
		// false positivies in link-in-link scenarios but, in those cases, link
		// content would already have been processed to dom in a subpipeline
		// and would necessitate filtering here anyways.
		$containers = $containers->filter( function ( $c ) use ( &$DOMUtils ) {
				return $c->firstChild && $c->firstChild->nodeName === 'A'
&&					$c->firstChild->firstChild && $c->firstChild->firstChild->nodeName === 'SPAN'
&&					// The media element may remain a <span> if we hit an error
					// below so use the annotation as another indicator of having
					// already been processed.
					!DOMUtils::hasTypeOf( $c, 'mw:Error' );
			}
		);

		/* await */ array_reduce( Promise::map( $containers, /* async */function ( $container ) {
					$dataMw = DOMDataUtils::getDataMw( $container );
					$span = $container->firstChild->firstChild;
					$attrs = [
						'size' => [
							'width' => ( $span->hasAttribute( 'data-width' ) ) ? Number( $span->getAttribute( 'data-width' ) ) : null,
							'height' => ( $span->hasAttribute( 'data-height' ) ) ? Number( $span->getAttribute( 'data-height' ) ) : null
						],
						'format' => WTSUtils::getMediaType( $container )->format,
						'title' => $env->makeTitleFromText( $span->textContent )
					];

					$ret = [ 'container' => $container, 'dataMw' => $dataMw, 'attrs' => $attrs, 'i' => null, 'm' => null ];

					if ( !$env->conf->parsoid->fetchImageInfo ) {
						$ret->i = [ 'err' => AddMediaInfo::makeErr( 'apierror-unknownerror', 'Fetch of image info disabled.' ) ];
						return $ret;
					}

					$dims = Object::assign( [], $attrs->size );

					$page = WTSUtils::getAttrFromDataMw( $dataMw, 'page', true );
					if ( $page && $dims->width !== null ) {
						$dims->page = $page[ 1 ]->txt;
					}

					// "starttime" should be used if "thumbtime" isn't present,
					// but only for rendering.
					// "starttime" should be used if "thumbtime" isn't present,
					// but only for rendering.
					$thumbtime = WTSUtils::getAttrFromDataMw( $dataMw, 'thumbtime', true );
					$starttime = WTSUtils::getAttrFromDataMw( $dataMw, 'starttime', true );
					if ( $thumbtime || $starttime ) {
						$seek = ( $thumbtime ) ? $thumbtime[ 1 ]->txt : $starttime[ 1 ]->txt;
						$seek = AddMediaInfo::parseTimeString( $seek );
						if ( $seek !== false ) {
							$dims->seek = $seek;
						}
					}

					$ret->i = /* await */ AddMediaInfo::requestInfo( $env, $attrs->title->getKey(), $dims );
					$ret->m = /* await */ AddMediaInfo::manualInfo( $env, $attrs, $dims, $dataMw );
					return $ret;
				}








































			),
			function ( $_, $ret ) {
				$temp0 = $ret; $container = $temp0->container; $dataMw = $temp0->dataMw; $attrs = $temp0->attrs; $i = $temp0->i; $m = $temp0->m;
				$errs = [];

				if ( $i->err !== null ) { $errs[] = $i->err;  }
				if ( $m->err !== null ) { $errs[] = $m->err;  }

				// Add mw:Error to the RDFa type.
				// Add mw:Error to the RDFa type.
				if ( count( $errs ) > 0 ) {
					AddMediaInfo::addErrors( $container, $errs, $dataMw );
					return $_;
				}

				$temp1 = $i; $info = $temp1->info;
				$temp2 = $m; $manualinfo = $temp2->info;

				// T110692: The batching API seems to return these as strings.
				// Till that is fixed, let us make sure these are numbers.
				// (This was fixed in Sep 2015, FWIW.)
				// T110692: The batching API seems to return these as strings.
				// Till that is fixed, let us make sure these are numbers.
				// (This was fixed in Sep 2015, FWIW.)
				$info->height = Number( $info->height );
				$info->width = Number( $info->width );

				$o = null;
				$isImage = false;
				switch ( $info->mediatype ) {
					case 'AUDIO':
					$o = AddMediaInfo::handleAudio( $env, $container, $attrs, $info, $manualinfo, $dataMw );
					break;
					case 'VIDEO':
					$o = AddMediaInfo::handleVideo( $env, $container, $attrs, $info, $manualinfo, $dataMw );
					break;
					default:
					$isImage = true;
					$o = AddMediaInfo::handleImage( $env, $container, $attrs, $info, $manualinfo, $dataMw );
				}
				$temp3 = $o; $rdfaType = $temp3->rdfaType; $elt = $temp3->elt;

				AddMediaInfo::handleLink( $env, $urlParser, $container, $attrs, $dataMw, $isImage );

				$anchor = $container->firstChild;
				$anchor->appendChild( $elt );

				$typeOf = $container->getAttribute( 'typeof' ) || '';
				$typeOf = preg_replace( '/\bmw:(Image)(\/\w*)?\b/', "{$rdfaType}\$2", $typeOf, 1 );
				$container->setAttribute( 'typeof', $typeOf );

				if ( is_array( $dataMw->attribs ) && count( $dataMw->attribs ) === 0 ) {
					unset( $dataMw->attribs );
				}

				return $_;
			}, null
		)


















































		;
	}

	public function run( ...$args ) {
		return AddMediaInfo::addMediaInfo( ...$args );
	}
}

// This pattern is used elsewhere
[ 'addMediaInfo', 'requestInfo', 'manualInfo' ]->forEach( function ( $f ) {
		AddMediaInfo[ $f ] = /* async */AddMediaInfo[ $f ];
	}
);

$module->exports->AddMediaInfo = $AddMediaInfo;
