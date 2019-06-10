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
	 * @param Selser|null $selser
	 * @return string
	 */
	abstract public function fromHTML(
		Env $env, DOMDocument $doc, ?Selser $selser = null
	): string;

}
