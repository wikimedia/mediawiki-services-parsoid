<?php

/**
 * General token sanitizer. Strips out (or encapsulates) unsafe and disallowed
 * tag types and attributes. Should run last in the third, synchronous
 * expansion stage.
 *
 * FIXME: This code was originally ported from PHP to JS in 2012
 * and periodically updated before being back to PHP. This code should be
 * (a) resynced with core sanitizer changes (b) updated to use HTML5 spec
 */

namespace Parsoid\Wt2Html\TT;

use DOMElement;
use Error;
use Parsoid\Config\Env;
use Parsoid\Config\WikitextConstants;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\SelfclosingTagTk;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\KV;
use Parsoid\Tokens\Token;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\TokenUtils;
use Parsoid\Utils\Util;

class Sanitizer extends TokenHandler {
	private $inTemplate;
	private $noEndTagSet;
	private $cssDecodeRE;
	private $attrWhiteList;
	private $microData;
	private $attrWhiteListCache;

	const UTF8_REPLACEMENT = "ï¿½";

	/**
	 * Regular expression to match various types of character references in
	 * Sanitizer::normalizeCharReferences and Sanitizer::decodeCharReferences
	 */
	const CHAR_REFS_RE_G = "/&([A-Za-z0-9\x80-\xff]+);
		|&\#([0-9]+);
		|&\#[xX]([0-9A-Fa-f]+);
		|(&)/x";

	const INSECURE_RE = '! expression
		| filter\s*:
		| accelerator\s*:
		| -o-link\s*:
		| -o-link-source\s*:
		| -o-replace\s*:
		| url\s*\(
		| image\s*\(
		| image-set\s*\(
		| attr\s*\([^)]+[\s,]+url
	!ix';

	/**
	 * Blacklist for evil uris like javascript:
	 * WARNING: DO NOT use this in any place that actually requires blacklisting
	 * for security reasons. There are NUMEROUS[1] ways to bypass blacklisting, the
	 * only way to be secure from javascript: uri based xss vectors is to whitelist
	 * things that you know are safe and deny everything else.
	 * [1]: http://ha.ckers.org/xss.html
	 */
	const EVIL_URI_RE = '/(^|\s|\*\/\s*)(javascript|vbscript)([^\w]|$)/i';

	const XMLNS_ATTRIBUTE_RE = '/^xmlns:[:A-Z_a-z-.0-9]+$/';

	const IDN_RE_G = [
		"[\t ]|" . // general whitespace
		"­|" . // 00ad SOFT HYPHEN
		"᠆|" . // 1806 MONGOLIAN TODO SOFT HYPHEN
		"​|" . // 200b ZERO WIDTH SPACE
		"⁠|" . // 2060 WORD JOINER
		"﻿|" . // feff ZERO WIDTH NO-BREAK SPACE
		"͏|" . // 034f COMBINING GRAPHEME JOINER
		"᠋|" . // 180b MONGOLIAN FREE VARIATION SELECTOR ONE
		"᠌|" . // 180c MONGOLIAN FREE VARIATION SELECTOR TWO
		"᠍|" . // 180d MONGOLIAN FREE VARIATION SELECTOR THREE
		"‌|" . // 200c ZERO WIDTH NON-JOINER
		"‍|" . // 200d ZERO WIDTH JOINER
		"[︀-️]" // , // fe00-fe0f VARIATION SELECTOR-1-16
		// 'g'
	];

	const GET_ATTRIBS_RE = '/^[:_\p{L}\p{N}][:_\.\-\p{L}\p{N}]*$/u';

	/** Assumptions:
	 1. This is "constant".
	 2. All sanitizers have the same global config.
	 */
	const GLOBAL_CONFIG = [
		'allowRdfaAttrs' => true,
		'allowMicrodataAttrs' => true,
		'html5Mode' => true
	];

	/** Character entity aliases accepted by MediaWiki */
	const HTML_ENTITY_ALIASES = [
		"רלמ" => 'rlm',
		"رلم" => 'rlm'
	];

	/**
	 * FIXME: Might need a HTML5 update.
	 * List of all named character entities defined in HTML 4.01
	 * http://www.w3.org/TR/html4/sgml/entities.html
	 * As well as &apos; which is only defined starting in XHTML1.
	 */
	const HTML_ENTITIES = [
		'Aacute' => 193,
		'aacute' => 225,
		'Acirc' => 194,
		'acirc' => 226,
		'acute' => 180,
		'AElig' => 198,
		'aelig' => 230,
		'Agrave' => 192,
		'agrave' => 224,
		'alefsym' => 8501,
		'Alpha' => 913,
		'alpha' => 945,
		'amp' => 38,
		'and' => 8743,
		'ang' => 8736,
		'apos' => 39, // New in XHTML & HTML 5; avoid in output for compatibility with IE.
		'Aring' => 197,
		'aring' => 229,
		'asymp' => 8776,
		'Atilde' => 195,
		'atilde' => 227,
		'Auml' => 196,
		'auml' => 228,
		'bdquo' => 8222,
		'Beta' => 914,
		'beta' => 946,
		'brvbar' => 166,
		'bull' => 8226,
		'cap' => 8745,
		'Ccedil' => 199,
		'ccedil' => 231,
		'cedil' => 184,
		'cent' => 162,
		'Chi' => 935,
		'chi' => 967,
		'circ' => 710,
		'clubs' => 9827,
		'cong' => 8773,
		'copy' => 169,
		'crarr' => 8629,
		'cup' => 8746,
		'curren' => 164,
		'dagger' => 8224,
		'Dagger' => 8225,
		'darr' => 8595,
		'dArr' => 8659,
		'deg' => 176,
		'Delta' => 916,
		'delta' => 948,
		'diams' => 9830,
		'divide' => 247,
		'Eacute' => 201,
		'eacute' => 233,
		'Ecirc' => 202,
		'ecirc' => 234,
		'Egrave' => 200,
		'egrave' => 232,
		'empty' => 8709,
		'emsp' => 8195,
		'ensp' => 8194,
		'Epsilon' => 917,
		'epsilon' => 949,
		'equiv' => 8801,
		'Eta' => 919,
		'eta' => 951,
		'ETH' => 208,
		'eth' => 240,
		'Euml' => 203,
		'euml' => 235,
		'euro' => 8364,
		'exist' => 8707,
		'fnof' => 402,
		'forall' => 8704,
		'frac12' => 189,
		'frac14' => 188,
		'frac34' => 190,
		'frasl' => 8260,
		'Gamma' => 915,
		'gamma' => 947,
		'ge' => 8805,
		'gt' => 62,
		'harr' => 8596,
		'hArr' => 8660,
		'hearts' => 9829,
		'hellip' => 8230,
		'Iacute' => 205,
		'iacute' => 237,
		'Icirc' => 206,
		'icirc' => 238,
		'iexcl' => 161,
		'Igrave' => 204,
		'igrave' => 236,
		'image' => 8465,
		'infin' => 8734,
		'int' => 8747,
		'Iota' => 921,
		'iota' => 953,
		'iquest' => 191,
		'isin' => 8712,
		'Iuml' => 207,
		'iuml' => 239,
		'Kappa' => 922,
		'kappa' => 954,
		'Lambda' => 923,
		'lambda' => 955,
		'lang' => 9001,
		'laquo' => 171,
		'larr' => 8592,
		'lArr' => 8656,
		'lceil' => 8968,
		'ldquo' => 8220,
		'le' => 8804,
		'lfloor' => 8970,
		'lowast' => 8727,
		'loz' => 9674,
		'lrm' => 8206,
		'lsaquo' => 8249,
		'lsquo' => 8216,
		'lt' => 60,
		'macr' => 175,
		'mdash' => 8212,
		'micro' => 181,
		'middot' => 183,
		'minus' => 8722,
		'Mu' => 924,
		'mu' => 956,
		'nabla' => 8711,
		'nbsp' => 160,
		'ndash' => 8211,
		'ne' => 8800,
		'ni' => 8715,
		'not' => 172,
		'notin' => 8713,
		'nsub' => 8836,
		'Ntilde' => 209,
		'ntilde' => 241,
		'Nu' => 925,
		'nu' => 957,
		'Oacute' => 211,
		'oacute' => 243,
		'Ocirc' => 212,
		'ocirc' => 244,
		'OElig' => 338,
		'oelig' => 339,
		'Ograve' => 210,
		'ograve' => 242,
		'oline' => 8254,
		'Omega' => 937,
		'omega' => 969,
		'Omicron' => 927,
		'omicron' => 959,
		'oplus' => 8853,
		'or' => 8744,
		'ordf' => 170,
		'ordm' => 186,
		'Oslash' => 216,
		'oslash' => 248,
		'Otilde' => 213,
		'otilde' => 245,
		'otimes' => 8855,
		'Ouml' => 214,
		'ouml' => 246,
		'para' => 182,
		'part' => 8706,
		'permil' => 8240,
		'perp' => 8869,
		'Phi' => 934,
		'phi' => 966,
		'Pi' => 928,
		'pi' => 960,
		'piv' => 982,
		'plusmn' => 177,
		'pound' => 163,
		'prime' => 8242,
		'Prime' => 8243,
		'prod' => 8719,
		'prop' => 8733,
		'Psi' => 936,
		'psi' => 968,
		'quot' => 34,
		'radic' => 8730,
		'rang' => 9002,
		'raquo' => 187,
		'rarr' => 8594,
		'rArr' => 8658,
		'rceil' => 8969,
		'rdquo' => 8221,
		'real' => 8476,
		'reg' => 174,
		'rfloor' => 8971,
		'Rho' => 929,
		'rho' => 961,
		'rlm' => 8207,
		'rsaquo' => 8250,
		'rsquo' => 8217,
		'sbquo' => 8218,
		'Scaron' => 352,
		'scaron' => 353,
		'sdot' => 8901,
		'sect' => 167,
		'shy' => 173,
		'Sigma' => 931,
		'sigma' => 963,
		'sigmaf' => 962,
		'sim' => 8764,
		'spades' => 9824,
		'sub' => 8834,
		'sube' => 8838,
		'sum' => 8721,
		'sup' => 8835,
		'sup1' => 185,
		'sup2' => 178,
		'sup3' => 179,
		'supe' => 8839,
		'szlig' => 223,
		'Tau' => 932,
		'tau' => 964,
		'there4' => 8756,
		'Theta' => 920,
		'theta' => 952,
		'thetasym' => 977,
		'thinsp' => 8201,
		'THORN' => 222,
		'thorn' => 254,
		'tilde' => 732,
		'times' => 215,
		'trade' => 8482,
		'Uacute' => 218,
		'uacute' => 250,
		'uarr' => 8593,
		'uArr' => 8657,
		'Ucirc' => 219,
		'ucirc' => 251,
		'Ugrave' => 217,
		'ugrave' => 249,
		'uml' => 168,
		'upsih' => 978,
		'Upsilon' => 933,
		'upsilon' => 965,
		'Uuml' => 220,
		'uuml' => 252,
		'weierp' => 8472,
		'Xi' => 926,
		'xi' => 958,
		'Yacute' => 221,
		'yacute' => 253,
		'yen' => 165,
		'Yuml' => 376,
		'yuml' => 255,
		'Zeta' => 918,
		'zeta' => 950,
		'zwj' => 8205,
		'zwnj' => 8204
	];

	// U+0280, U+0274, U+207F, U+029F, U+026A, U+207D, U+208D
	const IE_REPLACEMENTS = [
		"ʀ" => 'r',
		"ɴ" => 'n',
		"ⁿ" => 'n',
		"ʟ" => 'l',
		"ɪ" => 'i',
		"⁽" => '(',
		"₍" => '('
	];

	/**
	 * Constructor for paragraph wrapper.
	 * @param object $manager manager enviroment
	 * @param array $options various configuration options
	 */
	public function __construct( $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->inTemplate = !empty( $options[ 'inTemplate' ] );
		$this->setDerivedConstants();
		$this->setMicroData();
		$this->attrWhiteListCache = [];
	}

	// RDFa and microdata properties allow URLs, URIs and/or CURIs.
	private function setMicroData(): void {
		$this->microData = PHPUtils::makeSet( [
				'rel', 'rev', 'about', 'property', 'resource', 'datatype', 'typeof', // RDFa
				'itemid', 'itemprop', 'itemref', 'itemscope', 'itemtype'
			]
		);
	}

	/**
	 * @return string
	 */
	private function computeCSSDecodeRegexp(): string {
		// Decode escape sequences and line continuation
		// See the grammar in the CSS 2 spec, appendix D.
		// This has to be done AFTER decoding character references.
		// This means it isn't possible for this function to return
		// unsanitized escape sequences. It is possible to manufacture
		// input that contains character references that decode to
		// escape sequences that decode to character references, but
		// it's OK for the return value to contain character references
		// because the caller is supposed to escape those anyway.
		$space = '[\x20\t\r\n\f]';
		$nl = '(?:\n|\r\n|\r|\f)';
		$backslash = '\\\\';
		return '/' . $backslash .
			'(?:' .
			'(' . $nl . ')|' . // 1. Line continuation
			'([0-9A-Fa-f]{1,6})' . $space . '?|' . // 2. character number
			'(.)|' . // 3. backslash cancelling special meaning
			'()$' . // 4. backslash at end of string
			')' . '/xu';
	}

	// SSS FIXME:
	// If multiple sanitizers with different configs can be active at the same time,
	// attrWhiteList code would have to be redone to cache the white list in the
	// Sanitizer object rather than in the SanitizerConstants object.
	/**
	 * @param array $config
	 * @return array
	 */
	private function computeAttrWhiteList( array $config ): array {
		$common = [ 'id', 'class', 'lang', 'dir', 'title', 'style' ];

		// WAI-ARIA
		$common = array_merge( $common, [
				'aria-describedby',
				'aria-flowto',
				'aria-label',
				'aria-labelledby',
				'aria-owns',
				'role'
			]
		);

		// RDFa attributes
		// These attributes are specified in section 9 of
		// https://www.w3.org/TR/2008/REC-rdfa-syntax-20081014
		$rdfa = [ 'about', 'property', 'resource', 'datatype', 'typeof' ];
		if ( !empty( $config[ 'allowRdfaAttrs' ] ) ) {
			$common = array_merge( $common, $rdfa );
		}

		// Microdata. These are specified by
		// https://html.spec.whatwg.org/multipage/microdata.html#the-microdata-model
		$mda = [ 'itemid', 'itemprop', 'itemref', 'itemscope', 'itemtype' ];
		if ( !empty( $config[ 'allowMicrodataAttrs' ] ) ) {
			$common = array_merge( $common, $mda );
		}

		$block = array_merge( $common, [ 'align' ] );
		$tablealign = [ 'align', 'valign' ];
		$tablecell = [
			'abbr', 'axis', 'headers', 'scope', 'rowspan', 'colspan',
			// these next 4 are deprecated
			'nowrap', 'width', 'height', 'bgcolor'
		];

		// Numbers refer to sections in HTML 4.01 standard describing the element.
		// See: http://www.w3.org/TR/html4/
		return [
			// 7.5.4
			'div' => $block,
			'center' => $common, // deprecated
			'span' => $common,

			// 7.5.5
			'h1' => $block,
			'h2' => $block,
			'h3' => $block,
			'h4' => $block,
			'h5' => $block,
			'h6' => $block,

			// 7.5.6
			// address

			// 8.2.4
			'bdo' => $common,

			// 9.2.1
			'em' => $common,
			'strong' => $common,
			'cite' => $common,
			'dfn' => $common,
			'code' => $common,
			'samp' => $common,
			'kbd' => $common,
			'var' => $common,
			'abbr' => $common,
			// acronym

			// 9.2.2
			'blockquote' => array_merge( $common, [ 'cite' ] ),
			'q' => array_merge( $common, [ 'cite' ] ),

			// 9.2.3
			'sub' => $common,
			'sup' => $common,

			// 9.3.1
			'p' => $block,

			// 9.3.2
			'br' => array_merge( $common, [ 'clear' ] ),

			// https://www.w3.org/TR/html5/text-level-semantics.html#the-wbr-element
			'wbr' => $common,

			// 9.3.4
			'pre' => array_merge( $common, [ 'width' ] ),

			// 9.4
			'ins' => array_merge( $common, [ 'cite', 'datetime' ] ),
			'del' => array_merge( $common, [ 'cite', 'datetime' ] ),

			// 10.2
			'ul' => array_merge( $common, [ 'type' ] ),
			'ol' => array_merge( $common, [ 'type', 'start', 'reversed' ] ),
			'li' => array_merge( $common, [ 'type', 'value' ] ),

			// 10.3
			'dl' => $common,
			'dd' => $common,
			'dt' => $common,

			// 11.2.1
			'table' => array_merge( $common, [
					'summary', 'width', 'border', 'frame',
					'rules', 'cellspacing', 'cellpadding',
					'align', 'bgcolor'
				]
			),

			// 11.2.2
			'caption' => $block,

			// 11.2.3
			'thead' => $common,
			'tfoot' => $common,
			'tbody' => $common,

			// 11.2.4
			'colgroup' => array_merge( $common, [ 'span' ] ),
			'col' => array_merge( $common, [ 'span' ] ),

			// 11.2.5
			'tr' => array_merge( $common, [ 'bgcolor' ], $tablealign ),

			// 11.2.6
			'td' => array_merge( $common, $tablecell, $tablealign ),
			'th' => array_merge( $common, $tablecell, $tablealign ),

			// 12.2
			// NOTE: <a> is not allowed directly, but the attrib
			// whitelist is used from the Parser object
			'a' => array_merge( $common, [ 'href', 'rel', 'rev' ] ), // rel/rev esp. for RDFa

			// 13.2
			// Not usually allowed, but may be used for extension-style hooks
			// such as <math> when it is rasterized, or if wgAllowImageTag is
			// true
			'img' => array_merge( $common, [ 'alt', 'src', 'width', 'height', 'srcset' ] ),
			// Attributes for A/V tags added in T163583
			'audio' => array_merge( $common, [ 'controls', 'preload', 'width', 'height' ] ),
			'video' => array_merge( $common, [ 'poster', 'controls', 'preload', 'width', 'height' ] ),
			'source' => array_merge( $common, [ 'type', 'src' ] ),
			'track' => array_merge( $common, [ 'type', 'src', 'srclang', 'kind', 'label' ] ),

			// 15.2.1
			'tt' => $common,
			'b' => $common,
			'i' => $common,
			'big' => $common,
			'small' => $common,
			'strike' => $common,
			's' => $common,
			'u' => $common,

			// 15.2.2
			'font' => array_merge( $common, [ 'size', 'color', 'face' ] ),
			// basefont

			// 15.3
			'hr' => array_merge( $common, [ 'width' ] ),

			// HTML Ruby annotation text module, simple ruby only.
			// https://www.w3.org/TR/html5/text-level-semantics.html#the-ruby-element
			'ruby' => $common,
			// rbc
			'rb' => $common,
			'rp' => $common,
			'rt' => $common, // common.concat([ 'rbspan' ]),
			'rtc' => $common,

			// MathML root element, where used for extensions
			// 'title' may not be 100% valid here; it's XHTML
			// http://www.w3.org/TR/REC-MathML/
			'math' => [ 'class', 'style', 'id', 'title' ],

			// HTML 5 section 4.5
			'figure' => $common,
			'figure-inline' => $common,
			'figcaption' => $common,

			// HTML 5 section 4.6
			'bdi' => $common,

			// HTML5 elements, defined by:
			// https://html.spec.whatwg.org/multipage/semantics.html#the-data-element
			'data' => array_merge( $common, [ 'value' ] ),
			'time' => array_merge( $common, [ 'datetime' ] ),
			'mark' => $common,

			// meta and link are only permitted by removeHTMLtags when Microdata
			// is enabled so we don't bother adding a conditional to hide these
			// Also meta and link are only valid in WikiText as Microdata elements
			// (ie: validateTag rejects tags missing the attributes needed for Microdata)
			// So we don't bother including $common attributes that have no purpose.
			'meta' => [ 'itemprop', 'content' ],
			'link' => [ 'itemprop', 'href', 'title' ]
		];
	}

	// init caches, convert lists to hashtables, etc.

	/**
	 * setDerivedConstants()
	 */
	private function setDerivedConstants(): void {
		// Tags whose end tags are not accepted, but whose start /
		// self-closing version might be legal.
		$this->noEndTagSet = PHPUtils::makeSet( [ 'br' ] );
		$this->cssDecodeRE = $this->computeCSSDecodeRegexp();
		$this->attrWhiteList = $this->computeAttrWhiteList( self::GLOBAL_CONFIG );
	}

	/**
	 * Returns true if a given Unicode codepoint is a valid character in XML.
	 *
	 * @param int $cp
	 * @return bool
	 */
	private function validateCodepoint( int $cp ): bool {
		return ( $cp === 0x09 )
		|| ( $cp === 0x0a )
		|| ( $cp === 0x0d )
		|| ( $cp >= 0x20 && $cp <= 0xd7ff )
		|| ( $cp >= 0xe000 && $cp <= 0xfffd )
		|| ( $cp >= 0x10000 && $cp <= 0x10ffff );
	}

	/**
	 * Returns a string from the provided code point.
	 *
	 * @param int $cp
	 * @return string
	 */
	private function codepointToUtf8( int $cp ): string {
		return mb_chr( $cp, 'UTF-8' );
	}

	/**
	 * Returns the code point at the first position of the string.
	 *
	 * @param string $str
	 * @return int
	 */
	private function utf8ToCodepoint( string $str ): int {
		return mb_ord( $str );
	}

	/**
	 * @param string $tag
	 * @return array
	 */
	private function getAttrWhiteList( string $tag ) {
		$awlCache = $this->attrWhiteListCache;
		if ( empty( $awlCache[ $tag ] ) ) {
			$awlCache[ $tag ] = PHPUtils::makeSet( $this->attrWhiteList[ $tag ] ?? [] );
		}
		return $awlCache[ $tag ];
	}

	/**
	 * @param string $host
	 * @return string
	 */
	private function stripIDNs( string $host ) {
		return str_replace( self::IDN_RE_G, '', $host );
	}

	/**
	 * @param Env $env
	 * @param string $href
	 * @param string $mode
	 * @return string|null
	 */
	private function cleanUrl( Env $env, string $href, string $mode ): ?string {
		// PORT_FIXME - this code seems wrong and unnecessary, code tests right without it.
		// if ( $mode !== 'wikilink' ) {
		// $href = preg_replace( '/([\][<>"\x00-\x20\x7F\|])/', $href, urlencode( $href ) );
		// $temp = 0;  // just here to provide a line for a breakpoint
		// }

		preg_match( '/^((?:[a-zA-Z][^:\/]*:)?(?:\/\/)?)([^\/]+)(\/?.*)/', $href, $bits );
		$proto = null;
		$host = null;
		$path = null;
		if ( $bits ) {
			$proto = $bits[ 1 ];
			// if ( $proto && !$env->conf->wiki->hasValidProtocol( $proto ) ) {
			if ( $proto && !$env->getSiteConfig()->hasValidProtocol( $proto ) ) {
				// invalid proto, disallow URL
				return null;
			}
			$host = $this->stripIDNs( $bits[ 2 ] );
			preg_match( '/^%5B([0-9A-Fa-f:.]+)%5D((:\d+)?)$/', $host, $match );
			if ( $match ) {
				// IPv6 host names
				$host = '[' . $match[ 1 ] . ']' . $match[ 2 ];
			}
			$path = $bits[ 3 ];
		} else {
			$proto = '';
			$host = '';
			$path = $href;
		}
		return $proto . $host . $path;
	}

	/**
	 * If the named entity is defined in the HTML 4.0/XHTML 1.0 DTD,
	 * return the UTF-8 encoding of that character. Otherwise, returns
	 * pseudo-entity source (eg "&foo;").
	 * @param string $name
	 * @return string
	 */
	private function decodeEntity( string $name ): string {
		if ( self::HTML_ENTITY_ALIASES[ $name ] ) {
			$name = self::HTML_ENTITY_ALIASES[ $name ];
		}
		$e = self::HTML_ENTITIES[ $name ] ?? null;
		return $e ? $this->codepointToUtf8( $e ) : '&' . $name . ';';
	}

	/**
	 * Return UTF-8 string for a codepoint if that is a valid
	 * character reference, otherwise U+FFFD REPLACEMENT CHARACTER.
	 * @param int $codepoint
	 * @return string
	 */
	private function decodeChar( int $codepoint ): string {
		if ( $this->validateCodepoint( $codepoint ) ) {
			return $this->codepointToUtf8( $codepoint );
		} else {
			return self::UTF8_REPLACEMENT;
		}
	}

	/**
	 * Decode any character references, numeric or named entities,
	 * in the text and return a UTF-8 string.
	 * @param string $text
	 * @return string
	 */
	private function decodeCharReferences( string $text ): string {
		return preg_replace_callback(
			self::CHAR_REFS_RE_G,
			function ( $matches ) {
				if ( $matches[1] !== '' ) {
					return $this->decodeEntity( $matches[1] );
				} elseif ( $matches[2] !== '' ) {
					return $this->decodeChar( intval( $matches[2] ) );
				} elseif ( $matches[3] !== '' ) {
					return $this->decodeChar( hexdec( $matches[3] ) );
				}
				# Last case should be an ampersand by itself
				return $matches[4];
			},
			$text
		);
	}

	/**
	 * @param string $str
	 * @param string $quoteChar
	 * @return string
	 */
	private function removeMismatchedQuoteChar( string $str, string $quoteChar ): string {
		$re1 = null;
		$re2 = null;
		if ( $quoteChar === "'" ) {
			$re1 = /* RegExp */ "/'/";
			$re2 = /* RegExp */ "/'([^'\\n\\r\\f]*)\$/";
		} else {
			$re1 = /* RegExp */ '/"/';
			$re2 = /* RegExp */ '/"([^"\n\r\f]*)$/';
		}
		$mismatch = ( strlen( preg_match_all( $re1, $str ) || [] ) ) % 2 === 1;
		if ( $mismatch ) {
			// replace the mismatched quoteChar with a space
			$str = str_replace( $re2, ' ' . $quoteChar, $str );
		}
		return $str;
	}

	/**
	 * Normalize CSS into a format we can easily search for hostile input
	 *  - decode character references
	 *  - decode escape sequences
	 *  - convert characters that IE6 interprets into ascii
	 *  - remove comments, unless the entire value is one single comment
	 * @param string $text the css string
	 * @return string normalized css
	 */
	private function normalizeCss( string $text ): string {
		// Decode character references like &#123;
		$text = $this->decodeCharReferences( $text );

		$text = preg_replace_callback(
			$this->cssDecodeRE,
			function ( $matches ) {
				if ( $matches[1] !== '' ) {
					// Line continuation
					return '';
				} elseif ( $matches[2] !== '' ) {
					$char = $this->codepointToUtf8( hexdec( $matches[2] ) );
				} elseif ( $matches[3] !== '' ) {
					$char = $matches[3];
				} else {
					$char = '\\';
				}
				if ( $char === "\n" || $char === '"' || $char === "'" || $char === '\\' ) {
					// These characters need to be escaped in strings
					// Clean up the escape sequence to avoid parsing errors by clients
					return '\\' . dechex( ord( $char ) ) . ' ';
				} else {
					// Decode unnecessary escape
					return $char;
				}
			},
			$text
		);

		// Normalize Halfwidth and Fullwidth Unicode block that IE6 might treat as ascii
		$text = preg_replace_callback(
			'/[！-［］-ｚ]/u', // U+FF01 to U+FF5A, excluding U+FF3C (T60088)
			function ( $matches ) {
				$cp = $this->utf8ToCodepoint( $matches[0] );
				if ( $cp === false ) {
					return '';
				}
				return chr( $cp - 65248 ); // ASCII range \x21-\x7A
			},
			$text
		);

		// Convert more characters IE6 might treat as ascii
		$text = strtr( $text, self::IE_REPLACEMENTS );

		// PORT-FIXME: This code has been copied from core's Sanitizer and we
		// need to verify that this behavior compared to what Parsoid/JS does.
		//
		// Let the value through if it's nothing but a single comment, to
		// allow other functions which may reject it to pass some error
		// message through.
		if ( !preg_match( '! ^ \s* /\* [^*\\/]* \*/ \s* $ !x', $text ) ) {
			// Remove any comments; IE gets token splitting wrong
			// This must be done AFTER decoding character references and
			// escape sequences, because those steps can introduce comments
			// This step cannot introduce character references or escape
			// sequences, because it replaces comments with spaces rather
			// than removing them completely.
			$text = $this->delimiterReplace( '/*', '*/', ' ', $text );
			// Remove anything after a comment-start token, to guard against
			// incorrect client implementations.
			$commentPos = strpos( $text, '/*' );
			if ( $commentPos !== false ) {
				$text = substr( $text, 0, $commentPos );
			}
		}

		// Fix up unmatched double-quote and single-quote chars
		// Full CSS syntax here: http://www.w3.org/TR/CSS21/syndata.html#syntax
		//
		// This can be converted to a function and called once for ' and "
		// but we have to construct 4 different REs anyway
		$text = $this->removeMismatchedQuoteChar( $text, "'" );
		$text = $this->removeMismatchedQuoteChar( $text, '"' );

		// S followed by repeat, iteration, or prolonged sound marks,
		// which IE will treat as "ss"
		$text = preg_replace(
			'/s(?:
				\xE3\x80\xB1 | # U+3031
				\xE3\x82\x9D | # U+309D
				\xE3\x83\xBC | # U+30FC
				\xE3\x83\xBD | # U+30FD
				\xEF\xB9\xBC | # U+FE7C
				\xEF\xB9\xBD | # U+FE7D
				\xEF\xBD\xB0   # U+FF70
			)/ix',
			'ss',
			$text
		);

		return $text;
	}

	// PORT_FIXME - The delimiterReplace code below is from StringUtils in core

	/**
	 * Perform an operation equivalent to `preg_replace_callback()`
	 *
	 * Matches this code:
	 *
	 *     preg_replace_callback( "!$startDelim(.*)$endDelim!s$flags", $callback, $subject );
	 *
	 * If the start delimiter ends with an initial substring of the end delimiter,
	 * e.g. in the case of C-style comments, the behavior differs from the model
	 * regex. In this implementation, the end must share no characters with the
	 * start, so e.g. `/*\/` is not considered to be both the start and end of a
	 * comment. `/*\/xy/*\/` is considered to be a single comment with contents `/xy/`.
	 *
	 * The implementation of delimiterReplaceCallback() is slower than hungryDelimiterReplace()
	 * but uses far less memory. The delimiters are literal strings, not regular expressions.
	 *
	 * @param string $startDelim Start delimiter
	 * @param string $endDelim End delimiter
	 * @param callable $callback Function to call on each match
	 * @param string $subject
	 * @param string $flags Regular expression flags
	 * @throws \InvalidArgumentException
	 * @return string
	 */
	private function delimiterReplaceCallback(
		string $startDelim, string $endDelim, callable $callback, string $subject, string $flags = ''
	): string {
		$inputPos = 0;
		$outputPos = 0;
		$contentPos = 0;
		$output = '';
		$foundStart = false;
		$encStart = preg_quote( $startDelim, '!' );
		$encEnd = preg_quote( $endDelim, '!' );
		$strcmp = strpos( $flags, 'i' ) === false ? 'strcmp' : 'strcasecmp';
		$endLength = strlen( $endDelim );
		$m = [];
		while ( $inputPos < strlen( $subject ) &&
			preg_match( "!($encStart)|($encEnd)!S$flags", $subject, $m, PREG_OFFSET_CAPTURE, $inputPos )
		) {
			$tokenOffset = $m[0][1];
			if ( $m[1][0] !== '' ) {
				if ( $foundStart &&
					$strcmp( $endDelim, substr( $subject, $tokenOffset, $endLength ) ) === 0
				) {
					# An end match is present at the same location
					$tokenType = 'end';
					$tokenLength = $endLength;
				} else {
					$tokenType = 'start';
					$tokenLength = strlen( $m[0][0] );
				}
			} elseif ( $m[2][0] !== '' ) {
				$tokenType = 'end';
				$tokenLength = strlen( $m[0][0] );
			} else {
				throw new \InvalidArgumentException( 'Invalid delimiter given to ' . __METHOD__ );
			}
			if ( $tokenType === 'start' ) {
				# Only move the start position if we haven't already found a start
				# This means that START START END matches outer pair
				if ( !$foundStart ) {
					# Found start
					$inputPos = $tokenOffset + $tokenLength;
					# Write out the non-matching section
					$output .= substr( $subject, $outputPos, $tokenOffset - $outputPos );
					$outputPos = $tokenOffset;
					$contentPos = $inputPos;
					$foundStart = true;
				} else {
					# Move the input position past the *first character* of START,
					# to protect against missing END when it overlaps with START
					$inputPos = $tokenOffset + 1;
				}
			} elseif ( $tokenType === 'end' ) {
				if ( $foundStart ) {
					# Found match
					$output .= $callback( [
						substr( $subject, $outputPos, $tokenOffset + $tokenLength - $outputPos ),
						substr( $subject, $contentPos, $tokenOffset - $contentPos )
					] );
					$foundStart = false;
				} else {
					# Non-matching end, write it out
					$output .= substr( $subject, $inputPos, $tokenOffset + $tokenLength - $outputPos );
				}
				$inputPos = $outputPos = $tokenOffset + $tokenLength;
			} else {
				throw new \InvalidArgumentException( 'Invalid delimiter given to ' . __METHOD__ );
			}
		}
		if ( $outputPos < strlen( $subject ) ) {
			$output .= substr( $subject, $outputPos );
		}
		return $output;
	}

	/**
	 * Perform an operation equivalent to `preg_replace()` with flags.
	 *
	 * Matches this code:
	 *
	 *     preg_replace( "!$startDelim(.*)$endDelim!$flags", $replace, $subject );
	 *
	 * @param string $startDelim Start delimiter regular expression
	 * @param string $endDelim End delimiter regular expression
	 * @param string $replace Replacement string. May contain $1, which will be
	 *  replaced by the text between the delimiters
	 * @param string $subject String to search
	 * @param string $flags Regular expression flags
	 * @return string The string with the matches replaced
	 */
	private function delimiterReplace(
		string $startDelim, string $endDelim, string $replace, string $subject, string $flags = ''
	): string {
		return $this->delimiterReplaceCallback(
			$startDelim, $endDelim,
			function ( array $matches ) use ( $replace ) {
				return strtr( $replace, [ '$0' => $matches[0], '$1' => $matches[1] ] );
			},
			$subject, $flags
		);
	}

	/**
	 * SSS FIXME: There is a test in mediawiki.environment.js that doles out
	 * and tests about ids. There are probably some tests in Util.php as well.
	 * We should move all these kind of tests somewhere else.
	 * @param string $k
	 * @param string $v
	 * @param KV[] $attrs
	 * @return bool
	 */
	private function isParsoidAttr( string $k, string $v, array $attrs ): bool {
		// NOTES:
		// 1. Currently the tokenizer unconditionally escapes typeof and about
		// attributes from wikitxt to data-x-typeof and data-x-about. So,
		// this check will only pass through Parsoid inserted attrs.
		// 2. But, if we fix the over-aggressive escaping in the tokenizer to
		// not escape non-Parsoid typeof and about, then this will return
		// true for something like typeof='mw:Foo evilScriptHere'. But, that
		// is safe since this check is only used to see if we should
		// unconditionally discard the entire attribute or process it further.
		// That further processing will catch and discard any dangerous
		// strings in the rest of the attribute
		return preg_match( ( '/^(?:typeof|property|rel)$/' ), $k )
			&& preg_match( '/(?:^|\s)mw:.+?(?=$|\s)/', $v )
			|| $k === 'about' && preg_match( '/^#mwt\d+$/', $v )
			|| $k === 'content'
			&& preg_match( '/(?:^|\s)mw:.+?(?=$|\s)/', KV::lookup( $attrs, 'property' ) );
	}

	/**
	 * @param Env $env
	 * @param string|null $tagName
	 * @param Token|null $token
	 * @param array $attrs
	 * @return array
	 */
	private function sanitizeTagAttrs(
		Env $env, ?string $tagName, ?Token $token, array $attrs
	): array {
		$tag = $tagName ?? $token->getName();
		$allowRdfa = self::GLOBAL_CONFIG[ 'allowRdfaAttrs' ];
		$allowMda = self::GLOBAL_CONFIG[ 'allowMicrodataAttrs' ];
		$html5Mode = self::GLOBAL_CONFIG[ 'html5Mode' ];
		$xmlnsRE = self::XMLNS_ATTRIBUTE_RE;
		$evilUriRE = self::EVIL_URI_RE;

		$wlist = $this->getAttrWhiteList( $tag );
		$newAttrs = [];
		$n = count( $attrs );
		for ( $i = 0;  $i < $n;  $i++ ) {
			$a = $attrs[ $i ];
			if ( !isset( $a->v ) ) {
				$a->v = '';
			}

			// Convert attributes to string, if necessary.
			if ( is_array( $a->k ) ) {
				$a->k = TokenUtils::tokensToString( $a->k );
			}
			if ( is_array( $a->v ) ) {
				$a->v = TokenUtils::tokensToString( $a->v, false, [
						'unpackDOMFragments' => true,
						// FIXME: Sneaking in `env` to avoid changing the signature
						'env' => $env
					]
				);
			}

			$origK = $a->ksrc ?? $a->k;
			$k = strtolower( $a->k );
			$v = $a->v;
			$origV = $a->vsrc ?? $v;
			$psdAttr = $this->isParsoidAttr( $k, $v, $attrs );

			// Bypass RDFa/whitelisting checks for Parsoid-inserted attrs
			// Safe to do since the tokenizer renames about/typeof attrs.
			// unconditionally. FIXME: The escaping solution in the tokenizer
			// may be aggressive. There is no need to escape typeof strings
			// that or about ids that don't resemble Parsoid tokens/about ids.
			if ( !$psdAttr ) {
				if ( !preg_match( self::GET_ATTRIBS_RE, $k ) ) {
					$newAttrs[ $k ] = [ null, $origV, $origK ];
					continue;
				}

				// If RDFa is enabled, don't block XML namespace declaration
				if ( $allowRdfa && preg_match( $xmlnsRE, $k ) ) {
					if ( !preg_match( $evilUriRE, $v ) ) {
						$newAttrs[ $k ] = [ $v, $origV, $origK ];
					} else {
						$newAttrs[ $k ] = [ null, $origV, $origK ];
					}
					continue;
				}

				// If in HTML5 mode, don't block data-* attributes
				// (But always block data-ooui attributes for security: T105413)
				if ( !( $html5Mode && preg_match( ( '/^data-(?!ooui)[^:]*$/' ), $k ) )
					&& !array_key_exists( $k, $wlist ) ) {
						$newAttrs[ $k ] = [ null, $origV, $origK ];
					continue;
				}
			}

			// Strip javascript "expression" from stylesheets.
			// http://msdn.microsoft.com/workshop/author/dhtml/overview/recalc.asp
			if ( $k === 'style' ) {
				$v = self::checkCss( $v );
			}

			if ( $k === 'id' ) {
				$v = self::escapeIdForAttribute( $v );
			}

			// RDFa and microdata properties allow URLs, URIs and/or CURIs.
			// Check them for sanity
			if ( array_key_exists( $k, $this->microData ) ) {
				// Paranoia. Allow "simple" values but suppress javascript
				if ( preg_match( $evilUriRE, $v ) ) {
					// Retain the Parsoid typeofs for Parsoid attrs
					$newV = ( $psdAttr ) ? trim( preg_replace( '/(?:^|\s)(?!mw:\w)[^\s]*/', '', $origV ) ) : null;
					$newAttrs[ $k ] = [ $newV, $origV, $origK ];
					continue;
				}
			}

			// NOTE: Even though elements using href/src are not allowed directly,
			// supply validation code that can be used by tag hook handlers, etc
			if ( $token && ( $k === 'href' || $k === 'src' || $k === 'poster' ) ) { // T163583
				// `origV` will always be `v`, because `a.vsrc` isn't set, since
				// this attribute didn't come from source.  However, in the
				// LinkHandler, we may have already shadowed this value so use
				// that instead.
				$rel = $token->getAttributeShadowInfo( 'rel' );
				$mode = ( $k === 'href' && $rel
					&& ( preg_match( '/^mw:WikiLink(\/Interwiki)?$/', $rel['value'] ) ) ) ?
				'wikilink' : 'external';
				$origHref = $token->getAttributeShadowInfo( $k )['value'];
				$newHref = $this->cleanUrl( $env, $v, $mode );
				if ( $newHref !== $v ) {
					$newAttrs[ $k ] = [ $newHref, $origHref, $origK ];
					continue;
				}
			}

			// SSS FIXME: This logic is not RT-friendly.
			// If this attribute was previously set, override it.
			// Output should only have one attribute of each name.
			$newAttrs[ $k ] = [ $v, $origV, $origK ];

			if ( !$allowMda ) {
				// itemtype, itemid, itemref don't make sense without itemscope
				if ( $newAttrs[ 'itemscope' ] === null ) {
					// SSS FIXME: This logic is not RT-friendly.
					$newAttrs[ 'itemtype' ] = null;
					$newAttrs[ 'itemid' ] = null;
				}
				// TODO: Strip itemprop if we aren't descendants of an itemscope.
			}
		}

		return $newAttrs;
	}

	/**
	 * Sanitize and apply attributes to a wrapper element.
	 *
	 * Used primarily when we're applying tokenized attributes directly to
	 * dom elements, which wouldn't have had a chance to be sanitized before
	 * tree building.
	 * @param Env $env environment
	 * @param DOMElement $wrapper wrapper
	 * @param array $attrs attributes
	 */
	public function applySanitizedArgs( Env $env, DOMElement $wrapper, array $attrs ): void {
		$sanitizedAttrs = self::sanitizeTagAttrs( $env, strtolower( $wrapper->nodeName ), null, $attrs );
		foreach ( $sanitizedAttrs as $k => $v ) {
			if ( $v[ 0 ] ) {
				$wrapper->setAttribute( $k, $v[ 0 ] );
			}
		}
	}

	/**
	 * @param string $text
	 * @return string
	 */
	public function checkCss( string $text ): string {
		$text = self::normalizeCss( $text );
		// \000-\010\013\016-\037\177 are the octal escape sequences
		if ( preg_match( '/[\000-\010\013\016-\037\177]/', $text )
			|| strpos( $text, self::UTF8_REPLACEMENT ) !== false
		) {
			return '/* invalid control char */';
		} elseif ( preg_match( self::INSECURE_RE, $text ) ) {
			return '/* insecure input */';
		} else {
			return $text;
		}
	}

	/**
	 * Sanitize a token.
	 *
	 * XXX: Make attribute sanitation reversible by storing round-trip info in
	 * token.dataAttribs object (which is serialized as JSON in a data-parsoid
	 * attribute in the DOM).
	 * @param Env $env
	 * @param Token|string $token
	 * @param bool $inTemplate
	 * @return Token|string
	 */
	public function sanitizeToken( Env $env, $token, bool $inTemplate ) {
		$i = null;
		$l = null;
		$kv = null;
		$attribs = $token->attribs ?? null;
		$noEndTagSet = $this->noEndTagSet;
		$tagWhiteList = WikitextConstants::$Sanitizer[ 'TagWhiteList' ];

		if ( TokenUtils::isHTMLTag( $token )
			&& ( empty( $tagWhiteList[$token->getName()] )
				|| ( $token instanceof EndTagTk && !empty( $noEndTagSet[$token->getName()] ) )
			)
		) { // unknown tag -- convert to plain text
			if ( !$inTemplate && $token->dataAttribs->tsr ) {
				// Just get the original token source, so that we can avoid
				// whitespace differences.
				$token = $token->getWTSource( $env );
			} elseif ( !$token instanceof EndTagTk ) {
				// Handle things without a TSR: For example template or extension
				// content. Whitespace in these is not necessarily preserved.
				$buf = '<' . $token->getName();
				for ( $i = 0, $l = count( $attribs );  $i < $l;  $i++ ) {
					$kv = $attribs[ $i ];
					$buf .= ' ' . $kv->k . "='" . $kv->v . "'";
				}
				if ( $token instanceof SelfclosingTagTk ) {
					$buf .= ' /';
				}
				$buf .= '>';
				$token = $buf;
			} else {
				$token = '</' . $token->getName() . '>';
			}
		} elseif ( $attribs && count( $attribs ) > 0 ) {
			// Sanitize attributes
			if ( $token instanceof TagTk || $token instanceof SelfclosingTagTk ) {
				$newAttrs = $this->sanitizeTagAttrs( $env, null, $token, $attribs );

				// Reset token attribs and rebuild
				$token->attribs = [];

				// SSS FIXME: We are right now adding shadow information for all sanitized
				// attributes.  This is being done to minimize dirty diffs for the first
				// cut.  It can be reasonably argued that we can permanently delete dangerous
				// and unacceptable attributes in the interest of safety/security and the
				// resultant dirty diffs should be acceptable.  But, this is something to do
				// in the future once we have passed the initial tests of parsoid acceptance.
				// Object::keys( $newAttrs )->forEach( function ( $j ) use ( &$newAttrs, &$token ) {
				foreach ( $newAttrs as $k => $v ) {
					// explicit check against null to prevent discarding empty strings
					if ( $v[ 0 ] !== null ) {
						$token->addNormalizedAttribute( $k, $v[ 0 ], $v[ 1 ] );
					} else {
						$token->setShadowInfo( $v[ 2 ], $v[ 0 ], $v[ 1 ] );
					}
				}
			} else {
				// EndTagTk, drop attributes
				$token->attribs = [];
			}
		}

		return $token;
	}

	/**
	 * Sanitize a title to be used in a URI?
	 * @param string $title
	 * @param bool $isInterwiki
	 * @return string
	 */
	public function sanitizeTitleURI( string $title, bool $isInterwiki ): string {
		$bits = explode( '#', $title );
		$anchor = null;
		if ( count( $bits ) > 1 ) { // split at first '#'
			$anchor = mb_substr( $title, mb_strlen( $bits[ 0 ] ) + 1 );
			$title = $bits[ 0 ];
		}
		$titleEncoded = PHPUtils::encodeURIComponent( $title );
		$title = preg_replace( '/[%? \[\]#|<>]/', $titleEncoded, $title );
		if ( $anchor !== null ) {
			$title .= '#' . ( $isInterwiki ?
				$this->escapeIdForExternalInterwiki( $anchor ) :
				$this->escapeIdForLink( $anchor )
 );
		}
		return $title;
	}

	/**
	 * @param Token|string $token
	 * @return array|Token
	 */
	public function onAny( $token ) {
		$env = $this->manager->env;
		$env->log( 'trace/sanitizer', $this->manager->pipelineId, function () use ( $token ) {
			return PHPUtils::jsonEncode( $token );
		} );

		// Pass through a transparent line meta-token
		if ( TokenUtils::isEmptyLineMetaToken( $token ) ) {
			$env->log( 'trace/sanitizer', $this->manager->pipelineId, '--unchanged--' );
			return [ 'tokens' => [ $token ] ];
		}

		$token = $this->sanitizeToken( $env, $token, $this->inTemplate );

		$env->log( 'trace/sanitizer', $this->manager->pipelineId, function () use ( $token ) {
			return ' ---> ' . json_encode( $token );
		} );
		return [ 'tokens' => [ $token ] ];
	}

	// PORT_FIXME: this method is deprecated in PHP core, replaced by
	// private Sanitizer.escapeIdInternal() and a variety of
	// public Sanitizer.escapeIdFor* methods.  We should do the same.
	/**
	 * Helper for escapeIdFor*() functions. Performs most of the actual escaping.
	 *
	 * @param string $id String to escape.
	 * @param string $mode 'html5' or 'legacy'
	 * @return string
	 */
	private static function escapeIdInternal( string $id, string $mode ): string {
		switch ( $mode ) {
			case 'html5':
				$id = preg_replace( '/ /', '_', $id );
				break;

			case 'legacy':
				// This corresponds to 'noninitial' mode of the old escapeId
				$id = preg_replace( '/ /', '_', $id );
				$id = Util::phpURLEncode( $id );
				$id = preg_replace( '/%3A/', ':', $id );
				$id = preg_replace( '/%/', '.', $id );
				break;

			default:
				throw new Error( 'Invalid mode: ' . $mode );
		}
		return $id;
	}

	/**
	 * @param string $id
	 * @return string
	 */
	public static function escapeIdForLink( string $id ): string {
		return self::escapeIdInternal( $id, 'html5' );
	}

	/**
	 * @param string $id
	 * @return string
	 */
	public static function escapeIdForExternalInterwiki( string $id ): string {
		// Assume $wgExternalInterwikiFragmentMode = 'legacy'
		return self::escapeIdInternal( $id, 'legacy' );
	}
	/**
	 * Note the following, copied from the PHP implementation:
	 *   WARNING: unlike escapeId(), the output of this function is not guaranteed
	 *   to be HTML safe, be sure to use proper escaping.
	 * This is usually handled for us by the HTML serialization algorithm, but
	 * be careful of corner cases (such as emitting attributes in wikitext).
	 *
	 * @param string $id
	 * @param array $options
	 * @return string
	 */
	public static function escapeIdForAttribute( string $id, array $options = [] ): string {
		// For consistency with PHP's API, we accept "primary" or "fallback" as
		// the mode in 'options'.  This (slightly) abstracts the actual details
		// of the id encoding from the Parsoid code which handles ids; we could
		// swap primary and fallback here, or even transition to a new HTML6
		// encoding (!), without touching all the call sites.
		$mode = isset( $options[ 'fallback' ] ) ? 'legacy' : 'html5';
		return self::escapeIdInternal( $id, $mode );
	}

	/**
	 * @param string $id
	 * @return string
	 */
	public static function normalizeSectionIdWhiteSpace( string $id ): string {
		return trim( preg_replace( '/[ _]+/', ' ', $id ) );
	}
}
