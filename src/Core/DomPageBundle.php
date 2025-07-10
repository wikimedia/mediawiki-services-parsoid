<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Wt2Html\XHtmlSerializer;

/**
 * A page bundle stores an HTML DOM with separated data-parsoid and
 * data-mw content.  The data-parsoid and data-mw content is indexed
 * by the id attributes on individual nodes.  This content needs to
 * be loaded before the data-parsoid and/or data-mw information can be
 * used.
 *
 * Note that the parsoid/mw properties of the page bundle are in "serialized
 * array" form; that is, they are flat arrays appropriate for json-encoding
 * and do not contain DataParsoid or DataMw objects.
 *
 * See PageBundle for a similar structure used where the HTML DOM has been
 * serialized into a string.
 */
class DomPageBundle extends BasePageBundle {
	private bool $invalid = false;

	public function __construct(
		/** The document, as a DOM. */
		public Document $doc,
		?array $parsoid = null, ?array $mw = null,
		?string $version = null, ?array $headers = null,
		?string $contentmodel = null,
	) {
		parent::__construct(
			parsoid: $parsoid,
			mw: $mw,
			version: $version,
			headers: $headers,
			contentmodel: $contentmodel,
		);
		Assert::invariant(
			!self::isSingleDocument( $doc ),
			'single document should be unpacked before DomPageBundle created'
		);
	}

	public static function newEmpty(
		Document $doc,
		?string $version = null,
		?array $headers = null,
		?string $contentmodel = null
	): self {
		return new DomPageBundle(
			$doc,
			[
				'counter' => -1,
				'ids' => [],
			],
			[
				'ids' => [],
			],
			$version,
			$headers,
			$contentmodel
		);
	}

	/**
	 * Create a DomPageBundle from a PageBundle.
	 *
	 * This simply parses the HTML string from the PageBundle, preserving
	 * the metadata.
	 */
	public static function fromPageBundle( PageBundle $pb ): DomPageBundle {
		return new DomPageBundle(
			DOMUtils::parseHTML( $pb->html ),
			$pb->parsoid,
			$pb->mw,
			$pb->version,
			$pb->headers,
			$pb->contentmodel
		);
	}

	/**
	 * Return a DOM from the contents of this page bundle.
	 *
	 * If `$load` is true (the default), the returned DOM will be prepared
	 * and loaded using `$options`.
	 *
	 * If `$load` is false, any data-parsoid or data-mw information from this
	 * page bundle will be converted to inline attributes in the DOM.  This
	 * process is less efficient than preparing and loading the document
	 * directly from the DOM and should be avoided if possible.
	 */
	public function toDom( bool $load = true, ?array $options = null ): Document {
		Assert::invariant( !$this->invalid, "invalidated" );
		$doc = $this->doc;
		if ( $load ) {
			$options ??= [];
			DOMDataUtils::prepareDoc( $doc );
			$body = DOMCompat::getBody( $doc );
			'@phan-var Element $body'; // assert non-null
			DOMDataUtils::visitAndLoadDataAttribs(
				$body,
				[
					'loadFromPageBundle' => $this,
				] + $options + [
					'markNew' => true,
					'validateXMLNames' => true,
				]
			);
			DOMDataUtils::getBag( $doc )->loaded = true;
		} else {
			self::apply( $doc, $this );
		}
		$this->invalid = true;
		return $doc;
	}

	/**
	 * Applies the `data-*` attributes JSON structure to the document.
	 * Leaves `id` attributes behind -- they are used by citation code to
	 * extract `<ref>` body from the DOM.
	 *
	 * @param Document $doc doc
	 * @param DomPageBundle $pb page bundle
	 */
	private static function apply( Document $doc, DomPageBundle $pb ): void {
		Assert::invariant(
			!self::isSingleDocument( $doc ),
			"conflicting page bundle found in document"
		);
		$apply = static function ( Node $node ) use ( $pb ): void {
			if ( $node instanceof Element ) {
				$id = DOMCompat::getAttribute( $node, 'id' );
				if ( $id === null ) {
					return;
				}
				if ( isset( $pb->parsoid['ids'][$id] ) ) {
					DOMDataUtils::setJSONAttribute(
						$node, 'data-parsoid', $pb->parsoid['ids'][$id]
					);
				}
				if ( isset( $pb->mw['ids'][$id] ) ) {
					// Only apply if it isn't already set.  This means
					// earlier applications of the pagebundle have higher
					// precedence, inline data being the highest.
					if ( !$node->hasAttribute( 'data-mw' ) ) {
						DOMDataUtils::setJSONAttribute(
							$node, 'data-mw', $pb->mw['ids'][$id]
						);
					}
				}
			}
		};
		DOMUtils::visitDOM(
			DOMCompat::getBody( $doc ), $apply
		);
		// For fragment bank representations, visit <template> nodes in the
		// <head> as well.
		DOMUtils::visitDOM(
			DOMCompat::getHead( $doc ), $apply
		);
	}

	/**
	 * Create a "PageBundle as single Document" by embedding page bundle
	 * information into a <script> element in the <head> of the DOM.
	 *
	 * @see ::fromSingleDocument()
	 */
	public function toSingleDocument(): Document {
		Assert::invariant( !$this->invalid, "invalidated" );
		$script = DOMUtils::appendToHead( $this->doc, 'script', [
			'id' => 'mw-pagebundle',
			'type' => 'application/x-mw-pagebundle',
		] );
		$script->appendChild( $this->doc->createTextNode( $this->encodeForHeadElement() ) );
		$doc = $this->doc;
		// Invalidate this DomPageBundle to prevent us from using it again.
		$this->invalid = true;
		return $doc;
	}

	/**
	 * Return a DomPageBundle from a "PageBundle as single Document"
	 * representation, where some page bundle information has been embedded
	 * as a <script> element into the <head> of the DOM.
	 *
	 * @see ::toSingleDocument()
	 *
	 * @param Document $doc doc
	 * @param array $options Optional content version/headers/contentmodel
	 * @return DomPageBundle
	 */
	public static function fromSingleDocument( Document $doc, array $options = [] ): DomPageBundle {
		$dpScriptElt = DOMCompat::getElementById( $doc, 'mw-pagebundle' );
		Assert::invariant( $dpScriptElt !== null, "no page bundle found" );
		$dpScriptElt->parentNode->removeChild( $dpScriptElt );
		return self::decodeFromHeadElement( $doc, $dpScriptElt->textContent, $options );
	}

	/**
	 * Create a new DomPageBundle from a "prepared and loaded" document.
	 *
	 * If a `pageBundle` key is present in the options, the
	 * version/headers/contentmodel will be initialized from that
	 * page bundle.
	 *
	 * @param Document $doc Should be "prepared and loaded"
	 * @param array $options store options
	 * @return DomPageBundle
	 */
	public static function fromLoadedDocument( Document $doc, array $options = [] ): DomPageBundle {
		$metadata = $options['pageBundle'] ?? null;
		$dpb = self::newEmpty(
			$doc,
			$metadata->version ?? $options['contentversion'] ?? null,
			$metadata->headers ?? $options['headers'] ?? null,
			$metadata->contentmodel ?? $options['contentmodel'] ?? null
		);
		// XXX We can't create a full idIndex unless we can traverse
		// extension content, which requires an Env or a ParsoidExtensionAPI,
		// but as long as your extension content doesn't contain IDs beginning
		// with 'mw' you'll be fine.
		$env = $options['env'] ?? $options['extAPI'] ?? null;
		DOMDataUtils::visitAndStoreDataAttribs(
			DOMCompat::getBody( $doc ),
			[
				'storeInPageBundle' => $dpb,
				'outputContentVersion' => $dpb->version,
				'idIndex' => DOMDataUtils::usedIdIndex( $env, $doc ),
			] + $options
		);
		return $dpb;
	}

	/**
	 * Return true iff the given Document has page bundle information embedded
	 * as a <script id="mw-pagebundle"> element in its <head>.
	 */
	public static function isSingleDocument( Document $doc ): bool {
		return DOMCompat::getElementById( $doc, 'mw-pagebundle' ) !== null;
	}

	/**
	 * Convert this DomPageBundle to "single document" form, where page bundle
	 * information is embedded in the <head> of the document.
	 * @param array $options XHtmlSerializer options
	 * @return string an HTML string
	 */
	public function toSingleDocumentHtml( array $options = [] ): string {
		Assert::invariant( !$this->invalid, "invalidated" );
		$doc = $this->toSingleDocument();
		return XHtmlSerializer::serialize( $doc, $options )['html'];
	}

	/**
	 * Convert this DomPageBundle to "inline attribute" form, where page bundle
	 * information is represented as inline JSON-valued attributes.
	 * @param array $options XHtmlSerializer options
	 * @return string an HTML string
	 */
	public function toInlineAttributeHtml( array $options = [] ): string {
		Assert::invariant( !$this->invalid, "invalidated" );
		$doc = $this->toDom( false );
		if ( $options['body_only'] ?? false ) {
			$node = DOMCompat::getBody( $doc );
			$options['innerXML'] = true;
		} else {
			$node = $doc;
		}
		return XHtmlSerializer::serialize( $node, $options )['html'];
	}

	/**
	 * Encode some page bundle properties for emitting as a <script> element
	 * in the <head> of a document.
	 */
	private function encodeForHeadElement(): string {
		// Note that $this->parsoid and $this->mw are already serialized arrays
		// so a naive jsonEncode is sufficient.  We don't need a codec.
		return PHPUtils::jsonEncode( [ 'parsoid' => $this->parsoid ?? [], 'mw' => $this->mw ?? [] ] );
	}

	/**
	 * Decode some page bundle properties from the contents of the <script>
	 * element embedded in a document.
	 */
	private static function decodeFromHeadElement( Document $doc, string $s, array $options = [] ): DomPageBundle {
		// Note that only 'parsoid' and 'mw' are encoded, so these will be
		// the only fields set in the decoded DomPageBundle
		$decoded = PHPUtils::jsonDecode( $s );
		return new DomPageBundle(
			$doc,
			$decoded['parsoid'] ?? null,
			$decoded['mw'] ?? null,
			$options['contentversion'] ?? null,
			$options['headers'] ?? null,
			$options['contentmodel'] ?? null
		);
	}

	// JsonCodecable -------------

	/** @inheritDoc */
	public function toJsonArray(): array {
		Assert::invariant( !$this->invalid, "invalidated" );
		return PageBundle::fromDomPageBundle( $this )->toJsonArray();
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DomPageBundle {
		$pb = PageBundle::newFromJsonArray( $json );
		return self::fromPageBundle( $pb );
	}
}
