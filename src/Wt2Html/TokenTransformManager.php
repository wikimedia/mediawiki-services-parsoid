<?php
/**
 * Token transformation manager. Individual transformations
 * implement the TokenHandler interface. The parser pipeline
 * registers individual transformers.
 *
 * See https://www.mediawiki.org/wiki/Parsoid/Token_stream_transformations
 * for more documentation.
 */

namespace Parsoid\Wt2Html;

use Parsoid\Config\Env;
use Parsoid\Utils\EventEmitter;
use Parsoid\Utils\PHPUtils;
use Parsoid\Tokens\Token;
use Parsoid\Wt2Html\TT\TokenHandler;

/**
 * Base class for token transform managers.
 */
class TokenTransformManager extends EventEmitter {
	/** @var array */
	private $options = null;
	/** @var int */
	private $phaseEndRank = -1;
	/** @var string */
	private $attributeType = "";
	/** @var string */
	private $traceType = "";
	/** @var array */
	private $traceNames = null;
	/** @var array */
	private $transformers = [];

	/** @var Env */
	public $env = null;
	/** @var int */
	public $pipelineId = -1;

	/**
	 * @param Env $env
	 * @param array $options
	 * @param object $pipeFactory
	 * @param int $phaseEndRank
	 * @param string $attributeType
	 */
	public function __construct( Env $env,
		array $options,
		$pipeFactory,
		int $phaseEndRank,
		string $attributeType
	) {
		$this->env = $env;
		$this->options = $options;
		$this->phaseEndRank = $phaseEndRank;
		$this->attributeType = $attributeType;
		$this->traceType = 'trace/sync:' . $phaseEndRank;
		$this->pipelineId = null;
	}

	/**
	 * Get this manager's env
	 * @return Env
	 */
	public function getEnv(): Env {
		return $this->env;
	}

	/**
	 * Add a new transformer (in order) to this transform manager
	 * @param TokenHandler $transformer
	 */
	public function addTransformer( TokenHandler $transformer ): void {
		$this->transformers[] = $transformer;
	}

	/**
	 * Register to a token source, normally the tokenizer.
	 * The event emitter emits a 'chunk' event with a chunk of tokens,
	 * and signals the end of tokens by triggering the 'end' event.
	 *
	 * @param EventEmitter $tokenEmitter Token event emitter.
	 */
	public function addListenersOn( $tokenEmitter ) {
		$tokenEmitter->addListener( 'chunk', [ $this, 'onChunk' ] );
		$tokenEmitter->addListener( 'end', [ $this, 'onEndEvent' ] );
	}

	/**
	 * Debugging aid: set pipeline id
	 * @param int $id
	 */
	public function setPipelineId( int $id ): void {
		$this->pipelineId = $id;
	}

	/**
	 * Reset pipeline state
	 * @param array $opts
	 */
	public function resetState( array $opts ): void {
		foreach ( $this->transformers as $transformer ) {
			$transformer->resetState( $opts );
		}
	}

	/**
	 * @param Token[] $tokens
	 */
	public function process( array $tokens ): void {
		$this->onChunk( $tokens );
		$this->onEndEvent();
	}

	/** @private */
	private function generateTest( $transformer, $token, $res ) {
		throw new \BadMethodCallException( "Not ported yet" );
		/*
		$generateFlags = $this->env->conf->parsoid->generateFlags;
		$handlerName = $generateFlags->handler;
		if ( $handlerName && $handlerName === $transformer->constructor->name ) {
			$streamHandle = $generateFlags->streamHandle;
			if ( $streamHandle === null ) {
				// create token transformer/handler test file here to retain
				// the WriteStream object type in testStream
				$streamHandle = fs::createWriteStream( $generateFlags->fileName );
				if ( $streamHandle ) {
					$generateFlags = Object::assign( $generateFlags, [ 'streamHandle' => $streamHandle ] );
				} else {
					Assert::invariant( false,
						'--genTest option unable to create output file [' . $generateFlags->fileName . "]\n" );
				}
			}
			// CHECK THIS
			$resultString = array_slice(
				$this->pipelineId . '-gen/' . $handlerName . ' '->repeat( 20 ), 0, 27 );
			$inputToken = $resultString . ' | IN  | ' . json_encode( $token ) . "\n";
			$streamHandle->write( $inputToken );
			if ( ( $res === $token ) || $res->tokens ) {
				$outputTokens = $resultString . ' | OUT | ' . json_encode( $res->tokens || [ $res ] ) . "\n";
				$streamHandle->write( $outputTokens );
			}
		}
		*/
	}

	private function computeTraceNames() {
		$this->traceNames = [];
		foreach ( $this->transformers as $transformer ) {
			$baseName = get_class( $transformer ) . ':';
			$this->traceNames[] = [
				$baseName . 'onNewline',
				$baseName . 'onEnd',
				$baseName . 'onTag',
				$baseName . 'onAny'
			];
		}
	}

	/**
	 * Global in-order and synchronous traversal on token stream. Emits
	 * transformed chunks of tokens in the 'chunk' event.
	 *
	 * @param Token[] $tokens
	 */
	public function onChunk( array $tokens ): void {
		// Trivial case
		if ( count( $tokens ) === 0 ) {
			$this->emit( 'chunk', $tokens );
			return;
		}

		// Tracing, timing, and unit-test generation related state
		$env = $this->env;
		$genFlags = null; // PORT-FIXME
		$traceFlags = $env->traceFlags;
		$traceState = null;
		$startTime = null;
		if ( $traceFlags || $genFlags ) {
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
				'genFlags' => $genFlags,
				'genTest' => [ $this, 'generateTest' ]
			];

			if ( !$this->traceNames ) {
				$this->computeTraceNames();
			}
			if ( isset( $traceState['traceTime'] ) ) {
				$startTime = PHPUtils::getStartHRTime();
			}
		}

		$i = 0;
		foreach ( $this->transformers as $transformer ) {
			if ( !$transformer->isDisabled() ) {
				if ( $traceState ) {
					$traceState['traceNames'] = $this->traceNames[ $i ];
				}
				if ( count( $tokens ) === 0 ) {
					return;
				}

				$tokens = $transformer->processTokensSync( $env, $tokens, $traceState );
			}
			$i++;
		}

		if ( $traceState && $traceState['traceTime'] ) {
			$this->env->bumpTimeUse( 'SyncTTM',
				( PHPUtils::getStartHRTime() - $startTime - $traceState['tokenTimes'] ),
				'TTM' );
		}

		$this->emit( 'chunk', $tokens );
	}

	/**
	 * Callback for the end event emitted from the tokenizer.
	 */
	public function onEndEvent(): void {
		$this->env->log( $this->traceType, $this->pipelineId, 'SyncTokenTransformManager.onEndEvent' );
		$this->emit( 'end' );
	}
}
