<?php

/**
 * A simple parallel CURL client helper class
 * @TODO: name this ParsoidCurlMultiClient or move to core
 */
class CurlMultiClient {

	/**
	 * Get the default CURL options used for each request
	 *
	 * @static
	 * @returns array default options
	 */
	public static function getDefaultOptions() {
		return array(
			CURLOPT_HEADER => 0,
			CURLOPT_RETURNTRANSFER => 1
		);
	}

	/**
	 * Peform several CURL requests in parallel, and return the combined
	 * results.
	 *
	 * @static
	 * @param $requests array requests, each with an url and an optional
	 * 	'headers' member:
	 * 		  array(
	 * 			'url' => 'http://server.com/foo',
	 * 			'headers' => array( 'X-Foo: Bar' )
	 * 		  )
	 * @param $options array curl options used for each request, default
	 * {CurlMultiClient::getDefaultOptions}.
	 * @returns array An array of arrays containing 'error' and 'data'
	 * members. If there are errors, data will be null. If there are no
	 * errors, the error member will be null and data will contain the
	 * response data as a string.
	 */
	public static function request( $requests, array $options = null ) {
		if ( !count( $requests ) ) {
			return array();
		}

		$handles = array();

		if ( $options === null ) { // add default options
			$options = CurlMultiClient::getDefaultOptions();
		}

		// add curl options to each handle
		foreach ( $requests as $k => $row ) {
			$handle = curl_init();
			$reqOptions = array( CURLOPT_URL => $row['url'] ) + $options;
			wfDebug( "adding url: " . $row['url'] );
			if ( isset( $row['headers'] ) ) {
				$reqOptions[CURLOPT_HTTPHEADER] = $row['headers'];
			}
			curl_setopt_array( $handle, $reqOptions );

			$handles[$k] = $handle;
		}

		$mh = curl_multi_init();

		foreach ( $handles as $handle ) {
			curl_multi_add_handle( $mh, $handle );
		}

		$running_handles = null;
		//execute the handles
		do {
			$status_cme = curl_multi_exec( $mh, $running_handles );
		} while ( $status_cme == CURLM_CALL_MULTI_PERFORM );

		while ( $running_handles && $status_cme == CURLM_OK ) {
			if ( curl_multi_select( $mh ) != -1 ) {
				do {
					$status_cme = curl_multi_exec( $mh, $running_handles );
				} while ( $status_cme == CURLM_CALL_MULTI_PERFORM );
			}
		}

		$res = array();
		foreach ( $requests as $k => $row ) {
			$res[$k] = array();
			$res[$k]['error'] = curl_error( $handles[$k] );
			if ( strlen( $res[$k]['error'] ) ) {
				$res[$k]['data'] = null;
			} else {
				$res[$k]['error'] = null;
				$res[$k]['data'] = curl_multi_getcontent( $handles[$k] );  // get results
			}

			// close current handler
			curl_multi_remove_handle( $mh, $handles[$k] );
		}
		curl_multi_close( $mh );

		#wfDebug(serialize($res));
		return $res; // return response
	}

}
