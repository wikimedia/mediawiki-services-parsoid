<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Handlers;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\WTUtils;

class PrepareDOM {
	/**
	 * Migrate data-parsoid attributes into a property on each DOM node.
	 * We may migrate them back in the final DOM traversal.
	 *
	 * Various mw metas are converted to comments before the tree build to
	 * avoid fostering. Piggy-backing the reconversion here to avoid excess
	 * DOM traversals.
	 *
	 * @param Node $node
	 * @param Env $env
	 * @return bool|mixed
	 */
	public static function handler( Node $node, Env $env ) {
		$meta = WTUtils::reinsertFosterableContent( $env, $node );
		return $meta ?? true;
	}
}
