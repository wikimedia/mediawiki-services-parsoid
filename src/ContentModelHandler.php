<?php
declare( strict_types = 1 );

namespace Parsoid;

use DOMDocument;

use Parsoid\Config\Env;

abstract class ContentModelHandler {

	/**
	 * @param Env $env
	 * @return DOMDocument
	 */
	abstract public function toHTML( Env $env ): DOMDocument;

	/**
	 * @param Env $env
	 * @param DOMDocument $doc
	 * @param SelserData|null $selserData
	 * @return string
	 */
	abstract public function fromHTML(
		Env $env, DOMDocument $doc, ?SelserData $selserData = null
	): string;

}
