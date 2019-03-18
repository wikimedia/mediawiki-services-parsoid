<?php

declare( strict_types = 1 );

namespace Parsoid\Tests\ApiEnv;

use Wikimedia\ScopedCallback;

class ApiHelper {

	/** @var string */
	private $endpoint;

	/** @var array */
	private $curlopt;

	/**
	 * @param array $opts
	 *  - apiEndpoint: (string) URL for api.php. Required.
	 *  - apiTimeout: (int) Timeout, in sections. Default 60.
	 *  - userAgent: (string) User agent prefix.
	 */
	public function __construct( array $opts ) {
		if ( !isset( $opts['apiEndpoint'] ) ) {
			throw new \InvalidArgumentException( '$opts[\'apiEndpoint\'] must be set' );
		}
		$this->endpoint = $opts['apiEndpoint'];

		$this->curlopt = [
			CURLOPT_USERAGENT => trim( ( $opts['userAgent'] ?? '' ) . ' ApiEnv/1.0 Parsoid-PHP/0.1' ),
			CURLOPT_CONNECTTIMEOUT => $opts['apiTimeout'] ?? 60,
			CURLOPT_TIMEOUT => $opts['apiTimeout'] ?? 60,
			CURLOPT_FOLLOWLOCATION => false,
			CURLOPT_ENCODING => '', // Enable compression
			CURLOPT_SAFE_UPLOAD => true,
			CURLOPT_RETURNTRANSFER => true,
		];
	}

	/**
	 * Make an API request
	 * @param array $params API parameters
	 * @return array API response data
	 */
	public function makeRequest( array $params ): array {
		$ch = curl_init( $this->endpoint );
		if ( !$ch ) {
			throw new \RuntimeException( "Failed to open curl handle to $this->endpoint" );
		}
		$reset = new ScopedCallback( 'curl_close', [ $ch ] );

		$params['format'] = 'json';
		if ( !isset( $params['formatversion'] ) ) {
			$params['formatversion'] = '2';
		}

		$opts = [
			CURLOPT_POST => true,
			CURLOPT_POSTFIELDS => $params,
		] + $this->curlopt;
		if ( !curl_setopt_array( $ch, $opts ) ) {
			throw new \RuntimeException( "Error setting curl options: " . curl_error( $ch ) );
		}

		$res = curl_exec( $ch );

		if ( curl_errno( $ch ) !== 0 ) {
			throw new \RuntimeException( "HTTP request failed: " . curl_error( $ch ) );
		}

		$code = curl_getinfo( $ch, CURLINFO_RESPONSE_CODE );
		if ( $code !== 200 ) {
			throw new \RuntimeException( "HTTP request failed: HTTP code $code" );
		}

		ScopedCallback::consume( $reset );

		if ( !$res ) {
			throw new \RuntimeException( "HTTP request failed: Empty response" );
		}

		$data = json_decode( $res, true );
		if ( !is_array( $data ) ) {
			throw new \RuntimeException( "HTTP request failed: Response was not a JSON array" );
		}

		if ( isset( $data['error'] ) ) {
			$e = $data['error'];
			throw new \RuntimeException( "MediaWiki API error: [{$e['code']}] {$e['info']}" );
		}

		return $data;
	}

}
