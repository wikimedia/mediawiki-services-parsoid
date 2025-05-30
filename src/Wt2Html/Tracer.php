<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use Wikimedia\WikiPEG\DefaultTracer;

class Tracer extends DefaultTracer {
	private string $text;

	public function __construct( string $text ) {
		$this->text = $text;
	}

	/**
	 * @param array{location:\Wikimedia\WikiPEG\LocationRange,type:string,rule:string,args?:array} $event
	 */
	protected function log( $event ): void {
		$offset = $event['location']->start->offset;
		print str_pad(
			'' . $event['location'],
			20
		)
			. str_pad( 'c:' . json_encode( $this->text[$offset] ?? '' ), 10 )
			. str_pad( $event['type'], 10 ) . ' '
			. str_repeat( ' ', $this->indentLevel ) . $event['rule']
			. $this->formatArgs( $event['args'] ?? null )
			. "\n";
	}
}
