<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Utils;

// phpcs:disable MediaWiki.Commenting.PropertyDocumentation.ObjectTypeHintVar

/**
 * This object stores data associated with a single DOM node.
 *
 * Using undeclared properties reduces memory usage and CPU time if the
 * property is null in more than about 75% of instances. There are typically
 * a very large number of NodeData objects, so this optimisation is worthwhile.
 *
 * @property object|null $parsoid_diff
 * @property object|null $mw_variant
 * @property int|null $storedId
 * @property DataMwI18n|null $i18n
 */
#[\AllowDynamicProperties]
class NodeData {
	/**
	 * The unserialized data-parsoid attribute
	 */
	public ?DataParsoid $parsoid = null;

	/**
	 * The unserialized data-mw attribute
	 */
	public ?DataMw $mw = null;

	/**
	 * Deep clone this object
	 * If $stripSealedFragments is true, sealed DOMFragment included in expanded attributes are deleted in the
	 * clone.
	 * @param bool $stripSealedFragments
	 * @return self
	 */
	public function cloneNodeData( bool $stripSealedFragments = false ): self {
		$cloneableData = get_object_vars( $this );
		// Don't clone $this->parsoid because it has a custom clone method
		unset( $cloneableData['parsoid'] );
		// Don't clone storedId because it doesn't need it
		unset( $cloneableData['storedId'] );
		// Deep clone everything else
		$cloneableData = Utils::clone( $cloneableData );
		$nd = clone $this;
		if ( $nd->parsoid ) {
			$nd->parsoid = $nd->parsoid->clone();
		}
		// Avoid cloning sealed DOMFragments that may occur in expanded attributes
		if ( $nd->mw && $stripSealedFragments && is_array( $nd->mw->attribs ) ) {
			foreach ( $nd->mw->attribs as $attr ) {
				// Look for DOMFragments in both key and value of DataMwAttrib
				foreach ( [ 'key', 'value' ] as $part ) {
					if (
						isset( $attr->$part['html'] ) &&
						str_contains( $attr->$part['html'], 'mw:DOMFragment/sealed' )
					) {
						$doc = DOMUtils::parseHTML( $attr->$part['html'] );
						DOMUtils::visitDOM( $doc, static function ( Node $node ) {
							if (
								DOMUtils::matchTypeOf( $node, '#^mw:DOMFragment/sealed/\w+$#D' )
							) {
								DOMCompat::getParentElement( $node )->removeChild( $node );
							}
						} );
						$attr->$part['html'] = DOMCompat::getInnerHTML( DOMCompat::getBody( $doc ) );
					}
				}
			}
		}
		foreach ( $cloneableData as $key => $value ) {
			$nd->$key = $value;
		}
		return $nd;
	}
}
