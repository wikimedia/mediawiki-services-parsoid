<?php
declare( strict_types = 1 );

namespace Parsoid\Html2Wt;

use DOMNode;
use Parsoid\Config\Env;

/**
 * Wikitext to HTML serializer.
 * Serializes a chunk of tokens or an HTML DOM to MediaWiki's wikitext flavor.
 */
class WikitextSerializer {

	/** @var Env */
	public $env;

	/**
	 * @note Porting note: this replaces WikitextSerializer.wteHandlers.escapeWikiText
	 * @param SerializerState $state
	 * @param string $text
	 * @param array $opts
	 *   - node: (DOMNode)
	 *   - isLastChild: (bool)
	 * @return string
	 */
	public function escapeWikiText( SerializerState $state, string $text, array $opts ): string {
		throw new \LogicException( 'Not ported yet' );
	}

	/**
	 * Internal worker. Recursively serialize a DOM subtree.
	 * @param DOMNode $child
	 * @return DOMNode|null
	 * @private
	 */
	public function serializeNode( DOMNode $child ): ?DOMNode {
		throw new \LogicException( 'Not ported yet' );
	}

	/**
	 * Emit a separator based on the collected (and merged) constraints
	 * and existing separator text. Called when new output is triggered.
	 * @param DOMNode $node
	 * @return string
	 */
	public function buildSep( DOMNode $node ): string {
		throw new \LogicException( 'Not ported yet' );
	}

	/**
	 * @note Porting note: this replaces the pattern $serializer->env->log( $serializer->logType, ... )
	 * @param mixed ...$args
	 * @deprecated Use PSR-3 logging instead
	 */
	public function trace( ...$args ) {
	}

}
