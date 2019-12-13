<?php

/**
 * A bidirectional Language Converter, capable of round-tripping variant
 * conversion.
 *
 * Language conversion is as DOMPostProcessor pass, run over the
 * Parsoid-format HTML output, which may have embedded language converter
 * rules.  We first assign a (guessed) source variant to each DOM node,
 * which will be used when round-tripping the result back to the original
 * source variant.  Then for each applicable text node in the DOM, we
 * first "bracket" the text, splitting it into cleanly round-trippable
 * segments and lossy/unclean segments.  For the lossy segments we add
 * additional metadata to the output to record the original source variant
 * text to allow round-tripping (and variant-aware editing).
 *
 * Each individual language has a dynamically-loaded subclass of `Language`,
 * which may also have a `LanguageConverter` subclass to load appropriate
 * `ReplacementMachine`s and do other language-specific customizations.
 */

namespace Parsoid\Language;

use DOMDocument;
use DOMNode;
use Parsoid\Config\Env;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\Timing;
use Wikimedia\LangConv\ReplacementMachine;

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

	/** @var array */
	private $variantFallbacks;

	/** @var ReplacementMachine */
	private $machine;

	/**
	 * @param Language $language
	 * @param string $langCode The main language code of this language
	 * @param string[] $variants The supported variants of this language
	 * @param array|null $variantfallbacks The fallback language of each variant
	 * @param array|null $flags Defining the custom strings that maps to the flags
	 * @param array|null $manualLevel Limit for supported variants
	 */
	public function __construct(
		Language $language,
		$langCode,
		array $variants,
		array $variantfallbacks = null,
		array $flags = null,
		array $manualLevel = null
	) {
		$this->language = $language;
		$this->langCode = $langCode;
		$this->variants = $variants; // XXX subtract disabled variants
		$this->variantFallbacks = $variantfallbacks;
		// this.mVariantNames = Language.// XXX

		// Eagerly load conversion tables.
		// XXX we could defer loading in the future.
		$this->loadDefaultTables();
	}

	public function loadDefaultTables() {
	}

	/**
	 * Return the {@link ReplacementMachine} powering this conversion.
	 * @return ReplacementMachine
	 */
	public function getMachine() {
		return $this->machine;
	}

	/**
	 * @param ReplacementMachine $machine
	 */
	public function setMachine( ReplacementMachine $machine ) {
		$this->machine = $machine;
	}

	/**
	 * Try to return a classname from a given code.
	 * @param string $code
	 * @param bool $fallback Whether we're going through language fallback
	 * @return string Name of the language class (if one were to exist)
	 */
	public static function classFromCode( $code, $fallback ) {
		if ( $fallback && $code === 'en' ) {
			return '\Parsoid\Language\Language';
		} else {
			$code = preg_replace_callback( '/^\w/', function ( $matches ) {
				return strtoupper( $matches[0] );
			}, $code, 1 );
			$code = preg_replace( '/-/', '_', $code );
			$code = preg_replace( '#/|^\.+#', '', $code ); // avoid path attacks
			return "\Parsoid\Language\Language{$code}";
		}
	}

	/**
	 * @param Env $env
	 * @param string $lang
	 * @param bool $fallback
	 * @return Language
	 */
	public static function loadLanguage( Env $env, $lang, $fallback = false ) {
		try {
			if ( Language::isValidCode( $lang ) ) {
				$languageClass = self::classFromCode( $lang, $fallback );
				return new $languageClass();
			}
		} catch ( \Error $e ) {
			/* fall through */
		}
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
	 * @param string $variant
	 * @return bool
	 */
	public function guessVariant( $text, $variant ) {
		return false;
	}

	/**
	 * @param Env $env
	 * @param DOMDocument $doc
	 * @param string $targetVariant
	 * @param string $sourceVariant
	 */
	public static function maybeConvert(
		Env $env,
		DOMDocument $doc,
		$targetVariant,
		$sourceVariant
	) {
		// language converter must be enabled for the pagelanguage
		if ( !$env->langConverterEnabled() ) {
			return;
		}
		$variants = $env->getSiteConfig()->variants();

		// targetVariant must be specified, and a language-with-variants
		if ( !( $targetVariant && array_key_exists( $targetVariant, $variants ) ) ) {
			return;
		}

		// targetVariant must not be a base language code
		if ( $variants[$targetVariant]['base'] === $targetVariant ) {
			// XXX in the future we probably want to go ahead and expand
			// empty <span>s left by -{...}- constructs, etc.
			return;
		}

		// Record the fact that we've done conversion to targetVariant
		$env->getPageConfig()->setVariant( $targetVariant );

		// But don't actually do the conversion if __NOCONTENTCONVERT__
		if ( DOMCompat::querySelector( $doc, 'meta[property="mw:PageProp/nocontentconvert"]' ) ) {
			return;
		}

		// OK, convert!
		self::baseToVariant( $env, DOMCompat::getBody( $doc ), $targetVariant, $sourceVariant );
	}

	/**
	 * Convert a text in the "base variant" to a specific variant, given by `targetVariant`.  If
	 * `sourceVariant` is given, assume that the input wikitext is in `sourceVariant` to
	 * construct round-trip metadata, instead of using a heuristic to guess the best variant
	 * for each DOM subtree of wikitext.
	 * @param Env $env
	 * @param DOMNode $rootNode The root node of a fragment to convert.
	 * @param string $targetVariant The variant to be used for the output DOM.
	 * @param string $sourceVariant An optional variant assumed for the input DOM in order to
	 * create roundtrip metadata.
	 */
	public static function baseToVariant(
		Env $env,
		DOMNode $rootNode,
		$targetVariant,
		$sourceVariant
	) {
		$pageLangCode = $env->getPageConfig()->getPageLanguage()
			?: $env->getSiteConfig()->lang()
			?: 'en';
		$guesser = null;

		$languageClass = self::loadLanguage( $env, $pageLangCode );
		$lang = new $languageClass();
		$langconv = $lang->getConverter();
		// XXX we might want to lazily-load conversion tables here.

		// Check the the target variant is valid (and implemented!)
		$validTarget = $langconv !== null && $langconv->getMachine() !== null
			&& array_key_exists( $targetVariant, $langconv->getMachine()->getCodes() );
		if ( !$validTarget ) {
			// XXX create a warning header? (T197949)
			$env->log( 'info', "Unimplemented variant: {$targetVariant}" );
			return; /* no conversion */
		}

		$metrics = $env->getSiteConfig()->metrics();
		$timing = Timing::start( $metrics );
		if ( $metrics ) {
			$metrics->increment( 'langconv.count' );
			$metrics->increment( "langconv.{$targetVariant}.count" );
		}

		// XXX Eventually we'll want to consult some wiki configuration to
		// decide whether a ConstantLanguageGuesser is more appropriate.
		if ( $sourceVariant ) {
			$guesser = new ConstantLanguageGuesser( $sourceVariant );
		} else {
			$guesser = new MachineLanguageGuesser(
				$langconv->getMachine(), $rootNode, $targetVariant
			);
		}

		$ct = new ConversionTraverser( $targetVariant, $guesser, $langconv->getMachine() );
		$ct->traverse( $rootNode, $env, [], true );

		$timing->end( 'langconv.total' );
		$timing->end( "langconv.{$targetVariant}.total" );
	}
}
