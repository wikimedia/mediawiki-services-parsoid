<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\PegTokenizer as PegTokenizer;
use Parsoid\Sanitizer as Sanitizer;
use Parsoid\PipelineUtils as PipelineUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\JSUtils as JSUtils;
use Parsoid\KV as KV;
use Parsoid\TagTk as TagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\WikiLinkHandler as WikiLinkHandler;

// shortcuts
$lastItem = JSUtils::lastItem;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ExternalLinkHandler extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->manager->addTransform(
			function ( $token, $cb ) {return $this->onUrlLink( $token, $cb );
   },
			'ExternalLinkHandler:onUrlLink',
			self::rank(), 'tag', 'urllink'
		);
		$this->manager->addTransform(
			function ( $token, $cb ) {return $this->onExtLink( $token, $cb );
   },
			'ExternalLinkHandler:onExtLink',
			self::rank() - 0.001, 'tag', 'extlink'
		);
		$this->manager->addTransform(
			function ( $token, $cb ) {return $this->onEnd( $token, $cb );
   },
			'ExternalLinkHandler:onEnd',
			self::rank(), 'end'
		);

		// Create a new peg parser for image options.
		if ( !$this->urlParser ) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			self::prototype::urlParser = new PegTokenizer( $this->env );
		}

		$this->_reset();
	}
	public $urlParser;

	public static function rank() {
 return 1.15;
 }

	public function _reset() {
		$this->linkCount = 1;
	}

	public static function _imageExtensions( $str ) {
		switch ( $str ) {
			case 'jpg':
			// fall through

			case 'png':
			// fall through

			case 'gif':
			// fall through

			case 'svg':
			// fall through
			return true;
			default:
			return false;
		}
	}

	public function _hasImageLink( $href ) {
		$allowedPrefixes = $this->manager->env->conf->wiki->allowExternalImages;
		$bits = explode( '.', $href );
		$hasImageExtension = count( $bits ) > 1
&& self::_imageExtensions( $lastItem( $bits ) )
&& preg_match( '/^https?:\/\//i', $href );
		// Typical settings for mediawiki configuration variables
		// $wgAllowExternalImages and $wgAllowExternalImagesFrom will
		// result in values like these:
		// allowedPrefixes = undefined; // no external images
		// allowedPrefixes = [''];      // allow all external images
		// allowedPrefixes = ['http://127.0.0.1/', 'http://example.com'];
		// Note that the values include the http:// or https:// protocol.
		// See https://phabricator.wikimedia.org/T53092
		return $hasImageExtension && is_array( $allowedPrefixes )
&& // true iff some prefix in the list matches href
			$allowedPrefixes->some(
				function ( $prefix ) use ( &$href ) {return array_search( $prefix, $href ) === 0;
	   }
			);
	}

	public function onUrlLink( $token, $cb ) {
		$tagAttrs = null;
$builtTag = null;
		$env = $this->manager->env;
		$origHref = $token->getAttribute( 'href' );
		$href = TokenUtils::tokensToString( $origHref );
		$dataAttribs = Util::clone( $token->dataAttribs );

		if ( $this->_hasImageLink( $href ) ) {
			$tagAttrs = [
				new KV( 'src', $href ),
				new KV( 'alt', $lastItem( explode( '/', $href ) ) ),
				new KV( 'rel', 'mw:externalImage' )
			];

			// combine with existing rdfa attrs
			$tagAttrs = WikiLinkHandler::buildLinkAttrs( $token->attribs, false, null, $tagAttrs )->attribs;
			$cb( [ 'tokens' => [ new SelfclosingTagTk( 'img', $tagAttrs, $dataAttribs ) ] ] );
		} else {
			$tagAttrs = [
				new KV( 'rel', 'mw:ExtLink' )
			];

			// combine with existing rdfa attrs
			// href is set explicitly below

			$tagAttrs = WikiLinkHandler::buildLinkAttrs( $token->attribs, false, null, $tagAttrs )->attribs;
			$builtTag = new TagTk( 'a', $tagAttrs, $dataAttribs );
			$dataAttribs->stx = 'url';

			if ( !$this->options->inTemplate ) {
				// Since we messed with the text of the link, we need
				// to preserve the original in the RT data. Or else.
				$builtTag->addNormalizedAttribute( 'href', $href, $token->getWTSource( $env ) );
			} else {
				$builtTag->addAttribute( 'href', $href );
			}

			$cb( [
					'tokens' => [
						$builtTag,
						// Make sure there are no IDN-ignored characters in the text so
						// the user doesn't accidentally copy any.
						Sanitizer::cleanUrl( $env, $href ),
						new EndTagTk( 'a', [], [ 'tsr' => [ $dataAttribs->tsr[ 1 ], $dataAttribs->tsr[ 1 ] ] ] )
					]
				]
			);
		}
	}

	// Bracketed external link
	public function onExtLink( $token, $cb ) {
		$newAttrs = null;
$aStart = null;
		$env = $this->manager->env;
		$origHref = $token->getAttribute( 'href' );
		$hasExpandedAttrs = preg_match( '/mw:ExpandedAttrs/', $token->getAttribute( 'typeof' ) );
		$href = TokenUtils::tokensToString( $origHref );
		$hrefWithEntities = TokenUtils::tokensToString( $origHref, false, [
				'includeEntities' => true
			]
		);
		$content = $token->getAttribute( 'mw:content' );
		$dataAttribs = Util::clone( $token->dataAttribs );
		$rdfaType = $token->getAttribute( 'typeof' );
		$magLinkRe = /* RegExp */ '/(?:^|\s)(mw:(?:Ext|Wiki)Link\/(?:ISBN|RFC|PMID))(?=$|\s)/';
		$tokens = null;

		if ( $rdfaType && preg_match( $magLinkRe, $rdfaType ) ) {
			$newHref = $href;
			$newRel = 'mw:ExtLink';
			if ( preg_match( '/(?:^|\s)mw:(Ext|Wiki)Link\/ISBN/', $rdfaType ) ) {
				$newHref = $env->page->relativeLinkPrefix + $href;
				// ISBNs use mw:WikiLink instead of mw:ExtLink
				$newRel = 'mw:WikiLink';
			}
			$newAttrs = [
				new KV( 'href', $newHref ),
				new KV( 'rel', $newRel )
			];
			$token->removeAttribute( 'typeof' );

			// SSS FIXME: Right now, Parsoid does not support templating
			// of ISBN attributes.  So, "ISBN {{echo|1234567890}}" will not
			// parse as you might expect it to.  As a result, this code below
			// that attempts to combine rdf attrs from earlier is unnecessary
			// right now.  But, it will become necessary if Parsoid starts
			// supporting templating of ISBN attributes.
			//
			// combine with existing rdfa attrs
			$newAttrs = WikiLinkHandler::buildLinkAttrs( $token->attribs, false, null, $newAttrs )->attribs;
			$aStart = new TagTk( 'a', $newAttrs, $dataAttribs );
			$tokens = [ $aStart ]->concat( $content, [ new EndTagTk( 'a' ) ] );
			$cb( [
					'tokens' => $tokens
				]
			);
		} elseif (
			( !$hasExpandedAttrs && gettype( $origHref ) === 'string' )
|| $this->urlParser->tokenizesAsURL( $hrefWithEntities )
		) {
			$rdfaType = 'mw:ExtLink';
			if (
				count( $content ) === 1
&& $content[ 0 ]->constructor === $String
&& $env->conf->wiki->hasValidProtocol( $content[ 0 ] )
&& $this->urlParser->tokenizesAsURL( $content[ 0 ] )
&& $this->_hasImageLink( $content[ 0 ] )
			) {
				$src = $content[ 0 ];
				$content = [
					new SelfclosingTagTk( 'img', [
							new KV( 'src', $src ),
							new KV( 'alt', $lastItem( explode( '/', $src ) ) )
						], [ 'type' => 'extlink' ]
					)
				];
			}

			$newAttrs = [
				new KV( 'rel', $rdfaType )
			];
			// combine with existing rdfa attrs
			// href is set explicitly below

			$newAttrs = WikiLinkHandler::buildLinkAttrs( $token->attribs, false, null, $newAttrs )->attribs;
			$aStart = new TagTk( 'a', $newAttrs, $dataAttribs );

			if ( !$this->options->inTemplate ) {
				// If we are from a top-level page, add normalized attr info for
				// accurate roundtripping of original content.
				//
				// extLinkContentOffsets[0] covers all spaces before content
				// and we need src without those spaces.
				$tsr0a = $dataAttribs->tsr[ 0 ] + 1;
				$tsr1a = $dataAttribs->extLinkContentOffsets[ 0 ] - count( $token->getAttribute( 'spaces' ) || '' );
				$aStart->addNormalizedAttribute( 'href', $href, substr( $env->page->src, $tsr0a, $tsr1a/*CHECK THIS*/ ) );
			} else {
				$aStart->addAttribute( 'href', $href );
			}

			$content = PipelineUtils::getDOMFragmentToken(
				$content,
				( $dataAttribs->tsr ) ? $dataAttribs->extLinkContentOffsets : null,
				[ 'inlineContext' => true, 'token' => $token ]
			);

			$tokens = [ $aStart ]->concat( $content, [ new EndTagTk( 'a' ) ] );
			$cb( [
					'tokens' => $tokens
				]
			);
		} else {
			// Not a link, convert href to plain text.
			$cb( [ 'tokens' => WikiLinkHandler::bailTokens( $env, $token, true ) ] );
		}
	}

	public function onEnd( $token, $cb ) {
		$this->_reset();
		$cb( [ 'tokens' => [ $token ] ] );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->ExternalLinkHandler = $ExternalLinkHandler;
}
