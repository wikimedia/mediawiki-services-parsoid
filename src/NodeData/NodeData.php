<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;

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

	public function __clone() {
		// PHP performs a shallow clone then calls this method.
		// Make a deep clone of every object-valued property.
		// (Note that decoded 'rich attributes' are object-valued properties;
		// undecoded rich attributes and hints are not, but they are immutable
		// and thus don't need to be deep-cloned.)
		foreach ( get_object_vars( $this ) as $k => $v ) {
			if ( is_object( $v ) ) {
				$this->$k = clone $v;
			}
		}
	}

	/**
	 * Deep clone this object
	 * If $stripSealedFragments is true, sealed DOMFragment included in expanded attributes are deleted in the
	 * clone.
	 * @param bool $stripSealedFragments
	 * @return self
	 */
	public function cloneNodeData( bool $stripSealedFragments = false ): self {
		$nd = clone $this;

		if ( $this->mw === null || !$stripSealedFragments ) {
			return $nd;
		}

		// Avoid cloning sealed DOMFragments that may occur in expanded attributes
		// NOTE that we are removing the sealed DOMFragments from $this, *not*
		// the cloned node data $nd, which will retain the original values.

		foreach ( $this->mw->attribs ?? [] as $attr ) {
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

		return $nd;
	}
}
