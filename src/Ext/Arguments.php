<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\Fragments\PFragment;

/**
 * An object which implements Arguments provides a way to parse or
 * interpret its contents as arguments to a FragmentHandler or
 * other transclusion.
 *
 * There are two primary modes of parsing arguments, and both must
 * be supported:
 * - "Ordered" arguments: arguments are provided as an ordered list
 *   of PFragment values.  They are not split on `=` and `=` is not
 *   treated as a special character.  (This is traditionally how
 *   arguments were provided to parser functions.)
 * - "Named" arguments: arguments are provided as a map from string
 *   'names' to PFragment values.  Values are split on the first `=`
 *   character in their tokenized-but-unexpanded form, then keys are
 *   expanded. Strip markers in the key name cause the key to be
 *   discarded.  For example:
 *    - `{{foo|{{1x|a=b}}=c}}` assigns the value `c` to the key `a=b`
 *    - `{{foo|<nowiki>a=</nowiki>b=c}}` assigns no keys
 *   Any unnamed parameters (whose tokenized-but-unexpanded values
 *   contain no `=`) are assigned consecutive numeric string
 *   names starting with "1".  In case of duplicate keys, the
 *   one ordered last wins.
 *
 * As a convenience, both primary accessors provide a "expand and
 * trim" boolean which defaults to `true`.  This calls
 * PFragment::expand() and then PFragment::trim() on each value before
 * returning it, which is a common argument-handling pattern.  In
 * cases where lazy or untrimmed handling of arguments is desired,
 * call the accessor with `false`, and then manually expand/trim
 * specific values as needed.  (Note that key values for named
 * arguments are always "expanded and trimmed".)
 *
 * Often editors will want to pass "raw text" values to a fragment
 * handler, which may include "special" characters like `=`, `|`, and
 * `&`.  The PFragment::toRawText() helper method can be used on
 * (preferrably unexpanded) argument values to extract a "raw text"
 * string; this implements various conventions commonly used for
 * passing raw text.
 *
 * Not implemented yet, but expected in the future:
 *
 * 1. A third accessor will be added, which will provide access to
 * named arguments as a list of tuples containing:
 * - The parsed key, as a string
 * - The unexpanded-and-untrimmed key, as a PFragment including the `=`,
 *   or null for unnamed keys
 * - The unexpanded-and-untrimmed value
 *
 * That is, the list will provide the original argument order, including
 * the contents of arguments with duplicate or invalid keys, and the
 * list contents will allow recreation of the original argument text
 * by concatenating the unexpanded key with the unexpanded value.
 *
 * 2. As an additional Parsoid-only feature of both ordered and named
 * arguments, any argument whose trimmed value is a PFragment
 * implementing the Arguments interface will have those arguments spliced
 * into the argument list at that location (T390347).
 */
interface Arguments {

	/**
	 * Return a list of ordered arguments.
	 * @param ParsoidExtensionAPI $extApi
	 * @param bool|list<bool> $expandAndTrim If true (the default) the
	 *  return arguments each have PFragment::expand() and
	 *  PFragment::trim() invoked on them. If false, the arguments are
	 *  provided as they exist in the source: unexpanded and
	 *  untrimmed.  In addition to passing a boolean, an array of
	 *  booleans can be passed, which specifies the desired value of
	 *  $expandAndTrim for each ordered argument; missing entries
	 *  default to `true`.
	 * @return list<PFragment> The ordered argument list
	 */
	public function getOrderedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array;

	/**
	 * Return a map of named arguments.
	 *
	 * Unnamed arguments are assigned numeric "names" starting at 1.
	 *
	 * @note Beware that PHP will convert any numeric argument name
	 * which is an integer to a `int`, so the key type of the returned
	 * map is `string|int`.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param bool|array<string|int,bool> $expandAndTrim If true (the
	 *  default) the return argument values each have
	 *  PFragment::expand() and PFragment::trim() invoked on them. If
	 *  false, the argument values are provided as they exist in the
	 *  source: unexpanded and untrimmed.  In addition to passing a
	 *  boolean, an map of booleans can be passed, which specifies the
	 *  desired value of $expandAndTrim for each named argument;
	 *  missing entries default to `true`.
	 * @return array<string|int,PFragment> The named argument map
	 */
	public function getNamedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array;
}
