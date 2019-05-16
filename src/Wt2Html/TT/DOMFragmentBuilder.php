<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\TokenHandler as TokenHandler;
use Parsoid\PipelineUtils as PipelineUtils;
use Parsoid\TagTk as TagTk;
use Parsoid\EOFTk as EOFTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\EndTagTk as EndTagTk;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class DOMFragmentBuilder extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->manager->addTransform(
			function ( $scopeToken, $cb ) {return $this->buildDOMFragment( $scopeToken, $cb );
   },
			'buildDOMFragment',
			self::scopeRank(),
			'tag',
			'mw:dom-fragment-token'
		);
	}

	public static function scopeRank() {
 return 1.99;
 }

	/**
		* Can/should content represented in 'toks' be processed in its own DOM scope?
	 * 1. No reason to spin up a new pipeline for plain text
	 * 2. In some cases, if templates need not be nested entirely within the
	 *    boundary of the token, we cannot process the contents in a new scope.
	 */
	public function subpipelineUnnecessary( $toks, $contextTok ) {
		for ( $i = 0,  $n = count( $toks );  $i < $n;  $i++ ) {
			$t = $toks[ $i ];
			$tc = $t->constructor;

			// For wikilinks and extlinks, templates should be properly nested
			// in the content section. So, we can process them in sub-pipelines.
			// But, for other context-toks, we back out. FIXME: Can be smarter and
			// detect proper template nesting, but, that can be a later enhancement
			// when dom-scope-tokens are used in other contexts.
			if ( $contextTok && $contextTok->name !== 'wikilink' && $contextTok->name !== 'extlink'
&& $tc === SelfclosingTagTk::class
&& $t->name === 'meta' && $t->getAttribute( 'typeof' ) === 'mw:Transclusion'
			) {
				return true;
			} elseif ( $tc === TagTk::class || $tc === EndTagTk::class || $tc === SelfclosingTagTk::class ) {
				// Since we encountered a complex token, we'll process this
				// in a subpipeline.
				return false;
			}
		}

		// No complex tokens at all -- no need to spin up a new pipeline
		return true;
	}

	public function buildDOMFragment( $scopeToken, $cb ) {
		$content = $scopeToken->getAttribute( 'content' );
		if ( $this->subpipelineUnnecessary( $content, $scopeToken->getAttribute( 'contextTok' ) ) ) {
			// New pipeline not needed. Pass them through
			$cb( [ 'tokens' => ( gettype( $content ) === 'string' ) ? [ $content ] : $content, 'async' => false ] );
		} else {
			// First thing, signal that the results will be available asynchronously
			$cb( [ 'async' => true ] );

			// Source offsets of content
			$srcOffsets = $scopeToken->getAttribute( 'srcOffsets' );

			// Without source offsets for the content, it isn't possible to
			// compute DSR and template wrapping in content. So, users of
			// mw:dom-fragment-token should always set offsets on content
			// that comes from the top-level document.
			Assert::invariant(
				$this->options->inTemplate || (bool)$srcOffsets,
				'Processing top-level content without source offsets'
			);

			$pipelineOpts = [
				'inlineContext' => $scopeToken->getAttribute( 'inlineContext' ),
				'inPHPBlock' => $scopeToken->getAttribute( 'inPHPBlock' ),
				'expandTemplates' => $this->options->expandTemplates,
				'inTemplate' => $this->options->inTemplate
			];

			// Process tokens
			PipelineUtils::processContentInPipeline(
				$this->manager->env,
				$this->manager->frame,
				// Append EOF
				$content->concat( [ new EOFTk() ] ),
				[
					'pipelineType' => 'tokens/x-mediawiki/expanded',
					'pipelineOpts' => $pipelineOpts,
					'srcOffsets' => $srcOffsets,
					'documentCB' => function ( $dom ) use ( &$cb, &$scopeToken, &$pipelineOpts ) {return $this->wrapDOMFragment( $cb, $scopeToken, $pipelineOpts, $dom );
		   },
					'sol' => true
				]
			);
		}
	}

	public function wrapDOMFragment( $cb, $scopeToken, $pipelineOpts, $dom ) {
		// Pass through pipeline options
		$toks = PipelineUtils::tunnelDOMThroughTokens( $this->manager->env, $scopeToken, $dom->body, [
				'pipelineOpts' => $pipelineOpts
			]
		);

		// Nothing more to send cb after this
		$cb( [ 'tokens' => $toks, 'async' => false ] );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->DOMFragmentBuilder = $DOMFragmentBuilder;
}
