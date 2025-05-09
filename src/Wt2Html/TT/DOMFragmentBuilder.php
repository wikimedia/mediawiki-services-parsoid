<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

class DOMFragmentBuilder extends XMLTagBasedHandler {
	/**
	 * @param TokenHandlerPipeline $manager manager environment
	 * @param array $options options
	 */
	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	/**
	 * Can/should content represented in 'toks' be processed in its own DOM scope?
	 * 1. No reason to spin up a new pipeline for plain text
	 * 2. In some cases, if templates need not be nested entirely within the
	 *    boundary of the token, we cannot process the contents in a new scope.
	 * @param array $toks
	 * @param Token $contextTok
	 * @return bool
	 */
	private function processContentInOwnPipeline( array $toks, Token $contextTok ): bool {
		$linkContext = (
			$contextTok instanceof XMLTagTk &&
			( $contextTok->getName() === 'wikilink' || $contextTok->getName() === 'extlink' )
		);

		// For wikilinks and extlinks, templates should be properly nested
		// in the content section. So, we can process them in sub-pipelines.
		// But, for other context-toks, we should back out. FIXME: Can be smarter and
		// detect proper template nesting, but, that can be a later enhancement
		// when dom-scope-tokens are used in other contexts.
		Assert::invariant( $linkContext, 'A link context is assumed.' );

		foreach ( $toks as $t ) {
			if ( $t instanceof XMLTagTk ) {
				// Since we encountered a complex token, we'll process this
				// in a subpipeline.
				return true;
			}
		}

		// No complex tokens at all -- no need to spin up a new pipeline
		return false;
	}

	/**
	 * @return array<string|Token>
	 */
	private function buildDOMFragment( Token $scopeToken ): array {
		$contentKV = $scopeToken->getAttributeKV( 'content' );
		$content = $contentKV->v;
		if (
			is_string( $content ) || !$this->processContentInOwnPipeline(
				$content, $scopeToken->getAttributeV( 'contextTok' )
			)
		) {
			// New pipeline not needed. Pass them through
			return is_string( $content ) ? [ $content ] : $content;
		} else {
			// Source offsets of content
			$srcOffsets = $contentKV->srcOffsets;

			// Without source offsets for the content, it isn't possible to
			// compute DSR and template wrapping in content. So, users of
			// mw:dom-fragment-token should always set offsets on content
			// that comes from the top-level document.
			Assert::invariant(
				$this->options['inTemplate'] || (bool)$srcOffsets,
				'Processing top-level content without source offsets'
			);

			$pipelineOpts = [
				'inlineContext' => $scopeToken->getAttributeV( 'inlineContext' ) === "1",
				'expandTemplates' => $this->options['expandTemplates'],
				'inTemplate' => $this->options['inTemplate']
			];

			// Append EOF
			$content[] = new EOFTk();

			// Process tokens
			$domFragment = PipelineUtils::processContentInPipeline(
				$this->env,
				$this->manager->getFrame(),
				// Append EOF
				$content,
				[
					'pipelineType' => 'expanded-tokens-to-fragment',
					'pipelineOpts' => $pipelineOpts,
					'srcOffsets' => $srcOffsets->value,
					'sol' => true
				]
			);

			return PipelineUtils::tunnelDOMThroughTokens(
				$this->env,
				$scopeToken,
				$domFragment,
				[ "pipelineOpts" => $pipelineOpts ]
			);
		}
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( XMLTagTk $token ): ?array {
		return $token->getName() === 'mw:dom-fragment-token' ?
			$this->buildDOMFragment( $token ) : null;
	}
}
