<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdclass;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\RichCodecable;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Parsoid data for a DOM node. Managed by DOMDataUtils::get/setDataParsoid().
 *
 * To reduce memory usage, most the properties need to be undeclared, but we can
 * use the property declarations below to satisfy phan and to provide type
 * information to IDEs.
 *
 * TODO: Declaring common properties would be beneficial for memory usage, but
 * changes the JSON serialized output and breaks tests.
 *
 * == Miscellaneous / General properties ==
 *
 * Used to emit original wikitext in some scenarios (entities, placeholder spans)
 * Porting note: this can be '0', handle emptiness checks with care
 * @property string|null $src
 *
 * Tag widths for all tokens.
 * Temporarily present in data-parsoid, but not in final DOM output.
 * @see ComputeDSR::computeNodeDSR()
 * @property SourceRange|null $tsr
 *
 * Wikitext source ranges that generated this DOM node.
 * In the form [ start-offset, end-offset ] or
 * [ start-offset, end-offset, start-tag-width, end-tag-width ].
 *
 * Consider input wikitext: `abcdef ''foo'' something else`. Let us look at the `''foo''`
 * part of the input. It generates `<i data-parsoid='{"dsr":[7,14,2,2]}'>foo</i>` . The dsr
 * property of the data-parsoid attribute of this i-tag tells us the following. This HTML node
 * maps to input wikitext substring 7..14. The opening tag <i> was 2 characters wide in wikitext
 * and the closing tag </i> was also 2 characters wide in wikitext.
 * @property DomSourceRange|null $dsr
 *
 * Denotes special syntax. Possible values:
 *  - 'html' for html tags. Ex: `<div>foo</div>`
 *  - 'row' for dt/dd that show on the same line. Ex: `;a:b` (but not `;a\n:b`)
 *  - 'piped' for piped wikilinks with explicit content Ex: `[[Foo|bar]]` (but not `[[Foo]]`)
 * - 'magiclink', 'url' - legacy, not used anymore
 * @property string|null $stx
 *
 * Template parameter infos produced by TemplateHandler. After unserialization,
 * the objects are not fully populated.
 * @property list<list<ParamInfo>>|null $pi
 *
 * DocumentFragment content tunneled through for DOMFragment Token.
 * @property DocumentFragment|null $html
 *
 * On mw:Entity spans this is set to the decoded entity value.
 * @property string|null $srcContent
 *
 * An array of associative arrays describing image rendering options, attached
 * to the image container (span or figure).
 *   - ck: Canonical key for the image option.
 *   - ak: Aliased key.
 * @property array|null $optList
 *
 * Rendered attributes (shadow info). The key is the attribute name. The value
 * is documented as "mixed" but seems to be coerced to string in
 * Sanitizer::sanitizeTagAttrs().
 * @property array|null $a Rendered attributes
 *
 * Source attributes (shadow info). The key is the attribute name. The value
 * is documented as "mixed" but may possibly be a nullable string.
 * @property array|null $sa Source attributes
 *
 * The number of extra dashes in the source of an hr
 * @property int|null $extra_dashes
 *
 * The complete text of a double-underscore behavior switch
 * @property string|null $magicSrc
 *
 * Whether the first argument of a parser function was split on a colon
 * @property true|null $colon
 *
 * True if the input heading element had an id attribute, preventing automatic
 * assignment of a new id attribute.
 * @property bool|null $reusedId
 *
 * The link token associated with a redirect
 * @property Token|null $linkTk
 *
 * This is set to "extlink" on auto URL (external hotlink) image links.
 * @property string|null $type
 *
 * On a meta mw:Placeholder/StrippedTag, this is the name of the stripped tag.
 * @property string|null $name
 *
 * This is set on image containers in which a template expands to multiple
 * image parameters. It is converted to a typeof attribute later in the same
 * function, so it's unclear why it needs to persist in data-parsoid.
 * @property bool|null $uneditable
 *
 * == WrapTemplates ==
 *
 * The wikitext source which was not included in a template wrapper.
 * @property string|null $unwrappedWT
 *
 * The token or DOM node name, optionally suffixed with the syntax name from
 * $this->stx, of the first node within the encapsulated content.
 * @property string|null $firstWikitextNode
 *
 * == Extensions ==
 *
 * Offsets of opening and closing tags for extension tags, in the form
 * [ opening tag start , closing tag end, opening tag width, closing tag width ]
 * Temporarily present in data-parsoid, but not in final DOM output.
 * @property DomSourceRange|null $extTagOffsets
 *
 * The reference group. This is attached to the <ol> or its wrapper <div>,
 * redundantly with the data-mw-group attribute on the <ol>. It is produced by
 * the extension's sourceToDom() and consumed by wtPostprocess().
 * @property string $group
 *
 * == Annotations ==
 * This is used on annotation meta tags to indicate that the corresponding
 * tag has been moved compared to it's initial location defined by wikitext.
 * An annotation tag can be moved either as the result of fostering or as
 * the result of annotation range extension to enclose a contiguous DOM
 * forest.
 * @property bool|null $wasMoved
 *
 * == HTML tags ==
 *
 * Are void tags self-closed? (Ex: `<br>` vs `<br />`)
 * @property bool|null $selfClose
 *
 * Void tags that are not self-closed (Ex: `<br>`)
 * @property bool|null $noClose
 *
 * Whether this start HTML tag has no corresponding wikitext and was auto-inserted by a token
 * handler to generate well-formed html. Usually happens when a token handler fixes up misnesting.
 * @property bool|null $autoInsertedStartToken
 *
 * Whether this end HTML tag has no corresponding wikitext and was auto-inserted by a token
 * handler to generate well-formed html. Usually happens when a token handler fixes up misnesting.
 * @property bool|null $autoInsertedEndToken
 *
 * Whether this start HTML tag has no corresponding wikitext and was auto-inserted to generate
 * well-formed html. Usually happens when treebuilder fixes up badly nested HTML.
 * @property bool|null $autoInsertedStart
 *
 * Whether this end HTML tag has no corresponding wikitext and was auto-inserted to generate
 * well-formed html. Ex: `<tr>`, `<th>`, `<td>`, `<li>`, etc. that have no explicit closing
 * markup. Or, html tags that aren't closed.
 * @property bool|null $autoInsertedEnd
 *
 * Source tag name for HTML tags. Records case variations (`<div>` vs `<DiV>` vs `<DIV>`).
 * @property string|null $srcTagName
 *
 * UnpackDomFragments sets this on misnested elements
 * @property bool|null $misnested
 *
 * This is set by MarkFosteredContent to indicate fostered content and content
 * wrappers.
 * @property bool|null $fostered
 *
 * == Links ==
 *
 * Link trail source (Ex: the "l" in `[[Foo]]l`)
 * Porting note: this can be '0', handle emptiness checks with care
 * @property string|null $tail
 *
 * Link prefix source
 * Porting note: this can be '0', handle emptiness checks with care
 * @property string|null $prefix
 *
 * Did the link use interwiki syntax?
 * Probably redundant with the rel=mw:WikiLink/Interwiki
 * @property bool|null $isIW
 *
 * Source for first separator in a wikilink to account for variation
 * Ex. [[Test{{!}}123]]
 * @property string|null $firstPipeSrc
 *
 * == Tables ==
 *
 * Source for start-text separators in table wikitext.
 * @property string|null $startTagSrc
 *
 * Source for end-text separators in table wikitext.
 * @property string|null $endTagSrc
 *
 * Source for attribute-text separators in table wikitext.
 * @property string|null $attrSepSrc
 *
 * 'row' for td/th cells that show up on the same line, null otherwise
 * @property string|null $stx_v
 *
 * == Language variant data-parsoid properties ==
 *
 * @property array|null $flSp Spaces around flags, compressed with compressSpArray().
 * @property array|null $tSp Spaces around texts, compressed with compressSpArray().
 * @property array|null $fl Original flags, copied from VariantInfo::$original
 *  on the token.
 */
#[\AllowDynamicProperties]
class DataParsoid implements JsonCodecable, RichCodecable {
	use JsonCodecableTrait;

	/**
	 * Holds a number of transient properties in the wt->html pipeline to pass information between
	 * stages. Dropped before serialization.
	 */
	public ?TempData $tmp;

	/**
	 * Deeply clone this object
	 */
	public function __clone() {
		// Deep clone non-primitive properties

		// 1. Properties which are lists of cloneable objects
		foreach ( [ 'pi' ] as $prop ) {
			if ( isset( $this->$prop ) ) {
				$this->$prop = Utils::cloneArray( $this->$prop );
			}
		}

		// 2. Properties which are cloneable objects
		foreach ( [ 'tmp', 'linkTk', 'tsr', 'dsr', 'extTagOffsets', 'dmv' ] as $prop ) {
			if ( isset( $this->$prop ) ) {
				$this->$prop = clone $this->$prop;
			}
		}
		// 3. Properties which are DocumentFragments
		foreach ( [ 'html' ] as $field ) {
			if ( isset( $this->$field ) ) {
				$this->$field = DOMDataUtils::cloneDocumentFragment( $this->$field );
			}
		}
	}

	public function isEmpty(): bool {
		// First two checks short-circuit for the common case (dsr for nodes & tsr for tokens)
		return !isset( $this->dsr ) && !isset( $this->tsr ) && $this->toJsonArray() === [];
	}

	/**
	 * Get a lazy-initialized object to which temporary properties can be written.
	 * @return TempData
	 */
	public function getTemp(): TempData {
		// tmp can be unset despite being declared
		$this->tmp ??= new TempData();
		return $this->tmp;
	}

	/**
	 * Check whether a bit is set in $this->tmp->bits
	 *
	 * @param int $flag
	 * @return bool
	 */
	public function getTempFlag( $flag ): bool {
		return isset( $this->tmp ) && ( $this->tmp->bits & $flag );
	}

	/**
	 * Set a bit in $this->tmp->bits
	 *
	 * @param int $flag
	 * @param bool $value
	 */
	public function setTempFlag( $flag, $value = true ): void {
		if ( $value ) {
			if ( !isset( $this->tmp ) ) {
				$tmp = new TempData;
				$tmp->bits = $flag;
				$this->tmp = $tmp;
			} else {
				$this->tmp->bits |= $flag;
			}
		} elseif ( isset( $this->tmp ) ) {
			$this->tmp->bits &= ~$flag;
		}
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		static $clearNullsFrom = [
			'dsr', 'tsr', 'extTagOffsets',
		];
		$result = (array)$this;
		unset( $result['tmp'] );
		// Conciseness: don't include `null` values from certain properties.
		foreach ( $clearNullsFrom as $prop ) {
			if ( !isset( $result[$prop] ) ) {
				unset( $result[$prop] );
			}
		}
		return $result;
	}

	/** @return Hint<DataParsoid> */
	public static function hint(): Hint {
		static $hint = null;
		if ( $hint === null ) {
			$hint = Hint::build( self::class, Hint::ALLOW_OBJECT );
		}
		return $hint;
	}

	/** @inheritDoc */
	public static function defaultValue(): ?self {
		$dp = new DataParsoid;
		// Mark data parsoid created as a default value.
		$dp->setTempFlag( TempData::IS_NEW, true );
		return $dp;
	}

	/** @inheritDoc */
	public function flatten(): ?string {
		return null;
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		static $hints = null;
		if ( $hints === null ) {
			$dsr = DomSourceRange::hint();
			$sr = SourceRange::hint();
			$hints = [
				'dsr' => $dsr,
				'extTagOffsets' => $dsr,
				'tsr' => $sr,
				'pi' => Hint::build( ParamInfo::class, Hint::LIST, Hint::LIST ),
				'linkTk' => Token::class,
				'html' => DocumentFragment::class,
				'dmv' => DataMwVariant::hint(),
				'optList' => Hint::build( stdclass::class, Hint::LIST, Hint::LIST )
			];
		}
		return $hints[$keyname] ?? null;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DataParsoid {
		$dp = new DataParsoid;
		foreach ( $json as $key => $value ) {
			switch ( $key ) {
				case 'dsr':
				case 'extTagOffsets':
				case 'tsr':
					// For backward compatibility, leave these unset if null.
					if ( $value !== null ) {
						$dp->$key = $value;
					}
					break;
				case 'tmp':
					// This isn't serialized, but we can deserialize it
					// for tests.
					$tmp = new TempData;
					foreach ( $value as $key2 => $value2 ) {
						$tmp->$key2 = $value2;
					}
					$dp->$key = $tmp;
					break;
				default:
					$dp->$key = $value;
					break;
			}
		}
		return $dp;
	}
}
