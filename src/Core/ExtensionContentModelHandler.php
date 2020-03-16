<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use DOMDocument;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Ext\ContentModelHandlerExtension;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

class ExtensionContentModelHandler extends ContentModelHandler {

	/**
	 * @var ContentModelHandlerExtension
	 */
	private $impl;

	/**
	 * @param ContentModelHandlerExtension $impl
	 */
	public function __construct( ContentModelHandlerExtension $impl ) {
		$this->impl = $impl;
	}

	/**
	 * @inheritDoc
	 */
	public function toDOM( Env $env ): DOMDocument {
		$extApi = new ParsoidExtensionAPI( $env );
		return $this->impl->toDOM( $extApi, $env->getPageMainContent() );
	}

	/**
	 * @inheritDoc
	 */
	public function fromDOM(
		Env $env, DOMDocument $doc, ?SelserData $selserData = null
	): string {
		$extApi = new ParsoidExtensionAPI( $env );
		// FIXME: `$selserData` is ignored?
		return $this->impl->fromDOM( $extApi, $doc );
	}

}
