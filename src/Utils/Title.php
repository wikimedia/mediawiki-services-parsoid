<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\IPUtils;
use Wikimedia\Parsoid\Config\SiteConfig;

class Title {

	/** @var int */
	private $namespaceId;

	/** @var string */
	private $namespaceName;

	/** @var string */
	private $dbkey;

	/** @var ?string */
	private $fragment;

	/** @var TitleNamespace */
	private $namespace;

	/**
	 * @param string $key Page DBkey (with underscores, not spaces)
	 * @param int|TitleNamespace $ns
	 * @param SiteConfig $siteConfig
	 * @param ?string $fragment
	 */
	public function __construct(
		string $key, $ns, SiteConfig $siteConfig, ?string $fragment = null
	) {
		$this->dbkey = $key;
		if ( $ns instanceof TitleNamespace ) {
			$this->namespaceId = $ns->getId();
			$this->namespace = $ns;
		} else {
			$this->namespaceId = (int)$ns;
			// @phan-suppress-next-line PhanDeprecatedClass transitional
			$this->namespace = new TitleNamespace( $this->namespaceId, $siteConfig );
		}
		$this->namespaceName = $siteConfig->namespaceName( $this->namespaceId );
		$this->fragment = $fragment;
	}

	/**
	 * @param string $title
	 * @param SiteConfig $siteConfig
	 * @param int|TitleNamespace $defaultNs
	 * @return Title
	 */
	public static function newFromText(
		string $title, SiteConfig $siteConfig, $defaultNs = 0
	): Title {
		if ( $defaultNs === null ) {
			$defaultNs = 0;
		}

		$origTitle = $title;

		if ( !mb_check_encoding( $title, 'UTF-8' ) ) {
			throw new TitleException( "Bad UTF-8 in title \"$title\"", 'title-invalid-utf8', $title );
		}

		// Strip Unicode bidi override characters.
		$title = preg_replace( '/[\x{200E}\x{200F}\x{202A}-\x{202E}]+/u', '', $title );
		if ( $title === null ) {
			throw new TitleException( "Bad UTF-8 in title \"$title\"", 'title-invalid-utf8', $title );
		}

		// Clean up whitespace
		$title = preg_replace(
			'/[ _\x{00A0}\x{1680}\x{180E}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}]+/u',
			'_', $title
		);
		// Trim _ from beginning and end
		$title = trim( $title, '_' );

		if ( str_contains( $title, \UtfNormal\Constants::UTF8_REPLACEMENT ) ) {
			throw new TitleException( "Bad UTF-8 in title \"$title\"", 'title-invalid-utf8', $title );
		}

		// Initial colon indicates main namespace rather than specified default
		// but should not create invalid {ns,title} pairs such as {0,Project:Foo}
		if ( $title !== '' && $title[0] === ':' ) {
			$title = ltrim( substr( $title, 1 ), '_' );
			$defaultNs = 0;
		}

		if ( $title === '' ) {
			throw new TitleException( 'Empty title', 'title-invalid-empty', $title );
		}

		if ( $defaultNs instanceof TitleNamespace ) {
			$defaultNs = $defaultNs->getId();
		}
		$ns = $defaultNs;
		$interwiki = null;

		# Namespace or interwiki prefix
		$prefixRegexp = "/^(.+?)_*:_*(.*)$/S";
		// MediaWikiTitleCodec::splitTitleString wraps a loop around the
		// next section, to allow it to repeat this prefix processing if
		// an interwiki prefix is found which points at the local wiki.
		$m = [];
		if ( preg_match( $prefixRegexp, $title, $m ) ) {
			$p = $m[1];
			$nsId = $siteConfig->canonicalNamespaceId( $p ) ??
				  $siteConfig->namespaceId( $p );
			if ( $nsId !== null ) {
				$title = $m[2];
				$ns = $nsId;
				# For Talk:X pages, check if X has a "namespace" prefix
				if (
					$nsId === $siteConfig->canonicalNamespaceId( 'talk' ) &&
					preg_match( $prefixRegexp, $title, $x )
				) {
					if ( $siteConfig->namespaceId( $x[1] ) ) {
						// Disallow Talk:File:x type titles.
						throw new TitleException(
							"Invalid Talk namespace title \"$origTitle\"", 'title-invalid-talk-namespace', $title
						);
					} elseif ( $siteConfig->interwikiMapNoNamespaces()[$x[1]] ?? null ) {
						// Disallow Talk:Interwiki:x type titles.
						throw new TitleException(
							"Invalid Talk namespace title \"$origTitle\"", 'title-invalid-talk-namespace', $title
						);
					}
				}
			} elseif ( $siteConfig->interwikiMapNoNamespaces()[$p] ?? null ) {
				# Interwiki link
				$title = $m[2];
				$interwiki = strtolower( $p );

				# We don't check for a redundant interwiki prefix to the
				# local wiki, like core does here in
				# MediaWikiTitleCodec::splitTitleString;
				# core then does a `continue` to repeat the processing

				// If there's an initial colon after the interwiki, that also
				// resets the default namespace
				if ( $title !== '' && $title[0] === ':' ) {
					$title = trim( substr( $title, 1 ), '_' );
					$ns = 0;
				}
			}
			# If there's no recognized interwiki or namespace,
			# then let the colon expression be part of the title
		}

		$fragment = null;
		$fragmentIndex = strpos( $title, '#' );
		if ( $fragmentIndex !== false ) {
			$fragment = substr( $title, $fragmentIndex + 1 );
			$title = rtrim( substr( $title, 0, $fragmentIndex ), '_' );
		}

		$illegalCharsRe = '/[^' . $siteConfig->legalTitleChars() . ']'
			// URL percent encoding sequences interfere with the ability
			// to round-trip titles -- you can't link to them consistently.
			. '|%[0-9A-Fa-f]{2}'
			// XML/HTML character references produce similar issues.
			. '|&[A-Za-z0-9\x80-\xff]+;/S';
		if ( preg_match( $illegalCharsRe, $title ) ) {
			throw new TitleException(
				"Invalid characters in title \"$origTitle\"", 'title-invalid-characters', $title
			);
		}

		// Pages with "/./" or "/../" appearing in the URLs will often be
		// unreachable due to the way web browsers deal with 'relative' URLs.
		// Also, they conflict with subpage syntax. Forbid them explicitly.
		if ( str_contains( $title, '.' ) && (
			$title === '.' || $title === '..' ||
			str_starts_with( $title, './' ) ||
			str_starts_with( $title, '../' ) ||
			str_contains( $title, '/./' ) ||
			str_contains( $title, '/../' ) ||
			str_ends_with( $title, '/.' ) ||
			str_ends_with( $title, '/..' )
		) ) {
			throw new TitleException(
				"Title \"$origTitle\" contains relative path components", 'title-invalid-relative', $title
			);
		}

		// Magic tilde sequences? Nu-uh!
		if ( str_contains( $title, '~~~' ) ) {
			throw new TitleException(
				"Title \"$origTitle\" contains ~~~", 'title-invalid-magic-tilde', $title
			);
		}

		$maxLength = $ns === $siteConfig->canonicalNamespaceId( 'special' ) ? 512 : 255;
		if ( strlen( $title ) > $maxLength ) {
			throw new TitleException(
				"Title \"$origTitle\" is too long", 'title-invalid-too-long', $title
			);
		}

		if ( $interwiki === null && $siteConfig->namespaceCase( $ns ) === 'first-letter' ) {
			$title = $siteConfig->ucfirst( $title );
		}

		# Can't make a link to a namespace alone... "empty" local links can only be
		# self-links with a fragment identifier.
		if ( $title === '' && $interwiki === null && $ns !== $siteConfig->canonicalNamespaceId( '' ) ) {
			throw new TitleException( 'Empty title', 'title-invalid-empty', $title );
		}

		// This is from MediaWikiTitleCodec::splitTitleString() in core
		if ( $title !== '' && ( # T329690
			$ns === $siteConfig->canonicalNamespaceId( 'user' ) ||
			$ns === $siteConfig->canonicalNamespaceId( 'user_talk' )
		) ) {
			$title = IPUtils::sanitizeIP( $title );
		}

		// Any remaining initial :s are illegal.
		if ( $title !== '' && $title[0] == ':' ) {
			throw new TitleException(
				'Leading colon title', 'title-invalid-leading-colon', $title
			);
		}

		// This is not in core's splitTitleString but matches
		// mediawiki-title's newFromText.
		if ( $ns === $siteConfig->canonicalNamespaceId( 'special' ) ) {
			$title = self::fixSpecialName( $siteConfig, $title );
		}

		// This is not in core's splitTitleString but matches parsoid's
		// convention.
		if ( $interwiki !== null ) {
			$title = "$interwiki:$title";
		}

		return new self( $title, $ns, $siteConfig, $fragment );
	}

	/**
	 * Get the DBkey
	 * @return string
	 */
	public function getKey(): string {
		return $this->dbkey;
	}

	/**
	 * Get the prefixed DBkey
	 * @return string
	 */
	public function getPrefixedDBKey(): string {
		if ( $this->namespaceName === '' ) {
			return $this->dbkey;
		}
		return strtr( $this->namespaceName, ' ', '_' ) . ':' . $this->dbkey;
	}

	/**
	 * Get the prefixed text
	 * @return string
	 */
	public function getPrefixedText(): string {
		$ret = strtr( $this->dbkey, '_', ' ' );
		if ( $this->namespaceName !== '' ) {
			$ret = $this->namespaceName . ':' . $ret;
		}
		return $ret;
	}

	/**
	 * Get the fragment, if any
	 * @return string|null
	 */
	public function getFragment(): ?string {
		return $this->fragment;
	}

	/**
	 * @deprecated Use namespace IDs and SiteConfig methods instead.
	 * @return TitleNamespace
	 */
	public function getNamespace(): TitleNamespace {
		return $this->namespace;
	}

	/**
	 * Get the namespace ID
	 * @return int
	 */
	public function getNamespaceId(): int {
		return $this->namespaceId;
	}

	/**
	 * Compare with another title.
	 *
	 * @param Title $title
	 * @return bool
	 */
	public function equals( Title $title ) {
		return $this->getNamespaceId() === $title->getNamespaceId() &&
			$this->getKey() === $title->getKey();
	}

	/**
	 * Use the default special page alias.
	 *
	 * @param SiteConfig $siteConfig
	 * @param string $title
	 * @return string
	 */
	public static function fixSpecialName(
		SiteConfig $siteConfig, string $title
	): string {
		$parts = explode( '/', $title, 2 );
		$specialName = $siteConfig->specialPageLocalName( $parts[0] );
		if ( $specialName !== null ) {
			$parts[0] = $specialName;
			$title = implode( '/', $parts );
		}
		return $title;
	}
}
