<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\VariantInfo;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * A class for temporary node-related data, stored in DataParsoid->tmp
 *
 * We use undeclared properties to reduce memory usage, since there are
 * typically very many instances of this class.
 *
 * The original DSR for a quote (b/i) element prior to its adjustment by ComputeDSR.
 * @property DomSourceRange|null $origDSR
 *
 * Offsets of external link content.
 * @property SourceRange|null $extLinkContentOffsets
 *
 * This is set on h1-h6 tokens to track section numbers.
 * @property int|null $headingIndex
 *
 * Information about a template invocation
 * @property TemplateInfo|null $tplarginfo
 *
 * The TSR of the end tag
 * @property SourceRange|null $endTSR
 *
 * Used to shuttle tokens to the end of a stage in the TokenHandlerPipeline
 * @property array|null $shuttleTokens
 *
 * Unparsed components of a language variant rule token.
 * @property ?VariantInfo $variantInfo
 *
 * Used to shuttle DataMwVariant through the Token so it can be set on
 * the element rich attribute during tree building.
 * @property ?DataMwVariant $variantData
 *
 * Section data associated with a heading
 * @property ?array{line:string,linkAnchor:string} $section
 *
 * For td/th tokens, wikitext source for attributes
 * This is needed to reparse this as content when tokenization is incorrect
 * @property string|null $attrSrc
 *
 * Used for detection of template usage inside external links.
 * This is needed by linter and metrics to detect links with templates inside href part.
 * @property bool|null $linkContainsTemplate
 *
 * Node represents empty extension content
 * @property bool|null $empty
 */
#[\AllowDynamicProperties]
class TempData {
	/**
	 * Whether a DOM node is a new node added during an edit session. figureHandler()
	 * sets this on synthetic div elements.
	 */
	public const IS_NEW = 1 << 0;

	/**
	 * The tokenizer sets this on table cells originating in wikitext-style syntax
	 * with no attributes set in the input.
	 */
	public const NO_ATTRS = 1 << 1;

	/**
	 * The tokenizer sets this on table cells that use "||" or "!!" style syntax for
	 * th/td cells. While the tokenizer sets this on all cells, we are only interested
	 * in this info for td/th cells in "SOF" context (modulo comments & whtespace)
	 * in templates. Since Parsoid processes templates in independent parsing contexts,
	 * td/dh cells with this flag set cannot be merged with preceding cells. But cells
	 * without this flag and coming from a template are viable candidates for merging.
	 */
	public const NON_MERGEABLE_TABLE_CELL = 1 << 2;

	/**
	 * This is set on cell elements that could not be combined with the previous
	 * cell. Private to TableFixups.
	 */
	public const FAILED_REPARSE = 1 << 3;

	/**
	 * This cell is a merge of two cells in TableFixups.
	 * For now, this prevents additional merges.
	 */
	public const MERGED_TABLE_CELL = 1 << 4;

	/**
	 * Indicates a cell is from the start of template source.
	 * Used in TableFixups.
	 */
	public const AT_SRC_START = 1 << 5;

	/**
	 * This is set on span tags that are created by PipelineUtils::addSpanWrappers().
	 */
	public const WRAPPER = 1 << 6;

	/**
	 * This is set on wrapper tokens created by PipelineUtils::encapsulateExpansionHTML()
	 * to propagate the setDSR option to that function.
	 */
	public const SET_DSR = 1 << 7;

	/**
	 * A flag private to Linter, used to suppress duplicate messages.
	 */
	public const LINTED = 1 << 8;

	/**
	 * A flag private to Linter to help it traverse a DOM
	 */
	public const PROCESSED_TIDY_WS_BUG = 1 << 9;

	/**
	 * This is set on all elements that originate in a template. It controls
	 * the insertion of mw:Transclusion markers in MarkFosteredContent.
	 */
	public const IN_TRANSCLUSION = 1 << 10;

	/**
	 * MarkFosteredContent sets this on meta mw:Transclusion tags. It is only used
	 * in an assertion.
	 */
	public const FROM_FOSTER = 1 << 11;

	/**
	 * Used to indicate that media dimensions have redundant units.
	 */
	public const BOGUS_PX = 1 << 12;

	/**
	 * This is set on wrapper tokens created by PipelineUtils::encapsulateExpansionHTML()
	 * to propagate the fromCache option to that function.
	 */
	public const FROM_CACHE = 1 << 13;

	/**
	 * All elements inserted by TreeBuilderStage receive an integer ID. It is used
	 * in findAutoInsertedTags() in conjunction with data-stag to identify
	 * auto-inserted tags, and for debugging.
	 */
	public ?int $tagId;

	/**
	 * A combination of flags combined from consts on this class.
	 */
	public int $bits = 0;

	/**
	 * Node temporary attribute key-value pair to be processed in post-process steps.
	 * Some extensions need to store data to be post-processed due to custom state
	 * implementation.
	 *
	 * Make this property private and leave for ParsoidExtensionAPI to manipulate its
	 * content.
	 */
	private ?array $tagData;

	/**
	 * Deeply clone this object
	 */
	public function __clone() {
		// Properties that need deep cloning
		foreach ( [ 'origDSR', 'extLinkContentOffsets', 'tplarginfo', 'endTSR' ] as $f ) {
			if ( isset( $this->$f ) ) {
				$this->$f = clone $this->$f;
			}
		}
		foreach ( [ 'shuttleTokens', 'tagData', 'section' ] as $f ) {
			if ( isset( $this->$f ) ) {
				$this->$f = Utils::cloneArray( $this->$f );
			}
		}
	}

	/**
	 * Check whether a bit is set in $this->bits
	 */
	public function getFlag( int $flag ): bool {
		return (bool)( $this->bits & $flag );
	}

	/**
	 * Set a bit in $this->bits
	 */
	public function setFlag( int $flag, bool $value = true ): void {
		if ( $value ) {
			$this->bits |= $flag;
		} else {
			$this->bits &= ~$flag;
		}
	}

	/**
	 * Set a tag attribute for a specific extension with a given key
	 *
	 * @param string $key identifier to support a map for multiple extensions
	 * @param mixed $data Should be cloneable
	 */
	public function setTagData( string $key, $data ): void {
		$this->tagData ??= [];
		$this->tagData[$key] = $data;
	}

	/**
	 * Get a tag attribute for a specific extension tag with a given key
	 *
	 * @param string $key identifier to support a map for multiple tags
	 * @return mixed
	 */
	public function getTagData( string $key ) {
		return $this->tagData[$key] ?? null;
	}
}
