<?php
declare( strict_types = 1 );

namespace Parsoid;

use DOMDocument;

use Parsoid\Config\Env;
use Parsoid\Html2Wt\SelectiveSerializer;
use Parsoid\Html2Wt\WikitextSerializer;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;

class WikitextContentModelHandler extends ContentModelHandler {

	/**
	 * @param Env $env
	 * @return DOMDocument
	 */
	public function toHTML( Env $env ): DOMDocument {
		return $env->getPipelineFactory()->parse( $env->getPageMainContent() );
	}

	/**
	 * @param Env $env
	 * @param DOMDocument $doc
	 * @param Selser|null $selser
	 * @return string
	 */
	public function fromHTML(
		Env $env, DOMDocument $doc, ?Selser $selser = null
	): string {
		$serializerOpts = [
			"env" => $env,
		];
		$Serializer = !empty( $selser ) ?
			SelectiveSerializer::class : WikitextSerializer::class;
		$serializer = new $Serializer( $serializerOpts );
		$env->getPageConfig()->editedDoc = $doc;
		$body = DOMCompat::getBody( $doc );
		DOMDataUtils::visitAndLoadDataAttribs( $body, [ 'markNew' => true ] );
		return $serializer->serializeDOM( $body );
	}

}
