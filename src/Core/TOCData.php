<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Table of Contents data, including an array of section metadata.
 *
 * This is simply an array of SectionMetadata objects for now, but may
 * include additional ToC properties in the future.
 */
class TOCData implements \JsonSerializable {
	/**
	 * The sections in this Table of Contents.
	 * @var SectionMetadata[]
	 */
	private array $sections;

	/**
	 * Create a new empty TOCData object.
	 * @param SectionMetadata ...$sections
	 */
	public function __construct( ...$sections ) {
		$this->sections = $sections;
	}

	/**
	 * Add a new section to this TOCData.
	 * @param SectionMetadata $s
	 */
	public function addSection( SectionMetadata $s ) {
		$this->sections[] = $s;
	}

	/**
	 * Get the list of sections in the TOCData.
	 * @return SectionMetadata[]
	 */
	public function getSections() {
		return $this->sections;
	}

	/**
	 * Return as associative array, in the legacy format returned by the
	 * action API.
	 *
	 * This is helpful as b/c support while we transition to objects,
	 * but it drops some properties from this class and shouldn't be used
	 * in new code.
	 * @return array
	 */
	public function toLegacy(): array {
		return array_map(
			static function ( $s ) {
				return $s->toLegacy();
			},
			$this->sections
		);
	}

	/**
	 * Create a new TOCData object from the legacy associative array format.
	 *
	 * This is used for backward compatibility, but the associative array
	 * format does not include any properties of the TOCData other than the
	 * section list.
	 *
	 * @param array $data Associative array with ToC data in legacy format
	 * @return TOCData
	 */
	public static function fromLegacy( array $data ): TOCData {
		$sections = array_map(
			static function ( $d ) {
				return SectionMetadata::fromLegacy( $d );
			},
			$data
		);
		return new TOCData( ...$sections );
	}

	/**
	 * Serialize all data in the TOCData as JSON.
	 *
	 * Unlike the `:toLegacy()` method, this method will include *all*
	 * of the properties in the TOCData so that the serialization is
	 * reversible.
	 *
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'sections' => $this->sections,
		];
	}
}
