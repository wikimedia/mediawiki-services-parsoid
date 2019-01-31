<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module ext/LST */

namespace Parsoid;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );

$DOMDataUtils = ParsoidExtApi\DOMDataUtils;
$Promise = ParsoidExtApi\Promise;

// TODO: We're keeping this serial handler around to remain backwards
// compatible with stored content version 1.3.0 and below.  Remove it
// when those versions are no longer supported.
$serialHandler = [
	'handle' => Promise::method( function ( $node, $state, $wrapperUnmodified ) use ( &$DOMDataUtils ) {
			$env = $state->env;
			$typeOf = $node->getAttribute( 'typeof' ) || '';
			$dp = DOMDataUtils::getDataParsoid( $node );
			$src = null;
			if ( $dp->src ) {
				$src = $dp->src;
			} elseif ( preg_match( '/begin/', $typeOf ) ) {
				$src = '<section begin="' . $node->getAttribute( 'content' ) . '" />';
			} elseif ( preg_match( '/end/', $typeOf ) ) {
				$src = '<section end="' . $node->getAttribute( 'content' ) . '" />';
			} else {
				$env->log( 'error', 'LST <section> without content in: ' . $node->outerHTML );
				$src = '<section />';
			}
			return $src;
	}
	)
];

$module->exports = function () use ( &$serialHandler ) {
	$this->config = [
		// FIXME: This is registering <labeledsectiontransclusion> as an ext
		// tag.  All the more reason to get rid of this file altogether.
		'tags' => [
			[
				'name' => 'labeledsectiontransclusion',
				'serialHandler' => $serialHandler
			],
			[
				'name' => 'labeledsectiontransclusion/begin',
				'serialHandler' => $serialHandler
			],
			[
				'name' => 'labeledsectiontransclusion/end',
				'serialHandler' => $serialHandler
			]
		]
	];
};
