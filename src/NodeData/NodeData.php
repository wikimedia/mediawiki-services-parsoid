<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;

// phpcs:disable MediaWiki.Commenting.PropertyDocumentation.ObjectTypeHintVar

/**
 * This object stores data associated with a single DOM node.
 *
 * Using undeclared properties reduces memory usage and CPU time if the
 * property is null in more than about 75% of instances. There are typically
 * a very large number of NodeData objects, so this optimisation is worthwhile.
 *
 * @property object|null $mw_variant
 * @property int|null $storedId
 */
#[\AllowDynamicProperties]
class NodeData {
	/**
	 * The unserialized data-parsoid attribute
	 * @var array|DataParsoid|null
	 */
	public $parsoid = null;

	/**
	 * The unserialized data-mw attribute
	 * @var array|DataMw|null
	 */
	public $mw = null;

	public function __clone() {
		// PHP performs a shallow clone then calls this method.
		// Make a deep clone of every object-valued property.
		// (Note that decoded 'rich attributes' are object-valued properties;
		// undecoded rich attributes and hints are not, but they are immutable
		// and thus don't need to be deep-cloned.)
		foreach ( get_object_vars( $this ) as $k => $v ) {
			if ( $v instanceof DocumentFragment ) {
				$this->$k = DOMDataUtils::cloneDocumentFragment( $v );
			} elseif ( is_object( $v ) ) {
				$this->$k = clone $v;
			}
		}
	}

	/**
	 * Deep clone this object
	 * If $stripSealedFragments is true, sealed DOMFragment included in expanded attributes are deleted in the
	 * clone.
	 *
	 * @param bool $stripSealedFragments
	 * @return static
	 */
	public function cloneNodeData( bool $stripSealedFragments = false ): self {
		$nd = clone $this;

		if ( $this->mw === null || !$stripSealedFragments ) {
			return $nd;
		}

		// It is the responsibility of callers to ensure nd->mw is not in json-blob form.
		// Avoid cloning sealed DOMFragments that may occur in expanded attributes
		foreach ( $nd->mw->attribs ?? [] as $attr ) {
			// Look for DOMFragments in both key and value of DataMwAttrib
			foreach ( [ 'key', 'value' ] as $part ) {
				if ( isset( $attr->$part['html'] ) ) {
					$df = $attr->$part['html'];
					DOMUtils::visitDOM( $df, static function ( Node $node ) {
						if (
							DOMUtils::matchTypeOf( $node, '#^mw:DOMFragment/sealed/\w+$#D' )
						) {
							'@phan-var Element $node';
							DOMCompat::remove( $node );
						}
					} );
				}
			}
		}

		return $nd;
	}
}
