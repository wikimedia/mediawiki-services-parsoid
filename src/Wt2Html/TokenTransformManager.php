<?php

namespace Parsoid\Wt2Html;

use Generator;

use Parsoid\Config\Env;
use Parsoid\Wt2Html\TT\TokenHandler;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Title;

/**
 * Token transformation manager. Individual transformations
 * implement the TokenHandler interface. The parser pipeline
 * registers individual transformers.
 *
 * Could eventually be eliminated.
 */
class TokenTransformManager extends PipelineStage {
	/** @var array */
	private $options = null;

	/** @var int */
	private $stageId = -1;

	/** @var string */
	private $traceType = "";

	/** @var array */
	private $traceState = null;

	/** @var TokenHandler[] */
	private $transformers = [];

	/** @var Frame */
	private $frame = null;

	/**
	 * @param Env $env
	 * @param array $options
	 * @param int $stageId
	 * @param PipelineStage|null $prevStage
	 */
	public function __construct( Env $env, array $options, int $stageId, $prevStage = null ) {
		parent::__construct( $env, $prevStage );
		$this->options = $options;
		$this->stageId = $stageId;
		$this->traceType = 'trace/sync:' . $stageId;
		$this->pipelineId = null;

		// Compute tracing state
		$traceFlags = $env->traceFlags;
		$traceState = null;
		if ( $traceFlags ) {
			$traceState = [
				'tokenTimes' => 0,
				'traceFlags' => $traceFlags,
				'traceTime' => !empty( $traceFlags['time'] ),
				'tracer' => function ( $token, $transformer ) use ( $env ) {
					$env->log(
						$this->traceType, $this->pipelineId, get_class( $transformer ),
						PHPUtils::jsonEncode( $token )
					);
				},
			];
		}
	}

	/**
	 * @inheritDoc
	 */
	public function addTransformer( TokenHandler $t ): void {
		$this->transformers[] = $t;
	}

	/**
	 * Get this manager's tracing state object
	 * @return array|null
	 */
	public function getTraceState(): ?array {
		return $this->traceState;
	}

	/**
	 * Push the tokens through all the registered transformers.
	 * @inheritDoc
	 */
	public function processChunk( array $tokens ): ?array {
		// Trivial case
		if ( count( $tokens ) === 0 ) {
			return $tokens;
		}

		$startTime = null;
		if ( isset( $this->traceState['traceTime'] ) ) {
			$startTime = PHPUtils::getStartHRTime();
		}

		foreach ( $this->transformers as $transformer ) {
			if ( !$transformer->isDisabled() ) {
				if ( count( $tokens ) === 0 ) {
					break;
				}
				if ( $this->traceState ) {
					$this->traceState['transformer'] = get_class( $transformer );
				}

				$tokens = $transformer->process( $tokens );
			}
		}

		if ( isset( $this->traceState['traceTime'] ) ) {
			$this->env->bumpTimeUse( 'SyncTTM',
				( PHPUtils::getStartHRTime() - $startTime - $this->traceState['tokenTimes'] ),
				'TTM' );
		}

		return $tokens;
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $opts ): void {
		foreach ( $this->transformers as $transformer ) {
			$transformer->resetState( $opts );
		}
	}

	/**
	 * @inheritDoc
	 */
	public function setSourceOffsets( int $start, int $end ): void {
		foreach ( $this->transformers as $transformer ) {
			$transformer->setSourceOffsets( $start, $end );
		}
	}

	/**
	 * @inheritDoc
	 */
	public function setFrame( ?Frame $parentFrame, ?Title $title, array $args ): void {
		/**
		 * Commented out till Frame is ported
		 *
		// now actually set up the frame
		if ( !$parentFrame ) {
			$this->frame = new Frame( $title, $this, $args );
		} elseif ( !$title ) {
			// attribute, simply reuse the parent frame
			$this->frame = $parentFrame;
		} else {
			$this->frame = $parentFrame->newChild( $title, $this, $args );
		}
		*/
	}

	/**
	 * Process a chunk of tokens.
	 *
	 * @param array $tokens Array of tokens to process
	 * @param array|null $opts
	 * @return array Returns the array of processed tokens
	 */
	public function process( $tokens, array $opts = null ): array {
		'@phan-var array $tokens'; // @var array $tokens
		return $this->processChunk( $tokens );
	}

	/**
	 * @inheritDoc
	 */
	public function processChunkily( $input, array $opts = null ): Generator {
		if ( $this->prevStage ) {
			foreach ( $this->prevStage->processChunkily( $input, $opts ) as $chunk ) {
				'@phan-var array $chunk'; // @var array $chunk
				yield $this->processChunk( $chunk );
			}
		} else {
			yield $this->process( $input, $opts );
		}
	}
}
