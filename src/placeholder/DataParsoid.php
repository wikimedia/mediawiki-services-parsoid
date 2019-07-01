<?php
declare( strict_types = 1 );

namespace Parsoid;

use stdClass;

use Parsoid\Tokens\DomSourceRange;
use Parsoid\Tokens\SourceRange;

/**
 * Parsoid data for a DOM node. Managed by DOMDataUtils::get/setDataParsoid().
 * For now, this class is only used in type hints to improve IDE autocompletion,
 * getDataParsoid() actually returns an stdClass. This also means that any of the properties
 * documented here might not be set at all.
 * @see DOMDataUtils::getDataParsoid()
 * @see DOMDataUtils::setDataParsoid()
 */
class DataParsoid extends stdClass {

	/**
	 * Used to emit original wikitext in some scenarios (entities, placeholder spans)
	 * Porting note: this can be '0', handle emptiness checks with care
	 * @var string|null
	 */
	public $src;

	/**
	 * Wikitext source ranges that generated this DOM node.
	 * In the form [ start-offset, end-offset ] or
	 * [ start-offset, end-offset, start-tag-width, end-tag-width ].
	 *
	 * Consider input wikitext: `abcdef ''foo'' something else`. Let us look at the `''foo''`
	 * part of the input. It generates `<i data-parsoid='{"dsr":[7,14,2,2]}'>foo</i>` . The dsr
	 * property of the data-parsoid attribute of this i-tag tells us the following. This HTML node
	 * maps to input wikitext substring 7..14. The opening tag <i> was 2 characters wide in wikitext
	 * and the closing tag </i> was also 2 characters wide in wikitext.
	 *
	 * @var DomSourceRange|null
	 * @see ComputeDSR::computeNodeDSR()
	 */
	public $dsr;

	/**
	 * Tag widths for all tokens.
	 * Temporarily present in data-parsoid, but not in final DOM output.
	 * @var SourceRange|null
	 * @see ComputeDSR::computeNodeDSR()
	 */
	public $tsr;

	/**
	 * Denotes special syntax. Possible values:
	 *  - 'html' for html tags. Ex: `<div>foo</div>`
	 *  - 'row' for dt/dd that show on the same line. Ex: `;a:b` (but not `;a\n:b`)
	 *  - 'piped' for piped wikilinks with explicit content Ex: `[[Foo|bar]]` (but not `[[Foo]]`)
	 * - 'magiclink', 'url' - legacy, not used anymore
	 * @var string|null
	 */
	public $stx;

	/**
	 * Holds a number of transient properties in the wt->html pipeline to pass information between
	 * stages. Dropped before serialization.
	 * @var stdClass|null
	 */
	public $tmp;

	// extension tags

	/**
	 * Offsets of opening and closing tags for extension tags, in the form
	 * [ opening tag start , closing tag end, opening tag width, closing tag width ]
	 * Temporarily present in data-parsoid, but not in final DOM output.
	 * @var DomSourceRange|null
	 */
	public $extTagOffsets;

	// external links

	/**
	 * Offsets of external link content.
	 * Temporarily present in data-parsoid, but not in final DOM output.
	 * @var SourceRange|null
	 */
	public $extLinkContentOffsets;

	// HTML tags

	/**
	 * Whether this start HTML tag has no corresponding wikitext and was auto-inserted to generate
	 * well-formed html. Usually happens when treebuilder fixes up badly nested HTML.
	 * @var bool|null
	 */
	public $autoInsertedStart;
	/**
	 * Whether this end HTML tag has no corresponding wikitext and was auto-inserted to generate
	 * well-formed html. Ex: `<tr>`, `<th>`, `<td>`, `<li>`, etc. that have no explicit closing
	 * markup. Or, html tags that aren't closed.
	 * @var bool|null
	 */
	public $autoInsertedEnd;
	/**
	 * Source tag name for HTML tags. Records case variations (`<div>` vs `<DiV>` vs `<DIV>`).
	 * @var string|null
	 */
	public $srcTagName;
	/**
	 * Are void tags self-closed? (Ex: `<br>` vs `<br />`)
	 * @var bool|null
	 */
	public $selfClose;
	/**
	 * Void tags that are not self-closed (Ex: `<br>`)
	 * @var bool|null
	 */
	public $noClose;
	/**
	 * Used to roundtrip back these kind of tags: `</br>` or `<br/  >` or `<hr/  >`
	 * @var string|null
	 */
	public $brokenHTMLTag;

	// wikilinks

	/**
	 * Link trail source (Ex: the "l" in `[[Foo]]l`)
	 * Porting note: this can be '0', handle emptiness checks with care
	 * @var string|null
	 */
	public $tail;
	/**
	 * Link prefix source
	 * Porting note: this can be '0', handle emptiness checks with care
	 * @var string|null
	 */
	public $prefix;
	/**
	 * True if the link was a pipetrick (`[[Foo|]]`).
	 * @note This will likely be removed soon since this should not show up in saved wikitext since
	 * this is a pre-save transformation trick.
	 * @var bool|null
	 */
	public $pipeTrick;

	// wikitables

	/**
	 * Source for start-text separators in table wikitext.
	 * @var string|null
	 */
	public $startTagSrc;
	/**
	 * Source for end-text separators in table wikitext.
	 * @var string|null
	 */
	public $endTagSrc;
	/**
	 * Source for attribute-text separators in table wikitext.
	 * @var string|null
	 */
	public $attrSepSrc;
	/** @var string|null 'row' for td/th cells that show up on the same line, null otherwise */
	public $stx_v;

	// language variant

	/**
	 * flags
	 * @var array
	 */
	public $flags;
	/**
	 * variants
	 * @var array
	 */
	public $variants;
	/**
	 * original
	 * @var array
	 */
	public $original;
	/**
	 * flag sp
	 * @var array
	 */
	public $flagSp;
	/**
	 * texts
	 * @var object
	 */
	public $texts;

}
