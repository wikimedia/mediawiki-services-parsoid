<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\Assert\Assert;

/**
 * An abstraction/generalization of "strip state" from mediawiki core.
 *
 * The basic idea is that a special "strip marker" can be added to a text
 * string to represent the insertion of a fragment, here represented as a
 * PFragment (in core, represented as HTML).  This allows us to tunnel
 * rich content through interfaces which only allow strings, as long as
 * (a) we can maintain a strip state on the side, and (b) we guarantee
 * that the "strip markers" can never be forged in the string.  For
 * strip markers in wikitext and HTML this is guaranteed by using
 * a character (\x7f) which is invalid in both wikitext and HTML.
 *
 * The StripState object is not serializable because we can't easily
 * enforce the uniqueness of strip state keys on deserialization.
 * It is recommended that wikitext+strip state be serialized using
 * ::splitWt() (ie, as an array alternating between wikitext strings
 * and serialized PFragments) which both avoids the need to serialize
 * the strip state itself and also avoids exposing the internal keys
 * in the serialized representation.
 *
 * StripState should generally be considered an opaque type internal
 * to Parsoid; most external clients should use the appropriate
 * `split` methods to yield a list of Fragments rather than directly
 * interact with strip markers.
 */
class StripState {

	/**
	 * See Parser.php::MARKER_SUFFIX in core for an explanation of the
	 * special characters used in the marker.
	 *
	 * @note This marker is only valid in strings! We would need to
	 * use an alternate marker if we wanted "strip markers" inside DOM
	 * content since \x7f is (deliberately) not a valid HTML
	 * character.
	 *
	 * @note These markers are generally not visible outside of Parsoid;
	 * they are replaced with "real" core strip markers before being
	 * passed to legacy code.  *However* when running Parsoid in
	 * standalone/"API" mode we do use these to bypass fragment content
	 * around the legacy preprocessor, and so these should *not* match
	 * the Parser::MARKER_PREFIX used in core.  We've added a `P` to
	 * our prefix/suffix to ensure we don't conflict.
	 */
	private const MARKER_PREFIX = "\x7f'\"`PUNIQ-";
	/** @see ::MARKER_PREFIX */
	private const MARKER_SUFFIX = "-QINUP`\"'\x7f";

	/**
	 * The global strip state counter is guaranteed to be greater than
	 * the major counters in any created strip state.
	 */
	private static int $stripStateCounter = 0;

	private int $majorCounter;

	/**
	 * The minor counter for a strip state is guaranteed to be greater than the
	 * minor counter for all items in the strip state *with the same major
	 * counter*.
	 */
	private int $minorCounter;

	/**
	 * @var array<string,PFragment> A mapping from strip state keys to
	 *  PFragments.
	 */
	private array $items = [];

	private function __construct() {
		$this->majorCounter = self::$stripStateCounter++;
		$this->minorCounter = 0;
	}

	public function __clone() {
		// Ensure no two strip states have the same major counter
		$this->majorCounter = self::$stripStateCounter++;
		$this->minorCounter = 0;
	}

	/**
	 * Create a new internal key, guaranteed not to conflict with any other
	 * key.
	 */
	private function newKey(): string {
		$major = $this->majorCounter;
		$minor = $this->minorCounter++;
		return "$major-$minor";
	}

	/** Return true if there are no items in this strip state. */
	public function isEmpty(): bool {
		return !$this->items;
	}

	/**
	 * Add the given fragment to the strip state, returning a wikitext
	 * string that can be used as a placeholder for it.
	 */
	public function addWtItem( PFragment $fragment ): string {
		Assert::invariant(
			!( $fragment instanceof WikitextPFragment ),
			"strip state items should not be wikitext"
		);
		$key = $this->addWtItemKey( $fragment );
		return self::MARKER_PREFIX . $key . self::MARKER_SUFFIX;
	}

	/**
	 * Return true if the given wikitext string contains a strip marker,
	 * or false otherwise.
	 */
	public static function containsStripMarker( string $s ): bool {
		return str_contains( $s, self::MARKER_PREFIX );
	}

	/**
	 * Return true if the given wikitext string starts with a strip marker,
	 * or false otherwise.
	 */
	public static function startsWithStripMarker( string $s ): bool {
		return str_starts_with( $s, self::MARKER_PREFIX );
	}

	/**
	 * Return true if the given wikitext string ends with a strip marker,
	 * or false otherwise.
	 */
	public static function endsWithStripMarker( string $s ): bool {
		return str_ends_with( $s, self::MARKER_SUFFIX );
	}

	/**
	 * Add the given fragment to the strip state, returning the internal
	 * strip state key used for it.
	 */
	private function addWtItemKey( PFragment $fragment ): string {
		Assert::invariant(
			!( $fragment instanceof WikitextPFragment ),
			"wikitext fragments shouldn't be buried in strip state"
		);
		$key = $this->newKey();
		$this->items[$key] = $fragment;
		return $key;
	}

	/**
	 * Split the given wikitext string at its strip markers and return an array
	 * which alternates between string items and PFragment items.
	 * The first and last items are guaranteed to be strings, and the
	 * array length is guaranteed to be odd and at least 1.
	 * @return list<string|PFragment>
	 */
	public function splitWt( string $wikitext ): array {
		static $regex = '/' . self::MARKER_PREFIX . "([^\x7f<>&'\"]+)" . self::MARKER_SUFFIX . '/';
		$pieces = preg_split( $regex, $wikitext, -1, PREG_SPLIT_DELIM_CAPTURE );
		for ( $i = 1; $i < count( $pieces ); $i += 2 ) {
			$pieces[$i] = $this->items[$pieces[$i]];
		}
		return $pieces;
	}

	/**
	 * Create a new empty strip state.
	 */
	public static function new(): StripState {
		return new StripState();
	}

	/**
	 * Add all mappings from the given strip states to this one.
	 */
	public function addAllFrom( StripState ...$others ): void {
		foreach ( $others as $ss ) {
			foreach ( $ss->items as $key => $value ) {
				$this->items[$key] = $value;
			}
		}
	}

	/**
	 * Create a new strip state which contains the mappings of all of the
	 * given strip states.
	 */
	public static function merge( StripState $first, StripState ...$others ): StripState {
		$ss = clone $first;
		$ss->addAllFrom( ...$others );
		return $ss;
	}
}
