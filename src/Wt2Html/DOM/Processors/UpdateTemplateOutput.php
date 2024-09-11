<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class UpdateTemplateOutput implements Wt2HtmlDOMProcessor {
	/**
	 * FIXME:
	 * -- mwt-id counter may need to be reset!
	 * -- We have hardcoded check for Template: in English
	 * -- We aren't checking for other instances (ex: template args)
	 * -- We aren't checking for indirect dependencies (ex: nested templates)
	 * -- In the core repo, we also need to figure out what OutputTransformPipeline
	 *    stages need to run in this case.
	 *
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var Element|DocumentFragment $root';  // @var Element|DocumentFragment $root

		$selparData = $options['selparData'] ?? null;
		if ( !$selparData ) {
			error_log( "Missing selpar data" );
			return;
		}

		// FIXME: Hardcoded for English
		$tplTitle = "./Template:" . $selparData->templateTitle;
		// FIXME: Insufficient - missing check for template args, indirect dependencies
		$tplNodes = DOMCompat::querySelectorAll( $root, '[typeof~="mw:Transclusion"]' );
		foreach ( $tplNodes as $tplNode ) {
			$dataMw = DOMDataUtils::getDataMW( $tplNode );
			$ti = $dataMw->parts[0] ?? null;
			if ( !is_string( $ti ) && $ti->href === $tplTitle ) {
				$dp = DOMDataUtils::getDataParsoid( $tplNode );
				$wt = $dp->dsr->substr( $selparData->revText );
				$opts = [
					'pipelineType' => 'selective-update-fragment-wikitext-to-dom',
					'sol' => false, // FIXME: Not strictly correct
					'srcText' => $selparData->revText,
					'pipelineOpts' => [],
					'srcOffsets' => $dp->dsr,
				];

				// Process template string in new pipeline
				$frag = PipelineUtils::processContentInPipeline(
					$env, $options['frame'], $wt, $opts
				);

				// Pull out only the transclusion marked portion of $frag & strip p-wrapper
				$newContent = $frag->firstChild;
				if (
					DOMCompat::nodeName( $tplNode ) !== 'p' &&
					DOMCompat::nodeName( $newContent ) === 'p'
				) {
					$newContent = $newContent->firstChild;
				}
				DOMDataUtils::getDataParsoid( $newContent )->dsr = $dp->dsr;

				// Delete template from DOM + add new content to DOM
				// Note that $tplNode and $frag may have more than one child in the general case
				$tplParent = $tplNode->parentNode;
				$about = DOMCompat::getAttribute( $tplNode, 'about' );
				do {
					$next = $tplNode->nextSibling;
					$tplParent->removeChild( $tplNode );
					$tplNode = $next;
				} while (
					$tplNode instanceof Element &&
					DOMCompat::getAttribute( $tplNode, 'about' ) === $about
				);

				DOMUtils::migrateChildren( $newContent->parentNode, $tplParent, $tplNode );
			}
		}
	}
}
