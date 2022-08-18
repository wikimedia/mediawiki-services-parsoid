<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdclass;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\JsonCodecableWithCodecTrait;

/**
 * Represents a filter rule.
 */
class VariantFilter implements JsonCodecable {
	use JsonCodecableWithCodecTrait;

	/**
	 * Create a VariantFilter representing that when rendering one of the
	 * specified variants $lang, this construct should output $text.
	 */
	public function __construct(
		/** @var list<string> a list of variants selected by this filter. */
		public readonly array $langs,
		/** The text used for these variants. */
		public DocumentFragment $text,
	) {
	}

	public function __clone() {
		// Deep clone DocumentFragments
		// (Note that from/to can't be readonly properties until PHP 8.3:
		//  https://www.php.net/releases/8.3/en.php#readonly_classes )
		$this->text = DOMDataUtils::cloneDocumentFragment( $this->text );
	}

	/** @inheritDoc */
	public function toJsonArray( JsonCodecInterface $codec ): array {
		$json = [
			'l' => $this->langs,
			// compatibility with MediaWiki DOM Spec 2.8.0
			't' => self::encodeDocumentFragment( $codec, $this->text ),
		];
		return $json;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( JsonCodecInterface $codec, array $json ): self {
		$langs = $json['l'];
		// Usually '_h' or '_t' is used as a marker for caption/html, but
		// allow a bare string as well.
		$text = self::decodeDocumentFragment( $codec, $json['t'] );
		return new self( $langs, $text );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === 'l' ) {
			// The field is really a string, but it's the LIST/USE_SQUARE part
			// which is important.
			return Hint::build( stdclass::class, Hint::LIST, Hint::USE_SQUARE );
		}
		// 't' is not hinted as DocumentFragment because we manually
		// encode/decode it for MW Dom Spec 2.8.0 compat
		return null;
	}
}
