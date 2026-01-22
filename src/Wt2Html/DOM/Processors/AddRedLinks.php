<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Language\LanguageConverter;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\UrlUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class AddRedLinks implements Wt2HtmlDOMProcessor {

	/**
	 * Batch size to use for fetching page data to avoid exceeding LinkCache::MAX_SIZE
	 */
	private const LINK_BATCH_SIZE = 1000;

	/**
	 * Add red links to a document.
	 *
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root
		$allLinks = PHPUtils::iterable_to_array(
			DOMCompat::querySelectorAll( $root, 'a[rel~="mw:WikiLink"]' )
		);

		[ $customCaptionLinks, $defaultCaptionLinks ] = $this->splitByLinkCaption( $allLinks );

		$this->runInternal( $env, $root, $customCaptionLinks, false );
		$this->runInternal( $env, $root, $defaultCaptionLinks, true );
	}

	private function runInternal(
		Env $env, Node $root, array $allLinks, bool $isDefaultCaptionLinks
	) {
		// Split up processing into chunks of 1000 so that we don't exceed LinkCache::MAX_SIZE
		$chunks = array_chunk( $allLinks, self::LINK_BATCH_SIZE );
		foreach ( $chunks as $links ) {
			$titles = [];
			foreach ( $links as $a ) {
				$t = DOMCompat::getAttribute( $a, 'title' );
				if ( $t !== null ) {
					$titles[$t] = true;
				}
			}

			if ( !$titles ) {
				return;
			}

			$start = hrtime( true );
			$titleMap = $env->getDataAccess()->getPageInfo(
				$env->getPageConfig(),
				array_keys( $titles ),
				$isDefaultCaptionLinks
			);
			if ( $env->profiling() ) {
				$profile = $env->getCurrentProfile();
				$profile->bumpMWTime( "RedLinks", hrtime( true ) - $start, "api" );
				$profile->bumpCount( "RedLinks" );
			}

			$prefixedTitleText = $env->getContextTitle()->getPrefixedText();

			$variantMap = $this->getVariantTitles(
				$env,
				$root->ownerDocument,
				$titles,
				$titleMap,
				$isDefaultCaptionLinks
			);

			foreach ( $links as $a ) {
				$k = DOMCompat::getAttribute( $a, 'title' );
				if ( $k === null ) {
					continue;
				}

				$variantData = $variantMap[$k] ?? null;
				$data = $variantData ?? $titleMap[$k] ?? null;

				if ( $data === null ) {
					// Likely a consequence of T237535; can be removed once
					// that is fixed.
					$env->log( 'warn', 'We should have data for the title: ' . $k );
					continue;
				}

				// Convert links pointing to a variant title (T258856)
				if ( $variantData !== null ) {
					$variantTitle = $env->makeTitleFromURLDecodedStr(
						$variantData['variantTitle']
					);

					$origHref = DOMCompat::getAttribute( $a, 'href' );
					$origUrl = UrlUtils::parseUrl( $origHref ?? '' );

					$newUrl = UrlUtils::parseUrl( $env->makeLink( $variantTitle ) );
					$newUrl['query'] = $origUrl['query'];
					$newUrl['fragment'] = $origUrl['fragment'];

					$variantPrefixedText = $variantTitle->getPrefixedText();
					DOMDataUtils::addNormalizedAttribute(
						$a, 'title', $variantPrefixedText, $k
					);
					// Set $k to the new title for the selflink check below.
					// Note that getVariantTitles doesn't set $variantData for
					// missing titles, so we won't be in this block for the
					// red-link-title case below.
					$k = $variantPrefixedText;

					DOMDataUtils::addNormalizedAttribute(
						$a,
						'href',
						UrlUtils::assembleUrl( $newUrl ),
						$origHref,
						// Ensure we preserve the real original value
						// added during initial link parsing.
						true
					);
				}

				$a->removeAttribute( 'class' ); // Clear all, if we're doing a pb2pb refresh

				$href = DOMCompat::getAttribute( $a, 'href' );
				$parsedURL = UrlUtils::parseUrl( $href ?? '' );

				$queryElts = [];
				if ( isset( $parsedURL['query'] ) ) {
					parse_str( $parsedURL['query'], $queryElts );
				}

				if (
					!empty( $data['missing'] ) && empty( $data['known'] ) &&
					$k !== $prefixedTitleText
				) {
					DOMCompat::getClassList( $a )->add( 'new' );
					WTUtils::addPageContentI18nAttribute( $a, 'title', 'red-link-title', [ $k ] );
					$queryElts['action'] = 'edit';
					$queryElts['redlink'] = '1';
				} else {
					if ( $k === $prefixedTitleText ) {
						if ( isset( $parsedURL['fragment'] ) ) {
							DOMCompat::getClassList( $a )->add( 'mw-selflink-fragment' );
						} else {
							DOMCompat::getClassList( $a )->add( 'mw-selflink', 'selflink' );
						}
						$a->removeAttribute( 'title' );
					}
					// Clear a potential redlink, if we're doing a pb2pb refresh
					// This is similar to what's happening in Html2Wt/RemoveRedLinks
					// and maybe that pass should just run before this one.
					if ( isset( $queryElts['action'] ) && $queryElts['action'] === 'edit' ) {
						unset( $queryElts['action'] );
					}
					if ( isset( $queryElts['redlink'] ) && $queryElts['redlink'] === '1' ) {
						unset( $queryElts['redlink'] );
					}
				}

				if ( count( $queryElts ) === 0 ) {
					// avoids the insertion of ? on empty query string
					$parsedURL['query'] = null;
				} else {
					$parsedURL['query'] = http_build_query( $queryElts );
				}
				$newHref = UrlUtils::assembleUrl( $parsedURL );

				$a->setAttribute( 'href', $newHref );

				if ( !empty( $data['redirect'] ) ) {
					DOMCompat::getClassList( $a )->add( 'mw-redirect' );
				}
				foreach ( $data['linkclasses'] ?? [] as $extraClass ) {
					DOMCompat::getClassList( $a )->add( $extraClass );
				}
			}
		}
	}

	/**
	 * Splits the array of links into two arrays: those with custom captions
	 * and those with default captions.
	 *
	 * For the definition of "default caption", see {@see isDefaultLinkCaption()}.
	 * @param Element[] $links
	 * @return array{0:list<Element>,1:list<Element>} A pair, where the first element
	 *   is the list of links with non-default captions, and the second element is the list
	 *   of links with default captions.
	 */
	private function splitByLinkCaption( array $links ): array {
		$nonDefaultCaptionLinks = [];
		$defaultCaptionLinks = [];

		foreach ( $links as $link ) {
			$title = DOMCompat::getAttribute( $link, 'title' );
			$caption = DOMCompat::getInnerHTML( $link );

			$isDefaultCaption = $this->isDefaultLinkCaption( $title, $caption );

			if ( $isDefaultCaption ) {
				$defaultCaptionLinks[] = $link;
			} else {
				$nonDefaultCaptionLinks[] = $link;
			}
		}
		return [ $nonDefaultCaptionLinks, $defaultCaptionLinks ];
	}

	/**
	 * Attempt to resolve nonexistent link targets using their variants (T258856)
	 *
	 * @param Env $env
	 * @param Document $doc
	 * @param array<string,true> $titles map keyed by page titles
	 * @param array<string,array> $titleMap map of resolved page data keyed by title
	 * @param bool $isDefaultCaptionLinks whether the links being processed have default captions
	 *
	 * @return array<string,array> map of resolved variant page data keyed by original title
	 */
	private function getVariantTitles(
		Env $env,
		Document $doc,
		array $titles,
		array $titleMap,
		bool $isDefaultCaptionLinks
	): array {
		// Optimize for the common case where the page language has no variants
		if (
			$env->getSkipLanguageConversionPass() ||
			!$env->langConverterEnabled()
		) {
			return [];
		}

		$origsByVariant = [];

		$langConverter = LanguageConverter::loadLanguageConverter( $env );

		if ( !$langConverter ) {
			return [];
		}

		// Gather all nonexistent page titles to search for their variants
		foreach ( array_keys( $titles ) as $title ) {
			if (
				// T237535
				isset( $titleMap[$title] ) &&
				( empty( $titleMap[$title]['missing'] ) || !empty( $titleMap[$title]['known'] ) )
			) {
				continue;
			}

			// array_keys converts strings representing numbers to ints.
			// So, cast $title to string explicitly.
			$variantTitles = LanguageConverter::autoConvertToAllVariants( $doc, (string)$title, $langConverter );

			foreach ( $variantTitles as $variantTitle ) {
				$origsByVariant[$variantTitle][] = $title;
			}
		}

		$variantsByOrig = [];
		$variantTitles = array_keys( $origsByVariant );

		foreach ( array_chunk( $variantTitles, self::LINK_BATCH_SIZE ) as $variantChunk ) {
			$variantChunkData = $env->getDataAccess()->getPageInfo(
				$env->getPageConfig(),
				$variantChunk,
				$isDefaultCaptionLinks
			);

			// Map resolved variant titles to their corresponding originals
			foreach ( $variantChunkData as $variantTitle => $pageData ) {
				// Handle invalid titles
				// For example, a conversion might result in a title that's too long.
				if ( !empty( $pageData['invalid'] ) ) {
					continue;
				}

				// Handle non-existent variant titles
				if ( !empty( $pageData['missing'] ) && empty( $pageData['known'] ) ) {
					continue;
				}

				foreach ( $origsByVariant[$variantTitle] as $origTitle ) {
					$variantsByOrig[$origTitle] = [ 'variantTitle' => (string)$variantTitle ] + $pageData;
				}
			}
		}
		return $variantsByOrig;
	}

	/**
	 * Checks if the provided caption can be considered a default link caption
	 * for the given target page.
	 *
	 * A caption is default if, after stripping HTML tags and decoding HTML entities in it:
	 *   - it's a suffix of the target's prefixed title, and
	 *   - the target's prefixed title, after stripping the caption from the end,
	 *     ends with a colon, slash, or is empty.
	 *
	 * NOTE: For a given title, there may be multiple captions that are considered default.
	 *   For example, for "User:Admin/Sandbox", the default captions will be: "Sandbox",
	 *   "Admin/Sandbox", and "User:Admin/Sandbox".
	 *
	 * Examples:
	 *  - Target: "Help:Contents", Caption: "Contents" => true
	 *  - Target: "Help:Contents", Caption: "Help:Contents" => true
	 *  - Target: "Help:Contents", Caption: "ents" => false
	 *  - Target: "User:~2025-1", Caption: "&#126;2025-1" => true
	 *
	 * @see LinkRenderer::isDefaultLinkCaption in MediaWiki core
	 * @return bool
	 */
	public function isDefaultLinkCaption(
		?string $targetPage,
		string $caption
	): bool {
		// If the target page is invalid, it has no default caption
		if ( $targetPage === null ) {
			return false;
		}

		$caption = html_entity_decode( strip_tags( $caption ) );
		$captionLength = mb_strlen( $caption );
		$titleLength = mb_strlen( $targetPage );

		if ( $captionLength > $titleLength ) {
			return false;
		}

		$titleSuffix = mb_substr( $targetPage, -$captionLength );
		if ( $titleSuffix !== $caption ) {
			return false;
		}

		if ( $titleLength === $captionLength ) {
			return true;
		}

		$precedingChar = mb_substr( $targetPage, -$captionLength - 1, 1 );
		if ( $precedingChar === ':' || $precedingChar === '/' ) {
			return true;
		}
		return false;
	}
}
