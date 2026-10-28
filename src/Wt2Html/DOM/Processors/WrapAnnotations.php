<?php
declare( strict_types=1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Wt2Html\DOMProcessorPipelineFilter;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class WrapAnnotations implements Wt2HtmlDOMProcessor {
	/**
	 * @inheritDoc
	 */
	public function shouldRun( Env $env, Node $root, array $options, bool $atTopLevel ): bool {
		return DOMProcessorPipelineFilter::hasAnnotations( $env, $root );
	}

	/**
	 * Encapsulate template-affected DOM structures by wrapping text nodes into
	 * spans and adding RDFa attributes to all subtree roots according to
	 * http://www.mediawiki.org/wiki/Parsoid/RDFa_vocabulary#Template_content
	 * @inheritDoc
	 */
	public function run(
		Env $env, Element|DocumentFragment $root, array $options = [], bool $atTopLevel = false
	): void {
		$op = new AnnotationDOMRangeBuilder( $root->ownerDocument, $options['frame'] );
		$op->execute( $root );
	}
}
