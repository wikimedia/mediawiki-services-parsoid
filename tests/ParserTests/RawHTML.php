<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tests\ParserTests;

use DOMDocument;

use Wikimedia\Parsoid\Config\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\Extension;
use Wikimedia\Parsoid\Ext\ExtensionTag;

class RawHTML extends ExtensionTag implements Extension {
	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $content, array $args ): DOMDocument {
		return $extApi->parseHTML( $content );
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[ 'name' => 'html', 'class' => self::class ],
			],
		];
	}
}
