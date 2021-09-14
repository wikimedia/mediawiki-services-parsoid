<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

class TokenHandlerResult {
	/** @var array|null */
	public $tokens;
	/** @var bool */
	public $retry;
	/** @var bool */
	public $skipOnAny;

	/**
	 * @param array|null $tokens The new array of tokens, or null to retain the
	 *   current token
	 * @param bool $retry Restart the handler at the current token. The input is
	 *   replaced by $tokens if it is non-null.
	 * @param bool $skipOnAny Don't call this handler's onAny() method for this token
	 */
	public function __construct( array $tokens = null, $retry = false, $skipOnAny = false ) {
		if ( $tokens ) {
			foreach ( $tokens as $token ) {
				if ( $token === null ) {
					throw new \Exception( "Invalid token" );
				}
			}
		}
		$this->tokens = $tokens;
		$this->retry = $retry;
		$this->skipOnAny = $skipOnAny;
	}
}
