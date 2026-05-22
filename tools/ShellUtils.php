<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tools;

/**
 * Shell-execution helpers for maintenance scripts.
 */
trait ShellUtils {

	public static string $parsoidRoot = __DIR__ . '/..';

	private static function fetchUrl( string $url, ?string $userAgent = null ): string {
		$userAgent ??= getenv( 'GERRITUA' ) ?? 'wikimedia-parsoid-utils';
		$context = stream_context_create( [
			'http' => [
				'method' => 'GET',
				'header' => "User-Agent: {$userAgent}\r\n",
				'ignore_errors' => true,
			],
		] );
		$result = file_get_contents( $url, false, $context );
		if ( $result === false ) {
			throw new \RuntimeException( "Failed to fetch: {$url}" );
		}
		return $result;
	}

	/**
	 * Execute a command in the given directory, (optionally) printing it first.
	 * Throws RuntimeException if the command exits with non-zero status.
	 *
	 * @param string[] $cmd
	 * @param string|null $cwd Working directory (defaults to Parsoid root directory)
	 * @param bool $echo Whether to echo the command to the output (default: true)
	 */
	private static function exec( array $cmd, ?string $cwd = null, bool $echo = true ): void {
		$cwd ??= self::$parsoidRoot;
		if ( $echo ) {
			print( '>>> ' . implode( ' ', $cmd ) . "\n" );
		}
		// phpcs:ignore MediaWiki.Usage.ForbiddenFunctions.proc_open
		$proc = proc_open(
			$cmd,
			[ 0 => STDIN, 1 => STDOUT, 2 => STDERR ],
			$pipes,
			$cwd
		);
		if ( $proc === false ) {
			throw new \RuntimeException( 'Failed to start: ' . implode( ' ', $cmd ) );
		}
		$exitCode = proc_close( $proc );
		if ( $exitCode !== 0 ) {
			throw new \RuntimeException(
				'Command exited with code ' . $exitCode . ': ' . implode( ' ', $cmd )
			);
		}
	}

	/**
	 * Run a command and return its (optionally trimmed) stdout.
	 *
	 * @param string[] $cmd
	 * @param ?string $cwd Working directory (defaults to Parsoid root directory)
	 * @param bool $trim Whether to trim the stdout (defaults to true)
	 */
	private static function execCapture( array $cmd, ?string $cwd = null, bool $trim = true ): string {
		$cwd ??= self::$parsoidRoot;

		// phpcs:ignore MediaWiki.Usage.ForbiddenFunctions.proc_open
		$proc = proc_open(
			$cmd,
			[ 0 => STDIN, 1 => [ 'pipe', 'w' ], 2 => STDERR ],
			$pipes,
			$cwd
		);
		if ( $proc === false ) {
			throw new \RuntimeException( 'Failed to start: ' . implode( ' ', $cmd ) );
		}
		$output = stream_get_contents( $pipes[1] );
		fclose( $pipes[1] );
		$exitCode = proc_close( $proc );
		if ( $exitCode !== 0 ) {
			throw new \RuntimeException(
				'Command exited with code ' . $exitCode . ': ' . implode( ' ', $cmd )
			);
		}
		if ( $trim ) {
			$output = trim( $output );
		}
		return $output;
	}
}
