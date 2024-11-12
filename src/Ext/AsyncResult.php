<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\Fragments\PFragment;

/**
 * An AsyncResult indicates that the given fragment handler was not yet
 * ready to provide content.
 *
 * It can optionally provide a PFragment as temporary fallback content.
 *
 * In the future, additional methods or types of AsyncResult might be
 * added to (eg) provide a timestamp when the content is expected to be
 * ready, or to provide some sort of callback mechanism when the content
 * is ready, or to provide a fragment UUID that could be used to query
 * the fragment provider for the content later.
 */
class AsyncResult {

	/**
	 * Return fallback content to use for this "not ready yet" fragment,
	 * or null to use default fallback content.
	 */
	public function fallbackContent( ParsoidExtensionAPI $extAPI ): ?PFragment {
		return null;
	}
}
