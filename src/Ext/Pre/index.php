<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * The `<pre>` extension tag shadows the html pre tag, but has different
 * semantics.  It treats anything inside it as plaintext.
 * @module ext/Pre
 */

namespace Parsoid;

use Parsoid\domino as domino;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );

$temp0 = $ParsoidExtApi;
$Util = $temp0::Util;
$DOMDataUtils = $temp0::DOMDataUtils;
$Sanitizer = $temp0::Sanitizer;
$Promise = $temp0::Promise;

$toDOM = Promise::method( function ( $state, $txt, $extArgs ) use ( &$domino, &$Sanitizer, &$DOMDataUtils, &$Util ) {
		$doc = domino::createDocument();
		$pre = $doc->createElement( 'pre' );

		Sanitizer::applySanitizedArgs( $state->env, $pre, $extArgs );
		DOMDataUtils::getDataParsoid( $pre )->stx = 'html';

		// Support nowikis in pre.  Do this before stripping newlines, see test,
		// "<pre> with <nowiki> inside (compatibility with 1.6 and earlier)"
		$txt = preg_replace( '/<nowiki\s*>([^]*?)<\/nowiki\s*>/', '$1', $txt );

		// Strip leading newline to match php parser.  This is probably because
		// it doesn't do xml serialization accounting for `newlineStrippingElements`
		// Of course, this leads to indistinguishability between n=0 and n=1
		// newlines, but that only seems to affect parserTests output.  Rendering
		// is the same, and the newline is preserved for rt in the `extSrc`.
		$txt = preg_replace( '/^\n/', '', $txt, 1 );

		// `extSrc` will take care of rt'ing these
		$txt = Util::decodeWtEntities( $txt );

		$pre->appendChild( $doc->createTextNode( $txt ) );
		$doc->body->appendChild( $pre );

		return $doc;
}
);

$module->exports = function () use ( &$toDOM ) {
	$this->config = [
		'tags' => [
			[
				'name' => 'pre',
				'toDOM' => $toDOM
			]
		]
	];
};
