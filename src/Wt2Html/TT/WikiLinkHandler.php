<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 * @module
 */

namespace Parsoid;

use Parsoid\PegTokenizer as PegTokenizer;
use Parsoid\WikitextConstants as WikitextConstants;
use Parsoid\Sanitizer as Sanitizer;
use Parsoid\ContentUtils as ContentUtils;
use Parsoid\PipelineUtils as PipelineUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\Util as Util;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\KV as KV;
use Parsoid\EOFTk as EOFTk;
use Parsoid\TagTk as TagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\Token as Token;
use Parsoid\AddMediaInfo as AddMediaInfo;

// shortcuts

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class WikiLinkHandler extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		// Handle redirects first (since they used to emit additional link tokens)
		$this->manager->addTransformP( $this, $this->onRedirect,
			'WikiLinkHandler:onRedirect', self::rank(), 'tag', 'mw:redirect'
		);

		// Now handle regular wikilinks.
		$this->manager->addTransformP( $this, $this->onWikiLink,
			'WikiLinkHandler:onWikiLink', self::rank() + 0.001, 'tag', 'wikilink'
		);

		// Create a new peg parser for image options.
		if ( !$this->urlParser ) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			self::prototype::urlParser = new PegTokenizer( $this->env );
		}
	}
	public $urlParser;

	public static function rank() {
 return 1.15; /* after AttributeExpander */
 }

	public static function _hrefParts( $str ) {
		$m = preg_match( '/^([^:]+):(.*)$/', $str );
		return $m && [ 'prefix' => $m[ 1 ], 'title' => $m[ 2 ] ];
	}

	/**
	 * Normalize and analyze a wikilink target.
	 *
	 * Returns an object containing
	 * - href: The expanded target string
	 * - hrefSrc: The original target wikitext
	 * - title: A title object *or*
	 * - language: An interwikiInfo object *or*
	 * - interwiki: An interwikiInfo object.
	 * - localprefix: Set if the link had a localinterwiki prefix (or prefixes)
	 * - fromColonEscapedText: Target was colon-escaped ([[:en:foo]])
	 * - prefix: The original namespace or language/interwiki prefix without a
	 *   colon escape.
	 *
	 * @return Object The target info.
	 */
	public function getWikiLinkTargetInfo( $token, $hrefKV ) {
		$env = $this->manager->env;

		$info = [
			'href' => TokenUtils::tokensToString( $hrefKV->v ),
			'hrefSrc' => $hrefKV->vsrc
		];

		if ( is_array( $hrefKV->v ) && $hrefKV->v->some( function ( $t ) use ( &$Token, &$TokenUtils, &$env, &$token, &$DOMUtils ) {
						if ( $t instanceof Token::class
&& TokenUtils::isDOMFragmentType( $t->getAttribute( 'typeof' ) )
						) {
							$firstNode = $env->fragmentMap->get( $token->dataAttribs->html )[ 0 ];
							return $firstNode && DOMUtils::isElt( $firstNode )
&& preg_match( '/\bmw:(Nowiki|Extension)/', $firstNode->getAttribute( 'typeof' ) );
						}
						return false;
		}
				)
		) {
			throw new Error( 'Xmlish tags in title position are invalid.' );
		}

		if ( preg_match( '/^:/', $info->href ) ) {
			$info->fromColonEscapedText = true;
			// remove the colon escape
			$info->href = substr( $info->href, 1 );
		}
		if ( preg_match( '/^:/', $info->href ) ) {
			if ( $env->conf->parsoid->linting ) {
				$lint = [
					'dsr' => $token->dataAttribs->tsr,
					'params' => [ 'href' => ':' . $info->href ],
					'templateInfo' => null
				];
				if ( $this->options->inTemplate ) {
					// `frame.title` is already the result of calling
					// `getPrefixedDBKey`, but for the sake of consistency with
					// `findEnclosingTemplateName`, we do a little more work to
					// match `env.makeLink`.
					$name = preg_replace(

						'/^\.\//', '', Sanitizer::sanitizeTitleURI(
							$env->page->relativeLinkPrefix + $this->manager->frame->title,
							false
						), 1
					);
					$lint->templateInfo = [ 'name' => $name ];
					// TODO(arlolra): Pass tsr info to the frame
					$lint->dsr = [ 0, 0 ];
				}
				$env->log( 'lint/multi-colon-escape', $lint );
			}
			// This will get caught by the caller, and mark the target as invalid
			throw new Error( 'Multiple colons prefixing href.' );
		}

		$title = $env->resolveTitle( Util::decodeURIComponent( $info->href ) );
		$hrefBits = self::_hrefParts( $info->href );
		if ( $hrefBits ) {
			$nsPrefix = $hrefBits->prefix;
			$info->prefix = $nsPrefix;
			$nnn = Util::normalizeNamespaceName( trim( $nsPrefix ) );
			$interwikiInfo = $env->conf->wiki->interwikiMap->get( $nnn );
			// check for interwiki / language links
			$ns = $env->conf->wiki->namespaceIds->get( $nnn );
			// also check for url to protect against [[constructor:foo]]
			if ( $ns !== null ) {
				$info->title = $env->makeTitleFromURLDecodedStr( $title );
			} elseif ( $interwikiInfo && $interwikiInfo->localinterwiki !== null ) {
				if ( $hrefBits->title === '' ) {
					// Empty title => main page (T66167)
					$info->title = $env->makeTitleFromURLDecodedStr( $env->conf->wiki->mainpage );
				} else {
					$info->href = $hrefBits->title;
					// Recurse!
					$hrefKV = new KV( 'href', ( ( preg_match( '/:/', $info->href ) ) ? ':' : '' ) + $info->href );
					$hrefKV->vsrc = $info->hrefSrc;
					$info = $this->getWikiLinkTargetInfo( $token, $hrefKV );
					$info->localprefix = $nsPrefix
+ ( ( $info->localprefix ) ? ( ':' . $info->localprefix ) : '' );
				}
			} elseif ( $interwikiInfo && $interwikiInfo->url ) {
				$info->href = $hrefBits->title;
				// Ensure a valid title, even though we're discarding the result
				$env->makeTitleFromURLDecodedStr( $title );
				// Interwiki or language link? If no language info, or if it starts
				// with an explicit ':' (like [[:en:Foo]]), it's not a language link.
				if ( $info->fromColonEscapedText
|| ( $interwikiInfo->language === null && $interwikiInfo->extralanglink === null )
				) {
					// An interwiki link.
					$info->interwiki = $interwikiInfo;
				} else {
					// A language link.
					$info->language = $interwikiInfo;
				}
			} else {
				$info->title = $env->makeTitleFromURLDecodedStr( $title );
			}
		} else {
			$info->title = $env->makeTitleFromURLDecodedStr( $title );
		}

		return $info;
	}

	/**
	 * Handle mw:redirect tokens.
	 */
	public function onRedirectG( $token ) {
		// Avoid duplicating the link-processing code by invoking the
		// standard onWikiLink handler on the embedded link, intercepting
		// the generated tokens using the callback mechanism, reading
		// the href from the result, and then creating a
		// <link rel="mw:PageProp/redirect"> token from it.

		$rlink = new SelfclosingTagTk( 'link', Util::clone( $token->attribs ), Util::clone( $token->dataAttribs ) );
		$wikiLinkTk = $rlink->dataAttribs->linkTk;
		$rlink->setAttribute( 'rel', 'mw:PageProp/redirect' );

		// Remove the nested wikiLinkTk token and the cloned href attribute
		$rlink->dataAttribs->linkTk = null;
		$rlink->removeAttribute( 'href' );

		// Transfer href attribute back to wikiLinkTk, since it may have been
		// template-expanded in the pipeline prior to this point.
		$wikiLinkTk->attribs = Util::clone( $token->attribs );

		// Set "redirect" attribute on the wikilink token to indicate that
		// image and category links should be handled as plain links.
		$wikiLinkTk->setAttribute( 'redirect', 'true' );

		// Render the wikilink (including interwiki links, etc) then collect
		// the resulting href and transfer it to rlink.
		$r = /* await */ $this->onWikiLink( $wikiLinkTk );
		$isValid = $r && $r->tokens && $r->tokens[ 0 ]
&& preg_match( '/^(a|link)$/', $r->tokens[ 0 ]->name );
		if ( $isValid ) {
			$da = $r->tokens[ 0 ]->dataAttribs;
			$rlink->addNormalizedAttribute( 'href', $da->a->href, $da->sa->href );
			return [ 'tokens' => [ $rlink ] ];
		} else {
			// Bail!  Emit tokens as if they were parsed as a list item:
			// #REDIRECT....
			$src = $rlink->dataAttribs->src;
			$tsr = $rlink->dataAttribs->tsr;
			$srcMatch = /*RegExp#exec*/preg_match( '/^([^#]*)(#)/', $src, $FIXME );
			$ntokens = ( count( $srcMatch[ 1 ] ) ) ? [ $srcMatch[ 1 ] ] : [];
			$hashPos = $tsr[ 0 ] + count( $srcMatch[ 1 ] );
			$li = new TagTk( 'listItem', [ new KV( 'bullets', [ '#' ] ) ], [ 'tsr' => [ $hashPos, $hashPos + 1 ] ] );
			$ntokens[] = $li;
			$ntokens[] = array_slice( $src, count( $srcMatch[ 0 ] ) );
			return [ 'tokens' => $ntokens->concat( $r->tokens ) ];
		}
	}

	public static function bailTokens( $env, $token, $isExtLink ) {
		$count = ( $isExtLink ) ? 1 : 2;
		$tokens = [ '['->repeat( $count ) ];
		$content = [];

		if ( $isExtLink ) {
			// FIXME: Use this attribute in regular extline
			// cases to rt spaces correctly maybe?  Unsure
			// it is worth it.
			$spaces = $token->getAttribute( 'spaces' ) || '';
			if ( count( $spaces ) ) { $content[] = $spaces;
   }

			$mwc = $token->getAttribute( 'mw:content' );
			if ( count( $mwc ) ) { $content = $content->concat( $mwc );
   }
		} else {
			$token->attribs->forEach( function ( $a ) {
					if ( $a->k === 'mw:maybeContent' ) {
						$content = $content->concat( '|', $a->v );
					}
			}
			);
		}

		$dft = null;
		if ( preg_match( '/mw:ExpandedAttrs/', $token->getAttribute( 'typeof' ) ) ) {
			$dataMW = json_decode( $token->getAttribute( 'data-mw' ) )->attribs;
			$html = null;
			for ( $i = 0;  $i < count( $dataMW );  $i++ ) {
				if ( $dataMW[ $i ][ 0 ]->txt === 'href' ) {
					$html = $dataMW[ $i ][ 1 ]->html;
					break;
				}
			}

			// Since we are splicing off '['s and ']'s from the incoming token,
			// adjust TSR of the DOM-fragment by `count` each on both end.
			$tsr = $token->dataAttribs && $token->dataAttribs->tsr;
			if ( $tsr && gettype( $tsr[ 0 ] ) === 'number' && gettype( $tsr[ 1 ] ) === 'number' ) {
				// If content is present, the fragment we're building doesn't
				// extend all the way to the end of the token, so the end tsr
				// is invalid.
				$end = ( count( $content ) > 0 ) ? null : $tsr[ 1 ] - $count;
				$tsr = [ $tsr[ 0 ] + $count, $end ];
			} else {
				$tsr = null;
			}

			$body = ContentUtils::ppToDOM( $env, $html );
			$dft = PipelineUtils::buildDOMFragmentTokens( $env, $token, $body, [
					'tsr' => $tsr,
					'pipelineOpts' => [ 'inlineContext' => true ]
				]
			);
		} else {
			$dft = $token->getAttribute( 'href' );
		}

		$tokens = $tokens->concat( $dft, $content, ']'->repeat( $count ) );
		return $tokens;
	}

	/**
	 * Handle a mw:WikiLink token.
	 */
	public function onWikiLinkG( $token ) {
		$env = $this->manager->env;
		$hrefKV = KV::lookupKV( $token->attribs, 'href' );
		$target = null;

		try {
			$target = $this->getWikiLinkTargetInfo( $token, $hrefKV );
		} catch ( Exception $e ) {
			// Invalid title
			$target = null;
		}

		if ( !$target ) {
			return [ 'tokens' => self::bailTokens( $env, $token, false ) ];
		}

		// First check if the expanded href contains a pipe.
		if ( preg_match( '/[|]/', $target->href ) ) {
			// It does. This 'href' was templated and also returned other
			// parameters separated by a pipe. We don't have any sane way to
			// handle such a construct currently, so prevent people from editing
			// it.
			// TODO: add useful debugging info for editors ('if you would like to
			// make this content editable, then fix template X..')
			// TODO: also check other parameters for pipes!
			return [ 'tokens' => TokenUtils::placeholder( null, $token->dataAttribs ) ];
		}

		// Don't allow internal links to pages containing PROTO:
		// See Parser::replaceInternalLinks2()
		if ( $env->conf->wiki->hasValidProtocol( $target->href ) ) {
			// NOTE: Tokenizing this as src seems little suspect
			$src = '[' . array_reduce( array_slice( $token->attribs, 1 ), function ( $prev, $next ) {
						return $prev . '|' . TokenUtils::tokensToString( $next->v );
			}, $target->href
				)

			 . ']';

			$extToks = $this->urlParser->tokenizeExtlink( $src, /* sol */true );
			if ( !( $extToks instanceof $Error ) ) {
				$tsr = $token->dataAttribs && $token->dataAttribs->tsr;
				TokenUtils::shiftTokenTSR( $extToks, 1 + ( ( $tsr ) ? $tsr[ 0 ] : 0 ) );
			} else {
				$extToks = $src;
			}

			$tokens = [ '[' ]->concat( $extToks, ']' );
			$tokens->rank = self::rank() - 0.002; // Magic rank, since extlink is -0.001
			return [ 'tokens' => $tokens ];
		}

		// Ok, it looks like we have a sane href. Figure out which handler to use.
		$isRedirect = (bool)$token->getAttribute( 'redirect' );
		return ( /* await */ $this->_wikiLinkHandler( $token, $target, $isRedirect ) );
	}

	/**
	 * Figure out which handler to use to render a given WikiLink token. Override
	 * this method to add new handlers or swap out existing handlers based on the
	 * target structure.
	 */
	public function _wikiLinkHandler( $token, $target, $isRedirect ) {
		$title = $target->title;
		if ( $title ) {
			if ( $isRedirect ) {
				return $this->renderWikiLink( $token, $target );
			}
			if ( $title->getNamespace()->isMedia() ) {
				// Render as a media link.
				return $this->renderMedia( $token, $target );
			}
			if ( !$target->fromColonEscapedText ) {
				if ( $title->getNamespace()->isFile() ) {
					// Render as a file.
					return $this->renderFile( $token, $target );
				}
				if ( $title->getNamespace()->isCategory() ) {
					// Render as a category membership.
					return $this->renderCategory( $token, $target );
				}
			}
			// Render as plain wiki links.
			return $this->renderWikiLink( $token, $target );

			// language and interwiki links
		} else {
			if ( $target->interwiki ) {
				return $this->renderInterwikiLink( $token, $target );
			} elseif ( $target->language ) {
				$noLanguageLinks = $this->env->page->title->getNamespace()->isATalkNamespace()
|| !$this->env->conf->wiki->interwikimagic;
				if ( $noLanguageLinks ) {
					$target->interwiki = $target->language;
					return $this->renderInterwikiLink( $token, $target );
				} else {
					return $this->renderLanguageLink( $token, $target );
				}
			}
		}

		// Neither a title, nor a language or interwiki. Should not happen.
		throw new Error( 'Unknown link type' );
	}

	/* ------------------------------------------------------------
	* This (overloaded) function does three different things:
	* - Extracts link text from attrs (when k === "mw:maybeContent").
	*   As a performance micro-opt, only does if asked to (getLinkText)
	* - Updates existing rdfa type with an additional rdf-type,
	*   if one is provided (rdfaType)
	* - Collates about, typeof, and linkAttrs into a new attr. array
	* ------------------------------------------------------------ */
	public static function buildLinkAttrs( $attrs, $getLinkText, $rdfaType, $linkAttrs ) {
		$newAttrs = [];
		$linkTextKVs = [];
		$about = null;

		// In one pass through the attribute array, fetch about, typeof, and linkText
		//
		// about && typeof are usually at the end of the array if at all present
		for ( $i = 0,  $l = count( $attrs );  $i < $l;  $i++ ) {
			$kv = $attrs[ $i ];
			$k = $kv->k;
			$v = $kv->v;

			// link-text attrs have the key "maybeContent"
			if ( $getLinkText && $k === 'mw:maybeContent' ) {
				$linkTextKVs[] = $kv;
			} elseif ( $k->constructor === $String && $k ) {
				if ( trim( $k ) === 'typeof' ) {
					$rdfaType = ( $rdfaType ) ? $rdfaType . ' ' . $v : $v;
				} elseif ( trim( $k ) === 'about' ) {
					$about = $v;
				} elseif ( trim( $k ) === 'data-mw' ) {
					$newAttrs[] = $kv;
				}
			}
		}

		if ( $rdfaType ) {
			$newAttrs[] = new KV( 'typeof', $rdfaType );
		}

		if ( $about ) {
			$newAttrs[] = new KV( 'about', $about );
		}

		if ( $linkAttrs ) {
			$newAttrs = $newAttrs->concat( $linkAttrs );
		}

		return [
			'attribs' => $newAttrs,
			'contentKVs' => $linkTextKVs,
			'hasRdfaType' => $rdfaType !== null
		];
	}

	/**
	 * Generic wiki link attribute setup on a passed-in new token based on the
	 * wikilink token and target. As a side effect, this method also extracts the
	 * link content tokens and returns them.
	 *
	 * @return Array Content tokens.
	 */
	public function addLinkAttributesAndGetContent( $newTk, $token, $target, $buildDOMFragment ) {
		$attribs = $token->attribs;
		$dataAttribs = $token->dataAttribs;
		$newAttrData = self::buildLinkAttrs( $attribs, true, null, [ new KV( 'rel', 'mw:WikiLink' ) ] );
		$content = $newAttrData->contentKVs;
		$env = $this->manager->env;

		// Set attribs and dataAttribs
		$newTk->attribs = $newAttrData->attribs;
		$newTk->dataAttribs = Util::clone( $dataAttribs );
		$newTk->dataAttribs->src = null; // clear src string since we can serialize this

		// Note: Link tails are handled on the DOM in handleLinkNeighbours, so no
		// need to handle them here.
		if ( count( $content ) > 0 ) {
			$newTk->dataAttribs->stx = 'piped';
			$out = [];
			$l = count( $content );
			// re-join content bits
			for ( $i = 0;  $i < $l;  $i++ ) {
				$toks = $content[ $i ]->v;
				// since this is already a link, strip autolinks from content
				if ( !is_array( $toks ) ) { $toks = [ $toks ];
	   }
				$toks = $toks->filter( function ( $t ) {return $t !== '';
	   } );
				$toks = array_map( $toks, function ( $t, $j ) {
						if ( $t->constructor === $TagTk && $t->name === 'a' ) {
							if ( $toks[ $j + 1 ] && $toks[ $j + 1 ]->constructor === $EndTagTk
&& $toks[ $j + 1 ]->name === 'a'
							) {
								// autonumbered links in the stream get rendered
								// as an <a> tag with no content -- but these ought
								// to be treated as plaintext since we don't allow
								// nested links.
								return '[' . $t->getAttribute( 'href' ) . ']';
							}
							return ''; // suppress <a>
						}// suppress <a>

						if ( $t->constructor === $EndTagTk && $t->name === 'a' ) {
							return ''; // suppress </a>
						}// suppress </a>

						return $t;
				}
				);
				$toks = $toks->filter( function ( $t ) {return $t !== '';
	   } );
				$out = $out->concat( $toks );
				if ( $i < $l - 1 ) {
					$out[] = '|';
				}
			}

			if ( $buildDOMFragment ) {
				// content = [part 0, .. part l-1]
				// offsets = [start(part-0), end(part l-1)]
				$offsets = ( $dataAttribs->tsr ) ? [ $content[ 0 ]->srcOffsets[ 0 ], $content[ $l - 1 ]->srcOffsets[ 1 ] ] : null;
				$content = [ PipelineUtils::getDOMFragmentToken( $out, $offsets, [ 'inlineContext' => true, 'token' => $token ] ) ];
			} else {
				$content = $out;
			}
		} else {
			$newTk->dataAttribs->stx = 'simple';
			$morecontent = Util::decodeURIComponent( $target->href );

			// Strip leading colon
			$morecontent = preg_replace( '/^:/', '', $morecontent, 1 );

			// Try to match labeling in core
			if ( $env->conf->wiki->namespacesWithSubpages[ $env->page->ns ] ) {
				// subpage links with a trailing slash get the trailing slashes stripped.
				// See https://gerrit.wikimedia.org/r/173431
				$match = preg_match( '/^((\.\.\/)+|\/)(?!\.\.\/)(.*?[^\/])\/+$/', $morecontent );
				if ( $match ) {
					$morecontent = $match[ 3 ];
				} elseif ( preg_match( '/^\.\.\//', $morecontent ) ) {
					$morecontent = $env->resolveTitle( $morecontent );
				}
			}

			// for interwiki links, include the interwiki prefix in the link text
			if ( $target->interwiki ) {
				$morecontent = $target->prefix . ':' . $morecontent;
			}

			// for local links, include the local prefix in the link text
			if ( $target->localprefix ) {
				$morecontent = $target->localprefix . ':' . $morecontent;
			}

			$content = [ $morecontent ];
		}
		return $content;
	}

	/**
	 * Render a plain wiki link.
	 */
	public function renderWikiLinkG( $token, $target ) {
 // eslint-disable-line require-yield
		$newTk = new TagTk( 'a' );
		$content = $this->addLinkAttributesAndGetContent( $newTk, $token, $target, true );

		$newTk->addNormalizedAttribute( 'href', $this->env->makeLink( $target->title ), $target->hrefSrc );

		// Add title unless it's just a fragment
		if ( $target->href[ 0 ] !== '#' ) {
			$newTk->setAttribute( 'title', $target->title->getPrefixedText() );
		}

		return [ 'tokens' => [ $newTk ]->concat( $content, [ new EndTagTk( 'a' ) ] ) ];
	}

	/**
	 * Render a category 'link'. Categories are really page properties, and are
	 * normally rendered in a box at the bottom of an article.
	 */
	public function renderCategoryG( $token, $target ) {
		$tokens = [];
		$newTk = new SelfclosingTagTk( 'link' );
		$content = $this->addLinkAttributesAndGetContent( $newTk, $token, $target );
		$env = $this->manager->env;

		// Change the rel to be mw:PageProp/Category
		KV::lookupKV( $newTk->attribs, 'rel' )->v = 'mw:PageProp/Category';

		$strContent = TokenUtils::tokensToString( $content );
		$saniContent = preg_replace( '/#/', '%23', Sanitizer::sanitizeTitleURI( $strContent, false ) );
		$newTk->addNormalizedAttribute( 'href', $env->makeLink( $target->title ), $target->hrefSrc );
		// Change the href to include the sort key, if any (but don't update the rt info)
		if ( $strContent && $strContent !== '' && $strContent !== $target->href ) {
			$hrefkv = KV::lookupKV( $newTk->attribs, 'href' );
			$hrefkv->v += '#';
			$hrefkv->v += $saniContent;
		}

		$tokens[] = $newTk;

		if ( count( $content ) === 1 ) {
			return [ 'tokens' => $tokens ];
		} else {
			// Deal with sort keys that come from generated content (transclusions, etc.)
			$key = [ 'txt' => 'mw:sortKey' ];
			$val = /* await */ PipelineUtils::expandValueToDOM(
				$this->manager->env,
				$this->manager->frame,
				[ 'html' => $content ],
				$this->options->expandTemplates,
				$this->options->inTemplate
			);
			$attr = [ $key, $val ];
			$dataMW = $newTk->getAttribute( 'data-mw' );
			if ( $dataMW ) {
				$dataMW = json_decode( $dataMW );
				$dataMW->attribs[] = $attr;
			} else {
				$dataMW = [ 'attribs' => [ $attr ] ];
			}

			// Mark token as having expanded attrs
			$newTk->addAttribute( 'about', $env->newAboutId() );
			$newTk->addSpaceSeparatedAttribute( 'typeof', 'mw:ExpandedAttrs' );
			$newTk->addAttribute( 'data-mw', json_encode( $dataMW ) );

			return [ 'tokens' => $tokens ];
		}
	}

	/**
	 * Render a language link. Those normally appear in the list of alternate
	 * languages for an article in the sidebar, so are really a page property.
	 */
	public function renderLanguageLinkG( $token, $target ) {
 // eslint-disable-line require-yield
		// The prefix is listed in the interwiki map

		$newTk = new SelfclosingTagTk( 'link', [], $token->dataAttribs );
		$this->addLinkAttributesAndGetContent( $newTk, $token, $target );

		// add title attribute giving the presentation name of the
		// "extra language link"
		if ( $target->language->extralanglink !== null
&& $target->language->linktext
		) {
			$newTk->addNormalizedAttribute( 'title', $target->language->linktext );
		}

		// We set an absolute link to the article in the other wiki/language
		$title = Sanitizer::sanitizeTitleURI( Util::decodeURIComponent( $target->href ), false );
		$absHref = str_replace( '$1', $title, $target->language->url );
		if ( $target->language->protorel !== null ) {
			$absHref = preg_replace( '/^https?:/', '', $absHref, 1 );
		}
		$newTk->addNormalizedAttribute( 'href', $absHref, $target->hrefSrc );

		// Change the rel to be mw:PageProp/Language
		KV::lookupKV( $newTk->attribs, 'rel' )->v = 'mw:PageProp/Language';

		return [ 'tokens' => [ $newTk ] ];
	}

	/**
	 * Render an interwiki link.
	 */
	public function renderInterwikiLinkG( $token, $target ) {
 // eslint-disable-line require-yield
		// The prefix is listed in the interwiki map

		$tokens = [];
		$newTk = new TagTk( 'a', [], $token->dataAttribs );
		$content = $this->addLinkAttributesAndGetContent( $newTk, $token, $target, true );

		// We set an absolute link to the article in the other wiki/language
		$isLocal = $target->interwiki->hasOwnProperty( 'local' );
		$title = Sanitizer::sanitizeTitleURI( Util::decodeURIComponent( $target->href ), !$isLocal );
		$absHref = str_replace( '$1', $title, $target->interwiki->url );
		if ( $target->interwiki->protorel !== null ) {
			$absHref = preg_replace( '/^https?:/', '', $absHref, 1 );
		}
		$newTk->addNormalizedAttribute( 'href', $absHref, $target->hrefSrc );

		// Change the rel to be mw:ExtLink
		KV::lookupKV( $newTk->attribs, 'rel' )->v = 'mw:WikiLink/Interwiki';
		// Remember that this was using wikitext syntax though
		$newTk->dataAttribs->isIW = true;
		// Add title unless it's just a fragment (and trim off fragment)
		// (The normalization here is similar to what Title#getPrefixedDBKey() does.)
		if ( $target->href[ 0 ] !== '#' ) {
			$titleAttr = $target->interwiki->prefix . ':'
. Util::decodeURIComponent( preg_replace( '/_/', ' ', preg_replace( '/#[\s\S]*/', '', $target->href, 1 ) ) );
			$newTk->setAttribute( 'title', $titleAttr );
		}
		$tokens[] = $newTk;

		$tokens = $tokens->concat( $content, [ new EndTagTk( 'a' ) ] );
		return [ 'tokens' => $tokens ];
	}

	/**
	 * Get the style and class lists for an image's wrapper element.
	 *
	 * @private
	 * @param {Object} opts The option hash from renderFile.
	 * @return {Object}
	 * @return {boolean} return.isInline Whether the image is inline after handling options.
	 * @return {Array} return.classes The list of classes for the wrapper.
	 */
	public static function getWrapperInfo( $opts ) {
		$format = self::getFormat( $opts );
		$isInline = !( $format === 'thumbnail' || $format === 'framed' );
		$classes = [];
		$halign = ( $opts->format && $opts->format->v === 'framed' ) ? 'right' : null;

		if ( !$opts->size->src ) {
			$classes[] = 'mw-default-size';
		}

		if ( $opts->border ) {
			$classes[] = 'mw-image-border';
		}

		if ( $opts->halign ) {
			$halign = $opts->halign->v;
		}

		$halignOpt = $opts->halign && $opts->halign->v;
		switch ( $halign ) {
			case 'none':
			// PHP parser wraps in <div class="floatnone">
			$isInline = false;
			if ( $halignOpt === 'none' ) {
				$classes[] = 'mw-halign-none';
			}
			break;

			case 'center':
			// PHP parser wraps in <div class="center"><div class="floatnone">
			$isInline = false;
			if ( $halignOpt === 'center' ) {
				$classes[] = 'mw-halign-center';
			}
			break;

			case 'left':
			// PHP parser wraps in <div class="floatleft">
			$isInline = false;
			if ( $halignOpt === 'left' ) {
				$classes[] = 'mw-halign-left';
			}
			break;

			case 'right':
			// PHP parser wraps in <div class="floatright">
			$isInline = false;
			if ( $halignOpt === 'right' ) {
				$classes[] = 'mw-halign-right';
			}
			break;
		}

		if ( $isInline ) {
			$valignOpt = $opts->valign && $opts->valign->v;
			switch ( $valignOpt ) {
				case 'middle':
				$classes[] = 'mw-valign-middle';
				break;

				case 'baseline':
				$classes[] = 'mw-valign-baseline';
				break;

				case 'sub':
				$classes[] = 'mw-valign-sub';
				break;

				case 'super':
				$classes[] = 'mw-valign-super';
				break;

				case 'top':
				$classes[] = 'mw-valign-top';
				break;

				case 'text_top':
				$classes[] = 'mw-valign-text-top';
				break;

				case 'bottom':
				$classes[] = 'mw-valign-bottom';
				break;

				case 'text_bottom':
				$classes[] = 'mw-valign-text-bottom';
				break;
			}
		}

		return [ 'classes' => $classes, 'isInline' => $isInline ];
	}

	/**
	 * Determine the name of an option.
	 * @return {Object}
	 * @return {string} return.ck Canonical key for the image option.
	 * @return {string} return.v Value of the option.
	 * @return {string} return.ak
	 *   Aliased key for the image option - includes `"$1"` for placeholder.
	 * @return {string} return.s
	 *   Whether it's a simple option or one with a value.
	 */
	public static function getOptionInfo( $optStr, $env ) {
		$oText = trim( $optStr );
		$lowerOText = strtolower( $oText );
		$getOption = $env->conf->wiki->getMagicPatternMatcher(
			WikitextConstants\Media::PrefixOptions
		);
		// oText contains the localized name of this option.  the
		// canonical option names (from mediawiki upstream) are in
		// English and contain an '(img|timedmedia)_' prefix.  We drop the
		// prefix before stuffing them in data-parsoid in order to
		// save space (that's shortCanonicalOption)
		$canonicalOption = $env->conf->wiki->magicWords[ $oText ]
|| $env->conf->wiki->magicWords[ $lowerOText ] || '';
		$shortCanonicalOption = preg_replace( '/^(img|timedmedia)_/', '', $canonicalOption, 1 );
		// 'imgOption' is the key we'd put in opts; it names the 'group'
		// for the option, and doesn't have an img_ prefix.
		$imgOption = WikitextConstants\Media\SimpleOptions::get( $canonicalOption );
		$bits = $getOption( trim( $optStr ) );
		$normalizedBit0 = ( $bits ) ? strtolower( trim( $bits->k ) ) : null;
		$key = ( $bits ) ? WikitextConstants\Media\PrefixOptions::get( $normalizedBit0 ) : null;

		if ( $imgOption && $key === null ) {
			return [
				'ck' => $imgOption,
				'v' => $shortCanonicalOption,
				'ak' => $optStr,
				's' => true
			];
		} else {
			// bits.a has the localized name for the prefix option
			// (with $1 as a placeholder for the value, which is in bits.v)
			// 'normalizedBit0' is the canonical English option name
			// (from mediawiki upstream) with a prefix.
			// 'key' is the parsoid 'group' for the option; it doesn't
			// have a prefix (it's the key we'd put in opts)

			if ( $bits && $key ) {
				$shortCanonicalOption = preg_replace( '/^(img|timedmedia)_/', '', $normalizedBit0, 1 );
				// map short canonical name to the localized version used

				// Note that we deliberately do entity decoding
				// *after* splitting so that HTML-encoded pipes don't
				// separate options.  This matches PHP, whether or
				// not it's a good idea.
				return [
					'ck' => $shortCanonicalOption,
					'v' => Util::decodeWtEntities( $bits->v ),
					'ak' => $optStr,
					's' => false
				];
			} else {
				return null;
			}
		}
	}

	/**
	 * Make option token streams into a stringy thing that we can recognize.
	 *
	 * @param {Array} tstream
	 * @param {string} prefix Anything that came before this part of the recursive call stack.
	 * @return string|null
	 */
	public static function stringifyOptionTokens( $tstream, $prefix, $env ) {
		// Seems like this should be a more general "stripTags"-like function?
		$tokenType = null;
$tkHref = null;
$nextResult = null;
$optInfo = null;
$skipToEndOf = null;
		$resultStr = '';
		$cachedOptInfo = function () use ( &$optInfo, &$undefined, &$prefix, &$resultStr, &$env ) {
			if ( $optInfo === null ) {
				$optInfo = WikiLinkHandler::getOptionInfo( $prefix + $resultStr, $env );
			}
			return $optInfo;
		};
		$isWhitelistedOpt = function () use ( &$cachedOptInfo ) {
			// link and alt options are whitelisted for accepting arbitrary
			// wikitext (even though only strings are supported in reality)
			// SSS FIXME: Is this actually true of all options rather than
			// just link and alt?
			return $cachedOptInfo() && preg_match( '/^(link|alt)$/', cachedOptInfo()->ck );
		};

		$prefix = $prefix || '';

		for ( $i = 0;  $i < count( $tstream );  $i++ ) {
			$currentToken = $tstream[ $i ];

			if ( $skipToEndOf ) {
				if ( $currentToken->name === $skipToEndOf && $currentToken->constructor === EndTagTk::class ) {
					$skipToEndOf = null;
				}
				continue;
			}

			if ( $currentToken->constructor === $String ) {
				$resultStr += $currentToken;
			} elseif ( is_array( $currentToken ) ) {
				$nextResult = self::stringifyOptionTokens( $currentToken, $prefix + $resultStr, $env );

				if ( $nextResult === null ) {
					return null;
				}

				$resultStr += $nextResult;
			} elseif ( $currentToken->constructor !== EndTagTk::class ) {
				// This is actually a token
				if ( TokenUtils::isDOMFragmentType( $currentToken->getAttribute( 'typeof' ) ) ) {
					if ( $isWhitelistedOpt() ) {
						$str = TokenUtils::tokensToString( [ $currentToken ], false, [
								'unpackDOMFragments' => true,
								'env' => $env
							]
						);
						// Entity encode pipes since we wouldn't have split on
						// them from fragments and we're about to attempt to
						// when this function returns.
						// This is similar to getting the shadow "href" below.
						// FIXME: Sneaking in `env` to avoid changing the signature

						$resultStr += preg_replace( '/\|/', '&vert;', $str, 1 );
						$optInfo = null; // might change the nature of opt
						continue;
					} else {
						// if this is a nowiki, we must be in a caption
						return null;
					}
				}
				if ( $currentToken->name === 'mw-quote' ) {
					if ( $isWhitelistedOpt() ) {
						// just recurse inside
						$optInfo = null; // might change the nature of opt
						continue;
					}
				}
				// Similar to TokenUtils.tokensToString()'s includeEntities
				if ( TokenUtils::isEntitySpanToken( $currentToken ) ) {
					$resultStr += $currentToken->dataAttribs->src;
					$skipToEndOf = 'span';
					continue;
				}
				if ( $currentToken->name === 'a' ) {
					if ( $optInfo === null ) {
						$optInfo = self::getOptionInfo( $prefix + $resultStr, $env );
						if ( $optInfo === null ) {
							// An <a> tag before a valid option?
							// This is most likely a caption.
							$optInfo = null;
							return null;
						}
					}

					if ( $isWhitelistedOpt() ) {
						$tokenType = $currentToken->getAttribute( 'rel' );
						// Using the shadow since entities (think pipes) would
						// have already been decoded.
						$tkHref = $currentToken->getAttributeShadowInfo( 'href' )->value;
						$isLink = ( $optInfo->ck === 'link' );
						// Reset the optInfo since we're changing the nature of it
						$optInfo = null;
						// Figure out the proper string to put here and break.
						if (
							$tokenType === 'mw:ExtLink'
&& $currentToken->dataAttribs->stx === 'url'
						) {
							// Add the URL
							$resultStr += $tkHref;
							// Tell our loop to skip to the end of this tag
							$skipToEndOf = 'a';
						} elseif ( $tokenType === 'mw:WikiLink/Interwiki' ) {
							if ( $isLink ) {
								$resultStr += $currentToken->getAttribute( 'href' );
								$i += 2;
								continue;
							}
							// Nothing to do -- the link content will be
							// captured by walking the rest of the tokens.
						} elseif ( $tokenType === 'mw:WikiLink' || $tokenType === 'mw:MediaLink' ) {

							// Nothing to do -- the link content will be
							// captured by walking the rest of the tokens.
						} else {
							// There shouldn't be any other kind of link...
							// This is likely a caption.
							return null;
						}
					} else {
						// Why would there be an a tag without a link?
						return null;
					}
				}
			}
		}

		return $resultStr;
	}

	/**
	 * Get the format for media.
	 *
	 * @param {Object} opts
	 * @return string
	 */
	public static function getFormat( $opts ) {
		if ( $opts->manualthumb ) {
			return 'thumbnail';
		}
		return $opts->format && $opts->format->v;
	}

	/**
	 * This is the set of file options that apply to the container, rather
	 * than the media element itself (or, apply generically to a span).
	 * Other options depend on the fetched media type and won't necessary be
	 * applied.
	 *
	 * @return Set
	 */
	public static function getUsed() {
		if ( $this->used ) { return $this->used;
  }
		$this->used = new Set( [
				'lang', 'width', 'class', 'upright',
				'border', 'frameless', 'framed', 'thumbnail',
				'left', 'right', 'center', 'none',
				'baseline', 'sub', 'super', 'top', 'text_top', 'middle', 'bottom', 'text_bottom'
			]
		);
		return $this->used;
	}

	/**
	 * Render a file. This can be an image, a sound, a PDF etc.
	 */
	public function renderFileG( $token, $target ) {
		$manager = $this->manager;
		$env = $manager->env;

		// FIXME: Re-enable use of media cache and figure out how that fits
		// into this new processing model. See T98995
		// const cachedMedia = env.mediaCache[token.dataAttribs.src];

		$dataAttribs = Util::clone( $token->dataAttribs );
		$dataAttribs->optList = [];

		// Account for the possibility of an expanded target
		$dataMwAttr = $token->getAttribute( 'data-mw' );
		$dataMw = ( $dataMwAttr ) ? json_decode( $dataMwAttr ) : [];

		$opts = [
			'title' => [
				'v' => $env->makeLink( $target->title ),
				'src' => KV::lookupKV( $token->attribs, 'href' )->vsrc
			],
			'size' => [
				'v' => [
					'height' => null,
					'width' => null
				]
			]
		];

		$hasExpandableOpt = false;
		$hasTransclusion = function ( $toks ) use ( &$undefined, &$SelfclosingTagTk ) {
			return is_array( $toks ) && $toks->find( function ( $t ) use ( &$SelfclosingTagTk ) {
						return $t->constructor === SelfclosingTagTk::class
&& $t->getAttribute( 'typeof' ) === 'mw:Transclusion';
			}
				) !== null;
		};

		$optKVs = self::buildLinkAttrs( $token->attribs, true, null, null )->contentKVs;
		while ( count( $optKVs ) > 0 ) {
			$oContent = array_shift( $optKVs );

			$origOptSrc = $oContent->v;
			if ( is_array( $origOptSrc ) && count( $origOptSrc ) === 1 ) {
				$origOptSrc = $origOptSrc[ 0 ];
			}

			$oText = TokenUtils::tokensToString( $origOptSrc, true, [ 'includeEntities' => true ] );

			if ( $oText->constructor !== $String ) {
				// Might be that this is a valid option whose value is just
				// complicated. Try to figure it out, step through all tokens.
				$maybeOText = self::stringifyOptionTokens( $oText, '', $env );
				if ( $maybeOText !== null ) {
					$oText = $maybeOText;
				}
			}

			$optInfo = null;
			if ( $oText->constructor === $String ) {
				if ( preg_match( '/\|/', $oText ) ) {
					// Split the pipe-separated string into pieces
					// and convert each one into a KV obj and add them
					// to the beginning of the array. Note that this is
					// a hack to support templates that provide multiple
					// image options as a pipe-separated string. We aren't
					// really providing editing support for this yet, or
					// ever, maybe.
					//
					// TODO(arlolra): Tables in captions suppress breaking on
					// "linkdesc" pipes so `stringifyOptionTokens` should account
					// for pipes in table cell content.  For the moment, breaking
					// here is acceptable since it matches the php implementation
					// bug for bug.
					$pieces = array_map( explode( '|', $oText ), function ( $s ) {
							return new KV( 'mw:maybeContent', $s );
					}
					);
					$optKVs = $pieces->concat( $optKVs );

					// Record the fact that we won't provide editing support for this.
					$dataAttribs->uneditable = true;
					continue;
				} else {
					// We're being overly accepting of media options at this point,
					// since we don't know the type yet.  After the info request,
					// we'll filter out those that aren't appropriate.
					$optInfo = self::getOptionInfo( $oText, $env );
				}
			}

			// For the values of the caption and options, see
			// getOptionInfo's documentation above.
			//
			// If there are multiple captions, this code always
			// picks the last entry. This is the spec; see
			// "Image with multiple captions" parserTest.
			if ( $oText->constructor !== $String || $optInfo === null
|| // Deprecated options
					[ 'noicon', 'noplayer', 'disablecontrols' ]->includes( $optInfo->ck )
			) {
				// No valid option found!?
				// Record for RT-ing
				$optsCaption = [
					'v' => ( $oContent->constructor === $String ) ? $oContent : $oContent->v,
					'src' => $oContent->vsrc || $oText,
					'srcOffsets' => $oContent->srcOffsets,
					// remember the position
					'pos' => count( $dataAttribs->optList )
				];
				// if there was a 'caption' previously, round-trip it as a
				// "bogus option".
				if ( $opts->caption ) {
					array_splice( $dataAttribs->optList, $opts->caption->pos, 0, [
							'ck' => 'bogus',
							'ak' => $opts->caption->src
						]
					);
					$optsCaption->pos++;
				}
				$opts->caption = $optsCaption;
				continue;
			}

			if ( isset( $opts[ $optInfo->ck ] ) ) {
				// first option wins, the rest are 'bogus'
				$dataAttribs->optList[] = [
					'ck' => 'bogus',
					'ak' => $optInfo->ak
				];
				continue;
			}

			$opt = [
				'ck' => $optInfo->v,
				'ak' => $oContent->vsrc || $optInfo->ak
			];

			if ( $optInfo->s === true ) {
				// Default: Simple image option
				$opts[ $optInfo->ck ] = [ 'v' => $optInfo->v ];
			} else {
				// Map short canonical name to the localized version used.
				$opt->ck = $optInfo->ck;

				// The MediaWiki magic word for image dimensions is called 'width'
				// for historical reasons
				// Unlike other options, use last-specified width.
				if ( $optInfo->ck === 'width' ) {
					// We support a trailing 'px' here for historical reasons
					// (T15500, T53628)
					$maybeDim = Util::parseMediaDimensions( $optInfo->v );
					if ( $maybeDim !== null ) {
						$opts->size->v->width = ( Util::validateMediaParam( $maybeDim->x ) ) ?
						$maybeDim->x : null;
						$opts->size->v->height = ( $maybeDim->hasOwnProperty( 'y' )
&& Util::validateMediaParam( $maybeDim->y )
						) ? $maybeDim->y : null;
						// Only round-trip a valid size
						$opts->size->src = $oContent->vsrc || $optInfo->ak;
					}
				} else {
					$opts[ $optInfo->ck ] = [
						'v' => $optInfo->v,
						'src' => $oContent->vsrc || $optInfo->ak,
						'srcOffsets' => $oContent->srcOffsets
					];
				}
			}

			// Collect option in dataAttribs (becomes data-parsoid later on)
			// for faithful serialization.
			$dataAttribs->optList[] = $opt;

			// Collect source wikitext for image options for possible template expansion.
			$maybeOpt = !self::getUsed()->has( $opt->ck );
			$expOpt = null;
			// Links more often than not show up as arrays here because they're
			// tokenized as `autourl`.  To avoid unnecessarily considering them
			// expanded, we'll use a more restrictive test, at the cost of
			// perhaps missing some edgy behaviour.
			if ( $opt->ck === 'link' ) {
				$expOpt = $hasTransclusion( $origOptSrc );
			} else {
				$expOpt = is_array( $origOptSrc );
			}
			if ( $maybeOpt || $expOpt ) {
				$val = [];
				if ( $expOpt ) {
					$hasExpandableOpt = true;
					$val->html = $origOptSrc;
					/* await */ PipelineUtils::expandValueToDOM(
						$env, $manager->frame, $val,
						$this->options->expandTemplates,
						$this->options->inTemplate
					);
				}

				// This is a bit of an abuse of the "txt" property since
				// `optInfo.v` isn't unnecessarily wikitext from source.
				// It's a result of the specialized stringifying above, which
				// if interpreted as wikitext upon serialization will result
				// in some (acceptable) normalization.
				//
				// We're storing these options in data-mw because they aren't
				// guaranteed to apply to all media types and we'd like to
				// avoid the need to back them out later.
				//
				// Note that the caption in the legacy parser depends on the
				// exact set of options parsed, which we aren't attempting to
				// try and replicate after fetching the media info, since we
				// consider that more of bug than a feature.  It prevent anyone
				// from ever safely adding media options in the future.
				//
				// See T163582
				if ( $maybeOpt ) {
					$val->txt = $optInfo->v;
				}
				if ( !is_array( $dataMw->attribs ) ) { $dataMw->attribs = [];
	   }
				$dataMw->attribs[] = [ $opt->ck, $val ];
			}
		}

		// Add the last caption in the right position if there is one
		if ( $opts->caption ) {
			array_splice( $dataAttribs->optList, $opts->caption->pos, 0, [
					'ck' => 'caption',
					'ak' => $opts->caption->src
				]
			);
		}

		// Handle image default sizes and upright option after extracting all
		// options
		if ( $opts->format && $opts->format->v === 'framed' ) {
			// width and height is ignored for framed images
			// https://phabricator.wikimedia.org/T64258
			$opts->size->v->width = null;
			$opts->size->v->height = null;
		} elseif ( $opts->format ) {
			if ( !$opts->size->v->height && !$opts->size->v->width ) {
				$defaultWidth = $env->conf->wiki->widthOption;
				if ( $opts->upright !== null ) {
					if ( $opts->upright->v > 0 ) {
						$defaultWidth *= $opts->upright->v;
					} else {
						$defaultWidth *= 0.75;
					}
					// round to nearest 10 pixels
					$defaultWidth = 10 * round( $defaultWidth / 10 );
				}
				$opts->size->v->width = $defaultWidth;
			}
		}

		// FIXME: Default type, since we don't have the info.  That right?
		$rdfaType = 'mw:Image';

		// If the format is something we *recognize*, add the subtype
		$format = self::getFormat( $opts );
		switch ( $format ) {
			case 'thumbnail':
			$rdfaType += '/Thumb';
			break;
			case 'framed':
			$rdfaType += '/Frame';
			break;
			case 'frameless':
			$rdfaType += '/Frameless';
			break;
		}

		// Tell VE that it shouldn't try to edit this
		if ( $dataAttribs->uneditable ) {
			$rdfaType += ' mw:Placeholder';
		} else {
			$dataAttribs->src = null;
		}

		$wrapperInfo = self::getWrapperInfo( $opts );

		$temp0 = $wrapperInfo;
$isInline = $temp0->isInline;
		$containerName = ( $isInline ) ? 'figure-inline' : 'figure';

		$temp1 = $wrapperInfo;
$classes = $temp1->classes;
		if ( $opts->class ) {
			$classes = $classes->concat( explode( ' ', $opts->class->v ) );
		}

		$attribs = [ new KV( 'typeof', $rdfaType ) ];
		if ( count( $classes ) > 0 ) { array_unshift( $attribs, new KV( 'class', implode( ' ', $classes ) ) );
  }

		$container = new TagTk( $containerName, $attribs, $dataAttribs );
		$containerClose = new EndTagTk( $containerName );

		if ( $hasExpandableOpt ) {
			$container->addAttribute( 'about', $env->newAboutId() );
			$container->addSpaceSeparatedAttribute( 'typeof', 'mw:ExpandedAttrs' );
		} elseif ( preg_match( '/\bmw:ExpandedAttrs\b/', $token->getAttribute( 'typeof' ) ) ) {
			$container->addSpaceSeparatedAttribute( 'typeof', 'mw:ExpandedAttrs' );
		}

		$span = new TagTk( 'span', [], [] );

		// "resource" and "lang" are whitelisted attributes on spans
		$span->addNormalizedAttribute( 'resource', $opts->title->v, $opts->title->src );
		if ( isset( $opts[ 'lang' ] ) ) {
			$span->addNormalizedAttribute( 'lang', $opts->lang->v, $opts->lang->src );
		}

		// `size` is a computed property so ...
		$size = $opts->size->v;
		if ( $size->width !== null ) {
			$span->addAttribute( 'data-width', $size->width );
		}
		if ( $size->height !== null ) {
			$span->addAttribute( 'data-height', $size->height );
		}

		$anchor = new TagTk( 'a' );
		$filePath = Sanitizer::sanitizeTitleURI( $target->title->getKey(), false );
		$anchor->setAttribute( 'href', "./Special:FilePath/{$filePath}" );

		$tokens = [
			$container,
			$anchor,
			$span,
			// FIXME: The php parser seems to put the link text here instead.
			// The title can go on the `anchor` as the "title" attribute.
			$target->title->getPrefixedText(),
			new EndTagTk( 'span' ),
			new EndTagTk( 'a' )
		];

		if ( $isInline ) {
			if ( $opts->caption ) {
				if ( !is_array( $opts->caption->v ) ) {
					$opts->caption->v = [ $opts->caption->v ];
				}
				// Parse the caption asynchronously.
				$captionDOM = /* await */ PipelineUtils::promiseToProcessContent(
					$this->manager->env,
					$this->manager->frame,
					$opts->caption->v->concat( [ new EOFTk() ] ),
					[
						'pipelineType' => 'tokens/x-mediawiki/expanded',
						'pipelineOpts' => [
							'inlineContext' => true,
							'expandTemplates' => $this->options->expandTemplates,
							'inTemplate' => $this->options->inTemplate
						],
						'srcOffsets' => $opts->caption->srcOffsets,
						'sol' => true
					]
				);
				// Use parsed DOM given in `captionDOM`
				// FIXME: Does this belong in `dataMw.attribs`?
				$dataMw->caption = ContentUtils::ppToXML( $captionDOM->body, [ 'innerXML' => true ] );
			}
		} else {
			// We always add a figcaption for blocks
			$tokens[] = new TagTk( 'figcaption' );
			if ( $opts->caption ) {
				$tokens[] = PipelineUtils::getDOMFragmentToken(
					$opts->caption->v,
					$opts->caption->srcOffsets,
					[ 'inlineContext' => true, 'token' => $token ]
				);
			}
			$tokens[] = new EndTagTk( 'figcaption' );
		}

		if ( count( Object::keys( $dataMw ) ) ) {
			$container->addAttribute( 'data-mw', json_encode( $dataMw ) );
		}

		return [ 'tokens' => $tokens->concat( $containerClose ) ];
	}

	public function linkToMedia( $token, $target, $errs, $info ) {
		// Only pass in the url, since media links should not link to the thumburl
		$imgHref = preg_replace( '/^https?:\/\//', '//', $info->url, 1 ); // Copied from getPath
		$imgHrefFileName = preg_replace( '/.*\//', '', $imgHref, 1 );

		$link = new TagTk( 'a', [], Util::clone( $token->dataAttribs ) );
		$link->addAttribute( 'rel', 'mw:MediaLink' );
		$link->addAttribute( 'href', $imgHref );
		// html2wt will use the resource rather than try to parse the href.
		$link->addNormalizedAttribute(
			'resource',
			$this->env->makeLink( $target->title ),
			$target->hrefSrc
		);
		// Normalize title according to how PHP parser does it currently
		$link->setAttribute( 'title', preg_replace( '/_/', ' ', $imgHrefFileName ) );
		$link->dataAttribs->src = null; // clear src string since we can serialize this

		$type = $token->getAttribute( 'typeof' );
		if ( $type ) {
			$link->addSpaceSeparatedAttribute( 'typeof', $type );
		}

		if ( count( $errs ) > 0 ) {
			// Set RDFa type to mw:Error so VE and other clients
			// can use this to do client-specific action on these.
			$link->addAttribute( 'typeof', 'mw:Error' );

			// Update data-mw
			$dataMwAttr = $token->getAttribute( 'data-mw' );
			$dataMw = ( $dataMwAttr ) ? json_decode( $dataMwAttr ) : [];
			if ( is_array( $dataMw->errors ) ) {
				$errs = $dataMw->errors->concat( $errs );
			}
			$dataMw->errors = $errs;
			$link->addAttribute( 'data-mw', json_encode( $dataMw ) );
		}

		$content = preg_replace( '/^:/', '', TokenUtils::tokensToString( $token->getAttribute( 'href' ) ), 1 );
		$content = $token->getAttribute( 'mw:maybeContent' ) || [ $content ];
		$tokens = [ $link ]->concat( $content, [ new EndTagTk( 'a' ) ] );
		return [ 'tokens' => $tokens ];
	}

	// FIXME: The media request here is only used to determine if this is a
	// redlink and deserves to be handling in the redlink post-processing pass.
	public function renderMediaG( $token, $target ) {
		$env = $this->manager->env;
		$title = $target->title;
		$errs = [];
		$temp2 = /* await */ AddMediaInfo::requestInfo( $env, $title->getKey(), [
				'height' => null, 'width' => null
			]
		);
$err = $temp2->err;
$info = $temp2->info;

		if ( $err ) { $errs[] = $err;
  }
		return $this->linkToMedia( $token, $target, $errs, $info );
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
[
	'onRedirect', 'onWikiLink', 'renderWikiLink', 'renderCategory',
	'renderLanguageLink', 'renderInterwikiLink',
	'handleInfo', 'renderFile', 'renderMedia'
]->forEach( function ( $f ) {
		WikiLinkHandler::prototype[ $f ] = /* async */WikiLinkHandler::prototype[ $f . 'G' ];
}
);

if ( gettype( $module ) === 'object' ) {
	$module->exports->WikiLinkHandler = $WikiLinkHandler;
}
