<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wikitext;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\ContentModelHandler as IContentModelHandler;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Ext\DOMProcessor as ExtDOMProcessor;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Html2Wt\RemoveRedLinks;
use Wikimedia\Parsoid\Html2Wt\SelectiveSerializer;
use Wikimedia\Parsoid\Html2Wt\WikitextSerializer;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\Timing;

class ContentModelHandler extends IContentModelHandler {

	/** @var Env */
	private $env;

	/**
	 * Sneak an environment in here since it's not exposed as part of the
	 * ParsoidExtensionAPI
	 *
	 * @param Env $env
	 */
	public function __construct( Env $env ) {
		$this->env = $env;
	}

	/**
	 * Bring DOM to expected canonical form
	 */
	private function canonicalizeDOM(
		Env $env, Document $doc
	): void {
		Assert::invariant(
			DOMDataUtils::isPreparedAndLoaded( $doc ),
			"doc should already be prepared and loaded"
		);
		$body = DOMCompat::getBody( $doc );

		// Update DSR offsets if necessary.
		ContentUtils::convertOffsets(
			$env, $doc, $env->getRequestOffsetType(), 'byte'
		);

		// Strip <section> and mw:FallbackId <span> tags, if present,
		// as well as extended annotation wrappers.
		// This ensures that we can accept HTML from CX / VE
		// and other clients that might have stripped them.
		ContentUtils::stripUnnecessaryWrappersAndSyntheticNodes( $body );

		$redLinkRemover = new RemoveRedLinks( $this->env );
		$redLinkRemover->run( $body );
	}

	/**
	 * Fetch prior DOM for selser.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param SelectiveUpdateData $selserData
	 */
	private function setupSelser(
		ParsoidExtensionAPI $extApi, SelectiveUpdateData $selserData
	) {
		$env = $this->env;

		// Why is it safe to use a reparsed dom for dom diff'ing?
		// (Since that's the only use of `env.page.dom`)
		//
		// There are two types of non-determinism to discuss:
		//
		//   * The first is from parsoid generated ids.  At this point,
		//     data-attributes have already been applied so there's no chance
		//     that variability in the ids used to associate data-attributes
		//     will lead to data being applied to the wrong nodes.
		//
		//     Further, although about ids will differ, they belong to the set
		//     of ignorable attributes in the dom differ.
		//
		//   * Templates, and encapsulated content in general, are the second.
		//     Since that content can change in between parses, the resulting
		//     dom might not be the same.  However, because dom diffing on
		//     on those regions only uses data-mw for comparision (which will
		//     remain constant between parses), this also shouldn't be an
		//     issue.
		//
		//     There is one caveat.  Because encapsulated content isn't
		//     guaranteed to be "balanced", the template affected regions
		//     may change between parses.  This should be rare.
		//
		// We therefore consider this safe since it won't corrupt the page
		// and, at worst, mixed up diff'ing annotations can end up with an
		// unfaithful serialization of the edit.
		//
		// However, in cases where original content is not returned by the
		// client / RESTBase, selective serialization cannot proceed and
		// we're forced to fallback to normalizing the entire page.  This has
		// proved unacceptable to editors as is and, as we lean heavier on
		// selser, will only get worse over time.
		//
		// So, we're forced to trade off the correctness for usability.
		if ( $selserData->revHTML === null ) {
			$env->log( "warn/html2wt", "Missing selserData->revHTML. Regenerating." );

			// FIXME(T266838): Create a new Env for this parse?  Something is
			// needed to avoid this rigmarole.
			$topLevelDoc = $env->getTopLevelDoc();
			$env->setupTopLevelDoc();
			// This effectively parses $selserData->revText for us because
			// $selserData->revText = $env->getPageconfig()->getPageMainContent()
			$doc = $this->toDOM( $extApi );
			$env->setupTopLevelDoc( $topLevelDoc );
		} else {
			$doc = ContentUtils::createAndLoadDocument(
				$selserData->revHTML,
				[ 'markNew' => true, 'validateXMLNames' => true, ]
			);
		}

		$this->canonicalizeDOM( $env, $doc );
		$selserData->revDOM = $doc;
	}

	private function processIndicators( Document $doc, ParsoidExtensionAPI $extApi ): void {
		// Erroneous indicators without names will be <span>s
		$indicators = DOMCompat::querySelectorAll( $doc, 'meta[typeof~="mw:Extension/indicator"]' );
		$iData = [];

		// https://www.mediawiki.org/wiki/Help:Page_status_indicators#Adding_page_status_indicators
		// says that last one wins. But, that may just be documentation of the
		// implementation vs. being a deliberate strategy.
		//
		// The indicators are ordered by depth-first pre-order DOM traversal.
		// This ensures that the indicators are in document textual order.
		// Given that, the for-loop below implements "last-one-wins" semantics
		// for indicators that use the same name key.
		foreach ( $indicators as $meta ) {
			$dmw = DOMDataUtils::getDataMw( $meta );
			$name = $dmw->getExtAttrib( 'name' );
			$iData[$name] = $dmw->html;
		}

		// set indicator metadata for unique keys
		foreach ( $iData as $name => $html ) {
			$extApi->getMetadata()->setIndicator( (string)$name, $html );
		}
	}

	/**
	 * @inheritDoc
	 */
	public function toDOM(
		ParsoidExtensionAPI $extApi, ?SelectiveUpdateData $selectiveUpdateData = null
	): Document {
		$env = $this->env;
		$pipelineFactory = $env->getPipelineFactory();

		if ( $selectiveUpdateData ) {
			$doc = ContentUtils::createAndLoadDocument(
				$selectiveUpdateData->revHTML,
				[
					'markNew' => false, // !isSelectiveUpdate
					'validateXMLNames' => true,
				]
			);
			Assert::invariant(
				!DomPageBundle::isSingleDocument( $doc ),
				"toplevelDoc should not be a single-document page bundle"
			);
			$env->setupTopLevelDoc( $doc );
			$this->canonicalizeDOM( $env, $env->getTopLevelDoc() );
			$selectiveUpdateData->revDOM = $doc;
			$doc = $pipelineFactory->selectiveDOMUpdate( $selectiveUpdateData );
		} else {
			$doc = $pipelineFactory->parse(
				// @phan-suppress-next-line PhanDeprecatedFunction not ready for topFrame yet
				$env->getPageConfig()->getPageMainContent()
			);
		}

		// Hardcoded support for indicators
		// TODO: Eventually we'll want to apply this to selective updates as well
		if ( !$selectiveUpdateData ) {
			$this->processIndicators( $doc, $extApi );
		}

		Assert::invariant(
			DOMDataUtils::isPreparedAndLoaded( $doc ),
			"toDOM should return a prepared and loaded doc"
		);
		return $doc;
	}

	/**
	 * Preprocess the edited DOM as required before attempting to convert it to wikitext
	 * 1. The edited DOM (represented by body) might not be in canonical form
	 *    because Parsoid might be providing server-side management of global state
	 *    for extensions. To address this and bring the DOM back to canonical form,
	 *    we run extension-provided handlers. The original DOM isn't subject to this problem.
	 *    FIXME: But, this is not the only reason an extension might register a preprocessor.
	 *    How do we know when to run a preprocessor on both original & edited DOMs?
	 * 2. We need to do this after all data attributes have been loaded.
	 * 3. We need to do this before we run dom-diffs to eliminate spurious diffs.
	 *
	 * @param Env $env
	 * @param Document $doc
	 */
	private function preprocessEditedDOM( Env $env, Document $doc ): void {
		$siteConfig = $env->getSiteConfig();

		// Run any registered DOM preprocessors
		foreach ( $siteConfig->getExtDOMProcessors() as $extName => $domProcs ) {
			foreach ( $domProcs as $i => $classNameOrSpec ) {
				$c = $siteConfig->getObjectFactory()->createObject( $classNameOrSpec, [
					'allowClassName' => true,
					'assertClass' => ExtDOMProcessor::class,
				] );
				$c->htmlPreprocess(
					new ParsoidExtensionAPI( $env ), DOMCompat::getBody( $doc )
				);
			}
		}
	}

	/**
	 * @inheritDoc
	 */
	public function fromDOM(
		ParsoidExtensionAPI $extApi, ?SelectiveUpdateData $selserData = null
	): string {
		$env = $this->env;
		$siteConfig = $env->getSiteConfig();
		$setupTiming = Timing::start( $siteConfig );

		$this->canonicalizeDOM( $env, $env->getTopLevelDoc() );

		$serializerOpts = [ 'selserData' => $selserData ];
		if ( $selserData ) {
			$serializer = new SelectiveSerializer( $env, $serializerOpts );
			$this->setupSelser( $extApi, $selserData );
			$wtsType = 'selser';
		} else {
			// Fallback
			$serializer = new WikitextSerializer( $env, $serializerOpts );
			$wtsType = 'noselser';
		}

		$setupTiming->end( 'html2wt.setup', 'html2wt_setup_seconds', [] );

		$preprocTiming = Timing::start( $siteConfig );
		$this->preprocessEditedDOM( $env, $env->getTopLevelDoc() );
		$preprocTiming->end( 'html2wt.preprocess', 'html2wt_preprocess_seconds', [] );

		$serializeTiming = Timing::start( $siteConfig );
		$res = $serializer->serializeDOM( $env->getTopLevelDoc() );
		$serializeTiming->end(
			"html2wt.{$wtsType}.serialize",
			"html2wt_serialize_seconds",
			[ 'wts' => $wtsType ]
		);

		return $res;
	}

}
