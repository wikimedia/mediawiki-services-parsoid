<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Translate;

use DOMDocument;
use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Ext\LintHandlerTrait;

class Translate implements ExtensionTag {
	/* Translate doesn't implement linting, so use boilerplate */
	use LintHandlerTrait;

	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ): DOMDocument {
		return $extApi->getEnv()->createDocument();
	}

	/** @return array */
	public function getConfig(): array {
		return [
			'tags' => [
				[
					'name' => 'translate',
					'class' => self::class
				],
				[
					'name' => 'tvar',
					'class' => self::class
				]
			]
		];
	}

}
