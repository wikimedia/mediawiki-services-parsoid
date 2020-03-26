<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use DOMNode;
use Wikimedia\Parsoid\Ext\Extension;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together `<ref>` and `<references>`.
 */
class Cite implements Extension {
	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'cite',
			'domProcessors' => [
				'wt2htmlPostProcessor' => RefProcessor::class,
				'html2wtPreProcessor' => function ( ...$args ) {
					return self::html2wtPreProcessor( ...$args );
				}
			],
			'tags' => [
				[
					'name' => 'ref',
					'class' => Ref::class,
					'options' => [
						'wt2html' => [ 'sealFragment' => true ]
					],
				],
				[
					'name' => 'references',
					'class' => References::class,
					'options' => [
						'html2wt' => [ 'format' => 'block' ]
					],
				]
			],
			'styles' => [
				'ext.cite.style',
				'ext.cite.styles'
			]
		];
	}

	/**
	 * html -> wt DOM PreProcessor
	 *
	 * This is to reconstitute page-level information from local annotations
	 * left behind by editing clients.
	 *
	 * Editing clients add inserted: true or deleted: true properties to a <ref>'s
	 * data-mw object. These are no-ops for non-named <ref>s. For named <ref>s,
	 * - for inserted refs, we might want to de-duplicate refs.
	 * - for deleted refs, if the primary ref was deleted, we have to transfer
	 *   the primary ref designation to another instance of the named ref.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param DOMNode $body
	 * @suppress PhanEmptyPrivateMethod
	 */
	private static function html2wtPreProcessor( ParsoidExtensionAPI $extApi, DOMNode $body ) {
		// TODO
	}
}
