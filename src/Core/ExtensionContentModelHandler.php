<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Ext\ContentModelHandler as ExtContentModelHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

class ExtensionContentModelHandler extends ContentModelHandler {

	/**
	 * @var ExtContentModelHandler
	 */
	private $impl;

	/**
	 * @param ExtContentModelHandler $impl
	 */
	public function __construct( ExtContentModelHandler $impl ) {
		$this->impl = $impl;
	}

	/**
	 * @inheritDoc
	 */
	public function toDOM( Env $env ): Document {
		$extApi = new ParsoidExtensionAPI( $env );
		return $this->impl->toDOM( $extApi );
	}

	/**
	 * @inheritDoc
	 */
	public function fromDOM(
		Env $env, ?SelserData $selserData = null
	): string {
		$extApi = new ParsoidExtensionAPI( $env );
		// FIXME: `$selserData` is ignored?
		return $this->impl->fromDOM( $extApi );
	}

}
