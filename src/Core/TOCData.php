<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Table of Contents data, including an array of section metadata.
 *
 * This is simply an array of SectionMetadata objects for now, but may
 * include additional ToC properties in the future.
 *
 * Note that there is no ::setExtensionData() method on the top-level
 * TOCData.  If an extension wants to set additional top-level
 * properties, it is assumed they can use the page-level
 * ::setExtensionData() on the ParserOutput/ContentMetadataCollector
 * instead.  If this decision is revisited, the ::setExtensionData()
 * method on TOCData should match the ones on SectionMetadata and
 * ContentMetadataCollector.
 */
class TOCData implements \JsonSerializable {
	/**
	 * The sections in this Table of Contents.
	 * @var SectionMetadata[]
	 */
	private array $sections;

	/**
	 * --------------------------------------------------
	 * These next 4 properties are temporary state needed
	 * to construct section metadata objects used in TOC.
	 * These state properties are not useful once that is
	 * done and will not be exported or serialized.
	 * --------------------------------------------------
	 */

	/** @var int Temporary TOC State */
	private $tocLevel = 0;

	/** @var int Temporary TOC State */
	private $prevLevel = 0;

	/** @var array<int> Temporary TOC State */
	private $levelCount = [];

	/** @var array<int> Temporary TOC State */
	private $subLevelCount = [];

	/**
	 * Create a new empty TOCData object.
	 * @param SectionMetadata ...$sections
	 */
	public function __construct( ...$sections ) {
		$this->sections = $sections;
	}

	/**
	 * Return current TOC level while headings are being
	 * processed and section metadat is being constructed.
	 * @return int
	 */
	public function getCurrentTOCLevel(): int {
		return $this->tocLevel;
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
	 * @param int $oldLevel level of the heading (H1/H2, etc.)
	 * @param int $level level of the heading (H1/H2, etc.)
	 * @param SectionMetadata $metadata This metadata will be updated
	 * This logic is copied from Parser.php::finalizeHeadings
	 */
	public function processHeading( int $oldLevel, int $level, SectionMetadata $metadata ): void {
		if ( $this->tocLevel ) {
			$this->prevLevel = $oldLevel;
		}

		if ( $level > $this->prevLevel ) {
			# increase TOC level
			$this->tocLevel++;
			$this->subLevelCount[$this->tocLevel] = 0;
		} elseif ( $level < $this->prevLevel && $this->tocLevel > 1 ) {
			# Decrease TOC level, find level to jump to
			for ( $i = $this->tocLevel; $i > 0; $i-- ) {
				if ( $this->levelCount[$i] === $level ) {
					# Found last matching level
					$this->tocLevel = $i;
					break;
				} elseif ( $this->levelCount[$i] < $level ) {
					# Found first matching level below current level
					$this->tocLevel = $i + 1;
					break;
				}
			}
			if ( $i === 0 ) {
				$this->tocLevel = 1;
			}
		}

		$this->levelCount[$this->tocLevel] = $level;

		# count number of headlines for each level
		$this->subLevelCount[$this->tocLevel]++;
		$numbering = '';
		$dot = false;
		for ( $i = 1; $i <= $this->tocLevel; $i++ ) {
			if ( !empty( $this->subLevelCount[$i] ) ) {
				if ( $dot ) {
					$numbering .= '.';
				}
				$numbering .= $this->subLevelCount[$i];
				$dot = true;
			}
		}

		$metadata->hLevel = $level;
		$metadata->tocLevel = $this->tocLevel;
		$metadata->number = $numbering;
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
		# T312589 explicitly calling jsonSerialize() on the elements of
		# $this->sections will be unnecessary in the future.
		$sections = array_map(
			static function ( SectionMetadata $s ) {
				return $s->jsonSerialize();
			},
			$this->sections
		);
		return [
			'sections' => $sections,
		];
	}
}
