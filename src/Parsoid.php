<?php
declare( strict_types = 1 );

namespace Parsoid;

use LogicException;

use Parsoid\Config\DataAccess;
use Parsoid\Config\Env;
use Parsoid\Config\PageConfig;
use Parsoid\Config\SiteConfig;
use Parsoid\Language\LanguageConverter;
use Parsoid\Logger\LintLogger;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;
use Parsoid\Wt2Html\PP\Processors\AddRedLinks;

class Parsoid {

	/** @var SiteConfig */
	private $siteConfig;

	/** @var DataAccess */
	private $dataAccess;

	/**
	 * @param SiteConfig $siteConfig
	 * @param DataAccess $dataAccess
	 */
	public function __construct(
		SiteConfig $siteConfig, DataAccess $dataAccess
	) {
		$this->siteConfig = $siteConfig;
		$this->dataAccess = $dataAccess;
	}

	private function setupCommonOptions( array $options ): array {
		$envOptions = [];
		if ( isset( $options['offsetType'] ) ) {
			$envOptions['offsetType'] = $options['offsetType'];
		}
		if ( isset( $options['traceFlags'] ) ) {
			$envOptions['traceFlags'] = $options['traceFlags'];
		}
		if ( isset( $options['dumpFlags'] ) ) {
			$envOptions['dumpFlags'] = $options['dumpFlags'];
		}
		if ( isset( $options['debugFlags'] ) ) {
			$envOptions['debugFlags'] = $options['debugFlags'];
		}
		if ( !empty( $options['htmlVariantLanguage'] ) ) {
			$envOptions['htmlVariantLanguage'] = $options['htmlVariantLanguage'];
		}
		if ( !empty( $options['wtVariantLanguage'] ) ) {
			$envOptions['wtVariantLanguage'] = $options['wtVariantLanguage'];
		}
		if ( isset( $options['logLevels'] ) ) {
			$envOptions['logLevels'] = $options['logLevels'];
		}
		return $envOptions;
	}

	/**
	 * Parsing code shared between the next two methods.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options See wikitext2html.
	 * @return array
	 */
	private function parseWikitext(
		PageConfig $pageConfig, array $options = []
	): array {
		$envOptions = $this->setupCommonOptions( $options );
		$envOptions['discardDataParsoid'] = !empty( $options['discardDataParsoid'] );
		if ( isset( $options['wrapSections'] ) ) {
			$envOptions['wrapSections'] = !empty( $options['wrapSections'] );
		}
		if ( isset( $options['pageBundle'] ) ) {
			$envOptions['pageBundle'] = !empty( $options['pageBundle'] );
		}
		if ( isset( $options['pageWithOldid'] ) ) {
			$envOptions['pageWithOldid'] = !empty( $options['pageWithOldid'] );
		}
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
		);
		if ( isset( $options['outputContentVersion'] ) ) {
			$env->setOutputContentVersion( $options['outputContentVersion'] );
		}
		$env->bumpWt2HtmlResourceUse(
			# Should perhaps be strlen instead (or cached!): T239841
			'wikitextSize', mb_strlen( $env->getPageMainContent() )
		);
		$handler = $env->getContentHandler();
		return [ $env, $handler->toHTML( $env ) ];
	}

	/**
	 * Parse the wikitext supplied in a `PageConfig` to HTML.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options [
	 *   'wrapSections'         => (bool) Whether `<section>` wrappers should be added.
	 *   'pageBundle'           => (bool) Sets ids on nodes and stores
	 *                                    data-* attributes in a JSON blob.
	 *   'body_only'            => (bool|null) Only return the <body> children (T181657)
	 *   'outputContentVersion' => (string|null) Version of HTML to output.
	 *                                           `null` returns the default version.
	 *   'discardDataParsoid'   => (bool) Drop all data-parsoid annotations.
	 *   'offsetType'           => (string) ucs2, char, byte are valid values
	 *                                      what kind of source offsets should be emitted?
	 *   'htmlVariantLanguage'  => (string) If non-null, the language variant used for Parsoid HTML.
	 *   'wtVariantLanguage'    => (string) If non-null, the language variant used for wikitext.
	 *   'pageWithOldid'        => (bool) Does this request specify an oldid?
	 *   'traceFlags'           => (array) associative array with tracing options
	 *   'dumpFlags'            => (array) associative array with dump options
	 *   'debugFlags'           => (array) associative array with debug options
	 *   'logLevels'            => (string[]) Levels to log
	 * ]
	 * @param array|null &$headers
	 * @return PageBundle|string
	 */
	public function wikitext2html(
		PageConfig $pageConfig, array $options = [], array &$headers = null
	) {
		[ $env, $doc ] = $this->parseWikitext( $pageConfig, $options );
		// FIXME: Does this belong in parseWikitext so that the other endpoint
		// is covered as well?  It probably depends on expectations of the
		// Rest API.  If callers of /page/lint/ assume that will update the
		// results on the Special page.
		if ( $env->getSiteConfig()->linting() ) {
			( new LintLogger( $env ) )->logLintOutput();
		}
		$headers = DOMUtils::findHttpEquivHeaders( $doc );
		$body_only = !empty( $options['body_only'] );
		$node = $body_only ? DOMCompat::getBody( $doc ) : $doc;
		if ( $env->pageBundle ) {
			$out = ContentUtils::extractDpAndSerialize( $node, [
				'innerXML' => $body_only,
			] );
			return new PageBundle(
				$out['html'],
				get_object_vars( $out['pb']->parsoid ),
				isset( $out['pb']->mw ) ? get_object_vars( $out['pb']->mw ) : null,
				$env->getOutputContentVersion(),
				$headers
			);
		} else {
			return ContentUtils::toXML( $node, [
				'innerXML' => $body_only,
			] );
		}
	}

	/**
	 * Lint the wikitext supplied in a `PageConfig`.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options See wikitext2html.
	 * @return array
	 */
	public function wikitext2lint(
		PageConfig $pageConfig, array $options = []
	): array {
		[ $env, ] = $this->parseWikitext( $pageConfig, $options );
		return $env->getLints();
	}

	/**
	 * Serialize HTML to wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param string $html Data attributes are expected to have been applied
	 *   already.  Loading them will happen once the environment is created.
	 * @param array $options [
	 *   'scrubWikitext'       => (bool) Indicates emit "clean" wikitext.
	 *   'inputContentVersion' => (string) The content version of the input.
	 *     Necessary if it differs from the current default in order to
	 *     account for any serialization differences.
	 *   'offsetType'          => (string) ucs2, char, byte are valid values
	 *                                     what kind of source offsets are present in the HTML?
	 *   'htmlVariantLanguage' => (string) If non-null, the language variant used for Parsoid HTML.
	 *   'wtVariantLanguage'   => (string) If non-null, the language variant used for wikitext.
	 *   'traceFlags'          => (array) associative array with tracing options
	 *   'dumpFlags'           => (array) associative array with dump options
	 *   'debugFlags'          => (array) associative array with debug options
	 *   'logLevels'           => (string[]) Levels to log
	 * ]
	 * @param SelserData|null $selserData
	 * @return string
	 */
	public function html2wikitext(
		PageConfig $pageConfig, string $html, array $options = [],
		?SelserData $selserData = null
	): string {
		$envOptions = $this->setupCommonOptions( $options );
		if ( isset( $options['scrubWikitext'] ) ) {
			$envOptions['scrubWikitext'] = !empty( $options['scrubWikitext'] );
		}
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
		);
		if ( isset( $options['inputContentVersion'] ) ) {
			$env->setInputContentVersion( $options['inputContentVersion'] );
		}
		# Should perhaps be strlen instead (or cached!): T239841
		$env->bumpHtml2WtResourceUse( 'htmlSize', mb_strlen( $html ) );
		$doc = $env->createDocument( $html );
		$handler = $env->getContentHandler();
		return $handler->fromHTML( $env, $doc, $selserData );
	}

	/**
	 * Update the supplied HTML based on the `$update` type.
	 *
	 *   'redlinks': Refreshes the classes of known, missing, etc. links.
	 *   'variant': Hydrates the HTML based on the supplied variant.
	 *
	 * Note that these are DOM transforms, and not roundtrips through wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param string $update 'redlinks'|'variant'
	 * @param string $html
	 * @param array|null $options
	 * @param array|null &$headers
	 * @return string
	 */
	public function html2html(
		PageConfig $pageConfig, string $update, string $html,
		array $options = [], array &$headers = null
	): string {
		$envOptions = [];
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
		);
		$doc = $env->createDocument( $html );
		if ( $update === 'redlinks' ) {
			AddRedLinks::run( DOMCompat::getBody( $doc ), $env );
		} elseif ( $update === 'variant' ) {
			// Note that `maybeConvert` could still be a no-op, in case the
			// __NOCONTENTCONVERT__ magic word is present, or the targetVariant
			// is a base language code or otherwise invalid.
			LanguageConverter::maybeConvert(
				$env, $doc, $options['variant']['target'],
				$options['variant']['source'] ?? null
			);
			// Ensure there's a <head>
			if ( !DOMCompat::getHead( $doc ) ) {
				$doc->documentElement->insertBefore(
					$doc->createElement( 'head' ), DOMCompat::getBody( $doc )
				);
			}
			// Update content-language and vary headers.
			$ensureHeader = function ( string $h ) use ( $doc ) {
				$el = DOMCompat::querySelector( $doc, "meta[http-equiv=\"{$h}\"i]" );
				if ( !$el ) {
					$el = $doc->createElement( 'meta' );
					$el->setAttribute( 'http-equiv', $h );
					( DOMCompat::getHead( $doc ) )->appendChild( $el );
				}
				return $el;
			};
			( $ensureHeader( 'content-language' ) )->setAttribute(
				'content', $env->htmlContentLanguage()
			);
			( $ensureHeader( 'vary' ) )->setAttribute(
				'content', $env->htmlVary()
			);
		} else {
			throw new LogicException( 'Unknown transformation.' );
		}
		$headers = DOMUtils::findHttpEquivHeaders( $doc );
		// No need to `ContentUtils.extractDpAndSerialize`, it wasn't applied.
		$body_only = !empty( $options['body_only'] );
		$node = $body_only ? DOMCompat::getBody( $doc ) : $doc;
		return ContentUtils::toXML( $node, [
			'innerXML' => $body_only,
		] );
	}

}
