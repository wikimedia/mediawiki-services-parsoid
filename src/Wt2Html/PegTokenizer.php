<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\WikiPEG\SyntaxError;

/**
 * Tokenizer for wikitext, using WikiPEG and a
 * separate PEG grammar file (Grammar.pegphp)
 */
class PegTokenizer extends PipelineStage {
	private array $options;
	private array $offsets;
	/** @var Grammar|TracingGrammar|null */
	private $grammar = null;
	private bool $tracing;
	/**
	 * No need to retokenize identical strings
	 * Cache <src,startRule> --> token array.
	 * Expected benefits:
	 * - same expanded template source used multiple times on a page
	 * - convertToString calls
	 * - calls from TableFixups and elsewhere to tokenize* methods
	 */
	private TokenCache $cache;

	public function __construct(
		Env $env, array $options = [], string $stageId = "",
		?PipelineStage $prevStage = null
	) {
		parent::__construct( $env, $prevStage );
		$this->env = $env;
		$this->options = $options;
		$this->offsets = [];
		$this->tracing = $env->hasTraceFlag( 'grammar' );
		// Cache only on seeing the same source the second time.
		// This minimizes cache bloat & token cloning penalties.
		$this->cache = $this->env->getCache(
			"PegTokenizer",
			[ "repeatThreshold" => 1, "cloneValue" => true ]
		);
	}

	private function initGrammar(): void {
		if ( !$this->grammar ) {
			$this->grammar = $this->tracing ? new TracingGrammar : new Grammar;
		}
	}

	/**
	 * Get the constructor options.
	 *
	 * @internal
	 * @return array
	 */
	public function getOptions(): array {
		return $this->options;
	}

	/**
	 * Set start and end offsets of the source that generated this DOM.
	 *
	 * @param SourceRange $so
	 */
	public function setSourceOffsets( SourceRange $so ): void {
		$this->offsets['startOffset'] = $so->start;
		$this->offsets['endOffset'] = $so->end;
	}

	/**
	 * See PipelineStage::process docs as well. This doc block refines
	 * the generic arg types to be specific to this pipeline stage.
	 *
	 * @param string $input wikitext to tokenize
	 * @param array{sol:bool} $options
	 * - atTopLevel: (bool) Whether we are processing the top-level document
	 * - sol: (bool) Whether input should be processed in start-of-line context
	 *
	 * @return array|false The token array, or false for a syntax error
	 */
	public function process( $input, array $options ) {
		Assert::invariant( is_string( $input ), "Input should be a string" );
		return $this->tokenizeSync( $input, $options );
	}

	/**
	 * The text is tokenized in chunks (one per top-level block).
	 *
	 * @param string $input
	 * @param array{atTopLevel:bool,sol:bool} $options
	 *   - atTopLevel: (bool) Whether we are processing the top-level document
	 *   - sol (bool) Whether text should be processed in start-of-line context.
	 * @return Generator<list<Token|string>>
	 */
	public function processChunkily( $input, array $options ): Generator {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}

		Assert::invariant( is_string( $input ), "Input should be a string" );
		Assert::invariant( isset( $options['sol'] ), "Sol should be set" );

		// Kick it off!
		$pipelineOffset = $this->offsets['startOffset'] ?? 0;
		$args = [
			'env' => $this->env,
			'pipelineId' => $this->getPipelineId(),
			'pegTokenizer' => $this,
			'pipelineOffset' => $pipelineOffset,
			'sol' => $options['sol'],
			'stream' => true,
			'startRule' => 'start_async',
		];

		if ( $this->tracing ) {
			$args['tracer'] = new Tracer( $input );
		}

		// Wrap wikipeg's generator with our own generator
		// to track time usage.
		// @phan-suppress-next-line PhanTypeInvalidYieldFrom
		yield from $this->grammar->parse( $input, $args );
		yield [ new EOFTk() ];
	}

	/**
	 * Tokenize via a rule passed in as an arg.
	 * The text is tokenized synchronously in one shot.
	 *
	 * @param string $text
	 * @param array{sol:bool} $args
	 * - sol: (bool) Whether input should be processed in start-of-line context.
	 * - startRule: (string) which tokenizer rule to tokenize with
	 * @return array|false The token array, or false for a syntax error
	 */
	public function tokenizeSync( string $text, array $args ) {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}
		Assert::invariant( isset( $args['sol'] ), "Sol should be set" );
		$args += [
			'pegTokenizer' => $this,
			'pipelineId' => $this->getPipelineId(),
			'pipelineOffset' => $this->offsets['startOffset'] ?? 0,
			'startRule' => 'start',
			'env' => $this->env
		];

		// crc32 is much faster than md5 and since we are verifying a
		// $text match when reusing cache contents, hash collisions are okay.
		//
		// NOTE about inclusion of pipelineOffset in the cache key:
		// The PEG tokenizer returns tokens with offsets shifted by
		// $args['pipelineOffset'], so we cannot reuse tokens across
		// differing values of this option. If required, we could refactor
		// to move that and the logging code into this file.
		$cacheKey = crc32( $text ) .
			"|" . (int)$args['sol'] .
			"|" . $args['startRule'] .
			"|" . $args['pipelineOffset'];
		$res = $this->cache->lookup( $cacheKey, $text );
		if ( $res !== null ) {
			return $res;
		}

		if ( $this->tracing ) {
			$args['tracer'] = new Tracer( $text );
		}

		$start = null;
		$profile = null;
		if ( $this->env->profiling() ) {
			$profile = $this->env->getCurrentProfile();
			$start = hrtime( true );
		}

		try {
			$toks = $this->grammar->parse( $text, $args );
		} catch ( SyntaxError $e ) {
			return false;
		}

		if ( $profile ) {
			$profile->bumpTimeUse( 'PEG', hrtime( true ) - $start, 'PEG' );
		}

		if ( is_array( $toks ) ) {
			$this->cache->cache( $cacheKey, $toks, $text );
		}

		return $toks;
	}

	/**
	 * Tokenizes a string as a rule
	 *
	 * @param string $text The input text
	 * @param string $rule The rule name
	 * @param bool $sol Start of line flag
	 * @return array|false Array of tokens/strings or false on error
	 */
	public function tokenizeAs( string $text, string $rule, bool $sol ) {
		$args = [
			'startRule' => $rule,
			'sol' => $sol,
			'pipelineOffset' => 0
		];
		return $this->tokenizeSync( $text, $args );
	}

	/**
	 * Tokenize a URL.
	 * @param string $text
	 * @return array|false Array of tokens/strings or false on error
	 */
	public function tokenizeURL( string $text ) {
		return $this->tokenizeAs( $text, 'url', /* sol */true );
	}

	/**
	 * Tokenize table cell attributes.
	 * @param string $text
	 * @param bool $sol
	 * @return array|false Array of tokens/strings or false on error
	 */
	public function tokenizeTableCellAttributes( string $text, bool $sol ) {
		return $this->tokenizeAs( $text, 'row_syntax_table_args', $sol );
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $options ): void {
		TokenizerUtils::resetAnnotationIncludeRegex();
		if ( $this->grammar ) {
			$this->grammar->resetState();
		}
		parent::resetState( $options );
	}
}
