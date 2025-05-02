<?php
declare( strict_types = 1 );

/**
 * Tokenizer for wikitext, using WikiPEG and a
 * separate PEG grammar file
 * (Grammar.pegphp)
 *
 * Use along with a {@link Wt2Html/TreeBuilder/TreeBuilderStage} and the
 * {@link DOMProcessorPipeline}(s) for HTML output.
 */

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\WikiPEG\SyntaxError;

class PegTokenizer extends PipelineStage {
	/**
	 * Cache <src,startRule> --> token array.
	 * No need to retokenize identical strings
	 * Expected benefits:
	 * - same expanded template source used multiple times on a page
	 * - convertToString calls
	 * - calls from TableFixups and elsewhere to tokenize* methods
	 */
	private static array $cache = [];
	/**
	 * Track how often a tokenizer string is seen -- can be used
	 * to reduce caching overheads by only caching on the second
	 * occurence.
	 * @var array<string,int>
	 */
	private static array $sourceCounts = [];

	private array $options;
	private array $offsets;
	private ?SyntaxError $lastError = null;
	/** @var Grammar|TracingGrammar|null */
	private $grammar = null;
	private bool $tracing;

	public function __construct(
		Env $env, array $options = [], string $stageId = "",
		?PipelineStage $prevStage = null
	) {
		parent::__construct( $env, $prevStage );
		$this->env = $env;
		$this->options = $options;
		$this->offsets = [];
		$this->tracing = $env->hasTraceFlag( 'grammar' );
	}

	private function initGrammar() {
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
	 * @param array{sol:bool} $opts
	 * - atTopLevel: (bool) Whether we are processing the top-level document
	 * - sol: (bool) Whether input should be processed in start-of-line context
	 * @return array|false The token array, or false for a syntax error
	 */
	public function process( $input, array $opts ) {
		Assert::invariant( is_string( $input ), "Input should be a string" );
		return $this->tokenizeSync( $input, $opts );
	}

	/**
	 * The text is tokenized in chunks (one per top-level block)
	 * and registered event listeners are called with the chunk
	 * to let it get processed further.
	 *
	 * The main worker. Sets up event emission ('chunk' and 'end' events).
	 * Consumers are supposed to register with PegTokenizer before calling
	 * process().
	 *
	 * @param string $text
	 * @param array{sol:bool} $opts
	 *   - sol (bool) Whether text should be processed in start-of-line context.
	 * @return Generator
	 */
	public function processChunkily( $text, array $opts ): Generator {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}

		Assert::invariant( is_string( $text ), "Input should be a string" );
		Assert::invariant( isset( $opts['sol'] ), "Sol should be set" );

		// Kick it off!
		$pipelineOffset = $this->offsets['startOffset'] ?? 0;
		$args = [
			'env' => $this->env,
			'pipelineId' => $this->getPipelineId(),
			'pegTokenizer' => $this,
			'pipelineOffset' => $pipelineOffset,
			'sol' => $opts['sol'],
			'stream' => true,
			'startRule' => 'start_async',
		];

		if ( $this->tracing ) {
			$args['tracer'] = new Tracer( $text );
		}

		try {
			// Wrap wikipeg's generator with our own generator
			// to catch exceptions and track time usage.
			// @phan-suppress-next-line PhanTypeInvalidYieldFrom
			yield from $this->grammar->parse( $text, $args );
			yield [ new EOFTk() ];
		} catch ( SyntaxError $e ) {
			$this->lastError = $e;
			throw $e;
		}
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

		if ( $this->tracing ) {
			$args['tracer'] = new Tracer( $text );
		}

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
		$cachedOutput = self::$cache[$cacheKey] ?? null;
		if ( $cachedOutput && $cachedOutput['text'] === $text ) {
			$res = Utils::cloneArray( $cachedOutput['tokens'] );
			return $res;
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
			$this->lastError = $e;
			return false;
		}

		if ( $profile ) {
			$profile->bumpTimeUse( 'PEG', hrtime( true ) - $start, 'PEG' );
		}

		self::$sourceCounts[$cacheKey] = ( self::$sourceCounts[$cacheKey] ?? 0 ) + 1;
		if ( is_array( $toks ) && self::$sourceCounts[$cacheKey] > 1 ) {
			self::$cache[$cacheKey] = [
				'text' => $text,
				'tokens' => Utils::cloneArray( $toks )
			];
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
	 * If a tokenize method returned false, this will return a string describing the error,
	 * suitable for use in a log entry. If there has not been any error, returns false.
	 *
	 * @return string|false
	 */
	public function getLastErrorLogMessage() {
		if ( $this->lastError ) {
			return "Tokenizer parse error at input location {$this->lastError->location}: " .
				$this->lastError->getMessage();
		} else {
			return false;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $opts ): void {
		TokenizerUtils::resetAnnotationIncludeRegex();
		if ( $this->grammar ) {
			$this->grammar->resetState();
		}
		parent::resetState( $opts );
	}
}
