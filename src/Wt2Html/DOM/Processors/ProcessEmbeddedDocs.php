<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

/**
 */
class ProcessEmbeddedDocs implements Wt2HtmlDOMProcessor {
	private Env $env;
	private ParsoidExtensionAPI $extApi;

	private function processNode( Element $elt ): void {
		$doc = $elt->ownerDocument;
		ContentUtils::processAttributeEmbeddedHTML(
			$this->extApi,
			$elt,
			function ( string $html ) use ( $doc ) {
				$df = ContentUtils::createAndLoadDocumentFragment( $doc, $html );
				PipelineUtils::processContentInPipeline(
					$this->env,
					$this->env->topFrame,
					$df,
					[
						'pipelineType' => 'fullparse-embedded-docs-dom-to-dom',
						'pipelineOpts' => [],
						'sol' => true
					],
				);
				return ContentUtils::ppToXML( $df, [ 'innerXML' => true, 'fragment' => true ] );
			}
		);

		$child = $elt->firstChild;
		while ( $child ) {
			if ( $child instanceof Element ) {
				$this->processNode( $child );
			}
			$child = $child->nextSibling;
		}
	}

	/**
	 * DOM Postprocessor entry function to walk DOM rooted at $root
	 * and convert the DSR offsets as needed.
	 * @see ConvertUtils::convertOffsets
	 *
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		$this->env = $env;
		$this->extApi = new ParsoidExtensionAPI( $env );

		$children = ( $root instanceof Element ) ? [ $root ] : $root->childNodes;
		foreach ( $children as $child ) {
			if ( $child instanceof Element ) {
				$this->processNode( $child );
			}
		}
	}
}
