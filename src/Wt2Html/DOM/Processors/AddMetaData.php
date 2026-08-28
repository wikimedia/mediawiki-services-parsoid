<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wt2Html\DOMProcessorPipeline;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

/**
 * This stage is moving to core (T393925) and new feature development
 * should be done there (PageBundleParserOutputConverter).
 */
class AddMetaData implements Wt2HtmlDOMProcessor {
	private array $metadataMap;
	private ?DOMProcessorPipeline $parentPipeline;

	public function __construct( ?DOMProcessorPipeline $domPP ) {
		$this->parentPipeline = $domPP;
	}

	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		$document = $root->ownerDocument;

		// Set the charset in the <head> first.
		// This also adds the <head> element if it was missing.
		DOMUtils::appendToHead( $document, 'meta', [ 'charset' => 'utf-8' ] );

		// add mw: and mwr: RDFa prefixes
		$prefixes = [
			'dc: http://purl.org/dc/terms/',
			'mw: http://mediawiki.org/rdf/'
		];
		$document->documentElement->setAttribute( 'prefix', implode( ' ', $prefixes ) );

		// Add base href pointing to the wiki root
		DOMUtils::appendToHead( $document, 'base', [
			'href' => $env->getSiteConfig()->baseURI()
		] );

		// Indicate whether LanguageConverter is enabled, so that downstream
		// caches can split on variant (if necessary)
		DOMUtils::appendToHead( $document, 'meta', [
				'http-equiv' => 'content-language',
				// Note that this is "wrong": we should be returning
				// $env->htmlContentLanguageBcp47()->toBcp47Code() directly
				// but for back-compat we'll return the "old" mediawiki-internal
				// code for now
				'content' => Utils::bcp47ToMwCode( # T323052: remove this call
					$env->htmlContentLanguageBcp47()->toBcp47Code()
				),
			]
		);
		DOMUtils::appendToHead( $document, 'meta', [
				'http-equiv' => 'vary',
				'content' => $env->htmlVary()
			]
		);

		if ( $env->profiling() && $this->parentPipeline ) {
			$body = DOMCompat::getBody( $document );
			$body->appendChild( $body->ownerDocument->createTextNode( "\n" ) );
			$body->appendChild( $body->ownerDocument->createComment( $this->parentPipeline->getTimeProfile() ) );
			$body->appendChild( $body->ownerDocument->createTextNode( "\n" ) );
		}

		if ( $env->hasDumpFlag( 'wt2html:limits' ) ) {
			/*
			 * PORT-FIXME: Not yet implemented
			$env->printWt2HtmlResourceUsage( [
				'HTML Size' => strlen( DOMCompat::getOuterHTML( $document->documentElement ) )
			] );
			*/
		}
	}
}
