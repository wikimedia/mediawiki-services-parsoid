<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\Token;

/**
 * @phan-file-suppress PhanUndeclaredProperty
 */
trait TracingTrait {
	private string $traceType;
	private TokenHandler $handler;
	private string $name;

	private function init( string $traceType, TokenHandler $handler ): void {
		$this->traceType = $traceType;
		$this->handler = $handler;
		$this->name = ( new \ReflectionClass( $handler ) )->getShortName();
	}

	/**
	 * @param string $func
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	protected function traceEvent( string $func, $token ): ?array {
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
				'@phan-var Tokenhandler $this';
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
				'@phan-var Tokenhandler $this';
				$res = $this->handler->$func( $token, $this );
			} else {
				$res = $this->handler->$func( $token );
			}
		}
		return $res;
	}

	public function onCompoundTk( CompoundTk $token, TokenHandler $tokensHandler ): ?array {
		return $this->traceEvent( 'onCompoundTk', $token );
	}

	public function resetState( array $options ): void {
		$this->handler->resetState( $options );
	}

	public function setPipelineId( int $id ): void {
		$this->pipelineId = $id;
		$this->handler->setPipelineId( $id );
	}

	public function isDisabled(): bool {
		return $this->handler->isDisabled();
	}
}
