<?php

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use DOMDocumentFragment;
use DOMElement;
use DOMNode;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class Normalize implements Wt2HtmlDOMProcessor {
	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, DOMNode $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var DOMElement|DOMDocumentFragment $root';  // @var DOMElement|DOMDocumentFragment $root
		DOMCompat::normalize( $root );
	}
}
