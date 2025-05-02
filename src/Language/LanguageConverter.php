<?php
declare( strict_types = 1 );

/**
 * A bidirectional Language Converter, capable of round-tripping variant
 * conversion.
 *
 * Language conversion is a DOMProcessorPipeline pass, run over the
 * Parsoid-format HTML output, which may have embedded language converter
 * rules.  We first assign a (guessed) wikitext variant to each DOM node,
 * the variant we expect the original wikitext was written in,
 * which will be used when round-tripping the result back to the original
 * wikitext variant.  Then for each applicable text node in the DOM, we
 * first "bracket" the text, splitting it into cleanly round-trippable
 * segments and lossy/unclean segments.  For the lossy segments we add
 * additional metadata to the output to record the original text used in
 * the wikitext to allow round-tripping (and variant-aware editing).
 *
 * Note that different wikis have different policies for wikitext variant:
 * in some wikis all articles are authored in one particular variant, by
 * convention.  In others, it's a "first author gets to choose the variant"
 * situation.  In both cases, a constant/per-article "wikitext variant" may
 * be specified via some as-of-yet-unimplemented mechanism; either part of
 * the site configuration, or per-article metadata like pageLanguage.
 * In other wikis (like zhwiki) the text is a random mix of variants; in
 * these cases the "wikitext variant" will be null/unspecified, and we'll
 * dynamically pick the most likely wikitext variant for each subtree.
 *
 * Each individual language has a dynamically-loaded subclass of `Language`,
 * which may also have a `LanguageConverter` subclass to load appropriate
 * `ReplacementMachine`s and do other language-specific customizations.
 */

namespace Wikimedia\Parsoid\Language;

use Wikimedia\Bcp47Code\Bcp47Code;
use Wikimedia\LangConv\ReplacementMachine;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\ClientError;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\NodeData\TempData;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Timing;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Base class for language variant conversion.
 */
class LanguageConverter {

	/** @var Language */
	private $language;

	/** @var string */
	private $langCode;

	/** @var string[] */
	private $variants;

	/** @var ?array */
	private $variantFallbacks;

	/** @var ?ReplacementMachine */
	private $machine;

	/**
	 * @param Language $language
	 * @param string $langCode The main language code of this language
	 * @param string[] $variants The supported variants of this language
	 * @param ?array $variantfallbacks The fallback language of each variant
	 * @param ?array $flags Defining the custom strings that maps to the flags
	 * @param ?array $manualLevel Limit for supported variants
	 */
	public function __construct(
		Language $language, string $langCode, array $variants,
		?array $variantfallbacks = null, ?array $flags = null,
		?array $manualLevel = null
	) {
		$this->language = $language;
		$this->langCode = $langCode;
		$this->variants = $variants; // XXX subtract disabled variants
		$this->variantFallbacks = $variantfallbacks;
		// this.mVariantNames = Language.// XXX

		// Eagerly load conversion tables.
		// XXX we could defer loading in the future, or cache more
		// aggressively
		$this->loadDefaultTables();
	}

	public function loadDefaultTables() {
	}

	/**
	 * Return the {@link ReplacementMachine} powering this conversion.
	 * @return ?ReplacementMachine
	 */
	public function getMachine(): ?ReplacementMachine {
		return $this->machine;
	}

	public function setMachine( ReplacementMachine $machine ): void {
		$this->machine = $machine;
	}

	/**
	 * Try to return a classname from a given code.
	 * @param string $code
	 * @param bool $fallback Whether we're going through language fallback
	 * @return class-string Name of the language class (if one were to exist)
	 */
	public static function classFromCode( string $code, bool $fallback ): string {
		if ( $fallback && $code === 'en' ) {
			return '\Wikimedia\Parsoid\Language\Language';
		} else {
			$code = ucfirst( $code );
			$code = str_replace( '-', '_', $code );
			$code = preg_replace( '#/|^\.+#', '', $code ); // avoid path attacks
			return "\Wikimedia\Parsoid\Language\Language{$code}";
		}
	}

	/**
	 * @param Env $env
	 * @param Bcp47Code $lang a language code
	 * @param bool $fallback
	 * @return Language
	 */
	public static function loadLanguage( Env $env, Bcp47Code $lang, bool $fallback = false ): Language {
		// Our internal language classes still use MW-internal names.
		$lang = Utils::bcp47ToMwCode( $lang );
		try {
			if ( Language::isValidInternalCode( $lang ) ) {
				$languageClass = self::classFromCode( $lang, $fallback );
				return new $languageClass();
			}
		} catch ( \Error $e ) {
			/* fall through */
		}
		$fallback = (string)$fallback;
		$env->log( 'info', "Couldn't load language: {$lang} fallback={$fallback}" );
		return new Language();
	}

	// phpcs:ignore MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic
	public function findVariantLink( $link, $nt, $ignoreOtherCond ) {
		// XXX unimplemented
		return [ 'nt' => $nt, 'link' => $link ];
	}

	/**
	 * @param string $fromVariant
	 * @param string $text
	 * @param string $toVariant
	 * @suppress PhanEmptyPublicMethod
	 */
	public function translate( $fromVariant, $text, $toVariant ) {
		// XXX unimplemented
	}

	/**
	 * @param string $text
	 * @param Bcp47Code $variant a language code
	 * @return bool
	 * @deprecated Appears to be unused
	 */
	public function guessVariant( $text, $variant ) {
		return false;
	}

	/**
	 * Convert the given document into $htmlVariantLanguage, if:
	 *  1) language converter is enabled on this wiki, and
	 *  2) the htmlVariantLanguage is specified, and it is a known variant (not a
	 *     base language code)
	 *
	 * The `$wtVariantLanguage`, if provided is expected to be per-wiki or
	 * per-article metadata which specifies a standard "authoring variant"
	 * for this article or wiki.  For example, all articles are authored in
	 * Cyrillic by convention.  It should be left blank if there is no
	 * consistent convention on the wiki (as for zhwiki, for instance).
	 *
	 * @param Env $env
	 * @param Document $doc The input document.
	 * @param ?Bcp47Code $htmlVariantLanguage The desired output variant.
	 * @param ?Bcp47Code $wtVariantLanguage The variant used by convention when
	 *   authoring pages, if there is one; otherwise left null.
	 */
	public static function maybeConvert(
		Env $env, Document $doc,
		?Bcp47Code $htmlVariantLanguage, ?Bcp47Code $wtVariantLanguage
	): void {
		// language converter must be enabled for the pagelanguage
		if ( !$env->langConverterEnabled() ) {
			return;
		}
		// htmlVariantLanguage must be specified, and a language-with-variants
		if ( $htmlVariantLanguage === null ) {
			return;
		}
		$variants = $env->getSiteConfig()->variantsFor( $htmlVariantLanguage );
		if ( $variants === null ) {
			return;
		}

		// htmlVariantLanguage must not be a base language code
		if ( Utils::isBcp47CodeEqual( $htmlVariantLanguage, $variants['base'] ) ) {
			// XXX in the future we probably want to go ahead and expand
			// empty <span>s left by -{...}- constructs, etc.
			return;
		}

		// Record the fact that we've done conversion to htmlVariantLanguage
		$env->getPageConfig()->setVariantBcp47( $htmlVariantLanguage );

		// But don't actually do the conversion if __NOCONTENTCONVERT__
		if ( DOMCompat::querySelector( $doc, 'meta[property="mw:PageProp/nocontentconvert"]' ) ) {
			return;
		}

		// OK, convert!
		self::baseToVariant( $env, DOMCompat::getBody( $doc ), $htmlVariantLanguage, $wtVariantLanguage );
	}

	/**
	 * Convert a text in the "base variant" to a specific variant, given by `htmlVariantLanguage`.  If
	 * `wtVariantLanguage` is given, assume that the input wikitext is in `wtVariantLanguage` to
	 * construct round-trip metadata, instead of using a heuristic to guess the best variant
	 * for each DOM subtree of wikitext.
	 * @param Env $env
	 * @param Node $rootNode The root node of a fragment to convert.
	 * @param string|Bcp47Code $htmlVariantLanguage The variant to be used for the output DOM.
	 *  This is a mediawiki-internal language code string (T320662, deprecated),
	 *  or a BCP 47 language object (preferred).
	 * @param string|Bcp47Code|null $wtVariantLanguage An optional variant assumed for the
	 *  input DOM in order to create roundtrip metadata.
	 *  This is a mediawiki-internal language code (T320662, deprecated),
	 *  or a BCP 47 language object (preferred), or null.
	 */
	public static function baseToVariant(
		Env $env, Node $rootNode, $htmlVariantLanguage, $wtVariantLanguage
	): void {
		// Back-compat w/ old string-passing parameter convention
		if ( is_string( $htmlVariantLanguage ) ) {
			$htmlVariantLanguage = Utils::mwCodeToBcp47(
				$htmlVariantLanguage, true, $env->getSiteConfig()->getLogger()
			);
		}
		if ( is_string( $wtVariantLanguage ) ) {
			$wtVariantLanguage = Utils::mwCodeToBcp47(
				$wtVariantLanguage, true, $env->getSiteConfig()->getLogger()
			);
		}
		// PageConfig guarantees getPageLanguage() never returns null.
		$pageLangCode = $env->getPageConfig()->getPageLanguageBcp47();
		$guesser = null;

		$loadTiming = Timing::start( $env->getSiteConfig() );
		$languageClass = self::loadLanguage( $env, $pageLangCode );
		$lang = new $languageClass();
		$langconv = $lang->getConverter();
		$htmlVariantLanguageMw = Utils::bcp47ToMwCode( $htmlVariantLanguage );
		// XXX we might want to lazily-load conversion tables here.
		$loadTiming->end( "langconv.{$htmlVariantLanguageMw}.init", "langconv_init_seconds", [
			"variant" => $htmlVariantLanguageMw,
		] );
		$loadTiming->end( 'langconv.init', "langconv_all_variants_init_seconds", [] );

		// Check the html variant is valid (and implemented!)
		$validTarget = $langconv !== null && $langconv->getMachine() !== null
			&& array_key_exists( $htmlVariantLanguageMw, $langconv->getMachine()->getCodes() );
		if ( !$validTarget ) {
			// XXX create a warning header? (T197949)
			$env->log( 'info', "Unimplemented variant: {$htmlVariantLanguageMw}" );
			return; /* no conversion */
		}
		// Check that the wikitext variant is valid.
		$wtVariantLanguageMw = $wtVariantLanguage ?
			Utils::bcp47ToMwCode( $wtVariantLanguage ) : null;
		$validSource = $wtVariantLanguage === null ||
			array_key_exists( $wtVariantLanguageMw, $langconv->getMachine()->getCodes() );
		if ( !$validSource ) {
			throw new ClientError( "Invalid wikitext variant: $wtVariantLanguageMw for target $htmlVariantLanguageMw" );
		}

		$timing = Timing::start( $env->getSiteConfig() );
		$metrics = $env->getSiteConfig()->metrics();
		if ( $metrics ) {
			$metrics->increment( 'langconv.count' );
			$metrics->increment( "langconv." . $htmlVariantLanguageMw . ".count" );
			$env->getSiteConfig()->incrementCounter(
				'langconv_count_total',
				[ 'variant' => $htmlVariantLanguageMw ]
			);
		}

		// XXX Eventually we'll want to consult some wiki configuration to
		// decide whether a ConstantLanguageGuesser is more appropriate.
		if ( $wtVariantLanguage ) {
			$guesser = new ConstantLanguageGuesser( $wtVariantLanguage );
		} else {
			$guesser = new MachineLanguageGuesser(
				// @phan-suppress-next-line PhanTypeMismatchArgumentSuperType
				$langconv->getMachine(), $rootNode, $htmlVariantLanguage
			);
		}

		$ct = new ConversionTraverser( $env, $htmlVariantLanguage, $guesser, $langconv->getMachine() );
		$ct->traverse( null, $rootNode );

		// HACK: to avoid data-parsoid="{}" in the output, set the isNew flag
		// on synthetic spans
		DOMUtils::assertElt( $rootNode );
		foreach ( DOMCompat::querySelectorAll(
			$rootNode, 'span[typeof="mw:LanguageVariant"][data-mw-variant]'
		) as $span ) {
			$dmwv = DOMDataUtils::getJSONAttribute( $span, 'data-mw-variant', null );
			if ( $dmwv->rt ?? false ) {
				$dp = DOMDataUtils::getDataParsoid( $span );
				$dp->setTempFlag( TempData::IS_NEW );
			}
		}

		$timing->end( 'langconv.total', 'langconv_all_variants_total_seconds', [] );
		$timing->end( "langconv.{$htmlVariantLanguageMw}.total", "langconv_total_seconds", [
			"variant" => $htmlVariantLanguageMw,
		] );
		$loadTiming->end( 'langconv.totalWithInit', "langconv_total_with_init_seconds", [] );
	}

	/**
	 * Check if support for html variant conversion is implemented
	 * @internal FIXME: Remove once Parsoid's language variant work is completed
	 * @param Env $env
	 * @param Bcp47Code $htmlVariantLanguage The variant to be checked for implementation
	 * @return bool
	 */
	public static function implementsLanguageConversionBcp47( Env $env, Bcp47Code $htmlVariantLanguage ): bool {
		$htmlVariantLanguageMw = Utils::bcp47ToMwCode( $htmlVariantLanguage );
		$pageLangCode = $env->getPageConfig()->getPageLanguageBcp47();
		$lang = self::loadLanguage( $env, $pageLangCode );
		$langconv = $lang->getConverter();

		$validTarget = $langconv !== null && $langconv->getMachine() !== null
			&& array_key_exists( $htmlVariantLanguageMw, $langconv->getMachine()->getCodes() );

		return $validTarget;
	}

	/**
	 * Convert a string in an unknown variant of the page language to all its possible variants.
	 *
	 * @param Env $env
	 * @param Document $doc
	 * @param string $text
	 * @return string[] map of converted variants keyed by variant language
	 */
	public static function autoConvertToAllVariants(
		Env $env,
		Document $doc,
		string $text
	): array {
		$pageLangCode = $env->getPageConfig()->getPageLanguageBcp47();

		// Parsoid's Chinese language converter implementation is not performant enough,
		// so disable it explicitly (T346657).
		if ( $pageLangCode->toBcp47Code() === 'zh' ) {
			return [];
		}

		if ( $env->getSiteConfig()->variantsFor( $pageLangCode ) === null ) {
			// Optimize for the common case where the page language has no variants.
			return [];
		}

		$languageClass = self::loadLanguage( $env, $pageLangCode );
		$lang = new $languageClass();
		$langconv = $lang->getConverter();

		if ( $langconv === null || $langconv->getMachine() === null ) {
			return [];
		}

		$machine = $langconv->getMachine();
		$codes = $machine->getCodes();
		$textByVariant = [];

		foreach ( $codes as $destCode ) {
			foreach ( $codes as $invertCode ) {
				if ( !$machine->isValidCodePair( $destCode, $invertCode ) ) {
					continue;
				}

				$fragment = $machine->convert(
					// @phan-suppress-next-line PhanTypeMismatchArgument DOM library issues
					$doc,
					$text,
					$destCode,
					$invertCode
				);

				$converted = $fragment->textContent;

				if ( $converted !== $text ) {
					$textByVariant[$destCode] = $converted;
					// Move on to the next code once we found a candidate conversion,
					// to match behavior with the old LanguageConverter.
					break;
				}
			}
		}

		return $textByVariant;
	}
}
