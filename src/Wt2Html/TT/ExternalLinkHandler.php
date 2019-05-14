<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\TT;

use Parsoid\Utils\Util;
use Parsoid\Utils\TokenUtils;
use Parsoid\Tokens\KV;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\SelfclosingTagTk;
use Parsoid\Wt2Html\PegTokenizer;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\Token;
use Parsoid\Utils\PipelineUtils;

class ExternalLinkHandler extends TokenHandler {
	private $urlParser;
	private $linkCount;

	/** @inheritDoc */
	public function __construct( object $manager, array $options ) {
		parent::__construct( $manager, $options );

		// Create a new peg parser for image options.
		if ( !$this->urlParser ) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			$this->urlParser = new PegTokenizer( $this->env );
		}

		$this->reset();
	}

	/** @inheritDoc */
	public function onEnd( EOFTk $token ) {
		$this->reset();
		return $token;
	}

	private function reset(): void {
		$this->linkCount = 1;
	}

	/**
	 * @param string $str
	 * @return bool
	 */
	private static function imageExtensions( string $str ): bool {
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

	/**
	 * @param array $array
	 * @param callable $fn
	 * @return bool
	 */
	private function arraySome( array $array, callable $fn ): bool {
		foreach ( $array as $value ) {
			if ( $fn( $value ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @param string $href
	 * @return bool
	 */
	private function hasImageLink( string $href ): bool {
		$allowedPrefixes = $this->manager->env->allowedExternalImagePrefixes();
		$bits = explode( '.', $href );
		$hasImageExtension = count( $bits ) > 1 &&
			self::imageExtensions( end( $bits ) ) &&
			preg_match( '/^https?:\/\//i', $href );
		// Typical settings for mediawiki configuration variables
		// $wgAllowExternalImages and $wgAllowExternalImagesFrom will
		// result in values like these:
		//  allowedPrefixes = undefined; // no external images
		//  allowedPrefixes = [''];      // allow all external images
		//  allowedPrefixes = ['http://127.0.0.1/', 'http://example.com'];
		// Note that the values include the http:// or https:// protocol.
		// See https://phabricator.wikimedia.org/T53092
		return $hasImageExtension && is_array( $allowedPrefixes ) &&
			// true if some prefix in the list matches href
				self::arraySome( $allowedPrefixes, function ( $prefix ) use ( &$href ) {
					return strpos( $prefix, $href ) !== false;
				}
			);
	}

	/**
	 * @param Token $token
	 * @return Token|array
	 */
	private function onUrlLink( Token $token ) {
		$tagAttrs = null;
		$builtTag = null;
		$env = $this->manager->env;
		$origHref = $token->getAttribute( 'href' );
		$href = TokenUtils::tokensToString( $origHref );
		$dataAttribs = Util::clone( $token->dataAttribs );

		if ( $this->hasImageLink( $href ) ) {
			$checkAlt = explode( '/', $href );
			$tagAttrs = [
				new KV( 'src', $href ),
				new KV( 'alt', end( $checkAlt ) ),
				new KV( 'rel', 'mw:externalImage' )
			];

			// combine with existing rdfa attrs
			// PORT-FIXME
			// $tagAttrs = WikiLinkHandler::buildLinkAttrs(
			//        $token->attribs, false, null, $tagAttrs )->attribs;
			$tagAttrs = [];
			return [ 'tokens' => [ new SelfclosingTagTk( 'img', $tagAttrs, $dataAttribs ) ] ];
		} else {
			$tagAttrs = [
				new KV( 'rel', 'mw:ExtLink' )
			];

			// combine with existing rdfa attrs
			// href is set explicitly below
			// PORT-FIXME
			// $tagAttrs = WikiLinkHandler::buildLinkAttrs(
			//        $token->attribs, false, null, $tagAttrs )->attribs;
			$tagAttrs = [];
			$builtTag = new TagTk( 'a', $tagAttrs, $dataAttribs );
			$dataAttribs->stx = 'url';

			if ( !$this->options[ 'inTemplate' ] ) {
				// Since we messed with the text of the link, we need
				// to preserve the original in the RT data. Or else.
				$builtTag->addNormalizedAttribute( 'href', $href, $token->getWTSource( $env ) );
			} else {
				$builtTag->addAttribute( 'href', $href );
			}

			return [ 'tokens' => [
					$builtTag,
					// Make sure there are no IDN-ignored characters in the text so
					// the user doesn't accidentally copy any.
					Sanitizer::cleanUrl( $env, $href, '' ),   // mode could be 'wikilink'
					new EndTagTk( 'a', [],
						(object)[ 'tsr' => [ $dataAttribs->tsr[1], $dataAttribs->tsr[1] ] ] )
				]
			];
		}
	}

	/**
	 * Bracketed external link
	 * @param Token $token
	 * @return Token|array
	 */
	private function onExtLink( Token $token ) {
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
			// PORT-FIXME
			// $newAttrs = WikiLinkHandler::buildLinkAttrs(
			//        $token->attribs, false, null, $newAttrs )->attribs;
			$newAttrs = [];
			$aStart = new TagTk( 'a', $newAttrs, $dataAttribs );
			$tokens = array_merge( [ $aStart ], $content, [ new EndTagTk( 'a' ) ] );
			return [ 'tokens' => $tokens ];
		} elseif ( ( !$hasExpandedAttrs && gettype( $origHref ) === 'string' ) ||
					$this->urlParser->tokenizeURL( $hrefWithEntities ) !== false ) {
			$rdfaType = 'mw:ExtLink';
			if ( count( $content ) === 1 ) {
				if ( is_string( $content[ 0 ] ) ) {
					$src = $content[ 0 ];
					if ( $env->conf->wiki->hasValidProtocol( $src ) &&
						$this->urlParser->tokenizeURL( $src ) !== false &&
						$this->hasImageLink( $src )
					) {
						$checkAlt = explode( '/', $src );
						$content = [ new SelfclosingTagTk( 'img', [
							new KV( 'src', $src ),
							new KV( 'alt', end( $checkAlt ) )
							], (object)[ 'type' => 'extlink' ]
						)
						];
					}
				}
			}

			$newAttrs = [ new KV( 'rel', $rdfaType ) ];
			// combine with existing rdfa attrs
			// href is set explicitly below
			// PORT-FIXME
			// $newAttrs = WikiLinkHandler::buildLinkAttrs(
			//        $token->attribs, false, null, $newAttrs )->attribs;
			$newAttrs = [];
			$aStart = new TagTk( 'a', $newAttrs, $dataAttribs );

			if ( empty( $this->options[ 'inTemplate' ] ) ) {
				// If we are from a top-level page, add normalized attr info for
				// accurate roundtripping of original content.
				//
				// extLinkContentOffsets[0] covers all spaces before content
				// and we need src without those spaces.
				$tsr0a = $dataAttribs->tsr[ 0 ] + 1;
				$tsr1a = $dataAttribs->extLinkContentOffsets[ 0 ] -
					strlen( $token->getAttribute( 'spaces' ) || '' );
				$length = $tsr1a - $tsr0a;
				$aStart->addNormalizedAttribute( 'href', $href,
					substr( $env->getPageMainContent(), $tsr0a, $length ) );
			} else {
				$aStart->addAttribute( 'href', $href );
			}

			$content = PipelineUtils::getDOMFragmentToken(
				$content,
				( $dataAttribs->tsr ) ? $dataAttribs->extLinkContentOffsets : null,
				[ 'inlineContext' => true, 'token' => $token ]
			);

			$tokens = array_merge( [ $aStart ], [ $content ], [ new EndTagTk( 'a' ) ] );
			return [ 'tokens' => $tokens ];
		} else {
			// PORT-FIXME
			// Not a link, convert href to plain text.
			// return [ 'tokens' => WikiLinkHandler::bailTokens( $env, $token, true ) ];
			return [];
		}
	}

	/** @inheritDoc */
	public function onTag( Token $token ): Token {
		switch ( $token->getName() ) {
			case 'urllink':
				return $this->onUrlLink( $token );
			case 'extlink':
				return $this->onExtLink( $token );
			default:
				return $token;
		}
	}

}
