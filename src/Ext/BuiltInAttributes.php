<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataMwI18n;
use Wikimedia\Parsoid\NodeData\DataMwVariant;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\DataParsoidDiff;

/**
 * A schema for Parsoid's "built in" attribute types.
 *
 * This describes the rich attributes that Parsoid generates
 * internally.  Extensions may define additional rich attributes.
 */
class BuiltInAttributes implements ExtensionModule {
	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'BuiltInAttributes',
			'richAttributes' => [
				[
					'name' => 'data-mw',
					'hint' => [
						'factory' => [ DataMw::class, 'hint' ],
					],
				],
				[
					'name' => 'data-parsoid',
					'hint' => [
						'factory' => [ DataParsoid::class, 'hint' ],
					],
					// There's embedded HTML, but only used internally.
					'containsEmbeddedHtml' => false,
				],
				[
					'name' => 'data-parsoid-diff',
					'hint' => [
						'factory' => [ DataParsoidDiff::class, 'hint' ],
					],
					'containsEmbeddedHtml' => false,
				],
				[
					'name' => 'data-mw-variant',
					'hint' => [
						'factory' => [ DataMwVariant::class, 'hint' ],
					],
				],
				[
					'name' => 'data-mw-i18n',
					'hint' => [
						'factory' => [ DataMwI18n::class, 'hint' ],
					],
					'containsEmbeddedHtml' => false,
				],
			],
		];
	}
}
