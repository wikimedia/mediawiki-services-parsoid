<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Node;
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

	public function __construct(
		?DOMProcessorPipeline $domPP, bool $traverseWithTplInfo = false, bool $applyToAttributeEmbeddedHTML = false
	) {
		$this->dt = new DOMTraverser( $traverseWithTplInfo, $applyToAttributeEmbeddedHTML );
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
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		$state = new DTState( $env, $options, $atTopLevel );
		$this->dt->traverse( $env->getSiteConfig(), $root, $state );
	}
}
