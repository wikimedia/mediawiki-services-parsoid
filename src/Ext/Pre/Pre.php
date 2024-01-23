<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Pre;

use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\DOMDataUtils;
use Wikimedia\Parsoid\Ext\ExtensionModule;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\PHPUtils;
use Wikimedia\Parsoid\Ext\Utils;

/**
 * The `<pre>` extension tag shadows the html pre tag, but has different
 * semantics.  It treats anything inside it as plaintext.
 */
class Pre extends ExtensionTagHandler implements ExtensionModule {

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => '<pre>',
			'tags' => [
				[
					'name' => 'pre',
					'handler' => self::class,
					'options' => [
						// Strip nowiki markers from #tag parser-function
						// arguments (T299103)
						'stripNowiki' => true,
					],
				]
			]
		];
	}

	/** @inheritDoc */
	public function sourceToDom(
		ParsoidExtensionAPI $extApi, string $content, array $args
	): DocumentFragment {
		$domFragment = $extApi->htmlToDom( '' );
		$doc = $domFragment->ownerDocument;
		$pre = $doc->createElement( 'pre' );

		$kvArgs = $extApi->extArgsToArray( $args );
		if ( ( $kvArgs['format'] ?? '' ) === 'wikitext' ) {
			return $extApi->extTagToDOM( $args, $content, [
				'wrapperTag' => 'pre',
				'parseOpts' => [
					'extTag' => 'pre',
					'context' => 'inline',
				],
			] );
		}

		Sanitizer::applySanitizedArgs( $extApi->getSiteConfig(), $pre, $args );
		DOMDataUtils::getDataParsoid( $pre )->stx = 'html';

		// Support nowikis in pre.  Do this before stripping newlines, see test,
		// "<pre> with <nowiki> inside (compatibility with 1.6 and earlier)"
		$content = preg_replace( '/<nowiki\s*>(.*?)<\/nowiki\s*>/s', '$1', $content );

		// Strip leading newline to match legacy php parser.  This is probably because
		// it doesn't do xml serialization accounting for `newlineStrippingElements`
		// Of course, this leads to indistinguishability between n=0 and n=1
		// newlines, but that only seems to affect parserTests output.  Rendering
		// is the same, and the newline is preserved for rt in the `extSrc`.
		$content = PHPUtils::stripPrefix( $content, "\n" );

		// `extSrc` will take care of rt'ing these
		$content = Utils::decodeWtEntities( $content );

		$pre->appendChild( $doc->createTextNode( $content ) );
		$domFragment->appendChild( $pre );

		return $domFragment;
	}

}
