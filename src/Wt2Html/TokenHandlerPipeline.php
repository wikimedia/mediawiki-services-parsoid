<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Generator;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\Profile;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Wt2Html\TT\LineBasedHandler;
use Wikimedia\Parsoid\Wt2Html\TT\LineBasedHandlerTraceProxy;
use Wikimedia\Parsoid\Wt2Html\TT\TokenHandler;
use Wikimedia\Parsoid\Wt2Html\TT\UniversalTokenHandler;
use Wikimedia\Parsoid\Wt2Html\TT\UniversalTokenHandlerTraceProxy;
use Wikimedia\Parsoid\Wt2Html\TT\XMLTagBasedHandler;
use Wikimedia\Parsoid\Wt2Html\TT\XMLTagBasedHandlerTraceProxy;

/**
 * Token transformation manager. Individual transformations
 * implement the TokenHandler interface. The parser pipeline
 * registers individual transformers.
 *
 * See https://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for more documentation.  This abstract class could eventually be
 * eliminated and the various token transforms just extend PipelineStage
 * directly.
 */
class TokenHandlerPipeline extends PipelineStage {
	/** @var array */
	private $options;

	/** @var string */
	private $traceType = "";

	/** @var bool */
	private $traceEnabled;

	/** @var TokenHandler[] */
	private $transformers = [];

	/** @var int|float For TraceProxy */
	public $tokenTimes = 0;

	/** @var Profile|null For TraceProxy */
	public $profile;

	/** @var bool */
	private $hasShuttleTokens = false;

	public function __construct(
		Env $env, array $options, string $stageId,
		?PipelineStage $prevStage = null
	) {
		parent::__construct( $env, $prevStage );
		$this->options = $options;
		$this->pipelineId = null;
		$this->traceType = 'thp:' . str_replace( 'TokenTransform', '', $stageId );
		$this->traceEnabled = $env->hasTraceFlags();
	}

	public function setPipelineId( int $id ): void {
		parent::setPipelineId( $id );
		foreach ( $this->transformers as $transformer ) {
			$transformer->setPipelineId( $id );
		}
	}

	public function getFrame(): Frame {
		return $this->frame;
	}

	public function getOptions(): array {
		return $this->options;
	}

	/**
	 * @inheritDoc
	 */
	public function addTransformer( TokenHandler $t ): void {
		if ( $this->traceEnabled ) {
			if ( $t instanceof XMLTagBasedHandler ) {
				$t = new XMLTagBasedHandlerTraceProxy( $this, $this->options, $this->traceType, $t );
			} elseif ( $t instanceof LineBasedHandler ) {
				$t = new LineBasedHandlerTraceProxy( $this, $this->options, $this->traceType, $t );
			} elseif ( $t instanceof UniversalTokenHandler ) {
				$t = new UniversalTokenHandlerTraceProxy( $this, $this->options, $this->traceType, $t );
			} else {
				throw new UnreachableException( "THP: Got unknown token handler type: " . get_class( $t ) );
			}
		}
		$this->transformers[] = $t;
	}

	public function shuttleTokensToEndOfStage( array $toks ): array {
		$this->hasShuttleTokens = true;
		$thpEnd = new SelfclosingTagTk( 'mw:thp-end' );
		$thpEnd->dataParsoid->getTemp()->shuttleTokens = $toks;
		return [ $thpEnd ];
	}

	/**
	 * Push the tokens through all the registered transformers.
	 * @inheritDoc
	 */
	public function processChunk( array $tokens ): ?array {
		// Trivial case
		if ( !$tokens ) {
			return $tokens;
		}

		$startTime = null;
		$profile = $this->profile = $this->env->profiling() ? $this->env->getCurrentProfile() : null;

		if ( $profile ) {
			$startTime = hrtime( true );
			$this->tokenTimes = 0;
		}

		foreach ( $this->transformers as $transformer ) {
			if ( !$transformer->isDisabled() ) {
				if ( !$tokens ) {
					break;
				}
				$tokens = $transformer->process( $tokens );
			}
		}

		// Unpack tokens that were shuttled to the end of the stage.  This happens
		// when we used a nested pipeline to process tokens to the end of the
		// current stage but then they need to be reinserted into the stream
		// and we don't want them to be processed by subsequent handlers again.
		if ( $this->hasShuttleTokens ) {
			$this->hasShuttleTokens = false;
			$accum = [];
			foreach ( $tokens as $i => $t ) {
				if ( $t instanceof SelfclosingTagTk && $t->getName() === 'mw:thp-end' ) {
					$toks = $t->dataParsoid->getTemp()->shuttleTokens;
					PHPUtils::pushArray( $accum, $toks );
				} else {
					$accum[] = $t;
				}
			}
			$tokens = $accum;
		}

		if ( $profile ) {
			$profile->bumpTimeUse( 'THP',
				hrtime( true ) - $startTime - $this->tokenTimes,
				'THP' );
		}

		return $tokens;
	}

	/**
	 * @inheritDoc
	 */
	public function resetState( array $options ): void {
		$this->hasShuttleTokens = false;
		parent::resetState( $options );
		foreach ( $this->transformers as $transformer ) {
			$transformer->resetState( $options );
		}
	}

	/**
	 * See PipelineStage::process docs as well. This doc block refines
	 * the generic arg types to be specific to this pipeline stage.
	 *
	 * Process a chunk of tokens.
	 *
	 * @param array $input Array of tokens to process
	 * @param array $options
	 *
	 * @return array Returns the array of processed tokens
	 */
	public function process( $input, array $options ): array {
		return $this->processChunk( $input );
	}

	/**
	 * @inheritDoc
	 */
	public function processChunkily( $input, array $options ): Generator {
		if ( $this->prevStage ) {
			foreach ( $this->prevStage->processChunkily( $input, $options ) as $chunk ) {
				'@phan-var array $chunk'; // @var array $chunk
				yield $this->processChunk( $chunk );
			}
		} else {
			yield $this->process( $input, $options );
		}
	}
}
