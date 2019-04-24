<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTUtils as WTUtils;
use Parsoid\TagHandlers as TagHandlers;

use Parsoid\DOMHandler as DOMHandler;
use Parsoid\FallbackHTMLHandler as FallbackHTMLHandler;

function ClientError( $message ) {
	Error::captureStackTrace( $this, $ClientError );
	$this->name = 'Bad Request';
	$this->message = $message || 'Bad Request';
	$this->httpStatus = 400;
	$this->suppressLoggingStack = true;
}
ClientError::prototype = Error::prototype;

class EncapsulatedContentHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
		$this->parentMap = [
			'LI' => [ 'UL' => 1, 'OL' => 1 ],
			'DT' => [ 'DL' => 1 ],
			'DD' => [ 'DL' => 1 ]
		];
	}
	public $parentMap;

	public function handleG( $node, $state, $wrapperUnmodified ) {
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
		if ( $dataMw->extPrefix || $dataMw->extSuffix ) {
			$src = ( $dataMw->extPrefix || '' ) + $src + ( $dataMw->extSuffix || '' );
		}
		$self->emitWikitext( $this->handleListPrefix( $node, $state ) + $src, $node );
		array_pop( $state->singleLineContext );
		return WTUtils::skipOverEncapsulatedContent( $node );
	}
	// XXX: This is questionable, as the template can expand
	// to newlines too. Which default should we pick for new
	// content? We don't really want to make separator
	// newlines in HTML significant for the semantics of the
	// template content.
	public function before( $node, $otherNode, $state ) {
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
			$h = tagHandlers::get( $nodeName );
			if ( !$h && $dp->stx === 'html' && $nodeName !== 'a' ) {
				$h = new FallbackHTMLHandler();
			}
			if ( $h ) {
				return $h->before( $node, $otherNode, $state );
			}
		}

		// default behavior
		return [ 'min' => 0, 'max' => 2 ];
	}

	public function handleListPrefix( $node, $state ) {
		$bullets = '';
		if ( DOMUtils::isListOrListItem( $node )
&& !$this->parentBulletsHaveBeenEmitted( $node )
&& !DOMUtils::previousNonSepSibling( $node ) && // Maybe consider parentNode.
				$this->isTplListWithoutSharedPrefix( $node )
&& // Nothing to do for definition list rows,
				// since we're emitting for the parent node.
				!( $node->nodeName === 'DD'
&& DOMDataUtils::getDataParsoid( $node )->stx === 'row' )
		) {
			$bullets = $this->getListBullets( $state, $node->parentNode );
		}
		return $bullets;
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
	public function isTplListWithoutSharedPrefix( $node ) {
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

	public function parentBulletsHaveBeenEmitted( $node ) {
		if ( WTUtils::isLiteralHTMLNode( $node ) ) {
			return true;
		} elseif ( DOMUtils::isList( $node ) ) {
			return !DOMUtils::isListItem( $node->parentNode );
		} else {
			Assert::invariant( DOMUtils::isListItem( $node ) );
			$parentNode = $node->parentNode;
			// Skip builder-inserted wrappers
			while ( $this->isBuilderInsertedElt( $parentNode ) ) {
				$parentNode = $parentNode->parentNode;
			}
			return !( isset( $this->parentMap[ $node->nodeName ][ $parentNode->nodeName ] ) );
		}
	}
}

$module->exports = $EncapsulatedContentHandler;
