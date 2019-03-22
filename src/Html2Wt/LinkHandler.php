<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Serializes link markup.
 * @module
 */

namespace Parsoid;

use Parsoid\url as url;

use Parsoid\CT as CT;

$ContentUtils = require '../utils/ContentUtils.js'::ContentUtils;
$DiffUtils = require './DiffUtils.js'::DiffUtils;
$DOMDataUtils = require '../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../utils/DOMUtils.js'::DOMUtils;
$JSUtils = require '../utils/jsutils.js'::JSUtils;
$Promise = require '../utils/promise.js';
$TokenUtils = require '../utils/TokenUtils.js'::TokenUtils;
$Util = require '../utils/Util.js'::Util;
$WTUtils = require '../utils/WTUtils.js'::WTUtils;
$temp0 = require '../html2wt/WTSUtils.js';
$WTSUtils = $temp0::WTSUtils;

$AutoURLLinkText = CT\AutoURLLinkText;
$ExtLinkText = CT\ExtLinkText;
$MagicLinkText = CT\MagicLinkText;
$WikiLinkText = CT\WikiLinkText;
$lastItem = JSUtils::lastItem;

$REDIRECT_TEST_RE = /* RegExp */ '/^([ \t\n\r\0\x0b])*$/';

/**
 * Strip a string suffix if it matches.
 */
$stripSuffix = function ( $text, $suffix ) {
	$sLen = count( $suffix );
	if ( $sLen && substr( $text, -$sLen ) === $suffix ) {
		return substr( $text, 0, count( $text ) - $sLen );
	} else {
		return $text;
	}
};

$splitLinkContentString = function ( $contentString, $dp, $target ) use ( &$stripSuffix ) {
	$tail = $dp->tail;
	$prefix = $dp->prefix;

	if ( $tail && substr( $contentString, count( $contentString ) - count( $tail ) ) === $tail ) {
		// strip the tail off the content
		$contentString = $stripSuffix( $contentString, $tail );
	} elseif ( $tail ) {
		$tail = '';
	}

	if ( $prefix && substr( $contentString, 0, count( $prefix ) ) === $prefix ) {
		$contentString = substr( $contentString, count( $prefix ) );
	} elseif ( $prefix ) {
		$prefix = '';
	}

	return [
		'contentString' => $contentString || '',
		'tail' => $tail || '',
		'prefix' => $prefix || ''
	];
};

// Helper function for munging protocol-less absolute URLs:
// If this URL is absolute, but doesn't contain a protocol,
// try to find a localinterwiki protocol that would work.
$getHref = function ( $env, $node ) use ( &$url ) {
	$href = $node->getAttribute( 'href' ) || '';
	if ( preg_match( '/^\/[^\/]/', $href ) ) {
		// protocol-less but absolute.  let's find a base href
		$bases = [];
		$nhref = null;
		$env->conf->wiki->interwikiMap->forEach( function ( $interwikiInfo, $prefix ) use ( &$bases ) {
				if ( $interwikiInfo->localinterwiki !== null
&& $interwikiInfo->url !== null
				) {
					// this is a possible base href
					$bases[] = $interwikiInfo->url;
				}
		}
		);
		for ( $i = 0;  $i < count( $bases );  $i++ ) {
			// evaluate the url relative to this base
			$nhref = url::resolve( $bases[ $i ], $href );
			// can this match the pattern?
			$re = '^'
. implode( '[\s\S]*', array_map( explode( '$1', $bases[ $i ] ), JSUtils::escapeRegExp ) )
. '$';
			if ( preg_match( new RegExp( $re ), $nhref ) ) {
				return $nhref;
			}
		}
	}
	return $href;
};

function normalizeIWP( $str ) {
	return preg_replace( '/^:/', '', trim( strtolower( $str ) ), 1 );
}

$escapeLinkTarget = function ( $linkTarget, $state ) use ( &$Util ) {
	// Entity-escape the content.
	$linkTarget = Util::escapeWtEntities( $linkTarget );
	return [
		'linkTarget' => $linkTarget,
		// Is this an invalid link?
		'invalidLink' => !$state->env->isValidLinkTarget( $linkTarget )
|| // `isValidLinkTarget` omits fragments (the part after #) so,
			// even though "|" is an invalid character, we still need to ensure
			// it doesn't appear in there.  The percent encoded version is fine
			// in the fragment, since it won't break the parse.
			preg_match( '/\|/', $linkTarget )
	];
};

// Helper function for getting RT data from the tokens
$getLinkRoundTripData = /* async */function ( $env, $node, $state ) use ( &$DOMDataUtils, &$DOMUtils, &$getHref, &$DiffUtils, &$splitLinkContentString, &$escapeLinkTarget, &$Util ) {
	$dp = DOMDataUtils::getDataParsoid( $node );
	$wiki = $env->conf->wiki;
	$rtData = [
		'type' => null, // could be null
		'href' => null, // filled in below
		'origHref' => null, // filled in below
		'target' => null, // filled in below
		'tail' => $dp->tail || '',
		'prefix' => $dp->prefix || '',
		'content' => []
	];

	// Figure out the type of the link
	// string or tokens

	// Figure out the type of the link
	if ( $node->hasAttribute( 'rel' ) ) {
		$rel = $node->getAttribute( 'rel' );
		// Parsoid only emits and recognizes ExtLink, WikiLink, and PageProp rel values.
		// Everything else defaults to ExtLink during serialization (unless it is
		// serializable to a wikilink)
		// Parsoid only emits and recognizes ExtLink, WikiLink, and PageProp rel values.
		// Everything else defaults to ExtLink during serialization (unless it is
		// serializable to a wikilink)
		$typeMatch = preg_match( '/\b(mw:(WikiLink|ExtLink|MediaLink|PageProp)[^\s]*)\b/', $rel );
		if ( $typeMatch ) {
			$rtData->type = $typeMatch[ 1 ];
			// Strip link subtype info
			// Strip link subtype info
			if ( preg_match( '/^mw:(Wiki|Ext)Link\//', $rtData->type ) ) {
				$rtData->type = 'mw:' . $typeMatch[ 2 ];
			}
		}
	}

	// Default link type if nothing else is set
	// Default link type if nothing else is set
	if ( $rtData->type === null && !DOMUtils::selectMediaElt( $node ) ) {
		$rtData->type = 'mw:ExtLink';
	}

	// Get href, and save the token's "real" href for comparison
	// Get href, and save the token's "real" href for comparison
	$href = $getHref( $env, $node );
	$rtData->origHref = $href;
	$rtData->href = preg_replace( '/^(\.\.?\/)+/', '', $href, 1 );

	// WikiLinks should be relative (but see below); fixup the link type
	// if a WikiLink has an absolute URL.
	// (This may get converted back to a WikiLink below, in the interwiki
	// handling code.)
	// WikiLinks should be relative (but see below); fixup the link type
	// if a WikiLink has an absolute URL.
	// (This may get converted back to a WikiLink below, in the interwiki
	// handling code.)
	if ( $rtData->type === 'mw:WikiLink'
&& ( preg_match( '/^(\w+:)?\/\//', $rtData->href ) || preg_match( '/^\//', $rtData->origHref ) )
	) {
		$rtData->type = 'mw:ExtLink';
	}

	// Now get the target from rt data
	// Now get the target from rt data
	$rtData->target = /* await */ $state->serializer->serializedAttrVal( $node, 'href' );

	// Check if the link content has been modified or is newly inserted content.
	// FIXME: This will only work with selser of course. Hard to test without selser.
	// Check if the link content has been modified or is newly inserted content.
	// FIXME: This will only work with selser of course. Hard to test without selser.
	if ( $state->inModifiedContent || DiffUtils::hasDiffMark( $node, $env, 'subtree-changed' ) ) {
		$rtData->contentModified = true;
	}

	// Get the content string or tokens
	// Get the content string or tokens
	$contentParts = null;
	if ( $node->hasChildNodes() && DOMUtils::allChildrenAreText( $node ) ) {
		$contentString = $node->textContent;
		if ( $rtData->target->value && $rtData->target->value !== $contentString ) {
			// Try to identify a new potential tail
			$contentParts = $splitLinkContentString( $contentString, $dp, $rtData->target );
			$rtData->content->string = $contentParts->contentString;
			$rtData->tail = $contentParts->tail;
			$rtData->prefix = $contentParts->prefix;
		} else {
			$rtData->tail = '';
			$rtData->prefix = '';
			$rtData->content->string = $contentString;
		}
	} elseif ( $node->hasChildNodes() ) {
		$rtData->contentNode = $node;
	} elseif ( preg_match( '/^mw:PageProp\/redirect$/', $rtData->type ) ) {
		$rtData->isRedirect = true;
		$rtData->prefix = $dp->src
|| ( ( $wiki->mwAliases->redirect[ 0 ] || '#REDIRECT' ) . ' ' );
	}

	// Update link type based on additional analysis.
	// What might look like external links might be serializable as a wikilink.
	// Update link type based on additional analysis.
	// What might look like external links might be serializable as a wikilink.
	$target = $rtData->target;

	// mw:MediaLink annotations are considered authoritative
	// and interwiki link matches aren't made for these
	// mw:MediaLink annotations are considered authoritative
	// and interwiki link matches aren't made for these
	if ( preg_match( '/\bmw:MediaLink\b/', $rtData->type ) ) {
		// Parse title from resource attribute (see analog in image handling)
		$resource = /* await */ $state->serializer->serializedAttrVal( $node, 'resource' );
		if ( $resource->value === null ) {
			// from non-parsoid HTML: try to reconstruct resource from href?
			// (See similar code which tries to guess resource from <img src>)
			$mediaPrefix = $wiki->namespaceNames[ $wiki->namespaceIds->get( 'media' ) ];
			$resource = [
				'value' => $mediaPrefix . ':' . preg_replace( '/.*\//', '', $rtData->origHref, 1 ),
				'fromsrc' => false,
				'modified' => false
			];
		}
		$rtData->target = $resource;
		$rtData->href = preg_replace( '/^(\.\.?\/)+/', '', $rtData->target->value, 1 );
		return $rtData;
	}

	// Check if the href matches any of our interwiki URL patterns
	// Check if the href matches any of our interwiki URL patterns
	$interWikiMatch = preg_match( $href, $wiki->interWikiMatcher() );
	if ( $interWikiMatch
		// Question mark is a valid title char, so it won't fail the test below,
		// but gets percent encoded on the way out since it has special
		// semantics in a url.  That will break the url we're serializing, so
		// protect it.
		// FIXME: If ever the default value for $wgExternalInterwikiFragmentMode
		// changes, we can reduce this by always stripping off the fragment
		// identifier, since in "html5" mode, that isn't encoded.  At present,
		// we can only do that if we know it's a local interwiki link.
		 && // Question mark is a valid title char, so it won't fail the test below,
			// but gets percent encoded on the way out since it has special
			// semantics in a url.  That will break the url we're serializing, so
			// protect it.
			// FIXME: If ever the default value for $wgExternalInterwikiFragmentMode
			// changes, we can reduce this by always stripping off the fragment
			// identifier, since in "html5" mode, that isn't encoded.  At present,
			// we can only do that if we know it's a local interwiki link.
			!preg_match( '/\?/', $interWikiMatch[ 1 ] )
		// Ensure we have a valid link target, otherwise falling back to extlink
		// is preferable, since it won't serialize as a link.
		 && // Ensure we have a valid link target, otherwise falling back to extlink
			// is preferable, since it won't serialize as a link.
			( !count( $interWikiMatch[ 1 ] )
|| !$escapeLinkTarget( $interWikiMatch[ 1 ], $state )->invalidLink )
		// ExtLinks should have content to convert.
		 && // ExtLinks should have content to convert.
			( $rtData->type !== 'mw:ExtLink' || $rtData->content->string || $rtData->contentNode )
&& ( $dp->isIW || $target->modified || $rtData->contentModified )
	) {
		// External link that is really an interwiki link. Convert it.
		// TODO: Leaving this for backwards compatibility, remove when 1.5 is no longer bound
		if ( $rtData->type === 'mw:ExtLink' ) {
			$rtData->type = 'mw:WikiLink';
		}
		$rtData->isInterwiki = true;
		// could this be confused with a language link?
		// could this be confused with a language link?
		$iwi = $wiki->interwikiMap->get( normalizeIWP( $interWikiMatch[ 0 ] ) );
		$rtData->isInterwikiLang = $iwi && $iwi->language !== null;
		// is this our own wiki?
		// is this our own wiki?
		$rtData->isLocal = $iwi && $iwi->localinterwiki !== null;
		// strip off localinterwiki prefixes
		// strip off localinterwiki prefixes
		$localPrefix = '';
		$oldPrefix = null;
		while ( true ) { // eslint-disable-line
			$oldPrefix = preg_match( '/^(:?[^:]+):/', array_slice( $target->value, count( $localPrefix ) ) );
			if ( !$oldPrefix ) {
				break;
			}
			$iwi = $wiki->interwikiMap->get(
				Util::normalizeNamespaceName( preg_replace( '/^:/', '', $oldPrefix[ 1 ], 1 ) )
			);
			if ( !$iwi || $iwi->localinterwiki === null ) {
				break;
			}
			$localPrefix += $oldPrefix[ 1 ] . ':';
		}

		if ( $target->fromsrc && !$target->modified ) {

			// Leave the target alone!
		} else { // Leave the target alone!
		if ( preg_match( '/\bmw:PageProp\/Language\b/', $rtData->type ) ) {
			$target->value = preg_replace( '/^:/', '', implode( ':', $interWikiMatch ), 1 );
		} elseif (
			$oldPrefix && // Should we preserve the old prefix?
				strtolower( $oldPrefix[ 1 ] ) === strtolower( $interWikiMatch[ 0 ] )
|| // Check if the old prefix mapped to the same URL as
					// the new one. Use the old one if that's the case.
					// Example: [[w:Foo]] vs. [[:en:Foo]]
					( $wiki->interwikiMap->get( normalizeIWP( $oldPrefix[ 1 ] ) ) || [] )->url
=== ( $wiki->interwikiMap->get( normalizeIWP( $interWikiMatch[ 0 ] ) ) || [] )->url
		) {

			// Reuse old prefix capitalization
			if ( Util::decodeWtEntities( substr( $target->value, count( $oldPrefix[ 1 ] ) + 1 ) ) !== $interWikiMatch[ 1 ] ) {
				// Modified, update target.value.
				$target->value = $localPrefix + $oldPrefix[ 1 ] . ':' . $interWikiMatch[ 1 ];
			}
			// Ensure that we generate an interwiki link and not a language link!
			// Ensure that we generate an interwiki link and not a language link!
			if ( $rtData->isInterwikiLang && !( preg_match( '/^:/', $target->value ) ) ) {
				$target->value = ':' . $target->value;
			}
			// Else: preserve old encoding
		} else { // Else: preserve old encoding
		if ( $rtData->isLocal ) {
			// - interwikiMatch will be ":en", ":de", etc.
			// - This tests whether the interwiki-like link is actually
			// a local wikilink.
			$target->value = $interWikiMatch[ 1 ];
			$rtData->isInterwiki = $rtData->isInterwikiLang = false;
		} else {
			$target->value = implode( ':', $interWikiMatch );
		}
		}
		}
	}

	return $rtData;
};

/**
 * The provided URL is already percent-encoded -- but it may still
 * not be safe for wikitext.  Add additional escapes to make the URL
 * wikitext-safe. Don't touch percent escapes already in the url,
 * though!
 * @private
 */
$escapeExtLinkURL = function ( $urlStr ) {
	// this regexp is the negation of EXT_LINK_URL_CLASS in the PHP parser
	return preg_replace(

		// IPv6 host names are bracketed with [].  Entity-decode these.
		'/^([a-z][^:\/]*:)?\/\/&#x5B;([0-9a-f:.]+)&#x5D;(:\d|\/|$)/i',
		'$1//[$2]$3', preg_replace( '/[\]\[<>"\x00-\x20\x7F\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]|-(?=\{)/', function ( $m ) {
				return Util::entityEncodeAll( $m );
		}, $urlStr ),

		 1
	);
};

/**
 * Add a colon escape to a wikilink target string if needed.
 * @private
 */
$addColonEscape = function ( $env, $linkTarget, $linkData ) {
	$linkTitle = $env->makeTitleFromText( $linkTarget );
	if ( ( $linkTitle->getNamespace()->isCategory() || $linkTitle->getNamespace()->isFile() )
&& $linkData->type === 'mw:WikiLink'
&& !preg_match( '/^:/', $linkTarget )
	) {
		// Escape category and file links
		return ':' . $linkTarget;
	} else {
		return $linkTarget;
	}
};

$isURLLink = function ( $env, $node, $linkData ) use ( &$DOMUtils, &$getHref, &$Util ) {
	$target = $linkData->target;

	// Get plain text content, if any
	$contentStr = ( $node->hasChildNodes()
&& DOMUtils::allChildrenAreText( $node )
	) ? $node->textContent : null;
	// First check if we can serialize as an URL link
	return $contentStr
&& // Can we minimize this?
		( $target->value === $contentStr || $getHref( $env, $node ) === $contentStr )
&& // protocol-relative url links not allowed in text
		// (see autourl rule in peg tokenizer, T32269)
		!preg_match( ( '/^\/\//' ), $contentStr ) && Util::isProtocolValid( $contentStr, $env );
};

// Figure out if we need a piped or simple link
$isSimpleWikiLink = function ( $env, $dp, $target, $linkData ) use ( &$Util ) {
	$canUseSimple = false;
	$contentString = $linkData->content->string;

	// FIXME (SSS):
	// 1. Revisit this logic to see if all these checks
	// are still relevant or whether this can be simplified somehow.
	// 2. There are also duplicate computations for env.normalizedTitleKey(..)
	// and Util.decodeURIComponent(..) that could be removed.
	// 3. This could potentially be refactored as if-then chains.

	// Would need to pipe for any non-string content.
	// Preserve unmodified or non-minimal piped links.
	if ( $contentString !== null
&& ( $target->modified || $linkData->contentModified || $dp->stx !== 'piped' )
		// Relative links are not simple
		 && !preg_match( '/^\.\//', $contentString )
	) {
		// Strip colon escapes from the original target as that is
		// stripped when deriving the content string.
		// Strip ./ prefixes as well since they are relative link prefixes
		// added to all titles.
		$strippedTargetValue = preg_replace( '/^(:|\.\/)/', '', $target->value, 1 );
		$decodedTarget = Util::decodeWtEntities( $strippedTargetValue );
		// Deal with the protocol-relative link scenario as well
		$hrefHasProto = preg_match( '/^(\w+:)?\/\//', $linkData->href );

		// Normalize content string and decoded target before comparison.
		// Piped links don't come down this path => it is safe to normalize both.
		$contentString = preg_replace( '/_/', ' ', $contentString );
		$decodedTarget = preg_replace( '/_/', ' ', $decodedTarget );

		// See if the (normalized) content matches the
		// target, either shadowed or actual.
		$canUseSimple =
		$contentString === $decodedTarget
		// try wrapped in forward slashes in case they were stripped
		 || ( '/' . $contentString . '/' ) === $decodedTarget
		// normalize as titles and compare
		 || $env->normalizedTitleKey( $contentString, true ) === preg_replace( '/[\s_]+/', '_', $decodedTarget )
		// Relative link
		 || ( $env->conf->wiki->namespacesWithSubpages[ $env->page->ns ]
&& ( preg_match( '/^\.\.\/.*[^\/]$/', $strippedTargetValue )
&& $contentString === $env->resolveTitle( $strippedTargetValue ) )
|| ( preg_match( '/^\.\.\/.*?\/$/', $strippedTargetValue )
&& $contentString === preg_replace( '/^(?:\.\.\/)+(.*?)\/$/', '$1', $strippedTargetValue, 1 ) ) )
		// if content == href this could be a simple link... eg [[Foo]].
		// but if href is an absolute url with protocol, this won't
		// work: [[http://example.com]] is not a valid simple link!
		 || ( !$hrefHasProto
&& // Always compare against decoded uri because
				// <a rel="mw:WikiLink" href="7%25 Solution">7%25 Solution</a></p>
				// should serialize as [[7% Solution|7%25 Solution]]
				( $contentString === Util::decodeURIComponent( $linkData->href )
|| // normalize with underscores for comparison with href
					$env->normalizedTitleKey( $contentString, true ) === Util::decodeURIComponent( $linkData->href ) ) );
	}

	return $canUseSimple;
};

$serializeAsWikiLink = /* async */function ( $node, $state, $linkData ) use ( &$DOMDataUtils, &$Util, &$splitLinkContentString, &$escapeLinkTarget, &$DOMUtils, &$isSimpleWikiLink, &$WTUtils, &$addColonEscape, &$isURLLink, &$AutoURLLinkText, &$REDIRECT_TEST_RE, &$WikiLinkText ) {
	$contentParts = null;
	$contentSrc = '';
	$isPiped = false;
	$requiresEscaping = true;
	$env = $state->env;
	$wiki = $env->conf->wiki;
	$oldSOLState = $state->onSOL;
	$target = $linkData->target;
	$dp = DOMDataUtils::getDataParsoid( $node );

	// Decode any link that did not come from the source (data-mw/parsoid)
	// Links that come from data-mw/data-parsoid will be true titles,
	// but links that come from hrefs will need to be url-decoded.
	// Ex: <a href="/wiki/A%3Fb">Foobar</a>
	// Decode any link that did not come from the source (data-mw/parsoid)
	// Links that come from data-mw/data-parsoid will be true titles,
	// but links that come from hrefs will need to be url-decoded.
	// Ex: <a href="/wiki/A%3Fb">Foobar</a>
	if ( !$target->fromsrc ) {
		// Omit fragments from decoding
		$hash = array_search( '#', $target->value );
		if ( $hash > -1 ) {
			$target->value = Util::decodeURIComponent( substr( $target->value, 0, $hash/*CHECK THIS*/ ) ) + substr( $target->value, $hash );
		} else {
			$target->value = Util::decodeURIComponent( $target->value );
		}
	}

	// Special-case handling for category links
	// Special-case handling for category links
	if ( $linkData->type === 'mw:PageProp/Category' ) {
		// Split target and sort key
		$targetParts = preg_match( '/^([^#]*)#(.*)/', $target->value );

		if ( $targetParts ) {
			$target->value = preg_replace(

				'/_/', ' ', preg_replace(
					'/^(\.\.?\/)*/', '', $targetParts[ 1 ], 1 )
			);
			// FIXME: Reverse `Sanitizer.sanitizeTitleURI(strContent).replace(/#/g, '%23');`
			// FIXME: Reverse `Sanitizer.sanitizeTitleURI(strContent).replace(/#/g, '%23');`
			$strContent = Util::decodeURIComponent( $targetParts[ 2 ] );
			$contentParts = $splitLinkContentString( $strContent, $dp );
			$linkData->content->string = $contentParts->contentString;
			$dp->tail = $linkData->tail = $contentParts->tail;
			$dp->prefix = $linkData->prefix = $contentParts->prefix;
		} else { // No sort key, will serialize to simple link
			// Normalize the content string
			$linkData->content->string = preg_replace( '/_/', ' ', preg_replace( '/^\.\//', '', $target->value, 1 ) );
		}

		// Special-case handling for template-affected sort keys
		// FIXME: sort keys cannot be modified yet, but if they are,
		// we need to fully shadow the sort key.
		// if ( !target.modified ) {
		// The target and source key was not modified
		// Special-case handling for template-affected sort keys
		// FIXME: sort keys cannot be modified yet, but if they are,
		// we need to fully shadow the sort key.
		// if ( !target.modified ) {
		// The target and source key was not modified
		$sortKeySrc =
		/* await */ $state->serializer->serializedAttrVal( $node, 'mw:sortKey' );
		if ( $sortKeySrc->value !== null ) {
			$linkData->contentNode = null;
			$linkData->content->string = $sortKeySrc->value;
			// TODO: generalize this flag. It is already used by
			// getAttributeShadowInfo. Maybe use the same
			// structure as its return value?
			// TODO: generalize this flag. It is already used by
			// getAttributeShadowInfo. Maybe use the same
			// structure as its return value?
			$linkData->content->fromsrc = true;
		}
		// }
	} else { // }
	if ( $linkData->type === 'mw:PageProp/Language' ) {
		// Fix up the the content string
		// TODO: see if linkData can be cleaner!
		if ( $linkData->content->string === null ) {
			$linkData->content->string = Util::decodeWtEntities( $target->value );
		}
	}
	}

	// The string value of the content, if it is plain text.
	// The string value of the content, if it is plain text.
	$linkTarget = null;
$escapedTgt = null;
	if ( $linkData->isRedirect ) {
		$linkTarget = $target->value;
		if ( $target->modified || !$target->fromsrc ) {
			$linkTarget = preg_replace( '/_/', ' ', preg_replace( '/^(\.\.?\/)*/', '', $linkTarget, 1 ) );
			$escapedTgt = $escapeLinkTarget( $linkTarget, $state );
			$linkTarget = $escapedTgt->linkTarget;
			// Determine if it's a redirect to a category, in which case
			// it needs a ':' on front to distingish from a category link.
			// Determine if it's a redirect to a category, in which case
			// it needs a ':' on front to distingish from a category link.
			$categoryMatch = preg_match( '/^([^:]+)[:]/', $linkTarget );
			if ( $categoryMatch ) {
				$ns = $wiki->namespaceIds->get( Util::normalizeNamespaceName( $categoryMatch[ 1 ] ) );
				if ( $ns === $wiki->canonicalNamespaces->category ) {
					// Check that the next node isn't a category link,
					// in which case we don't want the ':'.
					$nextNode = $node->nextSibling;
					if ( !$nextNode && DOMUtils::isElt( $nextNode ) && $nextNode->nodeName === 'LINK'
&& $nextNode->getAttribute( 'rel' ) === 'mw:PageProp/Category'
&& $nextNode->getAttribute( 'href' ) === $node->getAttribute( 'href' )
					) {
						$linkTarget = ':' . $linkTarget;
					}
				}
			}
		}
	} elseif ( $isSimpleWikiLink( $env, $dp, $target, $linkData ) ) {
		// Simple case
		if ( !$target->modified && !$linkData->contentModified ) {
			$linkTarget = preg_replace( '/^\.\//', '', $target->value, 1 );
		} else {
			// If token has templated attrs or is a subpage, use target.value
			// since content string will be drastically different.
			if ( WTUtils::hasExpandedAttrsType( $node )
|| preg_match( '/(^|\/)\.\.\//', $target->value )
			) {
				$linkTarget = preg_replace( '/^\.\//', '', $target->value, 1 );
			} else {
				$escapedTgt = $escapeLinkTarget( $linkData->content->string, $state );
				if ( !$escapedTgt->invalidLink ) {
					$linkTarget = $addColonEscape( $env, $escapedTgt->linkTarget, $linkData );
				} else {
					$linkTarget = $escapedTgt->linkTarget;
				}
			}
			if ( $linkData->isInterwikiLang && !preg_match( '/^[:]/', $linkTarget )
&& $linkData->type !== 'mw:PageProp/Language'
			) {
				// ensure interwiki links can't be confused with
				// interlanguage links.
				$linkTarget = ':' . $linkTarget;
			}
		}
	} elseif ( $isURLLink( $state->env, $node, $linkData )/* && !linkData.isInterwiki */ ) { /* && !linkData.isInterwiki */
		// Uncomment the above check if we want [[wikipedia:Foo|http://en.wikipedia.org/wiki/Foo]]
		// for '<a href="http://en.wikipedia.org/wiki/Foo">http://en.wikipedia.org/wiki/Foo</a>'
		$linkData->linkType = 'mw:URLLink';
	} else {
		// Emit piped wikilink syntax
		$isPiped = true;

		// First get the content source
		// First get the content source
		if ( $linkData->contentNode ) {
			$cs = /* await */ $state->serializeLinkChildrenToString(
				$linkData->contentNode,
				$state->serializer->wteHandlers->wikilinkHandler
			);
			// strip off the tail and handle the pipe trick
			// strip off the tail and handle the pipe trick
			$contentParts = $splitLinkContentString( $cs, $dp );
			$contentSrc = $contentParts->contentString;
			$dp->tail = $contentParts->tail;
			$linkData->tail = $contentParts->tail;
			$dp->prefix = $contentParts->prefix;
			$linkData->prefix = $contentParts->prefix;
			$requiresEscaping = false;
		} else {
			$contentSrc = $linkData->content->string || '';
			$requiresEscaping = !$linkData->content->fromsrc;
		}

		if ( $contentSrc === ''
&& $linkData->type !== 'mw:PageProp/Category'
		) {
			// Protect empty link content from PST pipe trick
			$contentSrc = '<nowiki/>';
			$requiresEscaping = false;
		}

		$linkTarget = $target->value;
		if ( $target->modified || !$target->fromsrc ) {
			// Links starting with ./ shouldn't get _ replaced with ' '
			$linkContentIsRelative =
			$linkData->content && $linkData->content->string
&& preg_match( '/^\.\//', $linkData->content->string );
			$linkTarget = preg_replace( '/^(\.\.?\/)*/', '', $linkTarget, 1 );
			if ( !$linkData->isInterwiki && !$linkContentIsRelative ) {
				$linkTarget = preg_replace( '/_/', ' ', $linkTarget );
			}
			$escapedTgt = $escapeLinkTarget( $linkTarget, $state );
			$linkTarget = $escapedTgt->linkTarget;
		}

		// If we are reusing the target from source, we don't
		// need to worry about colon-escaping because it will
		// be in the right form already.
		//
		// Trying to eliminate this check and always check for
		// colon-escaping seems a bit tricky when the reused
		// target has encoded entities that won't resolve to
		// valid titles.
		// If we are reusing the target from source, we don't
		// need to worry about colon-escaping because it will
		// be in the right form already.
		//
		// Trying to eliminate this check and always check for
		// colon-escaping seems a bit tricky when the reused
		// target has encoded entities that won't resolve to
		// valid titles.
		if ( ( !$escapedTgt || !$escapedTgt->invalidLink ) && !$target->fromsrc ) {
			$linkTarget = $addColonEscape( $env, $linkTarget, $linkData );
		}
	}
	if ( $linkData->linkType === 'mw:URLLink' ) {
		$state->emitChunk( new AutoURLLinkText( $node->textContent, $node ), $node );
		return;
	}

	if ( $linkData->isRedirect ) {
		// Drop duplicates
		if ( $state->redirectText !== null ) {
			return;
		}

		// Buffer redirect text if it is not in start of file position
		// Buffer redirect text if it is not in start of file position
		if ( !preg_match( $REDIRECT_TEST_RE, $state->out + $state->currLine->text ) ) {
			$state->redirectText = $linkData->prefix . '[[' . $linkTarget . ']]';
			$state->emitChunk( '', $node ); // Flush seperators for this node
			// Flush seperators for this node
			return;
		}

		// Set to some non-null string
		// Set to some non-null string
		$state->redirectText = 'unbuffered';
	}

	$pipedText = null;
	if ( $escapedTgt && $escapedTgt->invalidLink ) {
		// If the link target was invalid, instead of emitting an invalid link,
		// omit the link and serialize just the content instead. But, log the
		// invalid html for Parsoid clients to investigate later.
		$state->env->log( 'error/html2wt/link', 'Bad title text', $node->outerHTML );

		// For non-piped content, use the original invalid link text
		// For non-piped content, use the original invalid link text
		$pipedText = ( $isPiped ) ? $contentSrc : $linkTarget;

		if ( $requiresEscaping ) {
			// Escape the text in the old sol context
			$state->onSOL = $oldSOLState;
			$pipedText = $state->serializer->wteHandlers->escapeWikiText( $state, $pipedText, [ 'node' => $node ] );
		}
		$state->emitChunk( $linkData->prefix + $pipedText + $linkData->tail, $node );
	} else {
		if ( $isPiped && $requiresEscaping ) {
			// We are definitely not in sol context since content
			// will be preceded by "[[" or "[" text in target wikitext.
			$pipedText = '|' . $state->serializer->wteHandlers->escapeLinkContent( $state, $contentSrc, false, $node, false );
		} elseif ( $isPiped ) {
			$pipedText = '|' . $contentSrc;
		} else {
			$pipedText = '';
		}
		$state->emitChunk( new WikiLinkText(
				$linkData->prefix . '[[' . $linkTarget . $pipedText . ']]' . $linkData->tail,
				$node, $wiki, $linkData->type
			), $node
		);
	}
};

$serializeAsExtLink = /* async */function ( $node, $state, $linkData ) use ( &$escapeExtLinkURL, &$isURLLink, &$AutoURLLinkText, &$WikiLinkText, &$ExtLinkText, &$MagicLinkText ) {
	$target = $linkData->target;
	$urlStr = $target->value;
	if ( $target->modified || !$target->fromsrc ) {
		// We expect modified hrefs to be percent-encoded already, so
		// don't need to encode them here any more. Unmodified hrefs are
		// just using the original encoding anyway.
		// BUT we do have to encode certain special wikitext
		// characters (like []) which aren't necessarily
		// percent-encoded because they are valid in URLs and HTML5
		$urlStr = $escapeExtLinkURL( $urlStr );
	}

	if ( $isURLLink( $state->env, $node, $linkData ) ) {
		// Serialize as URL link
		$state->emitChunk( new AutoURLLinkText( $urlStr, $node ), $node );
		return;
	}

	$wiki = $state->env->conf->wiki;

	// TODO: match vs. interwikis too
	// TODO: match vs. interwikis too
	$magicLinkMatch = preg_match( Util::decodeURI( $linkData->origHref ), $wiki::ExtResourceURLPatternMatcher );
	$pureHashMatch = preg_match( '/^#/', $urlStr );
	// Fully serialize the content
	// Fully serialize the content
	$contentStr = /* await */ $state->serializeLinkChildrenToString(
		$node,
		( $pureHashMatch ) ?
		$state->serializer->wteHandlers->wikilinkHandler :
		$state->serializer->wteHandlers->aHandler
	);
	// First check for ISBN/RFC/PMID links. We rely on selser to
	// preserve non-minimal forms.
	// First check for ISBN/RFC/PMID links. We rely on selser to
	// preserve non-minimal forms.
	if ( $magicLinkMatch ) {
		$serializer = $wiki::ExtResourceSerializer[ $magicLinkMatch[ 0 ] ];
		$serialized = $serializer( $magicLinkMatch, $target->value, $contentStr );
		if ( $serialized[ 0 ] === '[' ) {
			// Serialization as a magic link failed (perhaps the
			// content string wasn't appropriate).
			$state->emitChunk(
				( $magicLinkMatch[ 0 ] === 'ISBN' ) ?
				new WikiLinkText( $serialized, $node, $wiki, 'mw:WikiLink' ) :
				new ExtLinkText( $serialized, $node, $wiki, 'mw:ExtLink' ),
				$node
			);
		} else {
			$state->emitChunk( new MagicLinkText( $serialized, $node ), $node );
		}
		return;
		// There is an interwiki for RFCs, but strangely none for PMIDs.
	} else { // There is an interwiki for RFCs, but strangely none for PMIDs.

		// serialize as auto-numbered external link
		// [http://example.com]
		$linktext = null;
$Construct = null;
		// If it's just anchor text, serialize as an internal link.
		// If it's just anchor text, serialize as an internal link.
		if ( $pureHashMatch ) {
			$Construct = $WikiLinkText;
			$linktext = '[[' . $urlStr . ( ( $contentStr ) ? '|' . $contentStr : '' ) . ']]';
		} else {
			$Construct = $ExtLinkText;
			$linktext = '[' . $urlStr . ( ( $contentStr ) ? ' ' . $contentStr : '' ) . ']';
		}
		$state->emitChunk( new Construct( $linktext, $node, $wiki, $linkData->type ), $node );
		return;
	}
};

/**
 * Main link handler.
 * @function
 * @param {Node} node
 * @return {Promise}
 */
$linkHandler = /* async */function ( $node ) use ( &$getLinkRoundTripData, &$serializeAsWikiLink, &$serializeAsExtLink, &$DOMDataUtils, &$DOMUtils, &$escapeExtLinkURL, &$getHref, &$ExtLinkText ) {
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links without advanced attributes to
	// external wiki links for html import. Might want to consider converting
	// relative links without path component and file extension to wiki links.
	$env = $this->env;
	$state = $this->state;
	$wiki = $env->conf->wiki;

	// Get the rt data from the token and tplAttrs
	// Get the rt data from the token and tplAttrs
	$linkData = /* await */ $getLinkRoundTripData( $env, $node, $state );
	$linkType = $linkData->type;
	if ( preg_match( Util::decodeURI( $linkData->origHref ), $wiki::ExtResourceURLPatternMatcher ) ) {
		// Override the 'rel' type if this is a magic link
		$linkType = 'mw:ExtLink';
	}
	if ( $linkType !== null && $linkData->target->value !== null ) {
		// We have a type and target info
		if ( preg_match( '/^mw:WikiLink|mw:MediaLink$/', $linkType )
|| preg_match( TokenUtils::solTransparentLinkRegexp, $linkType )
		) {
			// [[..]] links: normal, category, redirect, or lang links
			// (except images)
			return ( /* await */ $serializeAsWikiLink( $node, $state, $linkData ) );
		} elseif ( $linkType === 'mw:ExtLink' ) {
			// [..] links, autolinks, ISBN, RFC, PMID
			return ( /* await */ $serializeAsExtLink( $node, $state, $linkData ) );
		} else {
			throw new Error( 'Unhandled link serialization scenario: '
. $node->outerHTML
			);
		}
	} else {
		$safeAttr = new Set( [ 'href', 'rel', 'class', 'title', DOMDataUtils\DataObjectAttrName() ] );
		$isComplexLink = function ( $attributes ) use ( &$safeAttr ) {
			for ( $i = 0;  $i < count( $attributes );  $i++ ) {
				$attr = $attributes->item( $i );
				// XXX: Don't drop rel and class in every case once a tags are
				// actually supported in the MW default config?
				// XXX: Don't drop rel and class in every case once a tags are
				// actually supported in the MW default config?
				if ( $attr->name && !$safeAttr->has( $attr->name ) ) {
					return true;
				}
			}
			return false;
		};

		$isFigure = false;
		if ( $isComplexLink( $node->attributes ) ) {
			$env->log( 'error/html2wt/link', 'Encountered', $node->outerHTML,
				'-- serializing as extlink and dropping <a> attributes unsupported in wikitext.'
			);
		} else {
			$media = DOMUtils::selectMediaElt( $node );
			$isFigure = (bool)( $media && $media->parentElement === $node );
		}

		$hrefStr = null;
		if ( $isFigure ) {
			// this is a basic html figure: <a><img></a>
			return ( /* await */ $state->serializer->figureHandler( $node ) );
		} else {
			// href is already percent-encoded, etc., but it might contain
			// spaces or other wikitext nasties.  escape the nasties.
			$hrefStr = $escapeExtLinkURL( $getHref( $env, $node ) );
			$handler = $state->serializer->wteHandlers->aHandler;
			$str = /* await */ $state->serializeLinkChildrenToString( $node, $handler );
			$chunk = null;
			if ( !$hrefStr ) {
				// Without an href, we just emit the string as text.
				// However, to preserve targets for anchor links,
				// serialize as a span with a name.
				if ( $node->hasAttribute( 'name' ) ) {
					$name = $node->getAttribute( 'name' );
					$doc = $node->ownerDocument;
					$span = $doc->createElement( 'span' );
					$span->setAttribute( 'name', $name );
					$span->appendChild( $doc->createTextNode( $str ) );
					$chunk = $span->outerHTML;
				} else {
					$chunk = $str;
				}
			} else {
				$chunk = new ExtLinkText( '[' . $hrefStr . ' ' . $str . ']',
					$node, $wiki, 'mw:ExtLink'
				);
			}
			$state->emitChunk( $chunk, $node );
		}
	}
};

function eltNameFromMediaType( $type ) {
	switch ( $type ) {
		case 'mw:Audio':
		return 'AUDIO';
		case 'mw:Video':
		return 'VIDEO';
		default:
		return 'IMG';
	}
}

/**
 * Main figure handler.
 *
 * All figures have a fixed structure:
 * ```
 * <figure or figure-inline typeof="mw:Image...">
 *  <a or span><img ...><a or span>
 *  <figcaption>....</figcaption>
 * </figure or figure-inline>
 * ```
 * Pull out this fixed structure, being as generous as possible with
 * possibly-broken HTML.
 *
 * @function
 * @param {Node} node
 * @return {Promise}
 */
$figureHandler = /* async */function ( $node ) use ( &$WTSUtils, &$AutoURLLinkText, &$DOMDataUtils, &$ContentUtils, &$Promise, &$lastItem, &$WikiLinkText ) {
	$env = $this->env;
	$state = $this->state;
	$outerElt = $node;

	$mediaTypeInfo = WTSUtils::getMediaType( $node );
	$temp1 = $mediaTypeInfo;
$rdfaType = $temp1->rdfaType;
	$temp2 = $mediaTypeInfo;
$format = $temp2->format;

	$eltName = eltNameFromMediaType( $rdfaType );
	$elt = $node->querySelector( $eltName );
	// TODO: Remove this when version 1.7.0 of the content is no longer supported
	// TODO: Remove this when version 1.7.0 of the content is no longer supported
	if ( !$elt && $rdfaType === 'mw:Audio' ) {
		$eltName = 'VIDEO';
		$elt = $node->querySelector( $eltName );
	}

	$linkElt = null;
	// parent of elt is probably the linkElt
	// parent of elt is probably the linkElt
	if ( $elt
&& ( $elt->parentElement->tagName === 'A'
|| ( $elt->parentElement->tagName === 'SPAN'
&& $elt->parentElement !== $outerElt ) )
	) {
		$linkElt = $elt->parentElement;
	}

	// FIGCAPTION or last child (which is not the linkElt) is the caption.
	// FIGCAPTION or last child (which is not the linkElt) is the caption.
	$captionElt = $node->querySelector( 'FIGCAPTION' );
	if ( !$captionElt ) {
		for ( $captionElt = $node->lastElementChild;
			$captionElt;
			$captionElt = $captionElt->previousElementSibling
		) {
			if ( $captionElt !== $linkElt && $captionElt !== $elt
&& preg_match( '/^(SPAN|DIV)$/', $captionElt->tagName )
			) {
				break;
			}
		}
	}

	// special case where `node` is the ELT tag itself!
	// special case where `node` is the ELT tag itself!
	if ( $node->tagName === $eltName ) {
		$linkElt = $captionElt = null;
		$outerElt = $elt = $node;
	}

	// Maybe this is "missing" media, i.e. a redlink
	// Maybe this is "missing" media, i.e. a redlink
	$isMissing = false;
	if ( !$elt
&& preg_match( '/^FIGURE/', $outerElt->nodeName )
&& $outerElt->firstChild && $outerElt->firstChild->nodeName === 'A'
&& $outerElt->firstChild->firstChild && $outerElt->firstChild->firstChild->nodeName === 'SPAN'
	) {
		$linkElt = $outerElt->firstChild;
		$elt = $linkElt->firstChild;
		$isMissing = true;
	}

	// The only essential thing is the ELT tag!
	// The only essential thing is the ELT tag!
	if ( !$elt ) {
		$env->log( 'error/html2wt/figure',
			'In WSP.figureHandler, node does not have any ' . $eltName . ' elements:',
			$node->outerHTML
		);
		$state->emitChunk( '', $node );
		return;
	}

	// Try to identify the local title to use for this image.
	// Try to identify the local title to use for this image.
	$resource = /* await */ $this->serializedImageAttrVal( $outerElt, $elt, 'resource' );
	if ( $resource->value === null ) {
		// from non-parsoid HTML: try to reconstruct resource from src?
		// (this won't work for manual-thumb images)
		if ( !$elt->hasAttribute( 'src' ) ) {
			$env->log( 'error/html2wt/figure',
				'In WSP.figureHandler, img does not have resource or src:',
				$node->outerHTML
			);
			$state->emitChunk( '', $node );
			return;
		}
		$src = $elt->getAttribute( 'src' );
		if ( preg_match( '/^https?:/', $src ) ) {
			// external image link, presumably $wgAllowExternalImages=true
			$state->emitChunk( new AutoURLLinkText( $src, $node ), $node );
			return;
		}
		$resource = [
			'value' => $src,
			'fromsrc' => false,
			'modified' => false
		];
	}
	if ( !$resource->fromsrc ) {
		$resource->value = preg_replace( '/^(\.\.?\/)+/', '', $resource->value, 1 );
	}

	$nopts = [];
	$outerDP = ( $outerElt ) ? DOMDataUtils::getDataParsoid( $outerElt ) : [];
	$outerDMW = ( $outerElt ) ? DOMDataUtils::getDataMw( $outerElt ) : [];
	$mwAliases = $state->env->conf->wiki->mwAliases;

	$getOpt = function ( $key ) use ( &$outerDP ) {
		if ( !$outerDP->optList ) {
			return null;
		}
		return $outerDP->optList->find( function ( $o ) use ( &$key ) { return $o->ck === $key;
  } );
	};
	$getLastOpt = function ( $key ) use ( &$outerDP ) {
		$o = $outerDP->optList || [];
		for ( $i = count( $o ) - 1;  $i >= 0;  $i-- ) {
			if ( $o[ $i ]->ck === $key ) {
				return $o[ $i ];
			}
		}
		return null;
	};

	// Try to identify the local title to use for the link.
	// Try to identify the local title to use for the link.
	$link = null;

	$linkFromDataMw = WTSUtils::getAttrFromDataMw( $outerDMW, 'link', true );
	if ( $linkFromDataMw !== null ) {
		// "link" attribute on the `outerElt` takes precedence
		if ( $linkFromDataMw[ 1 ]->html !== null ) {
			$link = /* await */ $state->serializer->getAttributeValueAsShadowInfo( $outerElt, 'link' );
		} else {
			$link = [
				'value' => "link={$linkFromDataMw[ 1 ]->txt}",
				'modified' => false,
				'fromsrc' => false,
				'fromDataMW' => true
			];
		}
	} elseif ( $linkElt && $linkElt->hasAttribute( 'href' ) ) {
		$link = /* await */ $state->serializer->serializedImageAttrVal( $outerElt, $linkElt, 'href' );
		if ( !$link->fromsrc ) {
			if ( $linkElt->getAttribute( 'href' )
=== $elt->getAttribute( 'resource' )
			) {
				// default link: same place as resource
				$link = $resource;
			}
			$link->value = preg_replace( '/^(\.\.?\/)+/', '', $link->value, 1 );
		}
	} else {
		// Otherwise, just try and get it from data-mw
		$link = /* await */ $state->serializer->getAttributeValueAsShadowInfo( $outerElt, 'href' );
	}

	if ( $link && !$link->modified && !$link->fromsrc ) {
		$linkOpt = $getOpt( 'link' );
		if ( $linkOpt ) {
			$link->fromsrc = true;
			$link->value = $linkOpt->ak;
		}
	}

	// Reconstruct the caption
	// Reconstruct the caption
	if ( !$captionElt && gettype( $outerDMW->caption ) === 'string' ) {
		$captionElt = $outerElt->ownerDocument->createElement( 'div' );
		ContentUtils::ppToDOM( $env, $outerDMW->caption, [ 'node' => $captionElt, 'markNew' => true ] );
		// Needs a parent node in order for WTS to be happy:
		// DocumentFragment to the rescue!
		// Needs a parent node in order for WTS to be happy:
		// DocumentFragment to the rescue!
		$outerElt->ownerDocument->createDocumentFragment()->appendChild( $captionElt );
	}

	$caption = null;
	if ( $captionElt ) {
		$caption = /* await */ $state->serializeCaptionChildrenToString(
			$captionElt, $state->serializer->wteHandlers->mediaOptionHandler
		);
	}

	// Fetch the alt (if any)
	// Fetch the alt (if any)
	$alt =
	/* await */ $state->serializer->serializedImageAttrVal( $outerElt, $elt, 'alt' );
	// Fetch the lang (if any)
	// Fetch the lang (if any)
	$lang =
	/* await */ $state->serializer->serializedImageAttrVal( $outerElt, $elt, 'lang' );

	// Ok, start assembling options, beginning with link & alt & lang
	// Other media don't have links in output.
	// Ok, start assembling options, beginning with link & alt & lang
	// Other media don't have links in output.
	$linkCond = $elt->nodeName === 'IMG' && ( !$link || $link->value !== $resource->value );

	// "alt" for non-image is handle below
	// "alt" for non-image is handle below
	$altCond = $alt->value !== null && $elt->nodeName === 'IMG';

	[
		[ 'name' => 'link', 'value' => $link, 'cond' => $linkCond ],
		[ 'name' => 'alt', 'value' => $alt, 'cond' => $altCond ],
		[ 'name' => 'lang', 'value' => $lang, 'cond' => $lang->value !== null ]
	]->forEach( function ( $o ) use ( &$nopts, &$state, &$node ) {
			if ( !$o->cond ) { return;
   }
			if ( $o->value && $o->value->fromsrc ) {
				$nopts[] = [
					'ck' => $o->name,
					'ak' => [ $o->value->value ]
				];
			} else {
				$value = ( $o->value ) ? $o->value->value : '';
				if ( $o->value && preg_match( '/^(link|alt)$/', $o->name ) ) {
					// see wt2html/tt/LinkHandler.js: link and alt are whitelisted
					// for accepting arbitrary wikitext, even though it is stripped
					// to a string before emitting.
					$value = $state->serializer->wteHandlers->escapeLinkContent( $state, $value, false, $node, true );
				}
				$nopts[] = [
					'ck' => $o->name,
					'v' => $value,
					'ak' => $mwAliases[ 'img_' . $o->name ]
				];
			}
	}
	);

	// Handle class-signified options
	// Handle class-signified options
	$classes = ( $outerElt ) ? $outerElt->classList : [];
	$extra = []; // 'extra' classes
	// 'extra' classes
	$val = null;

	for ( $ix = 0;  $ix < count( $classes );  $ix++ ) {
		switch ( $classes[ $ix ] ) {
			case 'mw-halign-none':

			case 'mw-halign-right':

			case 'mw-halign-left':

			case 'mw-halign-center':
			$val = preg_replace( '/^mw-halign-/', '', $classes[ $ix ], 1 );
			$nopts[] = [
				'ck' => $val,
				'ak' => $mwAliases[ 'img_' . $val ]
			];
			break;

			case 'mw-valign-top':

			case 'mw-valign-middle':

			case 'mw-valign-baseline':

			case 'mw-valign-sub':

			case 'mw-valign-super':

			case 'mw-valign-text-top':

			case 'mw-valign-bottom':

			case 'mw-valign-text-bottom':
			$val = preg_replace(
				'/-/', '_', preg_replace( '/^mw-valign-/', '', $classes[ $ix ], 1 ) );
			$nopts[] = [
				'ck' => $val,
				'ak' => $mwAliases[ 'img_' . $val ]
			];
			break;

			case 'mw-image-border':
			$nopts[] = [
				'ck' => 'border',
				'ak' => $mwAliases->img_border
			];
			break;

			case 'mw-default-size':

			case 'mw-default-audio-height':
			// handled below
			break;

			default:
			$extra[] = $classes[ $ix ];
			break;
		}
	}

	if ( count( $extra ) ) {
		$nopts[] = [
			'ck' => 'class',
			'v' => implode( ' ', $extra ),
			'ak' => $mwAliases->img_class
		];
	}

	$paramFromDataMw = /* async */function ( $o ) use ( &$outerDMW, &$WTSUtils, &$state, &$outerElt, &$mwAliases, &$nopts ) {
		$v = $outerDMW[ $o->prop ];
		if ( $v === null ) {
			$a = WTSUtils::getAttrFromDataMw( $outerDMW, $o->ck, true );
			if ( $a !== null && $a[ 1 ]->html === null ) { $v = $a[ 1 ]->txt;
   }
		}
		if ( $v !== null ) {
			$ak = /* await */ $state->serializer->getAttributeValue(
				$outerElt, $o->ck, $mwAliases[ $o->alias ]
			);
			$nopts[] = [
				'ck' => $o->ck,
				'ak' => $ak,
				'v' => $v
			];
			// Piggyback this here ...
			// Piggyback this here ...
			if ( $o->prop === 'thumb' ) { $format = '';
   }
		}
	};

	$mwParams = [
		[ 'prop' => 'thumb', 'ck' => 'manualthumb', 'alias' => 'img_manualthumb' ],
		[ 'prop' => 'page', 'ck' => 'page', 'alias' => 'img_page' ],
		// mw:Video specific
		[ 'prop' => 'starttime', 'ck' => 'starttime', 'alias' => 'timedmedia_starttime' ],
		[ 'prop' => 'endtime', 'ck' => 'endtime', 'alias' => 'timedmedia_endtime' ],
		[ 'prop' => 'thumbtime', 'ck' => 'thumbtime', 'alias' => 'timedmedia_thumbtime' ]
	];

	// "alt" for images is handled above
	// "alt" for images is handled above
	if ( $elt->nodeName !== 'IMG' ) {
		$mwParams = $mwParams->concat( [
				[ 'prop' => 'link', 'ck' => 'link', 'alias' => 'img_link' ],
				[ 'prop' => 'alt', 'ck' => 'alt', 'alias' => 'img_alt' ]
			]
		);
	}

	/* await */ Promise::map( $mwParams, $paramFromDataMw );

	switch ( $format ) {
		case 'Thumb':
		$nopts[] = [
			'ck' => 'thumbnail',
			'ak' => /* await */ $state->serializer->getAttributeValue(
				$outerElt, 'thumbnail', $mwAliases->img_thumbnail
			)
		];
		break;
		case 'Frame':
		$nopts[] = [
			'ck' => 'framed',
			'ak' => /* await */ $state->serializer->getAttributeValue(
				$outerElt, 'framed', $mwAliases->img_framed
			)
		];
		break;
		case 'Frameless':
		$nopts[] = [
			'ck' => 'frameless',
			'ak' => /* await */ $state->serializer->getAttributeValue(
				$outerElt, 'frameless', $mwAliases->img_frameless
			)
		];
		break;
	}

	// Get the user-specified height from wikitext
	// Get the user-specified height from wikitext
	$wh =
	/* await */ $state->serializer->serializedImageAttrVal( $outerElt, $elt, "{( $isMissing ) ? 'data-' : ''}height" );
	// Get the user-specified width from wikitext
	// Get the user-specified width from wikitext
	$ww =
	/* await */ $state->serializer->serializedImageAttrVal( $outerElt, $elt, "{( $isMissing ) ? 'data-' : ''}width" );

	$sizeUnmodified = $ww->fromDataMW || ( !$ww->modified && !$wh->modified );
	$upright = $getOpt( 'upright' );

	// XXX: Infer upright factor from default size for all thumbs by default?
	// Better for scaling with user prefs, but requires knowledge about
	// default used in VE.
	// XXX: Infer upright factor from default size for all thumbs by default?
	// Better for scaling with user prefs, but requires knowledge about
	// default used in VE.
	if ( $sizeUnmodified && $upright
		// Only serialize upright where it is actually respected
		// This causes some dirty diffs, but makes sure that we don't
		// produce nonsensical output after a type switch.
		// TODO: Only strip if type was actually modified.
		 && // Only serialize upright where it is actually respected
			// This causes some dirty diffs, but makes sure that we don't
			// produce nonsensical output after a type switch.
			// TODO: Only strip if type was actually modified.
			isset( [ 'Frameless' => 1, 'Thumb' => 1 ][ $format ] )
	) {
		// preserve upright option
		$nopts[] = [
			'ck' => $upright->ck,
			'ak' => [ $upright->ak ]
		];
	}// FIXME: don't use ak here!

	if ( !( $outerElt && $outerElt->classList->contains( 'mw-default-size' ) ) ) {
		$size = $getLastOpt( 'width' );
		$sizeString = ( $size && $size->ak ) || ( $ww->fromDataMW && $ww->value );
		if ( $sizeUnmodified && $sizeString ) {
			// preserve original width/height string if not touched
			$nopts[] = [
				'ck' => 'width',
				'v' => $sizeString, // original size string
				'ak' => [ '$1' ]
			];
		} else { // don't add px or the like

			$bbox = null;
			// Serialize to a square bounding box
			// Serialize to a square bounding box
			if ( $ww->value !== null && $ww->value !== ''
&& $ww->value !== null
			) {
				$bbox = +$ww->value;
			}
			if ( $wh->value !== null && $wh->value !== '' && $wh->value !== null
&& // As with "mw-default-size", editing clients should remove the
					// "mw-default-audio-height" if they want to factor a defined
					// height into the bounding box size.  However, note that, at
					// present, a defined height for audio is ignored while parsing,
					// so this only has the effect of modifying the width.
					( $rdfaType !== 'mw:Audio'
|| !$outerElt->classList->contains( 'mw-default-audio-height' ) )
			) {
				$height = +$wh->value;
				if ( $bbox === null || $height > $bbox ) {
					$bbox = $height;
				}
			}
			if ( $bbox !== null ) {
				$nopts[] = [
					'ck' => 'width',
					// MediaWiki interprets 100px as a width
					// restriction only, so we need to make the bounding
					// box explicitly square (100x100px). The 'px' is
					// added by the alias though, and can be localized.
					'v' => $bbox . 'x' . $bbox,
					'ak' => $mwAliases->img_width
				];
			}
		}
	}// adds the 'px' suffix

	$opts = $outerDP->optList || []; // original wikitext options

	// Add bogus options from old optlist in order to round-trip cleanly (T64500)
	// original wikitext options

	// Add bogus options from old optlist in order to round-trip cleanly (T64500)
	$opts->forEach( function ( $o ) use ( &$nopts ) {
			if ( $o->ck === 'bogus' ) {
				$nopts[] = [
					'ck' => 'bogus',
					'ak' => [ $o->ak ]
				];
			}
	}
	);

	// Put the caption last, by default.
	// Put the caption last, by default.
	if ( gettype( $caption ) === 'string' ) {
		$nopts[] = [
			'ck' => 'caption',
			'ak' => [ $caption ]
		];
	}

	// ok, sort the new options to match the order given in the old optlist
	// and try to match up the aliases used
	// ok, sort the new options to match the order given in the old optlist
	// and try to match up the aliases used
	$changed = false;
	$nopts->forEach( function ( $no ) use ( &$opts, &$state, &$lastItem ) {
			// Make sure we have an array here. Default in data-parsoid is
			// actually a string.
			// FIXME: don't reuse ak for two different things!
			if ( !is_array( $no->ak ) ) {
				$no->ak = [ $no->ak ];
			}

			$no->sortId = count( $opts );
			$idx = $opts->findIndex( function ( $o ) use ( &$no ) {
					return $o->ck === $no->ck
&& // for bogus options, make sure the source matches too.
						( $o->ck !== 'bogus' || $o->ak === $no->ak[ 0 ] );
			}
			);
			if ( $idx < 0 ) {
				// Preferred words are first in the alias list
				// (but not in old versions of mediawiki).
				$no->ak = ( $state->env->conf->wiki->useOldAliasOrder ) ?
				$lastItem( $no->ak ) : $no->ak[ 0 ];
				$changed = true;
				return; /* new option */
			}/* new option */

			$no->sortId = $idx;
			// use a matching alias, if there is one
			// use a matching alias, if there is one
			$a = $no->ak->find( function ( $b ) use ( &$no ) {
					// note the trim() here; that allows us to snarf eccentric
					// whitespace from the original option wikitext
					if ( isset( $no[ 'v' ] ) ) { $b = str_replace( '$1', $no->v, $b );
		   }
					return $b === trim( String( $opts[ $idx ]->ak ) );
			}
			);
			// use the alias (incl whitespace) from the original option wikitext
			// if found; otherwise use the last alias given (English default by
			// convention that works everywhere).
			// TODO: use first alias (localized) instead for RTL languages (T53852)
			// use the alias (incl whitespace) from the original option wikitext
			// if found; otherwise use the last alias given (English default by
			// convention that works everywhere).
			// TODO: use first alias (localized) instead for RTL languages (T53852)
			if ( $a !== null && $no->ck !== 'caption' ) {
				$no->ak = $opts[ $idx ]->ak;
				$no->v = null; // prevent double substitution
			} else { // prevent double substitution

				$no->ak = $lastItem( $no->ak );
				if ( !( $no->ck === 'caption' && $a !== null ) ) {
					$changed = true;
				}
			}
	}
	);

	// Filter out bogus options if the image options/caption have changed.
	// Filter out bogus options if the image options/caption have changed.
	if ( $changed ) {
		$nopts = $nopts->filter( function ( $no ) { return $no->ck !== 'bogus';
  } );
		// empty captions should get filtered out in this case, too (T64264)
		// empty captions should get filtered out in this case, too (T64264)
		$nopts = $nopts->filter( function ( $no ) {
				return !( $no->ck === 'caption' && $no->ak === '' );
		}
		);
	}

	// sort!
	// sort!
	$nopts->sort( function ( $a, $b ) { return $a->sortId - $b->sortId;
 } );

	// emit all the options as wikitext!
	// emit all the options as wikitext!
	$wikitext = '[[' . $resource->value;
	$nopts->forEach( function ( $o ) {
			$wikitext += '|';
			if ( $o->v !== null ) {
				$wikitext += str_replace( '$1', $o->v, $o->ak );
			} else {
				$wikitext += $o->ak;
			}
	}
	);
	$wikitext += ']]';

	$state->emitChunk(
		new WikiLinkText( $wikitext, $node, $state->env->conf->wiki, $rdfaType ),
		$node
	);
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->linkHandler = $linkHandler;
	$module->exports->figureHandler = $figureHandler;
}
