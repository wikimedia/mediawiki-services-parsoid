<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Wt2Html\TokenTransformManager;

class TraceProxy extends TokenHandler {
	private $traceType;
	private $handler;
	private $name;

	/**
	 * @param TokenTransformManager $manager
	 * @param array $options
	 * @param string $traceType
	 * @param TokenHandler $handler
	 */
	public function __construct( TokenTransformManager $manager, array $options,
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
	 * @return TokenHandlerResult|null
	 */
	private function traceEvent( string $func, $token ) {
		$this->env->log(
			$this->traceType, $this->pipelineId,
			function () {
				return str_pad( $this->name, 23, ' ',  STR_PAD_LEFT ) . "|";
			},
			static function () use ( $token ) {
				return PHPUtils::jsonEncode( $token );
			}
		);

		$profile = $this->manager->profile;
		if ( $profile ) {
			$s = microtime( true );
			$res = $this->handler->$func( $token );
			$t = (int)( ( microtime( true ) - $s ) * 1000 );
			$traceName = "{$this->name}::$func";
			$profile->bumpTimeUse( $traceName, $t, "TT" );
			$profile->bumpCount( $traceName );
			$this->manager->tokenTimes += $t;
		} else {
			$res = $this->handler->$func( $token );
		}
		// Copy onAnyEnabled for TraceProxy::process() to read
		$this->onAnyEnabled = $this->handler->onAnyEnabled;
		return $res;
	}

	/**
	 * @param EOFTk $token
	 * @return TokenHandlerResult|null
	 */
	public function onEnd( EOFTk $token ): ?TokenHandlerResult {
		return $this->traceEvent( 'onEnd', $token );
	}

	/**
	 * @param NlTk $token
	 * @return TokenHandlerResult|null
	 */
	public function onNewline( NlTk $token ): ?TokenHandlerResult {
		return $this->traceEvent( 'onNewline', $token );
	}

	/**
	 * @param Token $token
	 * @return TokenHandlerResult|null
	 */
	public function onTag( Token $token ): ?TokenHandlerResult {
		return $this->traceEvent( 'onTag', $token );
	}

	/**
	 * @param string|Token $token
	 * @return TokenHandlerResult|null
	 */
	public function onAny( $token ): ?TokenHandlerResult {
		return $this->traceEvent( 'onAny', $token );
	}

	/**
	 * @param array $options
	 */
	public function resetState( array $options ): void {
		$this->handler->resetState( $options );
	}

	/**
	 * @param int $id
	 */
	public function setPipelineId( int $id ): void {
		$this->pipelineId = $id;
		$this->handler->setPipelineId( $id );
	}

	/**
	 * @return bool
	 */
	public function isDisabled(): bool {
		return $this->handler->isDisabled();
	}
}
