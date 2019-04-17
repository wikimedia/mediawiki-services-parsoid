<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use Parsoid\Config\Env;
use Parsoid\Config\WikitextConstants as Consts;
use Parsoid\Tokens\Token;

/**
 * This file contains general utilities for token transforms.
 */
class Util {
	// Non-global and global versions of regexp for use everywhere
	const COMMENT_REGEXP = '/<!--(?:[^-]|-(?!->))*-->/';

	const COMMENT_REGEXP_G = '/<!--(?:[^-]|-(?!->))*-->/g';

	/**
	 * Regexp for checking marker metas typeofs representing
	 * transclusion markup or template param markup.
	 */
	const TPL_META_TYPE_REGEXP = '#(?:^|\s)(mw:(?:Transclusion|Param)(?:/End)?)(?=$|\s)#';

	/**
	 * PORT_FIXME add accurate description of this private function which was nested in JS
	 *
	 * @param object $target The object to modify.
	 * @param object $obj The object to extend tgt with.
	 * @return object
	 */
	private static function internalExtend( $target, $obj ) {
		throw new \BadMethodCallException( 'Not yet ported. This might need other native solutions.' );
		/*
		$allKeys = array_merge( get_object_vars( $target ), get_object_vars( $obj ) );
		for ( $i = 0, $numKeys = $allKeys->length; $i < $numKeys; $i++ ) {
			$k = $allKeys[$i];
			if ( $target[$k] === undefined || $target[$k] === null ) {
				$target[$k] = $obj[$k];
			}
		}
		return $target;
		*/
	}
	/**
	 * Update only those properties that are undefined or null in the target.
	 * Add more arguments to the function call to chain more extensions.
	 *
	 * @param object $tgt The object to modify.
	 * @param object $subject The object to extend tgt with.
	 * @return object
	 */
	public static function extendProps( $tgt, $subject /* FIXME: use spread operator */ ) {
		throw new \BadMethodCallException( 'Not yet ported. This might need other native solutions.' );
		/*	function internalExtend(target, obj) {
				var allKeys = [].concat(Object.keys(target), Object.keys(obj));
				for (var i = 0, numKeys = allKeys.length; i < numKeys; i++) {
					var k = allKeys[i];
					if (target[k] === undefined || target[k] === null) {
						target[k] = obj[k];
					}
				}
				return target;
			}
			var n = arguments.length;
			for (var j = 1; j < n; j++) {
				internalExtend(tgt, arguments[j]);
			}
			return tgt;
		}, */
		/*
		// PORT-FIXME
		$n = $arguments->length;
		for ( $j = 1; $j < $n; $j++ ) {
			internalExtend( $tgt, $arguments[$j] );
		}
		return $tgt;
		*/
	}

	/**
	 * Strip Parsoid id prefix from aboutID
	 *
	 * @param string $aboutId aboud ID string
	 * @return string
	 */
	public static function stripParsoidIdPrefix( string $aboutId ): string {
		// 'mwt' is the prefix used for new ids
		return preg_replace( '/^#?mwt/', '', $aboutId );
	}

	/**
	 * Check for Parsoid id prefix in an aboutID string
	 *
	 * @param string $aboutId aboud ID string
	 * @return bool
	 */
	public static function isParsoidObjectId( string $aboutId ): bool {
		// 'mwt' is the prefix used for new ids
		return (bool)preg_match( '/^#mwt/', $aboutId );
	}

	/**
	 * Determine if the named tag is void (can not have content).
	 *
	 * @param string $name tag name
	 * @return bool
	 */
	public static function isVoidElement( string $name ): bool {
		// PORT-FIXME: Remove after porting is complete
		if ( strtolower( $name ) !== $name ) {
			throw new \BadMethodCallException( "Use lowercase tag names" );
		}
		return isset( Consts::$HTML['VoidTags'][ $name ] );
	}

	/**
	 * recursive deep clones helper function
	 *
	 * @param object $el object
	 * @return object
	 */
	private static function recursiveClone( $el ) {
		return self::clone( $el, true );
	}

	/**
	 * deep clones by default.
	 * FIXME, see T161647
	 * @param object|array $obj any plain object not tokens or DOM trees
	 * @param bool $deepClone
	 * @return object|array
	 */
	public static function clone( $obj, $deepClone = true ) {
		if ( !$deepClone && is_object( $obj ) ) {
			return clone $obj;
		}
		return unserialize( serialize( $obj ) );
	}

	/**
	 * recursive deep unfreeze helper function
	 *
	 * @param object $el object
	 * @return object
	 */
	private static function recursiveUnfreeze( $el ) {
		return self::unFreeze( $el, true );
	}

	/**
	 * Just a copy `Util::clone` used in *testing* to reverse the effects of
	 * freezing an object.  Works with more than just "plain objects"
	 *
	 * @param object $obj object
	 * @param bool $deepClone
	 * @return object
	 */
	public static function unFreeze( $obj, $deepClone ) {
	/*	if (deepClone === undefined) {
			deepClone = true;
		}
		if (Array.isArray(obj)) {
			if (deepClone) {
				return obj.map(function(el) {
					return Util.unFreeze(el, true);
				});
			} else {
				return obj.slice();
			}
		} else if (obj instanceof Object) {
			if (deepClone) {
				return Object.keys(obj).reduce(function(nobj, key) {
					nobj[key] = Util.unFreeze(obj[key], true);
					return nobj;
				}, new obj.constructor());
			} else {
				return Object.assign({}, obj);
			}
		} else {
			return obj;
		} */
		throw new \BadMethodCallException( 'Not yet ported. This might need other native solutions.' );
	}

	/**
	 * This should not be used.
	 * @param string $txt URL to encode using PHP encoding
	 * @return string
	 */
	public static function phpURLEncode( $txt ) {
		throw new \BadMethodCallException( 'Use urlencode( $txt ) instead' );
	}

	/**
	 * Wraps `decodeURI` in a try/catch to suppress throws from malformed URI
	 * sequences.  Distinct from `decodeURIComponent` in that certain
	 * sequences aren't decoded if they result in (un)reserved characters.
	 *
	 * @param string $s URI to be decoded
	 * @return string
	 */
	public static function decodeURI( string $s ): string {
		return preg_replace_callback( '/(%[0-9a-fA-F][0-9a-fA-F])/', function ( $match ) {
			try {
				// PORT-FIXME: JS code here was decodeURI(m);
				return urldecode( $match[1] );
			} catch ( \Exception $e ) {
				return $match;
			}
		}, $s );
	}

	/**
	 * Wraps `decodeURIComponent` in a try/catch to suppress throws from
	 * malformed URI sequences.
	 *
	 * @param string $s URI to be decoded
	 * @return string
	 */
	public static function decodeURIComponent( string $s ): string {
		return preg_replace_callback( '/(%[0-9a-fA-F][0-9a-fA-F])/', function ( $match ) {
			try {
				// PORT-FIXME: JS code here was decodeURIComponent(m);
				return rawurldecode( $match );
			} catch ( \Exception $e ) {
				return $match;
			}
		}, $s );
	}

	/**
	 * Extract extension source from the token
	 *
	 * @param Token $token token
	 * @return string
	 */
	public static function extractExtBody( Token $token ): string {
		$src = $token->getAttribute( 'source' );
		$tagWidths = $token->dataAttribs->tagWidths;
		return mb_substr( $src, $tagWidths[0], -$tagWidths[1] );
	}

	/**
	 * Helper function checks numeric values
	 *
	 * @param ?int $n checks parameters for numeric type and value zero or positive
	 * @return bool
	 */
	private static function isValidOffset( ?int $n ): bool {
		return $n !== null && $n >= 0;
	}

	/**
	 * Check for valid DSR range(s)
	 * DSR = "DOM Source Range".  [0] and [1] are open and end,
	 * [2] and [3] are widths of the container tag.
	 *
	 * @param array|null $dsr DSR source range values
	 * @param bool $all Also check the widths of the container tag
	 * @return bool
	 */
	public static function isValidDSR( ?array $dsr, bool $all = false ): bool {
		return $dsr !== null &&
			self::isValidOffset( $dsr[0] ?? null ) && self::isValidOffset( $dsr[1] ?? null ) &&
			( !$all || ( self::isValidOffset( $dsr[2] ?? null ) && self::isValidOffset( $dsr[3] ?? null )
			) );
	}

	/**
	 * Quickly hash an array or string.
	 *
	 * @param Array|string $arr data to hash
	 * @return string
	 */
	public static function makeHash( $arr ) {
		// PORT-FIXME: Remove after porting is complete
		throw new \BadMethodCallException( "This function should not be used.\n" .
			"On the JS side, this was only needed for M/W API requests." );
	}

	/**
	 * Cannonicalizes a namespace name.
	 *
	 * Used by {@link WikiConfig}.
	 *
	 * @param string $name Non-normalized namespace name.
	 * @return string
	 */
	public static function normalizeNamespaceName( string $name ): string {
		return str_replace( ' ', '_', strtolower( $name ) );
	}

	/**
	 * Decode HTML5 entities in wikitext.
	 *
	 * NOTE that wikitext only allows semicolon-terminated entities, while
	 * HTML allows a number of "legacy" entities to be decoded without
	 * a terminating semicolon.  This function deliberately does not
	 * decode these HTML-only entity forms.
	 *
	 * @param string $text
	 * @return string
	 */
	public static function decodeWtEntities( string $text ): string {
		// HTML5 allows semicolon-less entities which wikitext does not:
		// in wikitext all entities must end in a semicolon.
		// PHP currently doesn't decode semicolon-less entities (see
		// https://bugs.php.net/bug.php?id=77769 ) but we've got a
		// unit test which would fail if it ever started to.
		return html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'utf-8' );
	}

	/**
	 * Entity-escape anything that would decode to a valid wikitext entity.
	 *
	 * Note that HTML5 allows certain "semicolon-less" entities, like
	 * `&para`; these aren't allowed in wikitext and won't be escaped
	 * by this function.
	 *
	 * @param string $text
	 * @return string
	 */
	public static function escapeWtEntities( string $text ): string {
		// We just want to encode ampersands that precede valid entities.
		// (And note that semicolon-less entities aren't valid wikitext.)
		return preg_replace_callback( '/&[#0-9a-zA-Z]+;/', function ( $match ) {
			$m = $match[0];
			$decodedChar = self::decodeWtEntities( $m );
			if ( $decodedChar !== $m ) {
				// Escape the ampersand
				return '&amp;' . substr( $m, 1 );
			} else {
				// Not an entity, just return the string
				return $m;
			}
		}, $text );
	}

	/**
	 * PORT-FIXME need accurate function description
	 *
	 *
	 * @param string $s
	 * @return string
	 */
	public static function escapeHtml( string $s ): string {
		// Only encodes five characters: " ' & < >
		return htmlspecialchars( $s, ENT_QUOTES | ENT_HTML5 );
	}

	/**
	 * Encode all characters as entity references.  This is done to make
	 * characters safe for wikitext (regardless of whether they are
	 * HTML-safe). Typically only called with single-codepoint strings.
	 * @param string $s
	 * @return string
	 */
	public static function entityEncodeAll( string $s ): string {
		// This is Unicode aware.
		static $conventions = [
			// We always use at least two characters for the hex code
			'&#x0;' => '&#x00;', '&#x1;' => '&#x01;', '&#x2;' => '&#x02;', '&#x3;' => '&#x03;',
			'&#x4;' => '&#x04;', '&#x5;' => '&#x05;', '&#x6;' => '&#x06;', '&#x7;' => '&#x07;',
			'&#x8;' => '&#x08;', '&#x9;' => '&#x09;', '&#xA;' => '&#x0A;', '&#xB;' => '&#x0B;',
			'&#xC;' => '&#x0C;', '&#xD;' => '&#x0D;', '&#xE;' => '&#x0E;', '&#xF;' => '&#x0F;',
			// By convention we use &nbsp; where possible
			'&#xA0;' => '&nbsp;',
		];

		return strtr( mb_encode_numericentity(
			$s, [ 0, 0x10ffff, 0, ~0 ], 'utf-8', true
		), $conventions );
	}

	/**
	 * Determine whether the protocol of a link is potentially valid. Use the
	 * environment's per-wiki config to do so.
	 *
	 * @param mixed $linkTarget
	 * @param Env $env
	 * @return bool
	 */
	public static function isProtocolValid( $linkTarget, Env $env ): bool {
		$siteConf = $env->getSiteConfig();
		if ( is_string( $linkTarget ) ) {
			return $siteConf->hasValidProtocol( $linkTarget );
		} else {
			return true;
		}
	}

	/**
	 * Get external argument info? PORT_FIXME accuracy of descript?
	 *
	 * @param object $extToken
	 * @return object
	 */
	public static function getExtArgInfo( $extToken ) {
		// PORT-FIXME
/*		var name = extToken.getAttribute('name');
		var options = extToken.getAttribute('options');
		return {
			dict: {
				name: name,
				attrs: TokenUtils.kvToHash(options, true),
				body: { extsrc: Util.extractExtBody(extToken) },
			},
		}; */
		throw new \BadMethodCallException( "Not yet ported" );
	}

	/**
	 * Parse media dimensions
	 *
	 * @param string $str media dimensions
	 * @param bool $onlyOne
	 * @return array
	 */
	public static function parseMediaDimensions( $str, $onlyOne ) {
		// PORT-FIXME
/*		var dimensions = null;
		var match = str.match(/^(\d*)(?:x(\d+))?\s*(?:px\s*)?$/);
		if (match) {
			dimensions = { x: Number(match[1]) };
			if (match[2] !== undefined) {
				if (onlyOne) { return null; }
				dimensions.y = Number(match[2]);
			}
		}
		return dimensions; */
		throw new \BadMethodCallException( "Not yet ported" );
	}

	/**
	 * Validate media parameters
	 * More generally, this is defined by the media handler in core
	 *
	 * @param int $num
	 * @return bool
	 */
	public static function validateMediaParam( int $num ): bool {
		return $num > 0;
	}

	/**
	 * FIXME: Is this needed??
	 *
	 * Extract content in a backwards compatible way
	 *
	 * @param object $revision
	 * @return object
	 */
	public static function getStar( $revision ) {
		/*
		$content = $revision;
		if ( $revision && isset( $revision->slots ) ) {
			$content = $revision->slots->main;
		}
		return $content;
		*/
		throw new \BadMethodCallException( "This method shouldn't be needed. " .
			"But, port this if you really need it." );
	}

	/**
	 * Magic words masquerading as templates.
	 * @property {Set}
	 */
	// PORT_FIXME no local references to this set in this file
	// magicMasqs: new Set(["defaultsort", "displaytitle"]),

	/**
	 * This regex was generated by running through *all unicode characters* and
	 * testing them against *all regexes* for linktrails in a default MW install.
	 * We had to treat it a little bit, here's what we changed:
	 *
	 * 1. A-Z, though allowed in Walloon, is disallowed.
	 * 2. '"', though allowed in Chuvash, is disallowed.
	 * 3. '-', though allowed in Icelandic (possibly due to a bug), is disallowed.
	 * 4. '1', though allowed in Lak (possibly due to a bug), is disallowed.
	 */
	public static $linkTrailRegex =
		'/^[^\0-`{÷ĀĈ-ČĎĐĒĔĖĚĜĝĠ-ĪĬ-įĲĴ-ĹĻ-ĽĿŀŅņŉŊŌŎŏŒŔŖ-ŘŜŝŠŤŦŨŪ-ŬŮŲ-ŴŶŸ' .
		'ſ-ǤǦǨǪ-Ǯǰ-ȗȜ-ȞȠ-ɘɚ-ʑʓ-ʸʽ-̂̄-΅·΋΍΢Ϗ-ЯѐѝѠѢѤѦѨѪѬѮѰѲѴѶѸѺ-ѾҀ-҃҅-ҐҒҔҕҘҚҜ-ҠҤ-ҪҬҭҰҲ' .
		'Ҵ-ҶҸҹҼ-ҿӁ-ӗӚ-ӜӞӠ-ӢӤӦӪ-ӲӴӶ-ՠֈ-׏׫-ؠً-ٳٵ-ٽٿ-څڇ-ڗڙ-ڨڪ-ڬڮڰ-ڽڿ-ۅۈ-ۊۍ-۔ۖ-਀਄਋-਎਑਒' .
		'਩਱਴਷਺਻਽੃-੆੉੊੎-੘੝੟-੯ੴ-჏ჱ-ẼẾ-​\u200d-‒—-‗‚‛”--\ufffd\ufffd]+$/';

	/**
	 * Check whether some text is a valid link trail.
	 *
	 * @param string $text
	 * @return bool
	 */
	public static function isLinkTrail( string $text ): bool {
		return $text !== '' && preg_match( self::$linkTrailRegex, $text );
	}

	/**
	 * Convert mediawiki-format language code to a BCP47-compliant language
	 * code suitable for including in HTML.  See
	 * `GlobalFunctions.php::wfBCP47()` in mediawiki sources.
	 *
	 * @param string $code Mediawiki language code.
	 * @return string BCP47 language code.
	 */
	public static function bcp47n( $code ) {
		throw new \BadMethodCallException( "Not yet ported" );
		// PORT_FIXME
		/*
		var codeSegment = code.split('-');
		var codeBCP = [];
		codeSegment.forEach(function(seg, segNo) {
			// When previous segment is x, it is a private segment and should be lc
			if (segNo > 0 && /^x$/i.test(codeSegment[segNo - 1])) {
				codeBCP[segNo] = seg.toLowerCase();
			// ISO 3166 country code
			} else if (seg.length === 2 && segNo > 0) {
				codeBCP[segNo] = seg.toUpperCase();
			// ISO 15924 script code
			} else if (seg.length === 4 && segNo > 0) {
				codeBCP[segNo] = seg[0].toUpperCase() + seg.slice(1).toLowerCase();
			// Use lowercase for other cases
			} else {
				codeBCP[segNo] = seg.toLowerCase();
			}
		});
		return codeBCP.join('-');
		*/
	}
}
