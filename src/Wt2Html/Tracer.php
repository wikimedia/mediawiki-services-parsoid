<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

use InvalidArgumentException;
use Wikimedia\WikiPEG\Tracer as ITracer;

/**
 * FIXME: DefaultTracer should make some things protected
 */
class Tracer implements ITracer {
	/** @var int */
	private $indentLevel = 0;
	private string $text;

	public function __construct( string $text ) {
		$this->text = $text;
	}

	/**
	 * @param array $event
	 */
	public function trace( $event ): void {
		switch ( $event['type'] ) {
			case 'rule.enter':
				$this->log( $event );
				$this->indentLevel++;
				break;

			case 'rule.match':
				$this->indentLevel--;
				$this->log( $event );
				break;

			case 'rule.fail':
				$this->indentLevel--;
				$this->log( $event );
				break;

			default:
				throw new InvalidArgumentException( "Invalid event type {$event['type']}" );
		}
	}

	/**
	 * @param array $event
	 */
	private function log( $event ) {
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

	/**
	 * @param ?array $argMap
	 * @return string
	 */
	private function formatArgs( $argMap ) {
		if ( !$argMap ) {
			return '';
		}

		$argParts = [];
		foreach ( $argMap as $argName => $argValue ) {
			if ( $argName === '$silence' ) {
				continue;
			}
			if ( $argName === '$boolParams' ) {
				$argParts[] = '0x' . base_convert( (string)$argValue, 10, 16 );
			} else {
				$displayName = str_replace( '$param_', '', $argName );
				if ( $displayName[0] === '&' ) {
					$displayName = substr( $displayName, 1 );
					$ref = '&';
				} else {
					$ref = '';
				}
				$argParts[] = "$displayName=$ref" .
						   json_encode( $argValue, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
			}
		}
		if ( $argParts ) {
			return '<' . implode( ', ', $argParts ) . '>';
		} else {
			return '';
		}
	}
}
