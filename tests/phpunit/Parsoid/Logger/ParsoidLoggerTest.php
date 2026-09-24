<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Logger;

use Psr\Log\AbstractLogger;
use Wikimedia\Parsoid\Logger\ParsoidLogger;
use Wikimedia\Parsoid\Utils\TitleException;

/**
 * @covers \Wikimedia\Parsoid\Logger\ParsoidLogger
 */
class ParsoidLoggerTest extends \PHPUnit\Framework\TestCase {

	public function testLogException() {
		$backend = new class extends AbstractLogger {
			public array $messages = [];

			public function log( $level, $message, array $context = [] ): void {
				$this->messages[] = [ $level, (string)$message ];
			}
		};
		$logger = new ParsoidLogger( $backend, [
			'logLevels' => [ 'error' ],
			'traceFlags' => [],
			'debugFlags' => [],
			'dumpFlags' => [],
		] );

		$logger->log( 'error/html2wt/tpldata',
			new TitleException( 'Bad title', 'title-invalid-characters', '{{foo}}' ) );

		$this->assertSame( [ [
			'error',
			'[error/html2wt/tpldata] ' . TitleException::class . ': Bad title',
		] ], $backend->messages );
	}
}
