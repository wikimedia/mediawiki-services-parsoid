<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\JsonCodecableWithCodecTrait;

/**
 * Represents a unidirectional language converter rule.
 */
class VariantOneWay implements JsonCodecable {
	use JsonCodecableWithCodecTrait;

	/**
	 * Create a VariantOneWay representing that when rendering into variant $lang,
	 * the given content $from should be rendered as $to.
	 * @param string $lang
	 * @param DocumentFragment $from
	 * @param DocumentFragment $to
	 */
	public function __construct(
		/** The language for this rule. */
		public readonly string $lang,
		/** The source text for this rule. */
		public DocumentFragment $from,
		/** The destination text for this rule. */
		public DocumentFragment $to,
	) {
	}

	public function __clone() {
		// Deep clone DocumentFragments
		// (Note that from/to can't be readonly properties until PHP 8.3:
		//  https://www.php.net/releases/8.3/en.php#readonly_classes )
		$this->from = DOMDataUtils::cloneDocumentFragment( $this->from );
		$this->to = DOMDataUtils::cloneDocumentFragment( $this->to );
	}

	/** @inheritDoc */
	public function toJsonArray( JsonCodecInterface $codec ): array {
		// compatibility with MediaWiki DOM Spec 2.8.0
		$json = [
			'f' => self::encodeDocumentFragment( $codec, $this->from ),
			'l' => $this->lang,
			't' => self::encodeDocumentFragment( $codec, $this->to ),
		];
		return $json;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( JsonCodecInterface $codec, array $json ): self {
		$lang = $json['l'];
		// Usually '_h' or '_t' is used as a marker for caption/html, but
		// allow a bare string as well.
		$from = self::decodeDocumentFragment( $codec, $json['f'] );
		$to = self::decodeDocumentFragment( $codec, $json['t'] );
		return new self( $lang, $from, $to );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		// 't'/'f' is not hinted as DocumentFragment because we manually
		// encode/decode it for MW Dom Spec 2.8.0 compat
		return null;
	}
}
