<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class WrapSections implements Wt2HtmlDOMProcessor {

	/**
	 * DOM Postprocessor entry function to walk DOM rooted at $root
	 * and add <section> wrappers as necessary.
	 * Implements the algorithm documented @ mw:Parsing/Notes/Section_Wrapping
	 *
	 * @param Env $env
	 * @param Element|DocumentFragment $root The root of the tree to process
	 * @param array $options
	 * @param bool $atTopLevel Is this processor invoked on the top level page?
	 *   If false, this is being invoked in a sub-pipeline (ex: extensions)
	 */
	public function run(
		Env $env, Element|DocumentFragment $root, array $options = [], bool $atTopLevel = false
	): void {
		if ( !$env->getWrapSections() ) {
			return;
		}

		$state = new WrapSectionsState(
			$env,
			$options['frame'],
			$root
		);
		$state->run();
	}
}
