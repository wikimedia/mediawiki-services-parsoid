<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class ProcessEmbeddedDocs implements Wt2HtmlDOMProcessor {
	private Env $env;

	private function processNode( Node $root, ?stdClass $tplInfo = null ): void {
		$node = $root->firstChild;

		while ( $node !== null ) {
			if ( !$node instanceof Element ) {
				$node = $node->nextSibling;
				continue;
			}

			if ( !$tplInfo && WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
				$aboutSibs = WTUtils::getAboutSiblings(
					$node, DOMCompat::getAttribute( $node, 'about' )
				);
				$tplInfo = (object)[
					'first' => $node,
					'last' => end( $aboutSibs ),
					'dsr' => DOMDataUtils::getDataParsoid( $node )->dsr ?? null,
					'isTemplated' => DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ),
				];
			}

			ContentUtils::processAttributeEmbeddedDom(
				$this->env->getSiteConfig(),
				$node,
				function ( DocumentFragment $df ) use ( $tplInfo ) {
					PipelineUtils::processContentInPipeline(
						$this->env,
						$this->env->topFrame,
						$df,
						[
							'pipelineType' => 'fullparse-embedded-docs-dom-to-dom',
							'pipelineOpts' => [],
							'sol' => true,
							'tplInfo' => ( $tplInfo->isTemplated ?? false ) ? $tplInfo : null,
						],
					);
					return true; // might have been changed.
				}
			);

			$this->processNode( $node, $tplInfo );

			if ( $tplInfo && $tplInfo->last === $node ) {
				$tplInfo = null;
			}

			$node = $node->nextSibling;
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
		$this->processNode( $root );
	}
}
