<?php
declare( strict_types = 1 );

/**
 * This file contains general utilities for:
 * (a) querying token properties and token types
 * (b) manipulating tokens, individually and as collections.
 */

// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic

namespace Parsoid\Utils;

use DOMNode;
use stdClass;

use Parsoid\Config\Env;
use Parsoid\Config\WikitextConstants as Consts;
use Parsoid\Tokens\CommentTk;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\KV;
use Parsoid\Tokens\NlTk;
use Parsoid\Tokens\Token;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\SelfclosingTagTk;

use Wikimedia\Assert\Assert;

class TokenUtils {
	const SOL_TRANSPARENT_LINK_REGEX = '/(?:^|\s)mw:PageProp\/(?:Category|redirect|Language)(?=$|\s)/';

	/**
	 * Gets a string type value for a token
	 * @param Token|string $token
	 * @return string
	 */
	public static function getTokenType( $token ): string {
		return is_string( $token ) ? 'string' : $token->getType();
	}

	/**
	 * Determine if a tag is block-level or not.
	 *
	 * `<video>` is removed from block tags, since it can be phrasing content.
	 * This is necessary for it to render inline.
	 * @param string $name
	 * @return bool
	 */
	public static function isBlockTag( string $name ): bool {
		return $name !== 'video' && isset( Consts::$HTML['HTML4BlockTags'][$name] );
	}

	/**
	 * In the PHP parser, these block tags open block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 * @param string $name
	 * @return bool
	 */
	public static function tagOpensBlockScope( string $name ): bool {
		return isset( Consts::$BlockScopeOpenTags[$name] );
	}

	/**
	 * In the PHP parser, these block tags close block-tag scope
	 * See doBlockLevels in the PHP parser (includes/parser/Parser.php).
	 * @param string $name
	 * @return bool
	 */
	public static function tagClosesBlockScope( string $name ): bool {
		return isset( Consts::$BlockScopeCloseTags[$name] );
	}

	/**
	 * Is this a template token?
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isTemplateToken( $token ): bool {
		return $token && $token instanceof SelfclosingTagTk && $token->getName() === 'template';
	}

	/**
	 * Determine whether the current token was an HTML tag in wikitext.
	 *
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isHTMLTag( $token ): bool {
		return $token && !is_string( $token ) &&
			( $token instanceof TagTk ||
			$token instanceof EndTagTk ||
			$token instanceof SelfClosingTagTk ) &&
			isset( $token->dataAttribs->stx ) &&
			$token->dataAttribs->stx === 'html';
	}

	/**
	 * Is the typeof a DOMFragment type value?
	 *
	 * @param string $typeOf
	 * @return bool
	 */
	public static function isDOMFragmentType( string $typeOf ): bool {
		return preg_match( '#(?:^|\s)mw:DOMFragment(/sealed/\w+)?(?=$|\s)#', $typeOf ) === 1;
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
		return (
				$token instanceof SelfclosingTagTk ||
				$token instanceof TagTk ||
				$token instanceof EndTagTk
			) &&
			$token->getName() === 'link' &&
			preg_match( self::SOL_TRANSPARENT_LINK_REGEX, $token->getAttribute( 'rel' ) ?? '' );
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
					$token->getAttribute( 'property' ) ?? '' )
			) );
	}

	/**
	 * This should come close to matching
	 * {@link DOMUtils.emitsSolTransparentSingleLineWT},
	 * without the single line caveat.
	 * @param Env $env
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isSolTransparent( Env $env, $token ): bool {
		if ( is_string( $token ) ) {
			return (bool)preg_match( '/^\s*$/', $token );
		} elseif ( self::isSolTransparentLinkTag( $token ) ) {
			return true;
		} elseif ( $token instanceof CommentTk ) {
			return true;
		} elseif ( self::isBehaviorSwitch( $env, $token ) ) {
			return true;
		} elseif ( !$token instanceof SelfclosingTagTk || $token->getName() !== 'meta' ) {
			return false;
		} else {  // only metas left
			return !( isset( $token->dataAttribs->stx ) && $token->dataAttribs->stx === 'html' );
		}
	}

	/**
	 * Is token a transparent link tag?
	 *
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isEmptyLineMetaToken( $token ): bool {
		return $token instanceof SelfclosingTagTk &&
			$token->getName() === 'meta' &&
			$token->getAttribute( 'typeof' ) === 'mw:EmptyLine';
	}

	/**
	 * Shift TSR of a token
	 *
	 * Port warning: in JS this was sometimes called with $offset=undefined, which meant do
	 * nothing by default, except if there was a third parameter set to true, in which case it
	 * meant the same thing as $offset = null. We can't pass in undefined in PHP, so this should
	 * usually be handled with isset() is the caller. But isset() returns true if the variable is
	 * null, so let's use false instead of null for whatever the previous code meant by a null
	 * offset.
	 *
	 * @param Token[] $tokens
	 * @param int|false $offset
	 */
	public static function shiftTokenTSR( array $tokens, $offset ): void {
		// Bail early if we can
		if ( $offset === 0 ) {
			return;
		}

		// JS b/c
		if ( $offset === null ) {
			$offset = false;
		}

		// update/clear tsr
		for ( $i = 0,  $n = count( $tokens );  $i < $n;  $i++ ) {
			$t = $tokens[$i];
			switch ( is_object( $t ) ? get_class( $t ) : null ) {
				case TagTk::class:
				case SelfclosingTagTk::class:
				case NlTk::class:
				case CommentTk::class:
				case EndTagTk::class:
					$da = $tokens[$i]->dataAttribs;
					$tsr = $da->tsr;
					if ( $tsr ) {
						if ( $offset !== false ) {
							$da->tsr = [ $tsr[0] + $offset, $tsr[1] + $offset ];
						} else {
							$da->tsr = null;
						}
					}

					// SSS FIXME: offset will always be available in
					// chunky-tokenizer mode in which case we wont have
					// buggy offsets below.  The null scenario is only
					// for when the token-stream-patcher attempts to
					// reparse a string -- it is likely to only patch up
					// small string fragments and the complicated use cases
					// below should not materialize.

					// target offset
					if ( $offset && isset( $da->targetOff ) ) {
						$da->targetOff += $offset;
					}

					// content offsets for ext-links
					if ( $offset && isset( $da->contentOffsets ) ) {
						$da->contentOffsets[0] += $offset;
						$da->contentOffsets[1] += $offset;
					}

					// end offset for pre-tag
					if ( $offset && isset( $da->endpos ) ) {
						$da->endpos += $offset;
					}

					// Process attributes
					if ( isset( $t->attribs ) ) {
						for ( $j = 0,  $m = count( $t->attribs );  $j < $m;  $j++ ) {
							$a = $t->attribs[$j];
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
								for ( $k = 0;  $k < count( $a->srcOffsets );  $k++ ) {
									// phpcs:disable Generic.Files.LineLength.TooLong
									// @phan-suppress-next-line PhanTypeArraySuspiciousNullable https://github.com/phan/phan/issues/805
									$a->srcOffsets[$k] += $offset;
								}
							}
						}
					}
					break;

				default:
					break;
			}
		}
	}

	/**
	 * Strip EOFTk token from token chunk.
	 * The EOFTk is expected to be the last token of the chunk.
	 *
	 * @param array &$tokens
	 */
	public static function stripEOFTkFromTokens( array &$tokens ): void {
		$tokens = (array)$tokens;
		$n = count( $tokens );
		if ( $n && $tokens[$n - 1] instanceof EOFTk ) {
			array_pop( $tokens );
		}
	}

	/**
	 * Create placeholder tokens for some content. This is just an escape hatch
	 * for scenarios where we don't have a good representation for this content
	 * and just want to render it without providing any editing support for it.
	 * Content with mw:Placeholder typeof attribute will be ignored by
	 * editing clients and they are expected to not modify it either.
	 *
	 * @param ?string $content
	 * @param stdClass $openTagAttribs
	 * @param stdClass $closeTagAttribs
	 * @return array
	 */
	public static function placeholder(
		?string $content, stdClass $openTagAttribs, stdClass $closeTagAttribs
	): array {
		if ( $content === null ) {
			return [
				new SelfclosingTagTk( 'meta', [
					new KV( 'typeof', 'mw:Placeholder' ),
				], $openTagAttribs ),
			];
		} else {
			return [
				new TagTk( 'span', [
					new KV( 'typeof', 'mw:Placeholder' ),
				], $openTagAttribs ),
				$content,
				new EndTagTk( 'span', [], $closeTagAttribs ),
			];
		}
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
	 * @param string $from Offset type to convert from.
	 * @param string $to Offset type to convert to.
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
		$fromPos = &${$from . 'Pos'};
		$toPos = &${$to . 'Pos'};

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
				case 0x00: case 0x08: case 0x10: case 0x18:
				case 0x20: case 0x28: case 0x30: case 0x38:
				case 0x40: case 0x48: case 0x50: case 0x58:
				case 0x60: case 0x68: case 0x70: case 0x78:
					++$bytePos;
					++$ucs2Pos;
					break;

				case 0xc0: case 0xc8: case 0xd0: case 0xd8:
					$bytePos += 2;
					++$ucs2Pos;
					break;

				case 0xe0: case 0xe8:
					$bytePos += 3;
					++$ucs2Pos;
					break;

				case 0xf0:
					$bytePos += 4;
					$ucs2Pos += 2;
					break;

				default:
					throw new \InvalidArgumentException( '$s is not UTF-8' );
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
	 * @param string $from Offset type to convert from
	 * @param string $to Offset type to convert to
	 * @param array<Token> $tokens
	 */
	public static function convertTokenOffsets(
		string $s, string $from, string $to, array $tokens
	) : void {
		$offsets = [];
		self::collectOffsets( $offsets, $tokens );
		self::convertOffsets( $s, $from, $to, $offsets );
		self::fixupOffsets( $tokens );
	}

	/**
	 * @param array<int> $dest
	 * @param array<int> $source
	 */
	private static function pushOffsets( array &$dest, array &$source ): void {
		foreach ( $source as &$offset ) {
			$dest[] =& $offset;
		}
	}

	/**
	 * @param array<int> $offsets
	 * @param array<Token>|array<KV>|KV|Token|string $input
	 */
	private static function collectOffsets( array &$offsets, $input ): void {
		if ( is_array( $input ) ) {
			foreach ( $input as $token ) {
				self::collectOffsets( $offsets, $token );
			}
		} elseif ( $input instanceof KV ) {
			self::collectOffsets( $offsets, $input->k );
			self::collectOffsets( $offsets, $input->v );
			if ( $input->srcOffsets ) {
				self::pushOffsets( $offsets, $input->srcOffsets );
			}
		} elseif ( $input instanceof Token ) {
			if ( isset( $input->dataAttribs->tsr ) ) {
				self::pushOffsets( $offsets, $input->dataAttribs->tsr );
			}
			if ( isset( $input->dataAttribs->targetOff ) ) {
				$offsets[] =& $input->dataAttribs->targetOff;
			}
			if ( isset( $input->dataAttribs->contentOffsets ) ) {
				self::pushOffsets( $offsets, $input->dataAttribs->contentOffsets );
			}
			if ( isset( $input->dataAttribs->tokens ) ) {
				self::collectOffsets( $offsets, $input->dataAttribs->tokens );
			}
			if ( isset( $input->dataAttribs->tagWidths ) ) {
				// This is tricky: convert these to offsets, and then reconvert
				// to widths in a post-processing pass
				$input->dataAttribs->tagWidths[0] = $input->dataAttribs->tsr[0] + $input->dataAttribs->tagWidths[0];
				$input->dataAttribs->tagWidths[1] = $input->dataAttribs->tsr[1] - $input->dataAttribs->tagWidths[1];
				self::pushOffsets( $offsets, $input->dataAttribs->tagWidths );
			}
			self::collectOffsets( $offsets, $input->attribs );
		}
	}

	/**
	 * @param array<Token>|array<KV>|KV|Token|string $input
	 */
	private static function fixupOffsets( $input ):void {
		if ( is_array( $input ) ) {
			foreach ( $input as $token ) {
				self::fixupOffsets( $token );
			}
		} elseif ( $input instanceof KV ) {
			self::fixupOffsets( $input->k );
			self::fixupOffsets( $input->v );
		} elseif ( $input instanceof Token ) {
			if ( isset( $input->dataAttribs->tokens ) ) {
				self::fixupOffsets( $input->dataAttribs->tokens );
			}
			if ( isset( $input->dataAttribs->tagWidths ) ) {
				// Reconvert offsets to widths
				// to widths in a post-processing pass
				$input->dataAttribs->tagWidths[0] = $input->dataAttribs->tagWidths[0] - $input->dataAttribs->tsr[0];
				$input->dataAttribs->tagWidths[1] = $input->dataAttribs->tsr[1] - $input->dataAttribs->tagWidths[1];
			}
			self::fixupOffsets( $input->attribs );
		}
	}

	/**
	 * Tests whether token represents an HTML entity.
	 * Think `<span typeof="mw:Entity">`.
	 * @param Token|string|null $token
	 * @return bool
	 */
	public static function isEntitySpanToken( $token ): bool {
		return $token &&
			$token instanceof TagTk &&
			$token->getName() === 'span' &&
			$token->getAttribute( 'typeof' ) === 'mw:Entity';
	}

	/**
	* Transform `"\n"` and `"\r\n"` in the input string to {@link NlTk} tokens.
	//
	public static function newlinesToNlTks($str, $tsr0) {
		$toks = preg_split( '/\n|\r\n/', $str );
		$ret = [];
		$tsr = $tsr0;
		$i = 0;
		// Add one NlTk between each pair, hence toks.length-1
		for ( $n = count( $toks ) - 1;  $i < $n;  $i++ ) {
			$ret[] = $toks[ $i ];
			$nlTk = new NlTk();
			if ( $tsr !== null ) {
				$tsr += count( $toks[ $i ] );
				$nlTk->dataAttribs = [ 'tsr' => [ $tsr, $tsr + 1 ] ];
			}
			$ret[] = $nlTk;
		}
		$ret[] = $toks[ $i ];
		return $ret;
	}

	//
	 * Strip include tags, and the contents of includeonly tags as well.
	//
	public static function stripIncludeTokens($tokens) {
		$toks = [];
		$includeOnly = false;
		for ( $i = 0;  $i < count( $tokens );  $i++ ) {
			$tok = $tokens[ $i ];
			switch ( $tok->constructor ) {
				case $TagTk:

				case $EndTagTk:

				case $SelfclosingTagTk:
				if ( [ 'noinclude', 'onlyinclude' ]->includes( $tok->name ) ) {
					continue;
				} elseif ( $tok->name === 'includeonly' ) {
					$includeOnly = ( $tok->constructor === $TagTk );
					continue;
				}
				// Fall through

				default:
				if ( !$includeOnly ) {
					$toks[] = $tok;
				}
			}
		}
		return $toks;
	}
*/

	/**
	 * Flatten/convert a token array into a string.
	 * @param array<Token|string> $tokens
	 * @param bool $strict Whether to abort as soon as we find a token we
	 *   can't stringify.
	 * @param array<string,bool|Env> $opts
	 * @return string|array{0:string,1:Array<Token|string>}
	 *   The stringified tokens. If $strict is true, returns a two-element
	 *   array containing string prefix and the remainder of the tokens as
	 *   soon as we encounter something we can't stringify.
	 */
	public static function tokensToString(
		array $tokens, bool $strict = false, array $opts = []
	) {
		$out = '';
		for ( $i = 0,  $l = count( $tokens );  $i < $l;  $i++ ) {
			// PORT-FIXME: Why are they null? JS version has a null check as well
			// which indicates that this may not be a porting related thing but
			// worth verifying.
			$token = $tokens[ $i ] ?? null;
			if ( !$token ) {
				continue;
			} elseif ( is_string( $token ) ) {
				$out .= $token;
			} elseif (
				$token instanceof CommentTk ||
				( empty( $opts['retainNLs'] ) && $token instanceof NlTk )
			) {
				// strip comments and newlines
			} elseif ( !empty( $opts['stripEmptyLineMeta'] ) && self::isEmptyLineMetaToken( $token ) ) {
				// If requested, strip empty line meta tokens too.
			} elseif ( !empty( $opts['includeEntities'] ) && self::isEntitySpanToken( $token ) ) {
				$out .= $token->dataAttribs->src;
				$i += 2; // Skip child and end tag.
			} elseif ( $strict ) {
				// If strict, return accumulated string on encountering first non-text token
				return [ $out, array_slice( $tokens, $i ) ];
			} elseif (
				!empty( $opts['unpackDOMFragments'] ) &&
				( $token instanceof TagTk || $token instanceof SelfclosingTagTk ) &&
				self::isDOMFragmentType( $token->getAttribute( 'typeof' ) )
			) {
				// Handle dom fragments
				$fragmentMap = $opts['env']->getFragmentMap();
				$nodes = $fragmentMap[ $token->dataAttribs->html ];
				$out .= array_reduce( $nodes, function ( string $prev, DOMNode $next ) {
						// FIXME: The correct thing to do would be to return
						// `next.outerHTML` for the current scenarios where
						// `unpackDOMFragments` is used (expanded attribute
						// values and reparses thereof) but we'd need to remove
						// the span wrapping and typeof annotation of extension
						// content and nowikis.  Since we're primarily expecting
						// to find <translate> and <nowiki> here, this will do.
						return $prev . $next->textContent;
				}, '' );
				if ( $token instanceof TagTk ) {
					$i += 1; // Skip the EndTagTK
					Assert::invariant(
						$i >= $l || $tokens[ $i ] instanceof EndTagTk,
						"tag should be followed by endtag"
					);
				}
			} elseif ( is_array( $token ) ) {
				Assert::invariant( !$strict, "strict case handled above" );
				$out .= self::tokensToString( $token, $strict, $opts );
			}
		}
		return $out;
	}

	/**
	public static function flattenAndAppendToks($array, $prefix, $t) {
		if ( is_array( $t ) || $t->constructor === $String ) {
			if ( count( $t ) > 0 ) {
				if ( $prefix ) {
					$array[] = $prefix;
				}
				$array = $array->concat( $t );
			}
		} else {
			if ( $prefix ) {
				$array[] = $prefix;
			}
			$array[] = $t;
		}

		return $array;
	}
*/

	/**
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	 * @param array<KV> $kvs
	 * @param bool $convertValuesToString
	 * @param bool $useSrc
	 * @return array<string,Token[]>
	 */
	public static function kvToHash( array $kvs, $convertValuesToString = false, $useSrc = false ): array {
		$res = [];
		foreach ( $kvs as $kv ) {
			$key = trim( self::tokensToString( $kv->k ) );
			// SSS FIXME: Temporary fix to handle extensions which use
			// entities in attribute values. We need more robust handling
			// of non-string template attribute values in general.
			$val = ( $useSrc && $kv->vsrc !== null ) ? $kv->vsrc :
				 ( $convertValuesToString ? self::tokensToString( $kv->v ) : $kv->v );
			$res[ strtolower( $key ) ] = self::tokenTrim( $val );
		}
		return $res;
	}

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 * @param string|Token|array<Token> $tokens
	 * @return string|Token|array<Token>
	 */
	public static function tokenTrim( $tokens ) {
		if ( !is_array( $tokens ) ) {
			if ( is_string( $tokens ) ) {
				return trim( $tokens );
			}
			return $tokens;
		}

		$n = count( $tokens );

		// strip leading space
		for ( $i = 0; $i < $n; $i++ ) {
			$token = &$tokens[$i];
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
		for ( $i = $n - 1;  $i >= 0;  $i-- ) {
			$token = &$tokens[ $i ];
			if ( $token instanceof NlTk ) {
				$token = ''; // replace newline with empty
			} elseif ( is_string( $token ) ) {
				$token = preg_replace( '/\s+$/', '', $token, 1 );
				if ( $token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}

		return $tokens;
	}

	/*
	'kvsFromArray' => function ( $a ) {
		return array_map( $a, function ( $e ) {
				return new KV( $e->k, $e->v, $e->srcOffsets || null, $e->ksrc, $e->vsrc );
			}
		)

		;
	},

------------------------------------------- */
}
