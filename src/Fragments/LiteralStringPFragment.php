<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * A fragment comprised of a literal string, which will be protected from
 * future processing and will be appropriately escaped when embedded in
 * HTML.
 *
 * This fragment is equivalent to the "nowiki" strip state in the
 * legacy parser.  It is an atomic fragment.
 */
class LiteralStringPFragment extends PFragment {

	public const TYPE_HINT = 'lit';

	private string $value;

	private function __construct( string $value, ?DomSourceRange $srcOffsets ) {
		parent::__construct( $srcOffsets );
		$this->value = $value;
	}

	/**
	 * Returns a new LiteralStringPFragment from the given literal string
	 * and optional source offsets.
	 *
	 * Unlike WikitextPFragment, the resulting fragment is atomic: it
	 * will be treated as an opaque strip marker, not escaped wikitext,
	 * and will thus be invisible to future wikitext processing.
	 *
	 * @see WikitextPFragment::newFromLiteral() for a non-atomic fragment
	 *  equivalent.
	 *
	 * @param string $value The literal string
	 * @param ?DomSourceRange $srcOffsets The source range corresponding to
	 *   this literal string, if there is one
	 */
	public static function newFromLiteral( string $value, ?DomSourceRange $srcOffsets ): LiteralStringPFragment {
		return new self( $value, $srcOffsets );
	}

	/** @inheritDoc */
	public function isEmpty(): bool {
		return $this->value === '';
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $extApi, bool $release = false ): DocumentFragment {
		$doc = $extApi->getTopLevelDoc();
		$df = $doc->createDocumentFragment();
		if ( !$this->isEmpty() ) {
			$df->appendChild( $doc->createTextNode( $this->value ) );
		}
		return $df;
	}

	/** @inheritDoc */
	public function asHtmlString( ParsoidExtensionAPI $extApi ): string {
		return Utils::escapeHtml( $this->value );
	}

	// JsonCodecable implementation

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [
			self::TYPE_HINT => $this->value,
		] + parent::toJsonArray();
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): self {
		$v = $json[self::TYPE_HINT];
		return new self( $v, $json['dsr'] ?? null );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === self::TYPE_HINT ) {
			return null; // string
		}
		return parent::jsonClassHintFor( $keyName );
	}
}
