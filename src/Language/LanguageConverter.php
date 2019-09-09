<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
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
 * Like in the PHP implementation, each individual language has a
 * dynamically-loaded subclass of `Language`, which may also have a
 * `LanguageConverter` subclass to load appropriate `ReplacementMachine`s
 * and do other language-specific customizations.
 *
 * @module
 */

namespace Parsoid;

use Parsoid\DOMTraverser as DOMTraverser;
use Parsoid\DOMPostOrder as DOMPostOrder;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\Language as Language;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;

/**
 * An oracle that gives you a predicted "source language" for every node
 * in a DOM, which is used when converting the result back to the source
 * language during round-tripping.
 *
 * This code is unique to Parsoid; the PHP implementation does not
 * round-trip. Do not confuse this with PHP's (soon to be deprecated) method
 * `LanguageConverter::guessVariant()`, which is a heuristic used to
 * *disable* language conversion when the text is guessed to be already
 * in the desired variant.
 */
class LanguageGuesser {
	public function guessLang( $node ) {
 throw new Error( 'abstract class' );
 }
}

/**
 * A simple {@link LanguageGuesser} that returns the same "source language"
 * for every node.  Appropriate for wikis which by convention are written
 * in a single variant.
 */
class ConstantLanguageGuesser extends LanguageGuesser {
	public function __construct( $langCode ) {
		parent::__construct();
		$this->langCode = $langCode;
	}
	public $langCode;

	public function guessLang( $node ) {
 return $this->langCode;
 }
}

/**
 * Use a {@Link ReplacementMachine} to predict the best "source language"
 * for every node in a DOM.  Appropriate for wikis which are written
 * in a mix of variants.
 */
class MachineLanguageGuesser extends LanguageGuesser {
	public function __construct( $machine, $root, $destCode ) {
		parent::__construct();
		$codes = $machine->codes->filter(
			function ( $invertCode ) use ( &$machine, &$destCode ) {return $machine->validCodePair( $destCode, $invertCode );
   }
		);
		$countMap = new Map();
		$merge = function ( $node, $map ) use ( &$countMap, &$codes ) {
			if ( !$countMap->has( $node ) ) {
				$countMap->set( $node, $map );
				$map->set( '$shared$', true );
				return;
			}
			$m = $countMap->get( $node );
			if ( $m->has( '$shared$' ) ) {
				// Clone the map (and mark the clone not-shared)
				$m = new Map(
					::from[ $m->entries() ]->filter( function ( $e ) {return $e[ 0 ] !== '$shared$';
		   } )
				);
				$countMap->set( $node, $m );
			}
			foreach ( $codes as $c => $___ ) {
				$m->set( $c, $m->get( $c ) + $map->get( $c ) );
			}
		};
		DOMPostOrder::class( $root, function ( $node ) use ( &$DOMUtils, &$countMap, &$codes, &$merge ) {
				// XXX look at `lang` attribute and use it to inform guess?
				if ( DOMUtils::isText( $node ) ) {
					$countMap->set(
						$node,
						new Map(
							array_map( $codes, function ( $invertCode ) {return [
										$invertCode,
										$machine->countBrackets(
											$node->textContent, $destCode, $invertCode
										)->safe
									];
							}
							)

						)
					);
				} elseif ( !$node->firstChild ) {
					$countMap->set( $node, new Map( array_map( $codes, function ( $ic ) {return [ $ic, 0 ];
		   } ) ) );
				} else {
					// Accumulate counts from children
					for ( $child = $node->firstChild;
						$child;
						$child = $child->nextSibling
					) {
						$merge( $node, $countMap->get( $child ) );
					}
				}
		}
		);
		// Post-process the counts to yield a guess for each node.
		$this->nodeMap = new Map();
		foreach ( $countMap->entries() as $undefined => $___ ) {
			$best = array_map( $codes,
				function ( $code ) { return [ 'code' => $code, 'safe' => $counts->get( $code ) ];
	   }
			)

			->sort(
				// Sort for maximum safe chars
				function ( $a, $b ) {return $b->safe - $a->safe;
	   }
			)[ 0 ]->code;
			$this->nodeMap->set( $node, $best );
		}
	}
	public $nodeMap;

	public function guessLang( $node ) {
 return $this->nodeMap->get( $node );
 }
}

function docFragToString( $docFrag, $force ) {
	global $DOMUtils;
	if ( !$force ) {
		for ( $child = $docFrag->firstChild;  $child;  $child = $child->nextSibling ) {
			if ( !DOMUtils::isText( $child ) ) { return null; /* unsafe */
   }
		}
	}
	return $docFrag->textContent;
}

class ConversionTraverser extends DOMTraverser {
	/**
	 * @param {string} toLang
	 * @param {LanguageGuesser} guesser
	 * @param {ReplacementMachine} machine
	 */
	public function __construct( $toLang, $guesser, $machine ) {
		parent::__construct();
		/** Target language for conversion. */
		$this->toLang = $toLang;
		/** Oracle to determine "original language" for round-tripping. */
		$this->guesser = $guesser;
		/** ReplacementMachine to do actual conversion. */
		$this->machine = $machine;
		/** The currently-active "original language" */
		$this->fromLang = null; // will be set by BODY and P handlers

		// Handlers are applied in order they are registered.

		// No conversion inside <code>, <script>, <pre>, <cite>
		// (See adhoc regexps inside LanguageConverter.php::autoConvert)
		// XXX: <cite> ought to probably be handled more generically
		// as extension output, not special-cased as a HTML tag.
		foreach ( [ 'code', 'script', 'pre', 'cite' ] as $el => $___ ) {
			$this->addHandler( $el, function ( ...$args ) {return $this->noConvertHandler( ...$args );
   } );
		}
		// Setting/saving the language context
		$this->addHandler( null, function ( ...$args ) {return $this->anyHandler( ...$args );
  } );
		$this->addHandler( 'p', function ( ...$args ) {return $this->langContextHandler( ...$args );
  } );
		$this->addHandler( 'body', function ( ...$args ) {return $this->langContextHandler( ...$args );
  } );
		// Converting #text, <a> nodes, and title/alt attributes
		$this->addHandler( '#text', function ( ...$args ) {return $this->textHandler( ...$args );
  } );
		$this->addHandler( 'a', function ( ...$args ) {return $this->aHandler( ...$args );
  } );
		$this->addHandler( null, function ( ...$args ) {return $this->attrHandler( ...$args );
  } );
		// LanguageConverter markup
		foreach ( [ 'meta', 'div', 'span' ] as $el => $___ ) {
			$this->addHandler( $el, function ( ...$args ) {return $this->lcHandler( ...$args );
   } );
		}
	}
	/** Target language for conversion. */
	public $toLang;
	/** Oracle to determine "original language" for round-tripping. */
	public $guesser;
	/** ReplacementMachine to do actual conversion. */
	public $machine;
	/** The currently-active "original language" */
	public $fromLang;

	public function noConvertHandler( $node, $env, $atTopLevel, $tplInfo ) {
		// Don't touch the inside of this node!
		return $node->nextSibling;
	}
	public function anyHandler( $node, $env, $atTopLevel, $tplInfo ) {
		/* Look for `lang` attributes */
		if ( DOMUtils::isElt( $node ) ) {
			if ( $node->hasAttribute( 'lang' ) ) {
				$lang = $node->getAttribute( 'lang' ); // eslint-disable-line no-unused-vars
				// XXX validate lang! override fromLang?
				// this.fromLang = lang;
			}
		}
		// Continue with other handlers.
		return true;
	}
	public function langContextHandler( $node, $env, $atTopLevel, $tplInfo ) {
		$this->fromLang = $this->guesser->guessLang( $node );
		$node->setAttribute( 'data-mw-variant-lang', $this->fromLang );
		return true; // Continue with other handlers
	}
	public function textHandler( $node, $env, $atTopLevel, $tplInfo ) {
		Assert::invariant( $this->fromLang !== null, 'Text w/o a context' );
		return str_replace( $node, $this->toLang, $this->fromLang, $this->machine );
	}
	public function aHandler( $node, $env, $atTopLevel, $tplInfo ) {
		// Is this a wikilink?  If so, extract title & convert it
		$rel = $node->getAttribute( 'rel' ) || '';
		if ( $rel === 'mw:WikiLink' ) {
			$href = preg_replace( '#^(\.\.?/)+#', '', $node->getAttribute( 'href' ), 1 );
			$fromPage = Util::decodeURI( $href );
			$toPageFrag = $this->machine->convert(
				$node->ownerDocument, $fromPage, $this->toLang, $this->fromLang
			);
			$toPage = docFragToString( $toPageFrag );
			if ( $toPage === null ) {
				// Non-reversible transform (sigh); mark this for rt.
				$node->setAttribute( 'data-mw-variant-orig', $fromPage );
				$toPage = docFragToString( $toPageFrag, true/* force */ );
			}
			if ( $node->hasAttribute( 'title' ) ) {
				$node->setAttribute( 'title', preg_replace( '/_/', ' ', $toPage ) );
			}
			$node->setAttribute( 'href', "./{$toPage}" );
		} elseif ( $rel === 'mw:WikiLink/Interwiki' ) {
			// Don't convert title or children of interwiki links
			return $node->nextSibling;
		} elseif ( $rel === 'mw:ExtLink' ) {
			// WTUtils.usesURLLinkSyntax uses data-parsoid, but syntactic free
			// links should also have class="external free"
			if ( WTUtils::usesURLLinkSyntax( $node ) || $node->classList->contains( 'free' ) ) {
				// Don't convert children of syntactic "free links"
				return $node->nextSibling;
			}
			// Other external link text is protected from conversion iff
			// (a) it doesn't starts/end with -{ ... }-
			if ( $node->firstChild && DOMDataUtils::hasTypeOf( $node->firstChild, 'mw:LanguageVariant' ) ) {
				return true;
			}
			// (b) it looks like a URL (protocol-relative links excluded)
			$linkText = $node->textContent; // XXX: this could be expensive
			if ( Util::isProtocolValid( $linkText, $env )
&& !$linkText->startsWith( '//' )
			) {
				return $node->nextSibling;
			}
		}
		return true;
	}
	public function attrHandler( $node, $env, $atTopLevel, $tplInfo ) {
		// Convert `alt` and `title` attributes on elements
		// (Called before aHandler, so the `title` might get overwritten there)
		if ( !DOMUtils::isElt( $node ) ) { return true;
  }
		foreach ( [ 'title', 'alt' ] as $attr => $___ ) {
			if ( !$node->hasAttribute( $attr ) ) { continue;
   }
			if ( $attr === 'title' && $node->getAttribute( 'rel' ) === 'mw:WikiLink' ) {
				// We've already converted the title in aHandler above.
				continue;
			}
			$orig = $node->getAttribute( $attr );
			if ( preg_match( '#://#', $orig ) ) { continue; /* Don't convert URLs */
   }
			$toFrag = $this->machine->convert(
				$node->ownerDocument, $orig, $this->toLang, $this->fromLang
			);
			$to = docFragToString( $toFrag );
			if ( $to === null ) {
				// Non-reversible transform (sigh); mark for rt.
				$node->setAttribute( "data-mw-variant-{$attr}", $orig );
				$to = docFragToString( $toFrag, true/* force */ );
			}
			$node->setAttribute( $attr, $to );
		}
		return true;
	}
	// LanguageConverter markup
	public function lcHandler( $node, $env, $atTopLevel, $tplInfo ) {
		if ( !DOMDataUtils::hasTypeOf( $node, 'mw:LanguageVariant' ) ) {
			return true; /* not language converter markup */
		}
		$dmv = DOMDataUtils::getJSONAttribute( $node, 'data-mw-variant', [] );
		if ( $dmv->disabled ) {
			$node->innerHTML = $dmv->disabled->t;
			// XXX check handling of embedded data-parsoid
			// XXX check handling of nested constructs
			return $node->nextSibling;
		} elseif ( $dmv->twoway ) {

			// FIXME
		} elseif ( $dmv->oneway ) {

			// FIXME
		} elseif ( $dmv->name ) {

			// FIXME
		} elseif ( $dmv->filter ) {

			// FIXME
		} elseif ( $dmv->describe ) {

			// FIXME
		}
		return true;
	}
}

/**
 * Base class for language variant conversion.
 */
class LanguageConverter {
	/**
	 * @param {Language} langobj
	 * @param {string} maincode The main language code of this language
	 * @param {string[]} variants The supported variants of this language
	 * @param {Map} variantfallbacks The fallback language of each variant
	 * @param {Map} flags Defining the custom strings that maps to the flags
	 * @param {Map} manualLevel Limit for supported variants
	 */
	public function __construct( $langobj, $maincode, $variants, $variantfallbacks, $flags, $manualLevel ) {
		$this->mLangObj = $langobj;
		$this->mMainLanguageCode = $maincode;
		$this->mVariants = $variants; // XXX subtract disabled variants
		$this->mVariantFallbacks = $variantfallbacks;
		// this.mVariantNames = Language.// XXX

		// Eagerly load conversion tables.
		// XXX we could defer loading in the future.
		$this->loadDefaultTables();
	}
	public $mLangObj;
	public $mMainLanguageCode;
	public $mVariants;
	public $mVariantFallbacks;

	// We don't really support lazy loading of conversion tables, but
	// for consistency with PHP's code we'll split the load into a separate
	// abstract method.
	public function loadDefaultTables() {
	}

	/**
	 * Return the {@link ReplacementMachine} powering this conversion.
	 * Parsoid-specific.
	 * @return ReplacementMachine
	 */
	public function getMachine() {
		// For rough consistency with PHP, we use the field name which PHP
		// uses for its ReplacementArray.
		return $this->mTables;
	}

	/**
	 * Try to return a classname from a given code.
	 * @param {string} code
	 * @param {boolean} fallback Whether we're going through language fallback
	 * @return string Name of the language class (if one were to exist)
	 */
	public static function classFromCode( $code, $fallback ) {
		if ( $fallback && $code === 'en' ) {
			return 'Language';
		} else {
			$ncode = preg_replace(

				'#/|^\.+#', '', preg_replace(

					'/-/', '_', preg_replace(
						'/^\w/', function ( $c ) {return strtoupper( $c );
			   }, $code, 1 )
				)
			); // avoid path attacks
			return "Language{$ncode}";
		}
	}

	public static function loadLanguage( $env, $lang, $fallback ) {
		try {
			if ( Language::isValidCode( $lang ) ) {
				return require "./{$this->classFromCode( $lang, $fallback )}.js";
			}
		} catch ( Exception $e ) { /* fall through */
  }
		$env->log(
			'info',
			"Couldn't load language: {$lang} fallback={!!$fallback}"
		);
		return Language::class;
	}

	public function findVariantLink( $link, $nt, $ignoreOtherCond ) {
		// XXX unimplemented
		return [ 'nt' => $nt, 'link' => $link ];
	}
	public function translate( $fromVariant, $text, $toVariant ) {
		// XXX unimplemented
	}
	public function guessVariant( $text, $variant ) {
 return false;
 }

	public static function maybeConvert( $env, $doc, $targetVariant, $sourceVariant ) {
		// language converter must be enabled for the pagelanguage
		if ( !$env->langConverterEnabled() ) { return;
  }
		// targetVariant must be specified, and a language-with-variants
		if ( !( $targetVariant && $env->conf->wiki->variants->has( $targetVariant ) ) ) {
			return;
		}
		// targetVariant must not be a base language code
		if ( $env->conf->wiki->variants->get( $targetVariant )->base === $targetVariant ) {
			// XXX in the future we probably want to go ahead and expand
			// empty <span>s left by -{...}- constructs, etc.
			return;
		}

		// Record the fact that we've done conversion to targetVariant
		$env->page->setVariant( $targetVariant );
		// But don't actually do the conversion if __NOCONTENTCONVERT__
		if ( $doc->querySelector(
				'meta[property="mw:PageProp/nocontentconvert"]'
			)
		) {
			return;
		}
		// OK, convert!
		$this->baseToVariant( $env, $doc->body, $targetVariant, $sourceVariant );
	}

	/**
	 * Convert a text in the "base variant" to a specific variant, given
	 * by `targetVariant`.  If `sourceVariant` is given, assume that the
	 * input wikitext is in `sourceVariant` to construct round-trip
	 * metadata, instead of using a heuristic to guess the best variant
	 * for each DOM subtree of wikitext.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Node} rootNode The root node of a fragment to convert.
	 * @param {string} targetVariant The variant to be used for the output
	 *   DOM.
	 * @param {string} [sourceVariant] An optional variant assumed for
	 *   the input DOM in order to create roundtrip metadata.
	 */
	public static function baseToVariant( $env, $rootNode, $targetVariant, $sourceVariant ) {
		$pageLangCode = $env->page->pagelanguage || $env->conf->wiki->lang || 'en';
		$guesser = null;

		$lang = new ( $this->loadLanguage( $env, $pageLangCode ) )();
		$langconv = $lang->getConverter();
		// XXX we might want to lazily-load conversion tables here.

		// Check the the target variant is valid (and implemented!)
		$validTarget = $langconv && $langconv->getMachine()
&& $langconv->getMachine()->codes->includes( $targetVariant );
		if ( !$validTarget ) {
			// XXX create a warning header? (T197949)
			$env->log( 'info', "Unimplemented variant: {$targetVariant}" );
			return; /* no conversion */
		}

		$metrics = $env->conf->parsoid->metrics;
		$startTime = null;
		if ( $metrics ) {
			$startTime = time();
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
		new ConversionTraverser( $targetVariant, $guesser, $langconv->getMachine() )->
		traverse( $rootNode, $env, null, true );

		if ( $metrics ) {
			$metrics->endTiming( 'langconv.total', $startTime );
			$metrics->endTiming( "langconv.{$targetVariant}.total", $startTime );
		}
	}
}

$module->exports->LanguageConverter = $LanguageConverter;
