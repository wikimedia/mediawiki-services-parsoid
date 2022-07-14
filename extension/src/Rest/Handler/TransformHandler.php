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

use MediaWiki\Rest\Handler\TransformHandler as CoreTransformHandler;
use Wikimedia\ParamValidator\ParamValidator;

/**
 * Handler for transforming content given in the request.
 * - /{domain}/v3/transform/{from}/to/{format}
 * - /{domain}/v3/transform/{from}/to/{format}/{title}
 * - /{domain}/v3/transform/{from}/to/{format}/{title}/{revision}
 * @see https://www.mediawiki.org/wiki/Parsoid/API#POST
 */
class TransformHandler extends CoreTransformHandler {

	// NOTE: this controls redirects by overriding methods!
	use EndpointRedirectTrait;

	/** @inheritDoc */
	public function checkPreconditions() {
		// Execute this since this sets up state needed for other functionality.
		parent::checkPreconditions();
		// Disable precondition checks by ignoring the return value above.
		// This works around the problem that Visual Editor will send an
		// If-Match header with the ETag it got when loading HTML, but
		// but since TransformHandler doesn't implement ETags, the If-Match
		// conditional will never match.
		return null;
	}

	/** @inheritDoc */
	public function getParamSettings() {
		return [
			// We need to verify that the correct domain is given, to avoid cache pollution.
			'domain' => [
				self::PARAM_SOURCE => 'path',
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_REQUIRED => true,
			]
		] + parent::getParamSettings();
	}

}
