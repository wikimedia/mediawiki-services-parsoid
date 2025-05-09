<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

class LineBasedHandlerTraceProxy extends LineBasedHandler {
	use TracingTrait;

	public function __construct(
		TokenHandlerPipeline $manager, array $options,
		string $traceType, LineBasedHandler $handler
	) {
		parent::__construct( $manager, $options );
		$this->init( $traceType, $handler );
		// Re-initialize this for phan's benefit so it knows
		// that $this->handler is a LineBasedHandler
		$this->handler = $handler;
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
	}

	/**
	 * @param string $func
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	protected function traceEventLH( string $func, $token ): ?array {
		$res = $this->traceEvent( $func, $token );
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
		return $res;
	}

	public function onEnd( EOFTk $token ): ?array {
		return $this->traceEventLH( 'onEnd', $token );
	}

	public function onNewline( NlTk $token ): ?array {
		return $this->traceEventLH( 'onNewline', $token );
	}

	public function onTag( XMLTagTk $token ): ?array {
		return $this->traceEventLH( 'onTag', $token );
	}

	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		return $this->traceEventLH( 'onCompoundTk', $ctk );
	}

	/**
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	public function onAny( $token ): ?array {
		return $this->traceEventLH( 'onAny', $token );
	}

	public function resetState( array $options ): void {
		$this->handler->resetState( $options );
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
	}
}
