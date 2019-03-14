<?php
/**
 * Tokenizer for wikitext, using WikiPEG and a
 * separate PEG grammar file
 * (Grammar.pegphp)
 *
 * Use along with a {@link module:wt2html/HTML5TreeBuilder} and the
 * {@link DOMPostProcessor}(s) for HTML output.
 * @module
 */

// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic
// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingParamTag
// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingReturn

declare( strict_types = 1 );

namespace Parsoid\Wt2Html;

use Parsoid\Config\Env;
use Parsoid\Utils\EventEmitter;
use Parsoid\Utils\PHPUtils;

class PegTokenizer extends EventEmitter {
	private $env;
	private $traceTime;
	private $options;
	private $offsets;

	/** @var Grammar */
	private $grammar;

	public function __construct( Env $env, array $options = [] ) {
		$this->env = $env;
		// env can be null during code linting
		$traceFlags = $env ? $env->traceFlags : [];
		$this->traceTime = isset( $traceFlags['time'] );
		$this->options = $options;
		$this->offsets = [];
	}

	private function initGrammar() {
		if ( !$this->grammar ) {
			$this->grammar = new Grammar;
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
	 * Process text.  The text is tokenized in chunks and control
	 * is yielded to the event loop after each top-level block is
	 * tokenized enabling the tokenized chunks to be processed at
	 * the earliest possible opportunity.
	 *
	 * @param string $text
	 * @param bool $sol Whether text should be processed in start-of-line
	 *   context.
	 */
	public function process( string $text, bool $sol ): void {
		$this->tokenizeAsync( $text, $sol );
	}

	/**
	 * Debugging aid: Set pipeline id.
	 */
	public function setPipelineId( $id ): void {
		$this->pipelineId = $id;
	}

	/**
	 * Set start and end offsets of the source that generated this DOM.
	 *
	 * @param int $start
	 * @param int $end
	 */
	public function setSourceOffsets( int $start = 0, int $end = 0 ): void {
		$this->offsets['startOffset'] = $start;
		$this->offsets['endOffset'] = $end;
	}

	/**
	 * The main worker. Sets up event emission ('chunk' and 'end' events).
	 * Consumers are supposed to register with PegTokenizer before calling
	 * process().
	 *
	 * @param string $text
	 * @param bool $sol Whether text should be processed in start-of-line
	 *   context.
	 */
	public function tokenizeAsync( string $text, bool $sol ): void {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}

		// ensure we're processing text
		$text = strval( $text );

		$chunkCB = function ( $tokens ) {
			$this->emit( 'chunk', $tokens );
		};

		// Kick it off!
		$pipelineOffset = $this->offsets['startOffset'] ?? 0;
		$args = [
			'cb' => $chunkCB,
			'pegTokenizer' => $this,
			'pipelineOffset' => $pipelineOffset,
			'sol' => $sol
		];

		$args['startRule'] = 'start_async';
		$args['stream'] = true;

		$start = null;
		if ( $this->traceTime ) {
			$start = PHPUtils::getStartHRTime();
		}
		// phpcs:ignore
		foreach ( $this->grammar->parse( $text, $args ) as $unused );
		if ( $this->traceTime ) {
			$this->env->bumpTimeUse( 'PEG-async', PHPUtils::getHRTimeDifferential( $start ),
				'PEG' );
		}
	}

	public function onEnd(): void {
		// Reset source offsets
		$this->setSourceOffsets();
		$this->emit( 'end' );
	}

	/**
	 * Tokenize via a rule passed in as an arg.
	 * The text is tokenized synchronously in one shot.
	 *
	 * @param string $text
	 * @param array $args
	 * @return array
	 */
	public function tokenizeSync( string $text, array $args = [] ): array {
		if ( !$this->grammar ) {
			$this->initGrammar();
		}
		$toks = [];
		$args += [
			// Some rules use callbacks: start, tlb, toplevelblock.
			// All other rules return tokens directly.
			'cb' => function ( $r ) use ( &$toks ) {
				PHPUtils::pushArray( $toks, $r );
			},
			'pegTokenizer' => $this,
			'pipelineOffset' => $this->offsets['startOffset'] ?? 0,
			'startRule' => 'start',
			'sol' => true
		];
		$start = null;
		if ( $this->traceTime ) {
			$start = PHPUtils::getStartHRTime();
		}
		$retToks = $this->grammar->parse( $text, $args );
		if ( $this->traceTime ) {
			$this->env->bumpTimeUse( 'PEG-sync', PHPUtils::getHRTimeDifferential( $start ), 'PEG' );
		}
		if ( is_array( $retToks ) && count( $retToks ) > 0 ) {
			PHPUtils::pushArray( $toks, $retToks );
		}
		return $toks;
	}

	/**
	 * Tokenizes a string as a rule, otherwise returns an `Error`
	 */
	public function tokenizeAs( string $text, string $rule, bool $sol ): array {
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
	 * @return array
	 */
	public function tokenizesAsURL( string $text ): array {
		return $this->tokenizeAs( $text, 'url', /* sol */true );
	}

	/**
	 * Tokenize an extlink.
	 * @param string $text
	 * @param bool $sol
	 * @return array
	 */
	public function tokenizeExtlink( string $text, bool $sol ): array {
		return $this->tokenizeAs( $text, 'extlink', $sol );
	}

	/**
	 * Tokenize table cell attributes.
	 * @param string $text
	 * @param bool $sol
	 * @return array
	 */
	public function tokenizeTableCellAttributes( string $text, bool $sol ) {
		return $this->tokenizeAs( $text, 'row_syntax_table_args', $sol );
	}
}
