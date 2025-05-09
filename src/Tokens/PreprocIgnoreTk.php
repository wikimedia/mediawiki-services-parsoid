<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * Represents "ignored content" from the preprocessor.  This is
 * typically <includeonly>/<noinclude>/<onlyinclude> content, but
 * this is also used to represent annotation tags.
 * Depending on whether we are in a tranclusion context or not,
 * either the *contents* of include-related tags will be ignored, or else
 * *just the open/close tags* will be ignored (with the content
 * available unnested).  For annotation tags, it is just the open/close
 * tags which are ignored.
 */
class PreprocIgnoreTk extends PreprocTk {
	public function __construct(
		SourceRange $tsr,
		string|KV $contents,
		public ?string $annotation = null
	) {
		parent::__construct(
			PreprocType::IGNORE,
			$tsr,
			$contents instanceof KV ? $contents :
				self::newContentsKV( [ $contents ], $tsr ),
			count: 0,
		);
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
			'attribs' => $this->attribs,
			'dataParsoid' => $this->dataParsoid,
		] + ( $this->annotation === null ? [] :
			 [ 'annotation' => $this->annotation ] );
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			$json['dataParsoid']->tsr,
			$json['attribs'][0],
			$json['annotation'] ?? null,
		);
	}

	/** @inheritDoc */
	protected function printInternal( array &$result, string $prefix, bool $pretty ): void {
		// Emit annotation content by default -- it may be stripped
		// by other code, but keep it for now.
		if ( $this->annotation === null && !$pretty ) {
			// It might be preferable in some situations to emit padding
			// characters so that the TSR lines up, but for now emit nothing
			// for ignored content.
			return;
		}
		if ( $pretty ) {
			$result[] = "$prefix<ignore>";
		}
		self::printContentsInternal(
			$result,
			$this->getContents(),
			$pretty ? $prefix . '  ' : $prefix,
			$pretty
		);
		if ( $pretty ) {
			$result[] = "$prefix</ignore>";
		}
	}
}
