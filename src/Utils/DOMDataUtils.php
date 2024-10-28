<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Composer\Semver\Semver;
use InvalidArgumentException;
use stdClass;
use Wikimedia\Assert\Assert;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\NodeData\DataBag;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataMwAttrib;
use Wikimedia\Parsoid\NodeData\DataMwI18n;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\I18nInfo;
use Wikimedia\Parsoid\NodeData\NodeData;
use Wikimedia\Parsoid\NodeData\TempData;

/**
 * These helpers pertain to HTML and data attributes of a node.
 */
class DOMDataUtils {
	public const DATA_OBJECT_ATTR_NAME = 'data-object-id';

	/** The internal property prefix used for rich attribute data. */
	private const RICH_ATTR_DATA_PREFIX = 'rich-data-';

	/** The internal property prefix used for rich attribute type hints. */
	private const RICH_ATTR_HINT_PREFIX = 'rich-hint-';

	/**
	 * Return the dynamic "bag" property of a Document.
	 * @param Document $doc
	 * @return DataBag
	 */
	public static function getBag( Document $doc ): DataBag {
		// This is a dynamic property; it is not declared.
		// All references go through here so we can suppress phan's complaint.
		// @phan-suppress-next-line PhanUndeclaredProperty
		return $doc->bag;
	}

	/**
	 * Return the JsonCodec used for rich attributes in a Document.
	 * @param Document $doc
	 * @return JsonCodec
	 */
	public static function getCodec( Document $doc ): JsonCodec {
		// This is a dynamic property; it is not declared.
		// All references go through here so we can suppress phan's complaint.
		// @phan-suppress-next-line PhanUndeclaredProperty
		return $doc->codec;
	}

	public static function prepareDoc( Document $doc ): void {
		// `bag` is a deliberate dynamic property; see DOMDataUtils::getBag()
		// @phan-suppress-next-line PhanUndeclaredProperty dynamic property
		$doc->bag = new DataBag();
		// `codec` is a deliberate dynamic property; see DOMDataUtils::getCodec()
		// @phan-suppress-next-line PhanUndeclaredProperty dynamic property
		$doc->codec = new JsonCodec();

		// Cache the head and body.
		DOMCompat::getHead( $doc );
		DOMCompat::getBody( $doc );
	}

	/**
	 * @param Document $topLevelDoc
	 * @param Document $childDoc
	 */
	public static function prepareChildDoc( Document $topLevelDoc, Document $childDoc ) {
		// @phan-suppress-next-line PhanUndeclaredProperty dynamic property
		Assert::invariant( $topLevelDoc->bag instanceof DataBag, 'doc bag not set' );
		// @phan-suppress-next-line PhanUndeclaredProperty dynamic property
		$childDoc->bag = $topLevelDoc->bag;
		// @phan-suppress-next-line PhanUndeclaredProperty dynamic property
		$childDoc->codec = $topLevelDoc->codec;
	}

	/**
	 * Stash $obj in $doc and return an id for later retrieval
	 * @param Document $doc
	 * @param NodeData $obj
	 * @return int
	 */
	public static function stashObjectInDoc( Document $doc, NodeData $obj ): int {
		return self::getBag( $doc )->stashObject( $obj );
	}

	/**
	 * Does this node have any attributes?
	 * @param Element $node
	 * @return bool
	 */
	public static function noAttrs( Element $node ): bool {
		// The 'xmlns' attribute is "invisible" T235295
		if ( $node->hasAttribute( 'xmlns' ) ) {
			return false;
		}
		$numAttrs = count( $node->attributes );
		return $numAttrs === 0 ||
			( $numAttrs === 1 && $node->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) );
	}

	/**
	 * Get data object from a node.
	 *
	 * @param Element $node node
	 * @return NodeData
	 */
	public static function getNodeData( Element $node ): NodeData {
		if ( !$node->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) ) {
			// Initialized on first request
			$dataObject = new NodeData;
			self::setNodeData( $node, $dataObject );
			return $dataObject;
		}

		$nodeId = DOMCompat::getAttribute( $node, self::DATA_OBJECT_ATTR_NAME );
		if ( $nodeId !== null ) {
			$dataObject = self::getBag( $node->ownerDocument )->getObject( (int)$nodeId );
		} else {
			$dataObject = null; // Make phan happy
		}
		Assert::invariant( isset( $dataObject ), 'Bogus nodeId given!' );
		if ( isset( $dataObject->storedId ) ) {
			throw new UnreachableException(
				'Trying to fetch node data without loading!' .
				// If this node's data-object id is different from storedId,
				// it will indicate that the data-parsoid object was shared
				// between nodes without getting cloned. Useful for debugging.
				'Node id: ' . $nodeId .
				'Stored data: ' . PHPUtils::jsonEncode( $dataObject )
			);
		}
		return $dataObject;
	}

	/**
	 * Set node data.
	 *
	 * @param Element $node node
	 * @param NodeData $data data
	 */
	public static function setNodeData( Element $node, NodeData $data ): void {
		$nodeId = self::stashObjectInDoc( $node->ownerDocument, $data );
		$node->setAttribute( self::DATA_OBJECT_ATTR_NAME, (string)$nodeId );
	}

	/**
	 * Get data parsoid info from a node.
	 *
	 * @param Element $node node
	 * @return DataParsoid
	 */
	public static function getDataParsoid( Element $node ): DataParsoid {
		$data = self::getNodeData( $node );
		$data->parsoid ??= new DataParsoid;
		return $data->parsoid;
	}

	/**
	 * Set data parsoid info on a node.
	 *
	 * @param Element $node node
	 * @param DataParsoid $dp data-parsoid
	 */
	public static function setDataParsoid( Element $node, DataParsoid $dp ): void {
		$data = self::getNodeData( $node );
		$data->parsoid = $dp;
	}

	/**
	 * Returns the i18n information of a node. This is in private access because it shouldn't
	 * typically be used directly; instead getDataNodeI18n and getDataAttrI18n should be used.
	 * @param Element $node
	 * @return DataMwI18n|null
	 */
	private static function getDataMwI18n( Element $node ): ?DataMwI18n {
		// No default value; returns null if not present.
		return self::getAttributeObject( $node, 'data-mw-i18n', DataMwI18n::hint() );
	}

	/**
	 * Returns the i18n information of a node, setting it to a default
	 * value if it is missing.  This should not typically be used
	 * directly; instead setDataNodeI18n and setDataAttrI18n should be
	 * used.
	 *
	 * @param Element $node
	 * @return DataMwI18n $i18n
	 */
	private static function getDataMwI18nDefault( Element $node ): DataMwI18n {
		return self::getAttributeObjectDefault( $node, 'data-mw-i18n', DataMwI18n::hint() );
	}

	/**
	 * Retrieves internationalization (i18n) information of a node (typically for localization)
	 * @param Element $node
	 * @return ?I18nInfo
	 */
	public static function getDataNodeI18n( Element $node ): ?I18nInfo {
		$i18n = self::getDataMwI18n( $node );
		if ( $i18n === null ) {
			return null;
		}
		return $i18n->getSpanInfo();
	}

	/**
	 * Sets internationalization (i18n) information of a node, used for later localization
	 * @param Element $node
	 * @param I18nInfo $info
	 * @return void
	 */
	public static function setDataNodeI18n( Element $node, I18nInfo $info ) {
		$i18n = self::getDataMwI18nDefault( $node );
		$i18n->setSpanInfo( $info );
	}

	/**
	 * Retrieves internationalization (i18n) information of an attribute value (typically for
	 * localization)
	 * @param Element $node
	 * @param string $name
	 * @return ?I18nInfo
	 */
	public static function getDataAttrI18n( Element $node, string $name ): ?I18nInfo {
		$i18n = self::getDataMwI18n( $node );
		if ( $i18n === null ) {
			return null;
		}
		return $i18n->getAttributeInfo( $name );
	}

	/**
	 * Sets internationalization (i18n) information of a attribute value, used for later
	 * localization
	 * @param Element $node
	 * @param string $name
	 * @param I18nInfo $info
	 * @return void
	 */
	public static function setDataAttrI18n( Element $node, string $name, I18nInfo $info ) {
		$i18n = self::getDataMwI18nDefault( $node );
		$i18n->setAttributeInfo( $name, $info );
	}

	/**
	 * @param Element $node
	 * @return array
	 */
	public static function getDataAttrI18nNames( Element $node ): array {
		$i18n = self::getDataMwI18n( $node );
		if ( $i18n === null ) {
			// We won't set a default value for this property
			return [];
		}
		return $i18n->getAttributeNames();
	}

	/**
	 * Get data diff info from a node.
	 *
	 * @param Element $node node
	 * @return ?stdClass
	 */
	public static function getDataParsoidDiff( Element $node ): ?stdClass {
		$data = self::getNodeData( $node );
		// We won't set a default value for this property
		return $data->parsoid_diff ?? null;
	}

	/**
	 * Set data diff info on a node.
	 *
	 * @param Element $node node
	 * @param ?stdClass $diffObj data-parsoid-diff object
	 */
	public static function setDataParsoidDiff( Element $node, ?stdClass $diffObj ): void {
		$data = self::getNodeData( $node );
		$data->parsoid_diff = $diffObj;
	}

	/**
	 * Get data meta wiki info from a node.
	 *
	 * @param Element $node node
	 * @return DataMw
	 */
	public static function getDataMw( Element $node ): DataMw {
		$data = self::getNodeData( $node );
		$data->mw ??= new DataMw;
		return $data->mw;
	}

	/**
	 * Set data meta wiki info from a node.
	 *
	 * @param Element $node node
	 * @param ?DataMw $dmw data-mw
	 */
	public static function setDataMw( Element $node, ?DataMw $dmw ): void {
		$data = self::getNodeData( $node );
		$data->mw = $dmw;
	}

	/**
	 * Check if there is meta wiki info in a node.
	 *
	 * @param Element $node node
	 * @return bool
	 */
	public static function validDataMw( Element $node ): bool {
		return (array)self::getDataMw( $node ) !== [];
	}

	/**
	 * Get an object from a JSON-encoded XML attribute on a node.
	 *
	 * @param Element $node node
	 * @param string $name name
	 * @param mixed $defaultVal
	 * @return mixed
	 */
	public static function getJSONAttribute( Element $node, string $name, $defaultVal ) {
		$attVal = DOMCompat::getAttribute( $node, $name );
		if ( $attVal === null ) {
			return $defaultVal;
		}
		$decoded = PHPUtils::jsonDecode( $attVal, false );
		if ( $decoded !== null ) {
			return $decoded;
		} else {
			error_log( 'ERROR: Could not decode attribute-val ' . $attVal .
				' for ' . $name . ' on node ' . DOMCompat::nodeName( $node ) );
			return $defaultVal;
		}
	}

	/**
	 * Set a attribute on a node with a JSON-encoded object.
	 *
	 * @param Element $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $obj value of the attribute to
	 */
	public static function setJSONAttribute( Element $node, string $name, $obj ): void {
		$val = $obj === [] ? '{}' : PHPUtils::jsonEncode( $obj );
		$node->setAttribute( $name, $val );
	}

	// Shadow attributes should probably be unified with rich attributes
	// at some point. [CSA 2024-10-15]

	/**
	 * Set shadow info on a node; similar to the method on tokens.
	 * Records a key = value pair in data-parsoid['a'] property.
	 *
	 * This is effectively a call of 'setShadowInfoIfModified' except
	 * there is no original value, so by definition, $val is modified.
	 *
	 * @param Element $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $val val
	 */
	public static function setShadowInfo( Element $node, string $name, $val ): void {
		$dp = self::getDataParsoid( $node );
		$dp->a ??= [];
		$dp->sa ??= [];
		$dp->a[$name] = $val;
	}

	/**
	 * Set shadow info on a node; similar to the method on tokens.
	 *
	 * If the new value ($val) for the key ($name) is different from the
	 * original value ($origVal):
	 * - the new value is recorded in data-parsoid->a and
	 * - the original value is recorded in data-parsoid->sa
	 *
	 * @param Element $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $val val
	 * @param mixed $origVal original value (null is a valid value)
	 * @param bool $skipOrig
	 */
	public static function setShadowInfoIfModified(
		Element $node, string $name, $val, $origVal, bool $skipOrig = false
	): void {
		if ( !$skipOrig && ( $val === $origVal || $origVal === null ) ) {
			return;
		}
		$dp = self::getDataParsoid( $node );
		$dp->a ??= [];
		$dp->sa ??= [];
		// FIXME: This is a hack to not overwrite already shadowed info.
		// We should either fix the call site that depends on this
		// behaviour to do an explicit check, or double down on this
		// by porting it to the token method as well.
		if ( !$skipOrig && !array_key_exists( $name, $dp->a ) ) {
			$dp->sa[$name] = $origVal;
		}
		$dp->a[$name] = $val;
	}

	/**
	 * Set an attribute and shadow info to a node.
	 * Similar to the method on tokens
	 *
	 * @param Element $node node
	 * @param string $name Name of the attribute.
	 * @param mixed $val value
	 * @param mixed $origVal original value
	 * @param bool $skipOrig
	 */
	public static function addNormalizedAttribute(
		Element $node, string $name, $val, $origVal, bool $skipOrig = false
	): void {
		if ( $name === 'id' ) {
			DOMCompat::setIdAttribute( $node, $val );
		} else {
			$node->setAttribute( $name, $val );
		}
		self::setShadowInfoIfModified( $node, $name, $val, $origVal, $skipOrig );
	}

	/**
	 * Get this document's pagebundle object
	 * @param Document $doc
	 * @return PageBundle
	 */
	public static function getPageBundle( Document $doc ): PageBundle {
		return self::getBag( $doc )->getPageBundle();
	}

	/**
	 * Removes the `data-*` attribute from a node, and migrates the data to the
	 * document's JSON store. Generates a unique id with the following format:
	 * ```
	 * mw<base64-encoded counter>
	 * ```
	 * but attempts to keep user defined ids.
	 *
	 * TODO: Note that $data is effective a partial PageBundle containing
	 * only the 'parsoid' and 'mw' properties.
	 *
	 * @param Element $node node
	 * @param stdClass $data data
	 * @param array $idIndex Index of used id attributes in the DOM
	 */
	public static function storeInPageBundle(
		Element $node, stdClass $data, array $idIndex
	): void {
		$hints = self::getCodecHints();
		$uid = DOMCompat::getAttribute( $node, 'id' );
		$document = $node->ownerDocument;
		$pb = self::getPageBundle( $document );
		$codec = self::getCodec( $document );
		$docDp = &$pb->parsoid;
		$origId = $uid;
		if ( $uid !== null && array_key_exists( $uid, $docDp['ids'] ) ) {
			$uid = null;
		}
		if ( $uid === '' ) {
			$uid = null;
		}
		if ( $uid === null ) {
			do {
				$docDp['counter'] += 1;
				// PORT-FIXME: NOTE that we aren't updating the idIndex here because
				// we are generating unique ids that will not conflict. In any case,
				// the idIndex is a workaround for the PHP DOM's issues and we might
				// switch out of this in the future anyway.
				$uid = 'mw' . PHPUtils::counterToBase64( $docDp['counter'] );
			} while ( isset( $idIndex[$uid] ) );
			self::addNormalizedAttribute( $node, 'id', $uid, $origId );
		}
		// Convert from DataParsoid/DataMw objects to associative array
		$docDp['ids'][$uid] = $codec->toJsonArray( $data->parsoid, $hints['data-parsoid'] );
		if ( isset( $data->mw ) ) {
			$pb->mw['ids'][$uid] = $codec->toJsonArray( $data->mw, $hints['data-mw'] );
		}
	}

	/**
	 * Helper function to create static Hint objects for JsonCodec.
	 * @return array<Hint>
	 */
	public static function getCodecHints(): array {
		static $hints = null;
		if ( $hints === null ) {
			$hints = [
				'data-parsoid' => Hint::build( DataParsoid::class, Hint::ALLOW_OBJECT ),
				'data-mw' => Hint::build( DataMw::class, Hint::ALLOW_OBJECT ),
			];
		}
		return $hints;
	}

	/**
	 * @param Document $doc doc
	 * @param PageBundle $pb object
	 */
	public static function injectPageBundle( Document $doc, PageBundle $pb ): void {
		$script = DOMUtils::appendToHead( $doc, 'script', [
			'id' => 'mw-pagebundle',
			'type' => 'application/x-mw-pagebundle',
		] );
		$script->appendChild( $doc->createTextNode( $pb->encodeForHeadElement() ) );
	}

	/**
	 * @param Document $doc doc
	 * @return ?PageBundle
	 */
	public static function extractPageBundle( Document $doc ): ?PageBundle {
		$pb = null;
		$dpScriptElt = DOMCompat::getElementById( $doc, 'mw-pagebundle' );
		if ( $dpScriptElt ) {
			$dpScriptElt->parentNode->removeChild( $dpScriptElt );
			$pb = PageBundle::decodeFromHeadElement( $dpScriptElt->textContent );
		}
		return $pb;
	}

	/**
	 * Walk DOM from node downward calling loadDataAttribs
	 *
	 * @param Node $node node
	 * @param array $options options
	 */
	public static function visitAndLoadDataAttribs( Node $node, array $options = [] ): void {
		DOMUtils::visitDOM( $node, [ self::class, 'loadDataAttribs' ], $options );
	}

	/**
	 * These are intended be used on a document after post-processing, so that
	 * the underlying .dataobject is transparently applied (in the store case)
	 * and reloaded (in the load case), rather than worrying about keeping
	 * the attributes up-to-date throughout that phase.  For the most part,
	 * using this.ppTo* should be sufficient and using these directly should be
	 * avoided.
	 *
	 * @param Node $node node
	 * @param array $options options
	 */
	public static function loadDataAttribs( Node $node, array $options ): void {
		if ( !( $node instanceof Element ) ) {
			return;
		}
		// Reset the node data object's stored state, since we're reloading it
		self::setNodeData( $node, new NodeData );
		$codec = self::getCodec( $node->ownerDocument );
		$dataParsoidAttr = DOMCompat::getAttribute( $node, 'data-parsoid' );
		$dp = $codec->newFromJsonString(
			$dataParsoidAttr ?? '{}', self::getCodecHints()['data-parsoid']
		);
		if ( !empty( $options['markNew'] ) ) {
			$dp->setTempFlag( TempData::IS_NEW, $dataParsoidAttr === null );
		}
		self::setDataParsoid( $node, $dp );
		$node->removeAttribute( 'data-parsoid' );

		$dataMwAttr = DOMCompat::getAttribute( $node, 'data-mw' );
		$dmw = $dataMwAttr === null ? null :
			$codec->newFromJsonString( $dataMwAttr, self::getCodecHints()['data-mw'] );
		self::setDataMw( $node, $dmw );
		$node->removeAttribute( 'data-mw' );

		$dpd = self::getJSONAttribute( $node, 'data-parsoid-diff', null );
		self::setDataParsoidDiff( $node, $dpd );
		$node->removeAttribute( 'data-parsoid-diff' );

		// We don't load rich attributes here: that will be done lazily as
		// getAttributeObject()/etc methods are called because we don't
		// know the true types of the rich values yet.  In the future
		// we might have a schema or self-labelling of values which would
		// allow us to load rich attributes here as well.
	}

	/**
	 * Builds an index of id attributes seen in the DOM
	 * @param Node $node
	 * @return array
	 */
	public static function usedIdIndex( Node $node ): array {
		$index = [];
		DOMUtils::visitDOM( DOMCompat::getBody( $node->ownerDocument ),
			static function ( Node $n, ?array $options = null ) use ( &$index ) {
				if ( $n instanceof Element ) {
					$id = DOMCompat::getAttribute( $n, 'id' );
					if ( $id !== null ) {
						$index[$id] = true;
					}
				}
			},
			[]
		);
		return $index;
	}

	/**
	 * Walk DOM from node downward calling storeDataAttribs
	 *
	 * @param Node $node node
	 * @param array $options options
	 */
	public static function visitAndStoreDataAttribs( Node $node, array $options = [] ): void {
		// PORT-FIXME: storeDataAttribs calls storeInPageBundle which calls getElementById.
		// PHP's `getElementById` implementation is broken, and we work around that by
		// using Zest which uses XPath. So, getElementById call can be O(n) and calling it
		// on on every element of the DOM via vistDOM here makes it O(n^2) instead of O(n).
		// So, we work around that by building an index and avoiding getElementById entirely
		// in storeInPageBundle.
		if ( !empty( $options['storeInPageBundle'] ) ) {
			$options['idIndex'] = self::usedIdIndex( $node );
		}
		DOMUtils::visitDOM( $node, [ self::class, 'storeDataAttribs' ], $options );
	}

	/**
	 * Copy data attributes from the bag to either JSON-encoded attributes on
	 * each node, or the page bundle, erasing the data-object-id attributes.
	 *
	 * @param Node $node node
	 * @param ?array $options options
	 *   - discardDataParsoid: Discard DataParsoid objects instead of storing them
	 *   - keepTmp: Preserve DataParsoid::$tmp
	 *   - storeInPageBundle: If true, data will be stored in the page bundle
	 *     instead of data-parsoid and data-mw.
	 *   - env: The Env object required for various features
	 *   - idIndex: Array of used ID attributes
	 */
	public static function storeDataAttribs( Node $node, ?array $options = null ): void {
		$hints = self::getCodecHints();
		$options ??= [];
		if ( !( $node instanceof Element ) ) {
			return;
		}

		// Store rich attributes.  Note that, at present, rich attributes may
		// be serialized into the data-mw attributes which are serialized in
		// the pagebundle; thus we need to serialize all the "attributes
		// with special html semantics" (which will get added to data-mw)
		// *before* we handle the other attributes and the page bundle.
		self::storeRichAttributes( $node, [ 'onlySpecial' => true ] + $options );

		Assert::invariant( empty( $options['discardDataParsoid'] ) || empty( $options['keepTmp'] ),
			'Conflicting options: discardDataParsoid and keepTmp are both enabled.' );
		$codec = self::getCodec( $node->ownerDocument );
		$dp = self::getDataParsoid( $node );
		$discardDataParsoid = !empty( $options['discardDataParsoid'] );
		if ( $dp->getTempFlag( TempData::IS_NEW ) ) {
			// Only necessary to support the cite extension's getById,
			// that's already been loaded once.
			//
			// This is basically a hack to ensure that DOMUtils.isNewElt
			// continues to work since we effectively rely on the absence
			// of data-parsoid to identify new elements. But, loadDataAttribs
			// creates an empty {} if one doesn't exist. So, this hack
			// ensures that a loadDataAttribs + storeDataAttribs pair don't
			// dirty the node by introducing an empty data-parsoid attribute
			// where one didn't exist before.
			//
			// Ideally, we'll find a better solution for this edge case later.
			$discardDataParsoid = true;
		}
		$data = null;
		if ( !$discardDataParsoid ) {
			if ( empty( $options['keepTmp'] ) ) {
				// @phan-suppress-next-line PhanTypeObjectUnsetDeclaredProperty
				unset( $dp->tmp );
			}

			if ( !empty( $options['storeInPageBundle'] ) ) {
				$data ??= new stdClass;
				$data->parsoid = $dp;
			} else {
				$node->setAttribute(
					'data-parsoid',
					PHPUtils::jsonEncode(
						$codec->toJsonArray( $dp, $hints['data-parsoid'] )
					)
				);
			}
		}

		// Special handling for data-mw.  This should eventually go away
		// and be replaced with the standard "rich attribute" handling:
		// (a) now that DataMw is a class type, we should never actually
		// have "invalid" data mw objects in practice;
		// (b) eventually we can remove support for output content version
		// older than 999.x.

		// Strip invalid data-mw attributes
		if ( self::validDataMw( $node ) ) {
			if (
				!empty( $options['storeInPageBundle'] ) && isset( $options['env'] ) &&
				// The pagebundle didn't have data-mw before 999.x
				Semver::satisfies( $options['env']->getOutputContentVersion(), '^999.0.0' )
			) {
				$data ??= new stdClass;
				$data->mw = self::getDataMw( $node );
			} else {
				$node->setAttribute(
					'data-mw',
					PHPUtils::jsonEncode(
						$codec->toJsonArray( self::getDataMw( $node ), $hints['data-mw'] )
					)
				);
			}
		}

		// Serialize the rest of the rich attributes
		// (This will eventually include data-mw.)
		self::storeRichAttributes( $node, $options );

		// Store pagebundle
		if ( $data !== null ) {
			self::storeInPageBundle( $node, $data, $options['idIndex'] );
		}

		// Indicate that this node's data has been stored so that if we try
		// to access it after the fact we're aware and remove the attribute
		// since it's no longer needed.
		$nd = self::getNodeData( $node );
		$id = DOMCompat::getAttribute( $node, self::DATA_OBJECT_ATTR_NAME );
		$nd->storedId = $id !== null ? intval( $id ) : null;
		$node->removeAttribute( self::DATA_OBJECT_ATTR_NAME );
	}

	/**
	 * Clones a node and its data bag
	 * @param Element $elt
	 * @param bool $deep
	 * @return Element
	 */
	public static function cloneNode( Element $elt, bool $deep ): Element {
		$clone = $elt->cloneNode( $deep );
		'@phan-var Element $clone'; // @var Element $clone
		// We do not need to worry about $deep because a shallow clone does not have child nodes,
		// so it's always cloning data on the cloned tree (which may be empty).
		self::fixClonedData( $clone );
		return $clone;
	}

	/**
	 * Recursively fixes cloned data from $elt: to avoid conflicts of element IDs, we clone the
	 * data and set it in the node with a new element ID (which setNodeData does).
	 * @param Element $elt
	 */
	private static function fixClonedData( Element $elt ) {
		if ( $elt->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) ) {
			self::setNodeData( $elt, self::getNodeData( $elt )->cloneNodeData() );
		}
		foreach ( $elt->childNodes as $child ) {
			if ( $child instanceof Element ) {
				self::fixClonedData( $child );
			}
		}
	}

	// This is a generic (and somewhat optimistic) interface for
	// complex-valued attributes in a DOM tree.  The object and DOM
	// values are "live"; that is, they are passed by-reference and
	// mutations to the object and DOM persist in the document.
	// These values are only "frozen" into a standards-compliant
	// HTML5 attribute representation when the document is serialized.
	// (A corresponding 'parse' stage needs to occur on a new document
	// to "thaw out" the HTML5 attribute representations.)

	// Note that although we are expanding the possible attribute *values*
	// we are still deliberately keeping attribute *names* restricted.
	// This is a deliberate design choice.  Dynamically-generated
	// attribute names are best handled by the "key value pair"
	// fragment datatype, which is one of the fragment types from which
	// the output document can be composed -- but that composition
	// mechanism and the way the fragment composition is reflected in
	// the DOM is out-of-scope for this API.  This just provides a
	// richer way to embed complex information of that sort into a
	// DOM document.

	// An important design decision here was not to embed type information
	// for attributes into the representation, which is done to avoid
	// HTML bloat.  This leads directly to a "lazy load" implementation,
	// as we can't actually load an attribute value until we know what
	// its class type is, and that's only provided when the call to
	// ::getAttributeObject() is made.  In order to implement an "eager
	// load" implementation, we would need a schema for the document
	// which maps every named attribute to an appropriate type.  This
	// is possible if eager loading is desired in the future, or because
	// you like the added structural documentation provided by a schema.

	// Certain attributes have semantics given by HTML.  For example,
	// the `class` and `alt` attributes shouldn't be serialized as a
	// JSON blob, even if you want to store a rich value.  For these
	// "HTML attributes with special semantics" (everything not
	// starting with data-* at the moment) we tolerate a bit of bloat
	// and store a flattened string representation of the rich value
	// in the direct HTML attribute, and store the serialized rich
	// value elsewhere. This value is used to provide the appropriate
	// HTML semantics (ie, the browser will apply CSS styling to the
	// flattened `class`, use the flattened `href` to navigate) but
	// should not be used by clients /of the MediaWiki DOM spec/
	// (including Parsoid), which should ignore the flattened value
	// and consistently use the rich value in order to avoid
	// losing/overwriting data.

	// The JSON representation of a rich valued attribute can be
	// customized using the mechanisms provided by the wikimedia/json-codec
	// library; in particular you will want to use the "implicit typing"
	// mechanism provided by the library to avoid bloating the output
	// with explicit references to the PHP implementation classes.

	// See
	// https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec/Rich_Attributes
	// for a more detailed discussion of this design.  The present
	// implementation corresponds to "proposal 1a", the first step in
	// the full proposal.

	/**
	 * Determine whether the given attribute name has "special" HTML
	 * semantics.  For these attributes, a "stringified" flattened
	 * version of the attribute is stored in the attribute, for
	 * semantic compatibility with browsers etc, and the "rich" form
	 * of the attribute is stored in a separate attribute.
	 *
	 * Although in theory we could minimize this by looking at the
	 * names of attributes explicitly reserved for each tag name in
	 * the HTML spec, at this time we're going to be conservative and
	 * assume every attribute has "special" semantics that we should
	 * preserve except for those attributes whose names begin with
	 * `data-*`.
	 *
	 * In the future we might tweak the set of attributes with special
	 * semantics in order to reduce unnecessary bloat (ie storing
	 * flattened versions of attributes where the flattened value will
	 * never be used) and/or to include flattened values for certain
	 * data-* attributes (for example, if a gadget were to rely on a
	 * flattened value in `data-time`).
	 *
	 * @param string $tagName The tag name of the Element containing the
	 *   attribute
	 * @param string $attrName The name of the attribute
	 * @return bool True if the named attribute has special HTML semantics
	 */
	private static function isHtmlAttributeWithSpecialSemantics( string $tagName, string $attrName ): bool {
		return !(bool)preg_match( '/^data-/i', $attrName );
	}

	/**
	 * Return the value of a rich attribute as a live (by-reference) object.
	 * This also serves as an assertion that there are not conflicting types.
	 *
	 * @phan-template T
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 * @param class-string<T>|Hint<T> $classHint
	 * @return ?T The attribute value, or null if not present.
	 */
	public static function getAttributeObject(
		Element $node, string $name, $classHint
	): ?object {
		self::loadRichAttributes( $node, $name ); // lazy load
		if ( !$node->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) ) {
			// Don't create an empty node data object if we don't need to.
			return null;
		}
		$nodeData = self::getNodeData( $node );
		$propName = self::RICH_ATTR_DATA_PREFIX . $name;
		$value = $nodeData->$propName ?? null;
		// We lazily decode rich values, because we need to know the $classHint
		// before we decode.  Undecoded values are wrapped with an array so
		// we can tell whether the value has been decoded already or not.
		if ( is_array( $value ) ) {
			// This value should be decoded
			$codec = self::getCodec( $node->ownerDocument );
			$value = $codec->newFromJsonArray( $value[0], $classHint );
			if ( is_array( $value ) ) {
				// JsonCodec allows class hints to indicate that the value
				// is an array of some object type, but for our purposes
				// the result must always be an object so that it is live.
				$value = (object)$value;
			}
			// To signal that it's been decoded already we need $value
			// not to be an array
			Assert::invariant(
				!is_array( $value ), "rich attribute can't be array"
			);
			$nodeData->$propName = $value;
			$hintName = self::RICH_ATTR_HINT_PREFIX . $name;
			$nodeData->$hintName = $classHint;
		}
		return $value;
	}

	/**
	 * Return the value of a rich attribute as a live (by-reference)
	 * object.  This also serves as an assertion that there are not
	 * conflicting types.  If the value is not present and the class
	 * hint is a RichCodecable, a default value will be created using
	 * `$className::defaultValue()` and stored as the value of the
	 * attribute.
	 *
	 * @note The $className should have be JsonCodecable (either directly
	 *  or via a custom JsonClassCodec).
	 *
	 * @phan-template T
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 * @param class-string<T>|Hint<T> $classHint
	 * @return ?T The attribute value, or null if not present.
	 */
	public static function getAttributeObjectDefault(
		Element $node, string $name, $classHint
	): ?object {
		$value = self::getAttributeObject( $node, $name, $classHint );
		if ( $value === null ) {
			$className = $classHint;
			while ( $className instanceof Hint ) {
				Assert::invariant(
					$className->modifier !== Hint::LIST &&
					$className->modifier !== Hint::STDCLASS,
					"Can't create default value for list or object"
				);
				$className = $className->parent;
			}
			'@phan-var string $className';
			if ( is_a( $className, RichCodecable::class, true ) ) {
				$value = $className::defaultValue();
			}
			$value ??= new $className;
			self::setAttributeObject( $node, $name, $value, $classHint );
		}
		return $value;
	}

	/**
	 * Set the value of a rich attribute, overwriting any previous
	 * value.  Generally mutating the result returned by the
	 * `::getAttribute*Default()` methods should be done instead of
	 * using this method, since the objects returned are live.
	 *
	 * @note For attribute names where
	 *  `::isHtmlAttributeWithSpecialSemantics()` returns `true` you
	 *  can customize the "flattened" representation used for HTML
	 *  semantics by having the value implement `RichCodecable::flatten()`.
	 *
	 * @phan-template T
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 * @phan-suppress-next-line PhanTypeMismatchDeclaredParam
	 * @param T $value The new (object) value for the attribute
	 * @param class-string<T>|Hint<T>|null $classHint Optional serialization hint
	 * @phpcs:ignore MediaWiki.Commenting.FunctionAnnotations.UnrecognizedAnnotation
	 * @phan-suppress-next-next-line PhanTemplateTypeNotUsedInFunctionReturn
	 */
	public static function setAttributeObject(
		Element $node, string $name, object $value, $classHint = null
	): void {
		// Remove attribute from DOM; will be rewritten from node data during
		// serialization.
		self::removeAttributeObject( $node, $name );
		$nodeData = self::getNodeData( $node );
		$propName = self::RICH_ATTR_DATA_PREFIX . $name;
		$nodeData->$propName = $value;
		if ( $classHint === null && is_a( $value, RichCodecable::class ) ) {
			$className = get_class( $value );
			$classHint = $className::hint();
		}
		$hintName = self::RICH_ATTR_HINT_PREFIX . $name;
		$nodeData->$hintName = $classHint;
	}

	/**
	 * Remove a rich attribute.
	 *
	 * @param Element $node The node on which the attribute is to be found.
	 * @param string $name The name of the attribute.
	 */
	public static function removeAttributeObject(
		Element $node, string $name
	): void {
		$node->removeAttribute( $name );
		self::removeFromExpandedAttrs( $node, $name );
		if ( $node->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) ) {
			$nodeData = self::getNodeData( $node );
			$propName = self::RICH_ATTR_DATA_PREFIX . $name;
			unset( $nodeData->$propName );
			$hintName = self::RICH_ATTR_HINT_PREFIX . $name;
			unset( $nodeData->$hintName );
		}
	}

	/**
	 * Helper function for code clarity: test whether there is
	 * an existing data-mw value on a node which has already had
	 * loadDataAttribs called on it.
	 */
	private static function nodeHasDataMw( Element $node ): bool {
		// If data-mw were present, loadDataAttribs would have created
		// the DATA_OBJECT_ATTR_NAME attribute for associated NodeData
		if ( !$node->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) ) {
			return false;
		}
		$data = self::getNodeData( $node );
		return $data->mw !== null;
	}

	/**
	 * Helper function to remove any entries from data-mw.attribs which match
	 * this attribute name.  They will be rewritten during rich attribute
	 * serialization if necessary.
	 * @param Element $node
	 * @param string $name
	 */
	private static function removeFromExpandedAttrs(
		Element $node, string $name
	): void {
		// Don't create a new data-mw yet if we don't need one.
		if ( !self::nodehasDataMw( $node ) ) {
			return;
		}
		if ( !self::isHtmlAttributeWithSpecialSemantics( $node->tagName, $name ) ) {
			return;
		}
		// If there was a data-mw.attribs for this attribute, remove it
		// (it will be rewritten during serialization later)
		$dataMw = self::getDataMw( $node );
		$dataMw->attribs = array_values( array_filter(
			$dataMw->attribs ?? [],
			static function ( $a ) use ( $name ) {
				if ( !( $a instanceof DataMwAttrib ) ) {
					return true;
				}
				$key = $a->key;
				if ( $key === $name ) {
					return false; // Remove this entry
				}
				if ( is_array( $key ) && ( $key['txt'] ?? null ) == $name ) {
					return false; // Remove this entry
				}
				return true;
			}
		) );
		if ( count( $dataMw->attribs ) === 0 ) {
			unset( $dataMw->attribs );
			DOMUtils::removeTypeOf( $node, 'mw:ExpandedAttrs' );
		}
	}

	// Serialization/deserialization support for rich attributes.

	// There are many possible serializations which could be used.
	// For the moment we've chosen the simplest possible one, which
	// embeds big JSON blobs in attribute values.  For "attributes
	// with special HTML semantics" the JSON blobs are stored in
	// data-mw.attribs and the straight HTML attribute value is a
	// flattened form of the true value.

	/**
	 * Internal function to lazy-load rich attribute data from the HTML
	 * DOM representation.
	 * @param Element $node The node possibly containing the rich attribute
	 * @param string $name The attribute name we are going to load values for
	 */
	private static function loadRichAttributes(
		Element $node, string $name
	): void {
		// Because we don't have a complete schema for the document which
		// identifies which attributes are 'rich' and which are not, we
		// lazily-load attributes one-by-one once we know their names and types
		// instead of trying to preload them in bulk.

		// *However* in order to avoid O(N^2) manipulation of the
		// data-mw.attribs list, we do move all the values from data-mw.attribs
		// into NodeData, even those not matching our given name.  We can't
		// decode those yet: they will be decoded once getAttributeObject()
		// is called on them to provide the proper type hint (or else they
		// will eventually be reserialized in their undecoded form).

		$flatValue = DOMCompat::getAttribute( $node, $name );
		if ( $flatValue === null ) {
			// Use the presence of the attribute in the DOM to indicate
			// whether this attribute has been loaded; this avoids (for
			// example) traversing AttributeExpander entries in
			// data-mw.attribs multiple times looking for the name of a
			// rich attribute.  If the attribute is not in the DOM either
			// there is no attribute of this name or it has already been
			// loaded.
			return;
		}

		if ( self::isHtmlAttributeWithSpecialSemantics( $node->tagName, $name ) ) {
			// Look aside at data-mw for attributes with special semantics
			if ( !self::nodeHasDataMw( $node ) ) {
				// No data-mw, so no rich value for this attribute
				return;
			}
			$dataMw = self::getDataMw( $node );
			// Load all attribute values from $dataMw->attribs to avoid O(N^2)
			// loading of list
			if ( $dataMw->attribs ?? false ) {
				$unused = [];
				foreach ( $dataMw->attribs as $a ) {
					if ( $a instanceof DataMwAttrib ) {
						$key = $a->key;
						$value = $a->value;
						// Attribute expander may use array values for
						// key, since it supports rich key values.
						// Ignore any entries created this way, since
						// we can't preserve their values: they will be
						// added to $unused and replaced.
						if ( is_string( $key ) || is_numeric( $key ) ) {
							$propName = self::RICH_ATTR_DATA_PREFIX . $key;
							$nodeData = self::getNodeData( $node );
							// wrap $value with an array to indicate that
							// is it not yet decoded. Preserve the flattened
							// value as well in case we round-trip without
							// modifying this value.
							$nodeData->$propName = [ $value, $flatValue ];
							// Signal that the value has been moved to NodeData
							// (this will also short cut this iteration over
							// data-mw.attribs in future calls)
							$node->removeAttribute( $key );
							continue;
						}
					}
					$unused[] = $a;
				}
				if ( count( $unused ) === 0 ) {
					unset( $dataMw->attribs );
				} else {
					$dataMw->attribs = $unused;
				}
			}
			return;
		}
		// The attribute does not have "special HTML semantics"
		$decoded = json_decode( $flatValue, false );
		// $decoded is the 'non-string' form of the value; we can't finish
		// deserializing it into an object until we know the appropriate type
		// hint.
		self::removeAttributeObject( $node, $name );
		$nodeData = self::getNodeData( $node );
		$propName = self::RICH_ATTR_DATA_PREFIX . $name;
		// Mark this as undecoded by wrapping it as an array,
		// since decoded values will always be objects.
		// (Attribute values without "special HTML semantics" do not
		// have flattened versions, so 2nd element to this array isn't
		// needed.)
		$nodeData->$propName = [ $decoded ];
	}

	/**
	 * Internal function to encode rich attribute data into an HTML
	 * DOM representation.
	 * @param Element $node The node possibly containing the rich attribute
	 * @param array $options The options provided to ::storeDataAttribs()
	 */
	private static function storeRichAttributes( Element $node, array $options ): void {
		if ( !$node->hasAttribute( self::DATA_OBJECT_ATTR_NAME ) ) {
			return; // No rich attributes here
		}
		$tagName = $node->tagName;
		$nodeData = self::getNodeData( $node );
		$codec = self::getCodec( $node->ownerDocument );
		foreach ( get_object_vars( $nodeData ) as $k => $v ) {
			// Look for dynamic properties with names w/ the proper prefix
			if ( str_starts_with( $k, self::RICH_ATTR_DATA_PREFIX ) ) {
				$attrName = substr( $k, strlen( self::RICH_ATTR_DATA_PREFIX ) );
				if (
					( $options['onlySpecial'] ?? false ) &&
					!self::isHtmlAttributeWithSpecialSemantics( $tagName, $attrName )
				) {
					continue; // skip this for now
				}
				$flat = null;
				if ( is_array( $v ) ) {
					// If $v is an array, it was never decoded.
					$json = $v[0];
					$flat = $v[1] ?? null;
				} else {
					$hintName = self::RICH_ATTR_HINT_PREFIX . $attrName;
					$classHint = $nodeData->$hintName ?? null;
					if ( is_a( $v, RichCodecable::class ) ) {
						$classHint ??= $v::hint();
						$flat = $v->flatten();
					}
					$classHint ??= get_class( $v );
					try {
						$json = $codec->toJsonArray( $v, $classHint );
					} catch ( InvalidArgumentException $e ) {
						// For better debuggability, include the attribute name
						throw new InvalidArgumentException( "$attrName: " . $e->getMessage() );
					}
				}
				if ( !self::isHtmlAttributeWithSpecialSemantics( $tagName, $attrName ) ) {
					$encoded = PHPUtils::jsonEncode( $json );
					$node->setAttribute( $attrName, $encoded );
				} else {
					// For compatibility, store the rich value in data-mw.attrs
					// and store a flattened version in the $attrName.
					if ( $flat !== null ) {
						$node->setAttribute( $attrName, $flat );
					} else {
						$node->removeAttribute( $attrName );
					}
					$dataMw = self::getDataMw( $node );
					$dataMw->attribs[] = new DataMwAttrib( $attrName, $json );
					DOMUtils::addTypeOf( $node, 'mw:ExpandedAttrs' );
				}
				unset( $nodeData->$k );
			}
		}
	}
}
