<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Html2Wt\DiffMarkers;
use Wikimedia\Parsoid\Utils\RichCodecable;

/**
 * Diff markers for a DOM node.  Managed by
 * DOMDataUtils::get/setDataParsoidDiff and DiffUtils::get/setDiffMark.
 */
class DataParsoidDiff implements JsonCodecable, RichCodecable {
	use JsonCodecableTrait;

	/**
	 * @var array<string, true> Set of diff markers.
	 * @see DiffMarkers class
	 */
	private array $diff = [];

	public function isEmpty(): bool {
		return count( $this->diff ) === 0;
	}

	/**
	 * Add the given mark to this set.
	 */
	public function addDiffMarker( DiffMarkers $mark ): void {
		$this->diff[$mark->value] = true;
	}

	/**
	 * Returns true if the given mark is present.
	 */
	public function hasDiffMarker( DiffMarkers $mark ): bool {
		return $this->diff[$mark->value] ?? false;
	}

	/**
	 * Returns true if no marks other than the given ones are present.
	 */
	public function hasOnlyDiffMarkers( DiffMarkers ...$marks ): bool {
		// Count the given marks, then compare that to the count of all marks.
		$count = 0;
		foreach ( $marks as $m ) {
			$count += ( $this->diff[$m->value] ?? false ) ? 1 : 0;
		}
		return $count === count( $this->diff );
	}

	// RichCodecable

	/** @inheritDoc */
	public static function defaultValue(): DataParsoidDiff {
		return new DataParsoidDiff;
	}

	/** @return class-string<DataParsoidDiff> */
	public static function hint(): string {
		return self::class;
	}

	/** No flattened value. */
	public function flatten(): ?string {
		return null;
	}

	// JsonCodecable

	/** @inheritDoc */
	public function toJsonArray(): array {
		$markers = array_keys( $this->diff );
		sort( $markers ); // keep order consistent
		return [ 'diff' => $markers ];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DataParsoidDiff {
		$dpd = new DataParsoidDiff;
		foreach ( $json['diff'] as $mark ) {
			$dpd->addDiffMarker( DiffMarkers::from( $mark ) );
		}
		return $dpd;
	}
}
