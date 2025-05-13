<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

class TraceProxy extends TokenHandler {
	private string $traceType;
	private TokenHandler $handler;
	private string $name;

	public function __construct( TokenHandlerPipeline $manager, array $options,
		string $traceType, TokenHandler $handler
	) {
		parent::__construct( $manager, $options );
		$this->traceType = $traceType;
		$this->handler = $handler;
		$this->name = ( new \ReflectionClass( $handler ) )->getShortName();
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
	}

	/**
	 * @param string $func
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	private function traceEvent( string $func, $token ) {
		$this->env->trace(
			$this->traceType, $this->pipelineId,
			fn () => str_pad( $this->name, 23, ' ', STR_PAD_LEFT ) . "| ",
			$token
		);

		$profile = $this->manager->profile;
		if ( $profile ) {
			$s = hrtime( true );
			if ( $func === 'onCompoundTk' ) {
				'@phan-var CompoundTk $token';
				$res = $this->handler->$func( $token, $this );
			} else {
				$res = $this->handler->$func( $token );
			}
			$t = hrtime( true ) - $s;
			$traceName = "{$this->name}::$func";
			$profile->bumpTimeUse( $traceName, $t, "TT" );
			$profile->bumpCount( $traceName );
			$this->manager->tokenTimes += $t;
		} else {
			if ( $func === 'onCompoundTk' ) {
				'@phan-var CompoundTk $token';
				$res = $this->handler->$func( $token, $this );
			} else {
				$res = $this->handler->$func( $token );
			}
		}
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
		return $res;
	}

	public function onEnd( EOFTk $token ): ?array {
		return $this->traceEvent( 'onEnd', $token );
	}

	public function onNewline( NlTk $token ): ?array {
		return $this->traceEvent( 'onNewline', $token );
	}

	public function onTag( XMLTagTk $token ): ?array {
		return $this->traceEvent( 'onTag', $token );
	}

	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		return $this->traceEvent( 'onCompoundTk', $ctk );
	}

	/** @inheritDoc */
	public function onAny( $token ): ?array {
		return $this->traceEvent( 'onAny', $token );
	}

	public function resetState( array $options ): void {
		$this->handler->resetState( $options );
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
	}

	public function setPipelineId( int $id ): void {
		$this->pipelineId = $id;
		$this->handler->setPipelineId( $id );
	}

	public function isDisabled(): bool {
		return $this->handler->isDisabled();
	}
}
