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
		$envOptions = [
			'discardDataParsoid' => !empty( $options['discardDataParsoid'] ),
		];
		if ( isset( $options['wrapSections'] ) ) {
			$envOptions['wrapSections'] = !empty( $options['wrapSections'] );
		}
		if ( isset( $options['pageBundle'] ) ) {
			$envOptions['pageBundle'] = !empty( $options['pageBundle'] );
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
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
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
	 * ]
	 * @return PageBundle
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
				// PORT-FIXME: Where is the conversion going to live?
				get_object_vars( $out['pb']->parsoid ),
				isset( $out['pb']->mw ) ? get_object_vars( $out['pb']->mw ) : null
			);
		} else {
			$html = ContentUtils::toXML( $node, [
				'innerXML' => $body_only,
			] );
			return new PageBundle( $html );
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
	) {
		[ $env, ] = $this->parseWikitext( $pageConfig, $options );
		return $env->getLints();
	}

	/**
	 * Serialize HTML to wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param PageBundle $pageBundle
	 * @param array $options [
	 *   'scrubWikitext' => (bool) Indicates emit "clean" wikitext.
	 *   'inputContentVersion' => (string) The content version of the input.
	 *     Necessary if it differs from the current default in order to
	 *     account for any serialization differences.
	 * ]
	 * @param SelserData|null $selserData
	 * @return string
	 */
	public function html2wikitext(
		PageConfig $pageConfig, PageBundle $pageBundle, array $options = [],
		?SelserData $selserData = null
	): string {
		$envOptions = [];
		if ( isset( $options['scrubWikitext'] ) ) {
			$envOptions['scrubWikitext'] = !empty( $options['scrubWikitext'] );
		}
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
		);
		if ( isset( $options['inputContentVersion'] ) ) {
			$env->setInputContentVersion( $options['inputContentVersion'] );
		}
		$doc = $env->createDocument( $pageBundle->html );
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
