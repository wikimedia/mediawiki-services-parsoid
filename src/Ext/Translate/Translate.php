<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Translate;

use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;

/**
 * This is effectively a stub at this point.
 * The JS version doesn't do any work so this version doesn't either.
 * It just intercepts the tags which causes the ExtensionHandler to
 * add a generic extension span wrapper around its contents.
 *
 * So, the PHP version mimics that and hence doesn't implement the
 * toDOM method.
 */
class Translate extends ExtensionTag implements Extension {
	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[
					'name' => 'translate',
					'class' => self::class
				],
				[
					'name' => 'tvar',
					'class' => self::class
				]
			]
		];
	}

}
