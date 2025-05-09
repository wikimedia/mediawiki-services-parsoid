<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

class UniversalTokenHandlerTraceProxy extends UniversalTokenHandler {
	use TracingTrait;

	public function __construct(
		TokenHandlerPipeline $manager, array $options,
		string $traceType, UniversalTokenHandler $handler
	) {
		parent::__construct( $manager, $options );
		$this->init( $traceType, $handler );
	}

	/**
	 * @param string|Token $token
	 * @return ?array<string|Token>
	 */
	public function onAny( $token ): ?array {
		return $this->traceEvent( 'onAny', $token );
	}
}
