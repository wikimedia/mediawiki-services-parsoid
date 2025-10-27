<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Language;

/**
 * Base class for Language objects.
 */
class Language {

	/** @var LanguageConverter|null */
	private $converter;

	public function getConverter(): ?LanguageConverter {
		return $this->converter;
	}

	public function setConverter( LanguageConverter $converter ): void {
		$this->converter = $converter;
	}

	/**
	 * Returns true if a language code string is of a valid form, whether or not it exists.
	 * This includes codes which are used solely for customisation via the MediaWiki namespace.
	 * @param string $code a MediaWiki-internal code
	 * @return bool
	 */
	public static function isValidInternalCode( string $code ): bool {
		static $validityCache = [];
		if ( !isset( $validityCache[$code] ) ) {
			$validityCache[$code] = strcspn( $code, ":/\\\000&<>'\"" ) === strlen( $code ) &&
				// XXX Core's version also checks against
				// !preg_match( MediaWikiTitleCodec::getTitleInvalidRegex(), $code ) &&
				strlen( $code ) <= 128;
		}
		return $validityCache[$code];
	}
}
