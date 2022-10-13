<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Config;

use Wikimedia\Bcp47Code\Bcp47Code;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Page-level configuration interface for Parsoid
 */
abstract class PageConfig {

	/**
	 * Non-null to record the fact that conversion has been done on
	 * this page (to the specified variant).
	 * @var ?Bcp47Code
	 */
	private $htmlVariant = null;

	/**
	 * Base constructor.
	 *
	 * This constructor is public because it is used to create mock objects
	 * in our test suite.
	 */
	public function __construct() {
	}

	/**
	 * Get content model
	 * @return string
	 */
	abstract public function getContentModel(): string;

	/**
	 * Whether the page has a lintable content model
	 * @return bool
	 */
	abstract public function hasLintableContentModel(): bool;

	/**
	 * The page's title, as a string.
	 * @return string With namespace, spaces not underscores
	 */
	abstract public function getTitle(): string;

	/**
	 * The page's namespace ID
	 * @return int
	 */
	abstract public function getNs(): int;

	/**
	 * The page's ID, if any
	 * @return int 0 if the page doesn't exist
	 */
	abstract public function getPageId(): int;

	// Implementors are expected to override *one of*
	// ::getPageLanguage() or ::getPageLanguageBcp47()

	/**
	 * The page's language code.
	 *
	 * @return string a MediaWiki-internal language code
	 * @deprecated Use ::getPageLanguageBcp47() (T320662)
	 */
	public function getPageLanguage(): string {
		return Utils::bcp47ToMwCode( $this->getPageLanguageBcp47() );
	}

	/**
	 * The page's language code.
	 *
	 * @return Bcp47Code a BCP-47 language code
	 */
	public function getPageLanguageBcp47(): Bcp47Code {
		// @phan-suppress-next-line PhanDeprecatedFunction
		return Utils::mwCodeToBcp47( $this->getPageLanguage() );
	}

	/**
	 * The page's language direction
	 * @return string 'ltr' or 'rtl'
	 */
	abstract public function getPageLanguageDir(): string;

	/**
	 * The revision's ID, if any
	 * @return int|null
	 */
	abstract public function getRevisionId(): ?int;

	/**
	 * The revision's parent ID, if any
	 * @return int|null
	 */
	abstract public function getParentRevisionId(): ?int;

	/**
	 * The revision's timestamp, if any
	 * @return string|null "YYYYMMDDHHIISS" format
	 */
	abstract public function getRevisionTimestamp(): ?string;

	/**
	 * The revision's author's user name, if any
	 * @return string|null
	 */
	abstract public function getRevisionUser(): ?string;

	/**
	 * The revision's author's user ID, if any
	 * @return int|null 0 if the user is not registered
	 */
	abstract public function getRevisionUserId(): ?int;

	/**
	 * The revision's SHA1 checksum, if any
	 * @return string|null Hex encoded
	 */
	abstract public function getRevisionSha1(): ?string;

	/**
	 * The revision's length, if known
	 * @return int|null Bytes
	 */
	abstract public function getRevisionSize(): ?int;

	/**
	 * The revision's content
	 * @return PageContent|null
	 */
	abstract public function getRevisionContent(): ?PageContent;

	/**
	 * Get the page's language variant
	 * This is a *mediawiki-internal* language code, not a BCP-47 code.
	 * @return string|null
	 * @deprecated Use ::getVariantBcp47() (T320662)
	 */
	public function getVariant(): ?string {
		return Utils::bcp47ToMwCode( $this->getVariantBcp47() );
	}

	/**
	 * Get the page's language variant
	 * @return ?Bcp47Code a BCP-47 language code
	 */
	public function getVariantBcp47(): ?Bcp47Code {
		return $this->htmlVariant; # stored as BCP-47
	}

	/**
	 * Set the page's language variant.  (Records the fact that
	 * conversion has been done in the parser pipeline.)
	 * @param string $htmlVariant a MediaWiki-internal language code
	 * @deprecated Use ::setVariantBcp47() (T320662)
	 */
	public function setVariant( $htmlVariant ): void {
		$this->setVariantBcp47( Utils::mwCodeToBcp47( $htmlVariant ) );
	}

	/**
	 * Set the page's language variant.  (Records the fact that
	 * conversion has been done in the parser pipeline.)
	 * @param Bcp47Code $htmlVariant a BCP-47 language code
	 */
	public function setVariantBcp47( Bcp47Code $htmlVariant ): void {
		$this->htmlVariant = $htmlVariant; # stored as BCP-47
	}

	/**
	 * FIXME: Once we remove the hardcoded slot name here,
	 * the name of this method could be updated, if necessary.
	 *
	 * Shortcut method to get page source
	 * @deprecated Use $this->topFrame->getSrcText()
	 * @return string
	 */
	public function getPageMainContent(): string {
		return $this->getRevisionContent()->getContent( 'main' );
	}

}
