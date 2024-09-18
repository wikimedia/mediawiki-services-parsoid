<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

/**
 */
class ProcessEmbeddedDocs implements Wt2HtmlDOMProcessor {
	private Env $env;
	private ParsoidExtensionAPI $extApi;

	private function processNode( Element $elt ): void {
		ContentUtils::processAttributeEmbeddedHTML(
			$this->extApi,
			$elt,
			function ( string $html ) {
				$dom = ContentUtils::createDocument( $html );
				$body = DOMCompat::getBody( $dom );
				DOMDataUtils::visitAndLoadDataAttribs( $body );
				PipelineUtils::processContentInPipeline(
					$this->env,
					$this->env->topFrame,
					$body,
					[
						'pipelineType' => 'fullparse-embedded-docs-dom-to-dom',
						'pipelineOpts' => [],
						'sol' => true
					],
				);
				return ContentUtils::ppToXML( $body, [ 'innerXML' => true ] );
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
		'@phan-var Element $root';
		$this->processNode( $root );
	}
}
