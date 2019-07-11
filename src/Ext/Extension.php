<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

/**
 * A Parsoid native extension.  The only method required is `getConfig`.
 */
interface Extension {

	/**
	 * Return information about this extension.
	 * @return array
	 */
	public function getConfig(): array;

}
