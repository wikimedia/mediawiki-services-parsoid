<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DOMCompat;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class Normalize implements Wt2HtmlDOMProcessor {
	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Element|DocumentFragment $root, array $options = [], bool $atTopLevel = false
	): void {
		DOMCompat::normalize( $root );
	}
}
