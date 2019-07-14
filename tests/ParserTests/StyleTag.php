<?php
declare( strict_types = 1 );

namespace Parsoid\Tests\ParserTests;

use DOMDocument;

use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Utils\DOMCompat;

class StyleTag extends ExtensionTag implements Extension {
	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $content, array $args ): DOMDocument {
		$doc = $extApi->getEnv()->createDocument();
		$style = $doc->createElement( 'style' );
		DOMCompat::setInnerHTML( $style, $content );
		$extApi->sanitizeArgs( $style, $args );
		DOMCompat::getBody( $doc )->appendChild( $style );
		return $doc;
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[ 'name' => 'style', 'class' => self::class ],
			],
		];
	}
}
