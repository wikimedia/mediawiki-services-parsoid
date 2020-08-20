<?php
/**
 * Copyright (C) 2011-2020 Wikimedia Foundation and others.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use MediaWiki\Rest\HttpException;
use MediaWiki\Rest\Response;

/**
 * This is an exception class that wraps a Response and extends
 * HttpException.  It is used when a particular response type
 * (whatever the HTTP status code) is treated as an exceptional output
 * in your API, and you want to be able to throw it from wherever you
 * are and immediately halt request processing.  It can also be used
 * to customize the standard 3xx or 4xx error Responses returned by
 * the standard HttpException, for example to add custom headers.
 *
 * This implementation is (hopefully) going to be upstreamed:
 * T260959
 *
 * @newable
 */
class ResponseException extends HttpException {

	/**
	 * @stable to call
	 *
	 * @param Response $response The wrapped Response
	 */
	public function __construct( Response $response ) {
		parent::__construct( '', $response->getStatusCode(), [
			'response' => $response
		] );
	}

	/**
	 * @return Response
	 */
	public function getResponse() {
		return $this->getErrorData()['response'];
	}
}
