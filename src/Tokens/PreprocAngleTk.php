<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Core\DomSourceRange;

/**
 * Represents an "extension tag" preprocessor piece.
 */
class PreprocAngleTk extends PreprocTk {
	public function __construct(
		SourceRange $tsr,
		/**
		 * The name of the extension tag, not including the leading `<`.
		 */
		public string $open,
		/**
		 * The attribute string, including leading whitespace but not
		 * including the trailing `>`.
		 */
		public string $extAttrs,
		/** The contents of the extension tag. */
		KV $contents,
		/**
		 * The close tag, including leading `<` and trailing `>`, or null
		 * for a self-closed tag.
		 */
		public ?string $close,
	) {
		Assert::invariant(
			$contents->srcOffsets !== null, "Must supply TSR for contents"
		);
		parent::__construct(
			PreprocType::ANGLE,
			$tsr,
			$contents
		);
		// Compute extTagOffsets from TSR
		$extTagOffsets = DomSourceRange::fromTsr( $tsr );
		$extTagOffsets->openWidth = 1 /* '<' */ +
			strlen( $open ) + strlen( $extAttrs ) +
			( $close === null ? 1 /* '/' */ : 0 ) + 1; /* '>' */
		$extTagOffsets->closeWidth = strlen( $close ?? '' );
		$this->dataParsoid->extTagOffsets = $extTagOffsets;
		// Set 'selfClose' flag
		if ( $close === null ) {
			$this->dataParsoid->selfClose = true;
		}
	}

	/**
	 * Return the normalized name of this extension tag.
	 */
	public function name(): string {
		// Strip off #hash part
		$name = explode( '#', $this->open, 2 )[0];
		return $name;
	}

	/**
	 * Return a KV for the open string.
	 */
	public function getOpenKV( string $key = self::CONTENTS_ATTR ): KV {
		$openTsr = $this->dataParsoid->extTagOffsets->openRange();
		$tsr = new SourceRange(
			$openTsr->start + 1,
			$openTsr->start + 1 + strlen( $this->open ),
			$openTsr->source
		);
		return new KV( $key, $this->open, $tsr->expandTsrV() );
	}

	/**
	 * Return a KV for the attributes.
	 */
	public function getExtAttrsKV( string $key = self::CONTENTS_ATTR ): KV {
		$openTsr = $this->dataParsoid->extTagOffsets->openRange();
		$tsr = new SourceRange(
			$openTsr->start + 1 + strlen( $this->open ),
			$openTsr->end - 1 - ( $this->close === null ? 1 : 0 ),
			$openTsr->source
		);
		return new KV( $key, $this->extAttrs, $tsr->expandTsrV() );
	}

	/**
	 * Return a KV for the close string.
	 */
	public function getCloseKV( string $key = self::CONTENTS_ATTR ): ?KV {
		if ( $this->close === null ) {
			return null;
		}
		$tsr = $this->dataParsoid->extTagOffsets->closeRange();
		return new KV( $key, $this->close, $tsr->expandTsrV() );
	}

	public function __clone() {
		parent::__clone();
		// No new non-primitive properties to clone.
	}

	/** @inheritDoc */
	#[\ReturnTypeWillChange]
	public function jsonSerialize() {
		return [
			'type' => $this->getType(),
			'open' => $this->open,
			'extAttrs' => $this->extAttrs,
			'close' => $this->close,
			'attribs' => $this->attribs,
			'dataParsoid' => $this->dataParsoid,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			$json['dataParsoid']->tsr,
			$json['open'],
			$json['extAttrs'],
			$json['attribs'][0],
			$json['close'],
		);
	}

	/** @inheritDoc */
	protected function printInternal( array &$result, string $prefix, bool $pretty ): void {
		$open = "<" . $this->open . $this->extAttrs;
		$contents = $this->getContents();
		// If contents have been added to this token since parsing it
		// we can't use the self-closed form even if that's what the token
		// was parsed as.
		if ( $this->close === null && !$contents[0] ) {
			$result[] = $prefix . $open . "/>";
		} else {
			$result[] = $prefix . $open . ">";
			self::printContentsInternal(
				$result,
				$this->getContents(),
				$pretty ? ( $prefix . '  ' ) : '',
				$pretty
			);
			// Contents might have been added to this token, so synthesize
			// a closing string if we need to.
			$close = $this->close ?? ( '</' . $this->open . '>' );
			$result[] = $prefix . $close;
		}
	}
}
