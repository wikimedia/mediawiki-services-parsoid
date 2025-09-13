<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\Assert\Assert;
use Wikimedia\Assert\UnreachableException;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Tokens\CommentTk;
use Wikimedia\Parsoid\Tokens\EmptyLineTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\KVSourceRange;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\PreprocTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\SourceRange;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Wikitext\Consts;

/**
 * This class contains general utilities for:
 * (a) querying token properties and token types
 * (b) manipulating tokens, individually and as collections.
 */
class TokenUtils {
	public const SOL_TRANSPARENT_LINK_REGEX =
		'/(?:^|\s)mw:PageProp\/(?:Category|redirect|Language)(?=$|\s)/D';

	/**
	 * @param string $name
	 * @return bool
	 */
	public static function isWikitextBlockTag( string $name ): bool {
		return isset( Consts::$wikitextBlockElems[$name] );
	}

	/**
	 * In the legacy parser, these block tags open block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 *
	 * @param string $name
	 * @return bool
	 */
	public static function tagOpensBlockScope( string $name ): bool {
		return isset( Consts::$blockElems[$name] ) ||
			isset( Consts::$alwaysBlockElems[$name] );
	}

	/**
	 * In the legacy parser, these block tags close block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 *
	 * @param string $name
	 * @return bool
	 */
	public static function tagClosesBlockScope( string $name ): bool {
		return isset( Consts::$antiBlockElems[$name] ) ||
			isset( Consts::$neverBlockElems[$name] );
	}

	/**
	 * Is this a template token?
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isTemplateToken( $token ): bool {
		return $token instanceof SelfclosingTagTk &&
			in_array( $token->getName(), [ 'template', 'template3', 'templatearg' ], true );
	}

	/**
	 * Is this a template arg token?
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isTemplateArgToken( $token ): bool {
		return $token instanceof SelfclosingTagTk && $token->getName() === 'templatearg';
	}

	/**
	 * Is this an extension token?
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isExtensionToken( $token ): bool {
		return $token instanceof SelfclosingTagTk && $token->getName() === 'extension';
	}

	/**
	 * Determine whether the current token was an HTML tag in wikitext.
	 *
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isHTMLTag( $token ): bool {
		return ( $token instanceof XMLTagTk ) &&
			isset( $token->dataParsoid->stx ) &&
			$token->dataParsoid->stx === 'html';
	}

	/**
	 * Is the token a DOMFragment type value?
	 *
	 * @param Token $token
	 * @return bool
	 */
	public static function hasDOMFragmentType( Token $token ): bool {
		return self::matchTypeOf( $token, '#^mw:DOMFragment(/sealed/\w+)?$#D' ) !== null;
	}

	/**
	 * Is the token a table tag?
	 *
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isTableTag( $token ): bool {
		return ( $token instanceof TagTk || $token instanceof EndTagTk ) &&
			isset( Consts::$HTML['TableTags'][$token->getName()] );
	}

	/**
	 * Determine if token is a transparent link tag
	 *
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isSolTransparentLinkTag( $token ): bool {
		return ( $token instanceof XMLTagTk ) &&
			$token->getName() === 'link' &&
			preg_match( self::SOL_TRANSPARENT_LINK_REGEX, $token->getAttributeV( 'rel' ) ?? '' );
	}

	/**
	 * Does this token represent a behavior switch?
	 *
	 * @param Env $env
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isBehaviorSwitch( Env $env, $token ): bool {
		return $token instanceof SelfclosingTagTk && (
			// Before BehaviorSwitchHandler (ie. PreHandler, etc.)
			$token->getName() === 'behavior-switch' ||
			// After BehaviorSwitchHandler
			// (ie. ListHandler, ParagraphWrapper, etc.)
			( $token->getName() === 'meta' &&
				$token->hasAttribute( 'property' ) &&
				preg_match( $env->getSiteConfig()->bswPagePropRegexp(),
					$token->getAttributeV( 'property' ) ?? '' )
			) );
	}

	/**
	 * This should come close to matching
	 * {@link WTUtils::emitsSolTransparentSingleLineWT},
	 * without the single line caveat.
	 * @param Env $env
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isSolTransparent( Env $env, $token ): bool {
		if ( is_string( $token ) ) {
			return (bool)preg_match( '/^[ \t]*$/D', $token );
		} elseif (
			self::isSolTransparentLinkTag( $token ) ||
			$token instanceof EmptyLineTk ||
			( $token instanceof CommentTk && !self::isTranslationUnitMarker( $env, $token ) ) ||
			self::isBehaviorSwitch( $env, $token )
		) {
			return true;
		} elseif ( $token instanceof SelfclosingTagTk && $token->getName() === 'meta' ) {
			return !( isset( $token->dataParsoid->stx ) && $token->dataParsoid->stx === 'html' );
		}
		return false;
	}

	/**
	 * @param Token $t
	 * @return bool
	 */
	public static function isAnnotationMetaToken( Token $t ): bool {
		return self::matchTypeOf( $t, WTUtils::ANNOTATION_META_TYPE_REGEXP ) !== null;
	}

	/**
	 * Checks whether the provided meta tag token is an annotation start token
	 * @param Token $t
	 * @return bool
	 */
	public static function isAnnotationStartToken( Token $t ): bool {
		$type = self::matchTypeOf( $t, WTUtils::ANNOTATION_META_TYPE_REGEXP );
		return $type !== null && !str_ends_with( $type, '/End' );
	}

	/**
	 * Checks whether the provided meta tag token is an annotation end token
	 * @param Token $t
	 * @return bool
	 */
	public static function isAnnotationEndToken( Token $t ): bool {
		$type = self::matchTypeOf( $t, WTUtils::ANNOTATION_META_TYPE_REGEXP );
		return $type !== null && str_ends_with( $type, '/End' );
	}

	/**
	 * HACK: Returns true if $token looks like a TU marker (<!--T:XXX-->) and if we could be in a
	 * translate-annotated page.
	 * @param Env $env
	 * @param CommentTk $token
	 * @return bool
	 */
	public static function isTranslationUnitMarker( Env $env, CommentTk $token ): bool {
		return $env->hasAnnotations &&
			$env->getSiteConfig()->isAnnotationTag( 'translate' ) &&
			preg_match( '/^T:/', $token->value ) === 1;
	}

	/**
	 * Determine whether the token matches the given `typeof` attribute value.
	 *
	 * @param Token $t The token to test
	 * @param string $typeRe Regular expression matching the expected value of
	 *   the `typeof` attribute.
	 * @return ?string The matching `typeof` value, or `null` if there is
	 *   no match.
	 */
	public static function matchTypeOf( Token $t, string $typeRe ): ?string {
		$v = $t->getAttributeV( 'typeof' );
		if ( $v === null ) {
			return null;
		}
		Assert::invariant( is_string( $v ), "Typeof is not simple" );
		foreach ( preg_split( '/\s+/', $v, -1, PREG_SPLIT_NO_EMPTY ) as $ty ) {
			$count = preg_match( $typeRe, $ty );
			Assert::invariant( $count !== false, "Bad regexp" );
			if ( $count ) {
				return $ty;
			}
		}
		return null;
	}

	/**
	 * Determine whether the token matches the given typeof attribute value.
	 *
	 * @param Token $t
	 * @param string $type Expected value of "typeof" attribute, as a literal
	 *   string.
	 * @return bool True if the token matches.
	 */
	public static function hasTypeOf( Token $t, string $type ): bool {
		return self::matchTypeOf(
			$t, '/^' . preg_quote( $type, '/' ) . '$/D'
		) !== null;
	}

	/**
	 * @param Env $env
	 * @param array<mixed> $maybeTokens
	 *   Attribute arrays in tokens may be tokens or something else.
	 */
	public static function dedupeAboutIds( Env $env, array $maybeTokens ): void {
		$aboutMap = [];
		foreach ( $maybeTokens as $t ) {
			if ( !( $t instanceof Token ) ) {
				continue;
			}

			foreach ( $t->attribs ?? [] as $kv ) {
				if ( $kv->k === 'about' ) {
					$aboutMap[$kv->v] ??= $env->newAboutId();
					$t->setAttribute( 'about', $aboutMap[$kv->v] );
				} else {
					if ( $kv->k instanceof Token ) {
						self::dedupeAboutIds( $env, [ $kv->k ] );
					} elseif ( is_array( $kv->k ) ) {
						self::dedupeAboutIds( $env, $kv->k );
					}

					if ( $kv->v instanceof Token ) {
						self::dedupeAboutIds( $env, [ $kv->v ] );
					} elseif ( is_array( $kv->v ) ) {
						self::dedupeAboutIds( $env, $kv->v );
					}
				}
			}
		}
	}

	/**
	 * Shift TSR of a token by the requested $offset value.
	 * A null value of $offset resets TSR on all tokens since we cannot
	 * compute a reliable new value of $tsr and the old value of $tsr
	 * should not be used either.
	 */
	public static function shiftTokenTSR( array $tokens, ?int $offset ): void {
		// Bail early if we can
		if ( $offset === 0 ) {
			return;
		}

		// update/clear tsr
		foreach ( $tokens as $t ) {
			if ( !( $t instanceof XMLTagTk ||
				$t instanceof NlTk ||
				$t instanceof CommentTk ||
				$t instanceof PreprocTk
			) ) {
				continue;
			}

			$da = $t->dataParsoid;
			$tsr = $da->tsr ?? null;
			if ( $tsr ) {
				$da->tsr = ( $offset === null ) ? null : $tsr->offset( $offset );
			}

			if ( $offset !== null ) {
				if ( isset( $da->extTagOffsets ) ) {
					$da->extTagOffsets = $da->extTagOffsets->offset( $offset );
				}

				// SSS FIXME: offset will always be available in
				// chunky-tokenizer mode in which case we wont have
				// buggy offsets below.  The null scenario is only
				// for when the token-stream-patcher attempts to
				// reparse a string -- it is likely to only patch up
				// small string fragments and the complicated use cases
				// below should not materialize.
				// CSA: token-stream-patcher shouldn't have problems
				// now that $tsr->source/$frame->srcText is always
				// accurate?

				// content offsets for ext-links
				if ( isset( $da->tmp->extLinkContentOffsets ) ) {
					$da->tmp->extLinkContentOffsets =
						$da->tmp->extLinkContentOffsets->offset( $offset );
				}
			}

			// Process attributes
			foreach ( $t->attribs ?? [] as $a ) {
				if ( is_array( $a->k ) ) {
					self::shiftTokenTSR( $a->k, $offset );
				}
				if ( is_array( $a->v ) ) {
					self::shiftTokenTSR( $a->v, $offset );
				}

				// src offsets used to set mw:TemplateParams
				if ( $offset === null ) {
					$a->srcOffsets = null;
				} elseif ( $a->srcOffsets !== null ) {
					$a->srcOffsets = $a->srcOffsets->offset( $offset );
				}
			}
		}
	}

	/**
	 * Strip EOFTk token from token chunk.
	 * The EOFTk is expected to be the last token of the chunk.
	 *
	 * @param array &$tokens
	 * @return array return the modified token array so that this call can be chained
	 */
	public static function stripEOFTkFromTokens( array &$tokens ): array {
		$last = array_key_last( $tokens );
		if ( $last !== null && $tokens[$last] instanceof EOFTk ) {
			array_pop( $tokens );
		}
		return $tokens;
	}

	/**
	 * Convert string offsets
	 *
	 * Offset types are:
	 *  - 'byte': Bytes (UTF-8 encoding), e.g. PHP `substr()` or `strlen()`.
	 *  - 'char': Unicode code points (encoding irrelevant), e.g. PHP `mb_substr()` or `mb_strlen()`.
	 *  - 'ucs2': 16-bit code units (UTF-16 encoding), e.g. JavaScript `.substring()` or `.length`.
	 *
	 * Offsets that are mid-Unicode character are "rounded" up to the next full
	 * character, i.e. the output offset will always point to the start of a
	 * Unicode code point (or just past the end of the string). Offsets outside
	 * the string are "rounded" to 0 or just-past-the-end.
	 *
	 * @note When constructing the array of offsets to pass to this method,
	 *  populate it with references as `$offsets[] = &$var;`.
	 *
	 * @param string $s Unicode string the offsets are offsets into, UTF-8 encoded.
	 * @param ('byte'|'ucs2'|'char') $from Offset type to convert from.
	 * @param ('byte'|'ucs2'|'char') $to Offset type to convert to.
	 * @param int[] $offsets References to the offsets to convert.
	 */
	public static function convertOffsets(
		string $s, string $from, string $to, array $offsets
	): void {
		static $valid = [ 'byte', 'char', 'ucs2' ];
		if ( !in_array( $from, $valid, true ) ) {
			throw new \InvalidArgumentException( 'Invalid $from' );
		}
		if ( !in_array( $to, $valid, true ) ) {
			throw new \InvalidArgumentException( 'Invalid $to' );
		}

		$i = 0;
		$offsetCt = count( $offsets );
		if ( $offsetCt === 0 ) { // Nothing to do
			return;
		}
		sort( $offsets, SORT_NUMERIC );

		$bytePos = 0;
		$ucs2Pos = 0;
		$charPos = 0;

		$fromPos = &${$from . 'Pos'};  // @phan-suppress-current-line PhanPluginDollarDollar
		$toPos = &${$to . 'Pos'};  // @phan-suppress-current-line PhanPluginDollarDollar

		$byteLen = strlen( $s );
		while ( $bytePos < $byteLen ) {
			// Update offsets that we've reached
			while ( $offsets[$i] <= $fromPos ) {
				$offsets[$i] = $toPos;
				if ( ++$i >= $offsetCt ) {
					return;
				}
			}

			// Update positions
			++$charPos;
			$c = ord( $s[$bytePos] ) & 0xf8;
			switch ( $c ) {
				case 0x00:
				case 0x08:
				case 0x10:
				case 0x18:
				case 0x20:
				case 0x28:
				case 0x30:
				case 0x38:
				case 0x40:
				case 0x48:
				case 0x50:
				case 0x58:
				case 0x60:
				case 0x68:
				case 0x70:
				case 0x78:
					++$bytePos;
					++$ucs2Pos;
					break;

				case 0xc0:
				case 0xc8:
				case 0xd0:
				case 0xd8:
					$bytePos += 2;
					++$ucs2Pos;
					break;

				case 0xe0:
				case 0xe8:
					$bytePos += 3;
					++$ucs2Pos;
					break;

				case 0xf0:
					$bytePos += 4;
					$ucs2Pos += 2;
					break;

				default:
					throw new \InvalidArgumentException(
						bin2hex( $s ) . " (dumped via php bin2hex) is not valid UTF-8" );
			}
		}

		// Convert any offsets past the end of the string to the length of the
		// string.
		while ( $i < $offsetCt ) {
			$offsets[$i] = $toPos;
			++$i;
		}
	}

	/**
	 * Convert offsets in a token array
	 *
	 * @see TokenUtils::convertOffsets()
	 *
	 * @param string $s The offset reference string
	 * @param ('byte'|'ucs2'|'char') $from Offset type to convert from
	 * @param ('byte'|'ucs2'|'char') $to Offset type to convert to
	 * @param array<Token|string|array> $tokens
	 */
	public static function convertTokenOffsets(
		string $s, string $from, string $to, array $tokens
	): void {
		$offsets = []; /* @var array<int> $offsets */
		self::collectOffsets( $tokens, static function ( $sr ) use ( &$offsets ) {
			if ( $sr instanceof DomSourceRange ) {
				// Adjust the widths to be actual character offsets
				if ( $sr->openWidth !== null ) {
					Assert::invariant( $sr->start !== null, "width w/o start" );
					$sr->openWidth = $sr->start + $sr->openWidth;
					$offsets[] =& $sr->openWidth;
				}
				if ( $sr->closeWidth !== null ) {
					Assert::invariant( $sr->end !== null, "width w/o end" );
					$sr->closeWidth = $sr->end - $sr->closeWidth;
					$offsets[] =& $sr->closeWidth;
				}
			}
			if ( $sr->start !== null ) {
				$offsets[] =& $sr->start;
			}
			if ( $sr->end !== null ) {
				$offsets[] =& $sr->end;
			}
		} );
		self::convertOffsets( $s, $from, $to, $offsets );
		self::collectOffsets( $tokens, static function ( $sr ) {
			if ( $sr instanceof DomSourceRange ) {
				// Adjust widths back from being character offsets
				if ( $sr->openWidth !== null ) {
					$sr->openWidth -= $sr->start;
				}
				if ( $sr->closeWidth !== null ) {
					$sr->closeWidth = $sr->end - $sr->closeWidth;
				}
			}
		} );
	}

	/**
	 * @param array<Token|string>|array<KV>|KV|Token|DomSourceRange|KVSourceRange|SourceRange|string $input
	 * @param callable $offsetFunc
	 */
	private static function collectOffsets( $input, callable $offsetFunc ): void {
		if ( is_array( $input ) ) {
			foreach ( $input as $token ) {
				self::collectOffsets( $token, $offsetFunc );
			}
		} elseif ( $input instanceof KV ) {
			self::collectOffsets( $input->k, $offsetFunc );
			self::collectOffsets( $input->v, $offsetFunc );
			if ( $input->srcOffsets ) {
				self::collectOffsets( $input->srcOffsets, $offsetFunc );
			}
		} elseif ( $input instanceof Token ) {
			if ( isset( $input->dataParsoid->tsr ) ) {
				self::collectOffsets( $input->dataParsoid->tsr, $offsetFunc );
			}
			if ( isset( $input->dataParsoid->tmp->extLinkContentOffsets ) ) {
				self::collectOffsets( $input->dataParsoid->tmp->extLinkContentOffsets, $offsetFunc );
			}
			if ( isset( $input->dataParsoid->extTagOffsets ) ) {
				self::collectOffsets( $input->dataParsoid->extTagOffsets, $offsetFunc );
			}
			self::collectOffsets( $input->attribs, $offsetFunc );
		} elseif ( $input instanceof KVSourceRange ) {
			self::collectOffsets( $input->key, $offsetFunc );
			self::collectOffsets( $input->value, $offsetFunc );
		} elseif ( $input instanceof SourceRange ) {
			// This includes DomSourceRange
			$offsetFunc( $input );
		}
	}

	/**
	 * Tests whether token represents an HTML entity.
	 * Think `<span typeof="mw:Entity">`.
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isEntitySpanToken( $token ): bool {
		return $token instanceof TagTk &&
			$token->getName() === 'span' &&
			self::hasTypeOf( $token, 'mw:Entity' );
	}

	/**
	 * Transform `"\n"` and `"\r\n"` in the input string to {@link NlTk} tokens.
	 *
	 * @param string $str
	 * @return non-empty-list<NlTk|string> (interspersed string and NlTk tokens)
	 */
	public static function newlinesToNlTks( string $str ): array {
		$ret = [];
		foreach ( preg_split( '/\r?\n/', $str ) as $i => $tok ) {
			if ( $i ) {
				$ret[] = new NlTk( null );
			}
			$ret[] = $tok;
		}
		return $ret;
	}

	/**
	 * Flatten/convert a token array into a string.
	 * @param string|Token|array<Token|string> $tokens
	 * @param bool $strict Whether to abort as soon as we find a token we
	 *   can't stringify.
	 * @param array<string,bool> $opts
	 * @return string|list{string,array<Token|string>}
	 *   The stringified tokens. If $strict is true, returns a two-element
	 *   array containing string prefix and the remainder of the tokens as
	 *   soon as we encounter something we can't stringify.
	 */
	public static function tokensToString( $tokens, bool $strict = false, array $opts = [] ) {
		if ( is_string( $tokens ) ) {
			return $tokens;
		}

		if ( !is_array( $tokens ) ) {
			$tokens = [ $tokens ];
		}

		$out = '';
		for ( $i = 0, $l = count( $tokens ); $i < $l; $i++ ) {
			$token = $tokens[$i];
			if ( $token === null ) {
				throw new UnreachableException( "No nulls expected." );
			} elseif ( $token instanceof KV ) {
				// Since this function is occasionally called on KV->v,
				// whose signature recursively includes KV[], a mismatch with
				// this function, we assert that those values are only
				// included in safe places that don't intend to stringify
				// their tokens.
				throw new UnreachableException( "No KVs expected." );
			} elseif ( is_string( $token ) ) {
				$out .= $token;
			} elseif ( $token instanceof PreprocTk ) {
				$out .= $token->print( pretty: false );
			} elseif (
				$token instanceof CommentTk ||
				( empty( $opts['retainNLs'] ) && $token instanceof NlTk )
			) {
				// strip comments and newlines
			} elseif ( !empty( $opts['stripEmptyLines'] ) && ( $token instanceof EmptyLineTk ) ) {
				// If requested, strip empty line meta tokens too.
			} elseif ( !empty( $opts['includeEntities'] ) && self::isEntitySpanToken( $token ) ) {
				$out .= $token->dataParsoid->src;
				$i += 2; // Skip child and end tag.
			} elseif ( $token instanceof TagTk && $token->getName() === 'listItem' ) {
				$out .= $token->getAttributeKV( 'bullets' )->srcOffsets->value->substr();
			} elseif (
				// This option shouldn't be used if the tokens have been
				// expanded to DOM
				!empty( $opts['unpackDOMFragments'] ) &&
				( $token instanceof TagTk || $token instanceof SelfclosingTagTk ) &&
				self::hasDOMFragmentType( $token )
			) {
				// Handle dom fragments
				$domFragment = $token->dataParsoid->html;
				// Removing the DOMFragment here is case dependent
				// but should be rare enough when permissible that it can be
				// ignored.
				// FIXME: The correct thing to do would be to return
				// `$domFragment.innerHTML` for the current scenarios where
				// `unpackDOMFragments` is used (expanded attribute
				// values and reparses thereof) but we'd need to remove
				// the span wrapping and typeof annotation of extension
				// content and nowikis.  Since we're primarily expecting
				// to find <translate> and <nowiki> here, this will do.
				$out .= $domFragment->textContent;
				if ( $token instanceof TagTk ) {
					$i += 1; // Skip the EndTagTK
					Assert::invariant(
						$i >= $l || $tokens[$i] instanceof EndTagTk,
						"tag should be followed by endtag"
					);
				}
			} elseif ( $strict ) {
				// If strict, return accumulated string on encountering first non-text token
				return [ $out, array_slice( $tokens, $i ) ];
			} elseif ( is_array( $token ) ) {
				Assert::invariant( !$strict, "strict case handled above" );
				$out .= self::tokensToString( $token, $strict, $opts );
			}
		}
		return $out;
	}

	/**
	 * Convert an array of key-value pairs into a hash of keys to values.
	 * For duplicate keys, the last entry wins.
	 * @note that numeric key values will be converted by PHP from string to
	 *  int when they are used as array keys.
	 * @param array<KV> $kvs
	 * @return array<string|int,array<Token|string>>|array<string|int,string>
	 */
	public static function kvToHash( array $kvs ): array {
		$res = [];
		foreach ( $kvs as $kv ) {
			$key = trim( self::tokensToString( $kv->k ) );
			// SSS FIXME: Temporary fix to handle extensions which use
			// entities in attribute values. We need more robust handling
			// of non-string template attribute values in general.
			$val = self::tokensToString( $kv->v );
			$res[mb_strtolower( $key )] = self::tokenTrim( $val );
		}
		return $res;
	}

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 * @param string|Token|(Token|string)[] $tokens
	 * @return string|Token|(Token|string)[]
	 */
	public static function tokenTrim( $tokens ) {
		if ( !is_array( $tokens ) ) {
			return is_string( $tokens ) ? trim( $tokens ) : $tokens;
		}

		// strip leading space
		foreach ( $tokens as &$token ) {
			if ( $token instanceof NlTk ) {
				$token = '';
			} elseif ( is_string( $token ) ) {
				$token = preg_replace( '/^\s+/', '', $token, 1 );
				if ( $token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}

		// strip trailing space
		for ( $i = count( $tokens ); $i--; ) {
			$token = &$tokens[$i];
			if ( $token instanceof NlTk ) {
				$token = ''; // replace newline with empty
			} elseif ( is_string( $token ) ) {
				$token = preg_replace( '/\s+$/D', '', $token, 1 );
				if ( $token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}

		return $tokens;
	}

	/**
	 * Detect, if array (or any iterable container) contains template token
	 * @param null|array<string|Token> $tokens
	 * @return bool
	 */
	public static function hasTemplateToken( $tokens ): bool {
		return is_array( $tokens ) &&
			array_any( $tokens, self::isTemplateToken( ... ) );
	}

}
