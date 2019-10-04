<?php
declare( strict_types = 1 );

namespace Parsoid;

use Parsoid\Config\DataAccess;
use Parsoid\Config\Env;
use Parsoid\Config\PageConfig;
use Parsoid\Config\SiteConfig;
use Parsoid\Logger\LintLogger;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;

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
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
		);
		if ( isset( $options['outputVersion'] ) ) {
			$env->setOutputContentVersion( $options['outputVersion'] );
		}
		$env->bumpWt2HtmlResourceUse(
			'wikitextSize', strlen( $env->getPageMainContent() )
		);
		$handler = $env->getContentHandler();
		return [ $env, $handler->toHTML( $env ) ];
	}

	/**
	 * Parse the wikitext supplied in a `PageConfig` to HTML.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options [
	 *   'wrapSections'       => (bool) Whether `<section>` wrappers should be added.
	 *   'pageBundle'         => (bool) Sets ids on nodes and stores data-* attributes in a JSON blob.
	 *   'body_only'          => (bool|null) Only return the <body> children (T181657)
	 *   'outputVersion'      => (string|null) Version of HTML to output.
	 *                                         `null` returns the default version.
	 *   'inlineDataAttribs'  => (bool) Setting to `true` avoids extracting data attributes.
	 *   'discardDataParsoid' => (bool) Drop all data-parsoid annotations.
	 *   'offsetType'         => (string) ucs2, char, byte are valid values
	 *                           what kind of source offsets should be emitted?
	 *   'traceFlags'         => (array) associative array with tracing options
	 *   'dumpFlags'          => (array) associative array with dump options
	 *   'debugFlags'         => (array) associative array with debug options
	 * ]
	 * @return PageBundle|string
	 */
	public function wikitext2html(
		PageConfig $pageConfig, array $options = []
	) {
		[ $env, $doc ] = $this->parseWikitext( $pageConfig, $options );
		// FIXME: Does this belong in parseWikitext so that the other endpoint
		// is covered as well?  It probably depends on expectations of the
		// Rest API.  If callers of /page/lint/ assume that will update the
		// results on the Special page.
		if ( $env->getSiteConfig()->linting() ) {
			( new LintLogger( $env ) )->logLintOutput();
		}
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
				$env->getOutputContentVersion()
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
	 *   'scrubWikitext' => (bool) Indicates emit "clean" wikitext.
	 *   'inputContentVersion' => (string) The content version of the input.
	 *     Necessary if it differs from the current default in order to
	 *     account for any serialization differences.
	 *   'offsetType'         => (string) ucs2, char, byte are valid values
	 *                           what kind of source offsets are present in the HTML?
	 *   'traceFlags'         => (array) associative array with tracing options
	 *   'dumpFlags'          => (array) associative array with dump options
	 *   'debugFlags'         => (array) associative array with debug options
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
		$env->bumpHtml2WtResourceUse( 'htmlSize', strlen( $html ) );
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
	 * @param PageBundle $pageBundle
	 * @param string $update 'redlinks'|'variant'
	 * @return PageBundle
	 */
	public function html2html(
		PageConfig $pageConfig, PageBundle $pageBundle, string $update
	): PageBundle {
		return new PageBundle( '' );
	}

}
