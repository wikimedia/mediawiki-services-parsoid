<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\Source;
use Wikimedia\Parsoid\Core\SourceString;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\WikiPEG\SyntaxError;

/**
 * Tokenizer for wikitext, using WikiPEG and a
 * separate PEG grammar file (Grammar.pegphp)
 */
class PegTokenizer extends PipelineStage {
	private array $options;
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
	private PipelineContentCache $cache;

	public function __construct( Env $env, array $options = [], string $stageId = "" ) {
		parent::__construct( $env );
		$this->env = $env;
		$this->options = $options;
		$this->tracing = $env->hasTraceFlag( 'grammar' ) ||
			// Allow substitution of a custom tracer for unit testing
			isset( $options['tracer'] );
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

	public function getFrame(): Frame {
		return $this->frame ?? $this->env->topFrame;
	}

	/**
	 * See PipelineStage::process docs as well. This doc block refines
	 * the generic arg types to be specific to this pipeline stage.
	 *
	 * @param string|array|DocumentFragment|Element $input
	 *   Wikitext to tokenize. In practice this should be a string.
	 * @param array{sol:bool} $options
	 * - atTopLevel: (bool) Whether we are processing the top-level document
	 * - sol: (bool) Whether input should be processed in start-of-line context
	 *
	 * @return array The token array
	 * @throws SyntaxError
	 */
	public function process(
		string|array|DocumentFragment|Element $input,
		array $options
	): array|Element|DocumentFragment {
		Assert::invariant( is_string( $input ), "Input should be a string" );
		$result = $this->tokenizeSync( $input, $options, $exception );
		if ( $result === false ) {
			// Should never happen.
			throw $exception;
		}

		// Downstream stages expect EOFTk at the end of the token stream.
		$result[] = new EOFTk();
		return $result;
	}

	/**
	 * The text is tokenized in chunks (one per top-level block).
	 *
	 * @param string|array|DocumentFragment|Element $input
	 *   Wikitext to tokenize. In practice this should be a string.
	 * @param array{atTopLevel:bool,sol:bool} $options
	 *   - atTopLevel: (bool) Whether we are processing the top-level document
	 *   - sol (bool) Whether text should be processed in start-of-line context.
	 * @return Generator<list<Token|string>>
	 */
	public function processChunkily(
		string|array|DocumentFragment|Element $input,
		array $options
	): Generator {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}

		Assert::invariant( is_string( $input ), "Input should be a string" );
		Assert::invariant( isset( $options['sol'] ), "Sol should be set" );

		// Kick it off!
		$args = [
			'env' => $this->env,
			'pipelineId' => $this->getPipelineId(),
			'pegTokenizer' => $this,
			'pipelineOffset' => $this->srcOffsets->start ?? 0,
			'source' => $this->srcOffsets->source,
			'sol' => $options['sol'],
			'stream' => true,
			'startRule' => 'start_async',
		];

		if ( $this->tracing ) {
			$args['tracer'] = $this->options['tracer'] ?? new Tracer( $input );
		}

		foreach ( $this->onlyIncludeOffsets( $input, $args ) as [ $start, $end ] ) {
			$piece = substr( $input, $start, $end - $start );
			// Wrap wikipeg's generator with our own generator
			// to track time usage.
			// @phan-suppress-next-line PhanTypeInvalidYieldFrom
			yield from $this->grammar->parse( $piece, [
				'pipelineOffset' => $args['pipelineOffset'] + $start,
			] + $args );
		}
	}

	/**
	 * Provide the offsets into $input needed for <onlyinclude> processing
	 * if `inTemplate` mode.  Otherwise just return the start and end
	 * of the string.
	 */
	private function onlyIncludeOffsets( string $input, array $args ): array {
		// Handle <onlyinclude>
		if (
			( $this->options['inTemplate'] ?? false ) &&
			str_contains( $input, '<onlyinclude>' ) &&
			str_contains( $input, '</onlyinclude>' )
		) {
			try {
				return $this->grammar->parse( $input, [
					'stream' => false,
					'startRule' => 'preproc_find_only_include',
					'pipelineOffset' => 0,
				] + $args );
			} catch ( SyntaxError ) {
				/* ignore, fall through to process the whole input */
				$this->env->log( 'warn', "Couldn't extract <onlyinclude>" );
			}
		}
		return [ [ 0, strlen( $input ) ] ];
	}

	/**
	 * @inheritDoc
	 */
	public function finalize(): Generator {
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
	 * @param SyntaxError|null &$exception a syntax error, if thrown.
	 * @return array|false The token array, or false for a syntax error
	 */
	public function tokenizeSync( string $text, array $args, &$exception = null ) {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}
		Assert::invariant( isset( $args['sol'] ), "Sol should be set" );
		$args += [
			'pegTokenizer' => $this,
			'pipelineId' => $this->getPipelineId(),
			'pipelineOffset' => $this->srcOffsets->start ?? 0,
			'source' => $this->srcOffsets->source ?? null,
			'startRule' => 'start',
			'env' => $this->env
		];
		Assert::invariant( $args['startRule'] !== null, 'null start rule' );
		Assert::invariant( !( $args['stream'] ?? false ), 'synchronous parse' );

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
			"|" . $args['pipelineOffset'] .
			"|" . ( $args['source'] ? spl_object_id( $args['source'] ) : "" ) .
			"|" . ( $this->options['enableOnlyInclude'] ?? false );
		$res = $this->cache->lookup( $cacheKey, $text );
		if ( $res !== null ) {
			return $res;
		}

		if ( $this->tracing ) {
			$args['tracer'] = $this->options['tracer'] ?? new Tracer( $text );
		}

		$start = null;
		$profile = null;
		if ( $this->env->profiling() ) {
			$profile = $this->env->getCurrentProfile();
			$start = hrtime( true );
		}

		try {
			if ( $this->options['enableOnlyInclude'] ?? false ) {
				$toks = [];
				foreach ( $this->onlyIncludeOffsets( $text, $args ) as [ $start, $end ] ) {
					$piece = substr( $text, $start, $end - $start );
					$result = $this->grammar->parse( $piece, [
						'pipelineOffset' => $args['pipelineOffset'] + $start,
					] + $args );
					if ( !is_array( $result ) ) {
						$result = [ $result ];
					}
					// The 'start' and 'start_async' rules manually call
					// ::shiftTokenTSR before returning tokens.  For all
					// others, we still need to perform the shift by the
					// requested $args['pipelineOffset'].
					if ( $args['startRule'] !== 'start' ) {
						TokenUtils::shiftTokenTSR(
							$result, $args['pipelineOffset'] + $start
						);
					}
					PHPUtils::pushArray( $toks, $result );
				}
			} else {
				$toks = $this->grammar->parse( $text, $args );
				// The 'start' and 'start_async' rules manually call
				// ::shiftTokenTSR before returning tokens.  For all
				// others, we still need to perform the shift by the
				// requested $args['pipelineOffset'].
				if ( $args['startRule'] !== 'start' ) {
					TokenUtils::shiftTokenTSR(
						is_array( $toks ) ? $toks : [ $toks ], $args['pipelineOffset']
					);
				}
			}
		} catch ( SyntaxError $e ) {
			$exception = $e;
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
	 * @param string|Source $text The input text
	 * @param string $rule The rule name
	 * @param bool $sol Start of line flag
	 * @return array|false Array of tokens/strings or false on error
	 */
	public function tokenizeAs( string|Source $text, string $rule, bool $sol ) {
		if ( $text instanceof Source ) {
			$source = $text;
			$text = $source->getSrcText();
		} else {
			// XXX T405759 Should probably take a SourceRange to allow
			// tokenizing substrings of the original source.
			$source = new SourceString( $text );
		}
		$args = [
			'startRule' => $rule,
			'sol' => $sol,
			'pipelineOffset' => 0,
			'source' => $source,
		];
		return $this->tokenizeSync( $text, $args );
	}

	/**
	 * Tokenize a URL.
	 * @param string $text
	 * @return array|false Array of tokens/strings or false on error
	 */
	public function tokenizeURL( string $text ) {
		// XXX T405759 This returns tokens with a unique (not top-level)
		// source in the TSR; if this is retokenizing part of the top-level
		// source this should pass srcOffsets.
		return $this->tokenizeAs( $text, 'url', /* sol */true );
	}

	/**
	 * Tokenize table cell attributes.
	 * @param string $text
	 * @param bool $sol
	 * @return array|false Array of tokens/strings or false on error
	 */
	public function tokenizeTableCellAttributes( string $text, bool $sol ) {
		// XXX T405759 This returns tokens with a unique (not top-level)
		// source in the TSR; if this is retokenizing part of the top-level
		// source this should pass srcOffsets.
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
