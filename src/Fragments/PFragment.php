<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use JsonException;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * A PFragment is a MediaWiki content fragment.
 *
 * PFragment is the input and output type for fragment generators in
 * MediaWiki: magic variables, parser functions, templates, and
 * extension tags.  You can imagine that the `P` stands for "Parsoid",
 * "Page", or "MediaWiki Content" but in reality it simply
 * disambiguates this fragment type from the DOM DocumentFragment and
 * any other fragments you might encounter.
 *
 * PFragment is an abstract class, and content is lazily converted to the
 * form demanded by a consumer.  Converting forms often loses information
 * or introduces edge cases, so we avoid conversion to intermediate forms
 * and defer conversion in general as late as possible.
 *
 * For example, in this invocation:
 *   {{1x|'''bold''' <nowiki>fragment</nowiki>}}
 *
 * If we were to flatten this "as string" (traditionally) we would
 * lose the bold face and the <nowiki> would get tunneled as strip
 * state.  Alternatively we could ask for this "as a source string"
 * which corresponds to the original "raw" form: "'''bold'''
 * <nowiki>fragment</nowiki>", which is often used to pass literal
 * arguments, bypassing wikitext processing.  Or we could
 * ask for the argument "as HTML" or "as DOM" in which case it would
 * get parsed as wikitext and returned as
 * `<b>bold</b> <span>fragment</span>`, either as a possibly-unbalanced
 * string ("as HTML") or as a balanced DOM tree ("as DOM").  These
 * transformations can be irreversible: once we've converted to one
 * representation we can't always recover the others.
 *
 * But now consider if `{{1x|...}}` simply wants to return its argument:
 * it doesn't need to force a specific representation, instead
 * it can return the PFragment directly without losing information
 * and allow the downstream customer to chose the type it prefers.
 * This also works for composition: a composite PFragment can be
 * defined which defers evaluation of its components until demanded,
 * and then applies the appropriate composition operation depending
 * on the demanded result.
 *
 * (WikitextPFragment is one such composite fragment type, which uses
 * Parsoid to do the composition of wikitext and other fragments.)
 *
 * Parsoid defines only those fragment types relevant to itself, and
 * defines conversions (`as*()` methods) only for those formats it
 * needs for HTML rendering.  Extensions should feel free to define
 * their own fragment types: as long as they are JsonCodecable and
 * define one of ::asDom() or ::asHtmlString() they will interoperate
 * with Parsoid and other extensions, albeit possibly as an opaque
 * strip marker.
 *
 * For example, Wikifunctions might define a PFragment for ZObjects,
 * which would allow nested wikifunction invocations to transfer
 * ZObjects between themselves without conversion through wikitext.
 * For example, given:
 *   {{#function:sum| {{#function:one}} }}
 * then the `sum` function will be given a ZObjectPFragment containing
 * the output of the `one` function, without forcing that value to
 * serialize to a wikitext string and deserialize.  With its special
 * knowledge of the ZObjectPFragment type, Wikifunctions can use this
 * to (say) preserve type information of the values.  But if this
 * same function is embedded into a wikitext template:
 *   {{1x| {{#function:one}} }}
 * then the value will be converted to wikitext or DOM as appropriate
 * and composed onto the page in that form.
 */
abstract class PFragment implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * The original wikitext source range for this fragment, or `null` for
	 * synthetic content that corresponds to no part of the original
	 * authored text.
	 */
	protected ?DomSourceRange $srcOffsets;

	/**
	 * Registry of known fragment types, used for serialization.
	 * @see ::registerFragmentClass()
	 * @var list<class-string<PFragment>>
	 */
	protected static array $FRAGMENT_TYPES = [
		WikitextPFragment::class,
		HtmlPFragment::class,
		DomPFragment::class,
		LiteralStringPFragment::class,
	];

	protected function __construct( ?DomSourceRange $srcOffsets ) {
		$this->srcOffsets = $srcOffsets;
	}

	/**
	 * Returns true if this fragment is empty.  This enables optimizations
	 * if implemented, but returns false by default.
	 */
	public function isEmpty(): bool {
		return false;
	}

	/**
	 * Returns true if this fragment contains no wikitext elements; that is,
	 * if `::asMarkedWikitext()` given an empty strip state
	 * would return a single strip marker and add a single item to the
	 * strip state (representing $this).  Otherwise, returns false.
	 */
	public function isAtomic(): bool {
		// This is consistent with the default implementation of
		// ::asMarkedWikitext()
		return true;
	}

	/**
	 * As an optimization to avoid unnecessary copying, certain
	 * operations on fragments may be destructive or lead to aliasing.
	 * For ease of debugging, fragments so affected will return `false`
	 * from `::isValid()` and code is encouraged to assert the validity
	 * of fragments where convenient to do so.
	 *
	 * @see the $release parameter to `::asDom()` and `DomPFragment::concat`,
	 *  but other PFragment types with mutable non-value types might also
	 *  provide accessors with `$release` parameters that interact with
	 *  fragment validity.
	 */
	public function isValid(): bool {
		// By default, fragments are valid forever.

		// See DomPFragment for an example of a fragment which may become
		// invalid.
		return true;
	}

	/**
	 * Return the region of the source document that corresponds to this
	 * fragment.
	 */
	public function getSrcOffsets(): ?DomSourceRange {
		return $this->srcOffsets;
	}

	/**
	 * Return the fragment as a (prepared and loaded) DOM
	 * DocumentFragment belonging to the Parsoid top-level document.
	 *
	 * If $release is true, then this PFragment will become invalid
	 * after this method returns.
	 *
	 * @note The default implementation of ::asDom() calls ::asHtmlString().
	 *  Subclassses must implement either ::asDom() or ::asHtmlString()
	 *  to avoid infinite mutual recursion.
	 */
	public function asDom( ParsoidExtensionAPI $ext, bool $release = false ): DocumentFragment {
		return $ext->htmlToDom( $this->asHtmlString( $ext ) );
	}

	/**
	 * Return the fragment as a string of HTML.  This method is very
	 * similar to asDom() but also supports fragmentary and unbalanced
	 * HTML, and therefore composition may yield unexpected results.
	 * This is a common type in legacy MediaWiki code, but use in
	 * new code should be discouraged.  Data attributes will be
	 * represented as inline attributes, which may be suboptimal.
	 * @note The default implementation of ::asHtmlString() calls ::asDom().
	 *  Subclassses must implement either ::asDom() or ::asHtmlString()
	 *  to avoid infinite mutual recursion.
	 */
	public function asHtmlString( ParsoidExtensionAPI $ext ): string {
		return $ext->domToHtml( $this->asDom( $ext ), true );
	}

	/**
	 * This method returns a "wikitext string" in the legacy format.
	 * Wikitext constructs will be parsed in the result.
	 * Constructs which are not representable in wikitext will be replaced
	 * with strip markers, and you will get a strip state which maps
	 * those markers back to PFragment objects.  When you (for example)
	 * compose two marked strings and then ask for the result `asDom`,
	 * the strip markers in the marked strings will first be conceptually
	 * replaced with the PFragment from the StripState, and then
	 * the resulting interleaved strings and fragments will be composed.
	 */
	public function asMarkedWikitext( StripState $stripState ): string {
		// By default just adds this fragment to the strip state and
		// returns a strip marker.  Non-atomic fragments can be
		// more clever.
		return $stripState->addWtItem( $this );
	}

	/**
	 * Helper function to create a new fragment from a mixed array of
	 * strings and fragments.
	 *
	 * Unlike WikitextPFragment::newFromSplitWt() this method will not
	 * always return a WikitextPFragment; for example if only one
	 * non-empty piece is provided this method will just return that
	 * piece without casting it to a WikitextPFragment.
	 *
	 * @param list<string|PFragment> $pieces
	 */
	public static function fromSplitWt( array $pieces, ?DomSourceRange $srcOffset = null ): PFragment {
		$result = [];
		// Remove empty pieces
		foreach ( $pieces as $p ) {
			if ( $p === '' ) {
				continue;
			}
			if ( $p instanceof PFragment && $p->isEmpty() ) {
				continue;
			}
			$result[] = $p;
		}
		// Optimize!
		if ( count( $result ) === 1 && $result[0] instanceof PFragment ) {
			return $result[0];
		}
		return WikitextPFragment::newFromSplitWt( $result, $srcOffset );
	}

	/**
	 * Helper function to append two source ranges.
	 */
	protected static function joinSourceRange( ?DomSourceRange $first, ?DomSourceRange $second ): ?DomSourceRange {
		if ( $first === null || $second === null ) {
			return null;
		}
		return new DomSourceRange( $first->start, $second->end, null, null );
	}

	// JsonCodec support

	/**
	 * Register a fragment type with the JSON deserialization code.
	 *
	 * The given class should have a static constant named TYPE_HINT
	 * which gives the unique string property name which will distinguish
	 * serialized fragments of the given class.
	 * @param class-string<PFragment> $className
	 */
	public function registerFragmentClass( string $className ): void {
		if ( !in_array( $className, self::$FRAGMENT_TYPES, true ) ) {
			self::$FRAGMENT_TYPES[] = $className;
		}
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return $this->srcOffsets === null ? [] : [
			'dsr' => $this->srcOffsets
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): PFragment {
		foreach ( self::$FRAGMENT_TYPES as $c ) {
			if ( isset( $json[$c::TYPE_HINT] ) ) {
				return $c::newFromJsonArray( $json );
			}
		}
		throw new JsonException( "unknown fragment type" );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === 'dsr' ) {
			return DomSourceRange::hint();
		}
		foreach ( self::$FRAGMENT_TYPES as $c ) {
			if ( $keyName === $c::TYPE_HINT ) {
				return $c::jsonClassHintFor( $keyName );
			}
		}
		return null;
	}

	public static function hint(): Hint {
		return Hint::build( self::class, Hint::INHERITED );
	}
}
