<?php
declare( strict_types = 1 );

namespace Parsoid;

use Parsoid\Config\DataAccess;
use Parsoid\Config\Env;
use Parsoid\Config\PageConfig;
use Parsoid\Config\SiteConfig;
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
	 * Parse the wikitext supplied in a `PageConfig` to HTML.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options [
	 *   'wrapSections'      => (bool) Whether `<section>` wrappers should be added.
	 *   'pageBundle'        => (bool) Sets ids on nodes and stores data-* attributes in a JSON blob.
	 *   'body_only'         => (bool|null) Only return the <body> children (T181657)
	 *   'outputVersion'     => (string|null) Version of HTML to output.
	 *                                        `null` returns the default version.
	 *   'inlineDataAttribs' => (bool) Setting to `true` avoids extracting data attributes.
	 *   'lint'              => (bool) Setting to `true` returns linting results rather than html
	 * ]
	 * @return PageBundle|array
	 */
	public function wikitext2html(
		PageConfig $pageConfig, array $options = []
	) {
		$envOptions = [];
		if ( isset( $options['wrapSections'] ) ) {
			$envOptions['wrapSections'] = !empty( $options['wrapSections'] );
		}
		if ( isset( $options['pageBundle'] ) ) {
			$envOptions['pageBundle'] = !empty( $options['pageBundle'] );
		}
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $envOptions
		);
		$handler = $env->getContentHandler();
		$doc = $handler->toHTML( $env );

		if ( !empty( $options['lint'] ) ) {
			return $env->getLints();
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
	 * @param Selser|null $selser
	 * @return string
	 */
	public function html2wikitext(
		PageConfig $pageConfig, PageBundle $pageBundle, array $options = [],
		?Selser $selser = null
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
		return $handler->fromHTML( $env, $doc, $selser );
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
