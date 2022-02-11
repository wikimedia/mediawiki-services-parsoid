<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Config;

use Wikimedia\Parsoid\Core\SelserData;
use Wikimedia\Parsoid\DOM\Document;

abstract class ContentModelHandler {

	/**
	 * @param Env $env
	 * @return Document
	 */
	abstract public function toDOM( Env $env ): Document;

	/**
	 * @param Env $env
	 * @param ?SelserData $selserData
	 * @return string
	 */
	abstract public function fromDOM(
		Env $env, ?SelserData $selserData = null
	): string;

}
