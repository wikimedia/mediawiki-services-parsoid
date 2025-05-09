<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

class XMLTagBasedHandlerTraceProxy extends XMLTagBasedHandler {
	use TracingTrait;

	public function __construct(
		TokenHandlerPipeline $manager, array $options,
		string $traceType, XMLTagBasedHandler $handler
	) {
		parent::__construct( $manager, $options );
		$this->init( $traceType, $handler );
	}

	public function onTag( XMLTagTk $token ): ?array {
		return $this->traceEvent( 'onTag', $token );
	}
}
