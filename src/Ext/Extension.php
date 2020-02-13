<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

/**
 * A Parsoid native extension.  The only method required is `getConfig`.
 */
interface Extension {

	/**
	 * Return information about this extension.
	 * FIXME: Add more expected fields or create a class for this
	 * @return array{tags:array}
	 */
	public function getConfig(): array;

}
