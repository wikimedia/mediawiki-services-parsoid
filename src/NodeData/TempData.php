<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\Parsoid\Core\DomSourceRange;

/**
 * A class for temporary node-related data, stored in DataParsoid->tmp
 *
 * We use undeclared properties to reduce memory usage, since there are
 * typically very many instances of this class.
 *
 * Whether a DOM node is a new node added during an edit session. figureHandler()
 * sets this on synthetic div elements.
 * @property bool|null $isNew
 *
 * An array of stdClass objects indexed by about ID. Private to WrapTemplates.
 * FIXME: not cloneable, contains DOM nodes.
 * @property stdClass[]|null $tplRanges
 *
 * The tokenizer sets this on table cells originating in wikitext-style syntax
 * with no attributes set in the input.
 * @property bool|null $noAttrs
 *
 * This is set on cell elements that could not be combined with the previous
 * cell. Private to TableFixups.
 * @property bool|null $failedReparse
 *
 * This is set on span tags that are created by PipelineUtils::addSpanWrappers().
 * @property bool|null $wrapper
 *
 * This is set on wrapper tokens created by PipelineUtils::encapsulateExpansionHTML()
 * to propagate the setDSR option to that function.
 * @property bool|null $setDSR
 *
 * This is set on wrapper tokens created by PipelineUtils::encapsulateExpansionHTML()
 * to propagate the fromCache option to that function.
 * @property bool|null $fromCache
 *
 * An associative array with keys "key" and "params", set on span typeof=mw:I18n
 * elements to carry wfMessage() parameters.
 * @property array|null $i18n
 *
 * The original DSR for a quote (b/i) element prior to its adjustment by ComputeDSR.
 * @property DomSourceRange|null $origDSR
 *
 * A flag private to Linter, used to suppress duplicate messages.
 * @property bool|null $linted
 *
 * A flag private to Linter to help it traverse a DOM
 * @property bool|null $processedTidyWSBug
 *
 * This is set on all elements that originate in a template. (That's a lot of
 * elements.) It controls the insertion of mw:Transclusion markers in
 * MarkFosteredContent.
 * @property bool|null $inTransclusion
 *
 * MarkFosteredContent sets this on meta mw:Transclusion tags. It is only used
 * in an assertion.
 * @property bool|null $fromFoster
 *
 * All elements inserted by HTML5TreeBuilder receive an integer ID. It is used
 * in findAutoInsertedTags() in conjunction with data-stag to identify
 * auto-inserted tags, and for debugging.
 * @property int|null $tagId
 *
 * This is set on h1-h6 tokens to track section numbers.
 * @property int|null $headingIndex
 *
 * This is an array of key-value pairs [[k,v], [k,v]] set by AttributeExpander
 * on template tokens. It filters through to data-mw attribs.
 * @property array|null $templatedAttribs
 *
 * FIXME: never written
 * @property int|null $tsrDelta
 *
 * JSON-encoded information about template arguments. It starts out as an array
 * but gets decoded as a stdClass. It has the following properties:
 *   - dict
 *      - target
 *        - wt: (string) Wikitext
 *        - function: (string, optional) Parser function name
 *        - href: (string, optional) The URL of the template
 *      - params: An object in which the keys are the template parameter names
 *        and the values are an object:
 *        - wt: (string) The parameter value source
 *        - key: (array/object, optional)
 *          - wt: (string) The original wikitext of the parameter name, if
 *            different from the key in the params array/object
 *   - paramInfos: An array of objects identical to DataParsoid::$pi
 *      - k: (string)
 *      - srcOffsets: KVSourceRange, in array serialized form
 *      - named: (bool, optional)
 *      - spc: (string[])
 * FIXME: Why JSON? Why "dict"? Why so complex?
 * @property string|null $tplarginfo
 */
class TempData {
}
