<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class UpdateTemplateOutput implements Wt2HtmlDOMProcessor {
	/**
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
		$tplNodes = DOMCompat::querySelectorAll( $root, '[typeof~="mw:Transclusion"]' );
		foreach ( $tplNodes as $tplNode ) {
			$dataMw = DOMDataUtils::getDataMW( $tplNode );
			$ti = $dataMw->parts[0] ?? null;
			if ( !is_string( $ti ) && $ti->href === $tplTitle ) {
				// we found it!
				$dp = DOMDataUtils::getDataParsoid( $tplNode );
				$wt = $dp->dsr->substr( $selparData->revText );
				$opts = [
					'pipelineType' => 'selective-update-fragment-wikitext-to-dom',
					'sol' => false, // FIXME: Not strictly correct
					'srcText' => $selparData->revText,
					'pipelineOpts' => []
				];

				// FIXME: This fragment might need its p-wrapper stripped in some cases
				// Pull out only the translcusion marked portion of $frag
				$frag = PipelineUtils::processContentInPipeline( $env, $options['frame'], $wt, $opts );

				// FIXME: May have more than one child in the general case
				$content = $frag->firstChild;
				DOMDataUtils::getDataParsoid( $content )->dsr = $dp->dsr;
				$tplNode->parentNode->replaceChild( $content, $tplNode );
			}
		}
	}
}
