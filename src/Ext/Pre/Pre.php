<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Pre;

use DOMDocument;
use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\Util;
use Parsoid\Wt2Html\TT\Sanitizer;

/**
 * The `<pre>` extension tag shadows the html pre tag, but has different
 * semantics.  It treats anything inside it as plaintext.
 */
class Pre extends ExtensionTag implements Extension {

	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ): DOMDocument {
		$doc = $extApi->getEnv()->createDocument();
		$pre = $doc->createElement( 'pre' );

		Sanitizer::applySanitizedArgs( $extApi->getEnv(), $pre, $extArgs );
		DOMDataUtils::getDataParsoid( $pre )->stx = 'html';

		// Support nowikis in pre.  Do this before stripping newlines, see test,
		// "<pre> with <nowiki> inside (compatibility with 1.6 and earlier)"
		$txt = preg_replace( '/<nowiki\s*>(.*?)<\/nowiki\s*>/s', '$1', $txt );

		// Strip leading newline to match legacy php parser.  This is probably because
		// it doesn't do xml serialization accounting for `newlineStrippingElements`
		// Of course, this leads to indistinguishability between n=0 and n=1
		// newlines, but that only seems to affect parserTests output.  Rendering
		// is the same, and the newline is preserved for rt in the `extSrc`.
		$txt = preg_replace( '/^\n/', '', $txt, 1 );

		// `extSrc` will take care of rt'ing these
		$txt = Util::decodeWtEntities( $txt );

		$pre->appendChild( $doc->createTextNode( $txt ) );
		DOMCompat::getBody( $doc )->appendChild( $pre );

		return $doc;
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[
					'name' => 'pre',
					'class' => self::class,
				]
			]
		];
	}

}
