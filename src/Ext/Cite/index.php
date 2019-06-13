<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * This module implements `<ref>` and `<references>` extension tag handling
 * natively in Parsoid.
 * @module ext/Cite
 */

namespace Parsoid;

use Parsoid\Ref as Ref;
use Parsoid\References as References;
use Parsoid\RefProcessor as RefProcessor;

/**
 * Native Parsoid implementation of the Cite extension
 * that ties together `<ref>` and `<references>`.
 */
class Cite {
	public function __construct() {
		$this->config = [
			'name' => 'cite',
			'domProcessors' => [
				'wt2htmlPostProcessor' => RefProcessor::class,
				'html2wtPreProcessor' => function ( ...$args ) {return $this->_html2wtPreProcessor( ...$args );
	   }
			],
			'tags' => [
				[
					'name' => 'ref',
					'toDOM' => Ref::toDOM,
					'fragmentOptions' => [
						'sealFragment' => true
					],
					'serialHandler' => Ref::serialHandler, // FIXME: Rename to toWikitext
					'lintHandler' => Ref::lintHandler
				]
				, // FIXME: Do we need (a) domDiffHandler (b) ... others ...
				[
					'name' => 'references',
					'toDOM' => References::toDOM,
					'serialHandler' => References::serialHandler,
					'lintHandler' => References::lintHandler
				]
			],
			'styles' => [
				'ext.cite.style',
				'ext.cite.styles'
			]
		];
	}
	public $config;

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
	 */
	public function _html2wtPreProcessor( $env, $body ) {
		// TODO
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports = $Cite;
}
