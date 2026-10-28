<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Utils\DOMTraverser;
use Wikimedia\Parsoid\Utils\DTState;
use Wikimedia\Parsoid\Wt2Html\DOMProcessorPipeline;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

/**
 * This is a class that wraps the DOMTraverser utility for use
 * in the DOM Processor pipeline.
 */
class DOMPPTraverser implements Wt2HtmlDOMProcessor {
	private DOMTraverser $dt;
	private array $runFilters;

	public function __construct(
		?DOMProcessorPipeline $domPP,
		bool $traverseWithTplInfo = false,
		bool $applyToAttributeEmbeddedHTML = false,
		array $runFilters = []
	) {
		$this->dt = new DOMTraverser( $traverseWithTplInfo, $applyToAttributeEmbeddedHTML );
		$this->runFilters = $runFilters;
	}

	/**
	 * @param ?string $nodeName An optional node name filter
	 * @param callable $action A callback, called on each node we traverse that matches nodeName.
	 * Proxies call to underlying DOMTraverser. See docs for DOMTraverser::addHandler
	 */
	public function addHandler( ?string $nodeName, callable $action ): void {
		$this->dt->addHandler( $nodeName, $action );
	}

	/**
	 * @inheritDoc
	 */
	public function shouldRun(
		Env $env, Element|DocumentFragment $root, array $options, bool $atTopLevel
	): bool {
		// No filters => always run
		if ( !$this->runFilters ) {
			return true;
		}

		// Return false only if all runFilters fail
		foreach ( $this->runFilters as $f ) {
			if ( $f( $env, $root ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Element|DocumentFragment $root, array $options = [], bool $atTopLevel = false
	): void {
		$state = new DTState( $env, $options, $atTopLevel );
		$this->dt->traverse( $env->getSiteConfig(), $root, $state );
	}
}
