<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\JsonCodecableWithCodecTrait;

/**
 * Represents one case of a bidirectional language converter rule.
 */
class VariantTwoWay implements JsonCodecable {
	use JsonCodecableWithCodecTrait;

	/**
	 * Create a VariantTwoWay case representing the rendering in a given
	 * language.
	 * @param string $lang
	 * @param DocumentFragment $text
	 */
	public function __construct(
		/** The language for this variant. */
		public readonly string $lang,
		/** The text to use for this variant. */
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
			'l' => $this->lang,
			// compatibility with MediaWiki DOM Spec 2.8.0
			't' => self::encodeDocumentFragment( $codec, $this->text ),
		];
		return $json;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( JsonCodecInterface $codec, array $json ): self {
		$lang = $json['l'];
		// Usually '_h' or '_t' is used as a marker for caption/html, but
		// allow a bare string as well.
		$text = self::decodeDocumentFragment( $codec, $json['t'] );
		return new self( $lang, $text );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		// 't' is not hinted as DocumentFragment because we manually
		// encode/decode it for MW Dom Spec 2.8.0 compat
		return null;
	}
}
