<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use Wikimedia\Parsoid\Ext\ExtensionModule;

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together `<ref>` and `<references>`.
 */
class Cite implements ExtensionModule {
	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'Cite',
			'domProcessors' => [
				RefProcessor::class,
			],
			'tags' => [
				[
					'name' => 'ref',
					'handler' => Ref::class,
					'options' => [
						'wt2html' => [
							'unpackOutput' => false,
							'embedsHTMLInAttributes' => true
						],
						'outputHasCoreMwDomSpecMarkup' => true
					],
				],
				[
					'name' => 'references',
					'handler' => References::class,
					'options' => [
						'wt2html' => [
							'embedsHTMLInAttributes' => true
						],
						'html2wt' => [ 'format' => 'block' ],
						'outputHasCoreMwDomSpecMarkup' => true
					],
				]
			],
		];
	}
}
