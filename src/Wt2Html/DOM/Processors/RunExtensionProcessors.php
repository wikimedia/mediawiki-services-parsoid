<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Ext\DOMProcessor as ExtDOMProcessor;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

/**
 * A wrapper to call extension-specific DOM processors.
 *
 * FIXME: There are two potential ordering problems here.
 *
 * 1. unpackDOMFragment should always run immediately
 *    before these extensionPostProcessors, which we do currently.
 *    This ensures packed content get processed correctly by extensions
 *    before additional transformations are run on the DOM.
 *
 * This ordering issue is handled through documentation.
 *
 * 2. This has existed all along (in the PHP parser as well as Parsoid
 *    which is probably how the ref-in-ref hack works - because of how
 *    parser functions and extension tags are procesed, #tag:ref doesn't
 *    see a nested ref anymore) and this patch only exposes that problem
 *    more clearly with the unpackOutput property.
 *
 * * Consider the set of extensions that
 *   (a) process wikitext
 *   (b) provide an extensionPostProcessor
 *   (c) run the extensionPostProcessor only on the top-level
 *   As of today, there is exactly one extension (Cite) that has all
 *   these properties, so the problem below is a speculative problem
 *   for today. But, this could potentially be a problem in the future.
 *
 * * Let us say there are at least two of them, E1 and E2 that
 *   support extension tags <e1> and <e2> respectively.
 *
 * * Let us say in an instance of <e1> on the page, <e2> is present
 *   and in another instance of <e2> on the page, <e1> is present.
 *
 * * In what order should E1's and E2's extensionPostProcessors be
 *   run on the top-level? Depending on what these handlers do, you
 *   could get potentially different results. You can see this quite
 *   starkly with the unpackOutput flag.
 *
 * * The ideal solution to this problem is to require that every extension's
 *   extensionPostProcessor be idempotent which lets us run these
 *   post processors repeatedly till the DOM stabilizes. But, this
 *   still doesn't necessarily guarantee that ordering doesn't matter.
 *   It just guarantees that with the unpackOutput flag set to false
 *   multiple extensions, all sealed fragments get fully processed.
 *   So, we still need to worry about that problem.
 *
 *   But, idempotence *could* potentially be a sufficient property in most cases.
 *   To see this, consider that there is a Footnotes extension which is similar
 *   to the Cite extension in that they both extract inline content in the
 *   page source to a separate section of output and leave behind pointers to
 *   the global section in the output DOM. Given this, the Cite and Footnote
 *   extension post processors would essentially walk the dom and
 *   move any existing inline content into that global section till it is
 *   done. So, even if a <footnote> has a <ref> and a <ref> has a <footnote>,
 *   we ultimately end up with all footnote content in the footnotes section
 *   and all ref content in the references section and the DOM stabilizes.
 *   Ordering is irrelevant here.
 *
 *   So, perhaps one way of catching these problems would be in code review
 *   by analyzing what the DOM postprocessor does and see if it introduces
 *   potential ordering issues.
 */
class RunExtensionProcessors implements Wt2HtmlDOMProcessor {
	private ?array $extProcessors = null;

	/**
	 * FIXME: We've lost the ability to dump dom pre/post individual
	 * extension processors. Need to fix RunExtensionProcessors to
	 * reintroduce that granularity
	 */
	private function initialize( Env $env ): array {
		$extProcessors = [];
		foreach ( $env->getSiteConfig()->getExtDOMProcessors() as $extName => $domProcs ) {
			foreach ( $domProcs as $i => $classNameOrSpec ) {
				// Extension post processor, object factory spec given
				$objectFactory = $env->getSiteConfig()->getObjectFactory();
				$extProcessors[] = $objectFactory->createObject( $classNameOrSpec, [
					'allowClassName' => true,
					'assertClass' => ExtDOMProcessor::class,
				] );
			}
		}

		return $extProcessors;
	}

	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		$this->extProcessors ??= $this->initialize( $env );
		foreach ( $this->extProcessors as $ep ) {
			$ep->wtPostprocess( $options['extApi'], $root, $options );
		}
	}
}
