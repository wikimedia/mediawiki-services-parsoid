<?php
declare( strict_types = 1 );

namespace Parsoid\Tests\ParserTests;

use DOMDocument;

use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;

class RawHTML extends ExtensionTag implements Extension {
	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $content, array $args ): DOMDocument {
		return $extApi->getEnv()->createDocument( $content );
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
