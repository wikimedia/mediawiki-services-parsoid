<?php

/**
 * This file contains general utilities for:
 * (a) querying token properties and token types
 * (b) manipulating tokens, individually and as collections.
 *
 */

namespace Parsoid\Utils;

use Parsoid\Config\Env;
use Parsoid\Config\WikitextConstants as Consts;
use Parsoid\Tokens\Token;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\EndTagTk;
use Parsoid\Tokens\SelfclosingTagTk;

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
	 * Checks if a token is of a specific type (primitive string
	 * or one of the token types)
	 * @param Token|string $token
	 * @param string $expectedType
	 * @return bool
	 */
	public static function isOfType( $token, string $expectedType ): bool {
		return self::getTokenType( $token ) === $expectedType;
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
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isHTMLTag( $token ): bool {
		return !is_string( $token ) &&
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
		return preg_match( '#(?:^|\s)mw:DOMFragment(/sealed/\w+)?(?=$|\s)#', $typeOf );
	}

	/**
	 * Is the token a table tag?
	 *
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isTableTag( $token ): bool {
		$tc = self::getTokenType( $token );
		return ( $tc === 'TagTk' || $tc === 'EndTagTk' ) &&
			isset( Consts::$HTML['TableTags'][$token->getName()] );
	}

	/**
	 * Determine if token is a transparent link tag
	 *
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isSolTransparentLinkTag( $token ): bool {
		$tc = self::getTokenType( $token );
		return ( $tc === 'SelfclosingTagTk' || $tc === 'TagTk' || $tc === 'EndTagTk' ) &&
			$token->getName() === 'link' &&
			preg_match( self::SOL_TRANSPARENT_LINK_REGEX, $token->getAttribute( 'rel' ) );
	}

	/**
	 * Does this token represent a behavior switch?
	 *
	 * @param Env $env
	 * @param Token|string $token
	 * @return bool
	 */
	public static function isBehaviorSwitch( Env $env, $token ): bool {
		return self::isOfType( $token, 'SelfclosingTagTk' ) && (
			// Before BehaviorSwitchHandler (ie. PreHandler, etc.)
			$token->getName() === 'behavior-switch' ||
			// After BehaviorSwitchHandler
			// (ie. ListHandler, ParagraphWrapper, etc.)
			( $token->getName() === 'meta' &&
				$token->hasAttribute( 'property' ) &&
				preg_match( $env->getSiteConfig()->bswPagePropRegexp(), $token->getAttribute( 'property' ) ) )
			);
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
		$tt = self::getTokenType( $token );
		if ( $tt === 'string' ) {
			return preg_match( '/^\s*$/', $token );
		} elseif ( self::isSolTransparentLinkTag( $token ) ) {
			return true;
		} elseif ( $tt === 'CommentTk' ) {
			return true;
		} elseif ( self::isBehaviorSwitch( $env, $token ) ) {
			return true;
		} elseif ( $tt !== 'SelfclosingTagTk' || $token->getName() !== 'meta' ) {
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
		return self::isOfType( $token, 'SelfclosingTagTk' ) &&
			$token->getName() === 'meta' &&
			$token->getAttribute( 'typeof' ) === 'mw:EmptyLine';
	}

/**
	public static function isEntitySpanToken(token) {
		return token.constructor === TagTk && token.name === 'span' &&
			token.getAttribute('typeof') === 'mw:Entity';
	}

	//
	* Transform `"\n"` and `"\r\n"` in the input string to {@link NlTk} tokens.
	//
	public static function newlinesToNlTks(str, tsr0) {
		var toks = str.split(/\n|\r\n/);
		var ret = [];
		var tsr = tsr0;
		var i = 0;
		// Add one NlTk between each pair, hence toks.length-1
		for (var n = toks.length - 1; i < n; i++) {
			ret.push(toks[i]);
			var nlTk = new NlTk();
			if (tsr !== undefined) {
				tsr += toks[i].length;
				nlTk.dataAttribs = { tsr: [tsr, tsr + 1] };
			}
			ret.push(nlTk);
		}
		ret.push(toks[i]);
		return ret;
	}

	public static function shiftTokenTSR(tokens, offset, clearIfUnknownOffset) {
		// Bail early if we can
		if (offset === 0) {
			return;
		}

		// offset should either be a valid number or null
		if (offset === undefined) {
			if (clearIfUnknownOffset) {
				offset = null;
			} else {
				return;
			}
		}

		// update/clear tsr
		for (var i = 0, n = tokens.length; i < n; i++) {
			var t = tokens[i];
			switch (t && t.constructor) {
				case TagTk:
				case SelfclosingTagTk:
				case NlTk:
				case CommentTk:
				case EndTagTk:
					var da = tokens[i].dataAttribs;
					var tsr = da.tsr;
					if (tsr) {
						if (offset !== null) {
							da.tsr = [tsr[0] + offset, tsr[1] + offset];
						} else {
							da.tsr = null;
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
					if (offset && da.targetOff) {
						da.targetOff += offset;
					}

					// content offsets for ext-links
					if (offset && da.contentOffsets) {
						da.contentOffsets[0] += offset;
						da.contentOffsets[1] += offset;
					}

					// end offset for pre-tag
					if (offset && da.endpos) {
						da.endpos += offset;
					}

					//  Process attributes
					if (t.attribs) {
						for (var j = 0, m = t.attribs.length; j < m; j++) {
							var a = t.attribs[j];
							if (Array.isArray(a.k)) {
								this.shiftTokenTSR(a.k, offset, clearIfUnknownOffset);
							}
							if (Array.isArray(a.v)) {
								this.shiftTokenTSR(a.v, offset, clearIfUnknownOffset);
							}

							// src offsets used to set mw:TemplateParams
							if (offset === null) {
								a.srcOffsets = null;
							} else if (a.srcOffsets) {
								for (var k = 0; k < a.srcOffsets.length; k++) {
									a.srcOffsets[k] += offset;
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

	//
	 * Strip include tags, and the contents of includeonly tags as well.
	//
	public static function stripIncludeTokens(tokens) {
		var toks = [];
		var includeOnly = false;
		for (var i = 0; i < tokens.length; i++) {
			var tok = tokens[i];
			switch (tok.constructor) {
				case TagTk:
				case EndTagTk:
				case SelfclosingTagTk:
					if (['noinclude', 'onlyinclude'].includes(tok.name)) {
						continue;
					} else if (tok.name === 'includeonly') {
						includeOnly = (tok.constructor === TagTk);
						continue;
					}
				// Fall through
				default:
					if (!includeOnly) {
						toks.push(tok);
					}
			}
		}
		return toks;
	}

	public static function tokensToString(tokens, strict, opts) {
		var out = '';
		if (!opts) {
			opts = {};
		}
		// XXX: quick hack, track down non-array sources later!
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		for (var i = 0, l = tokens.length; i < l; i++) {
			var token = tokens[i];
			if (!token) {
				continue;
			} else if (token.constructor === String) {
				out += token;
			} else if (token.constructor === CommentTk ||
					(!opts.retainNLs && token.constructor === NlTk)) {
				// strip comments and newlines
			} else if (opts.stripEmptyLineMeta && this.isEmptyLineMetaToken(token)) {
				// If requested, strip empty line meta tokens too.
			} else if (opts.includeEntities && this.isEntitySpanToken(token)) {
				out += token.dataAttribs.src;
				i += 2;  // Skip child and end tag.
			} else if (strict) {
				// If strict, return accumulated string on encountering first non-text token
				return [out, tokens.slice(i)];
			} else if (opts.unpackDOMFragments &&
					[TagTk, SelfclosingTagTk].indexOf(token.constructor) !== -1 &&
					this.isDOMFragmentType(token.getAttribute('typeof'))) {
				// Handle dom fragments
				const nodes = opts.env.fragmentMap.get(token.dataAttribs.html);
				out += nodes.reduce(function(prev, next) {
					// FIXME: The correct thing to do would be to return
					// `next.outerHTML` for the current scenarios where
					// `unpackDOMFragments` is used (expanded attribute
					// values and reparses thereof) but we'd need to remove
					// the span wrapping and typeof annotation of extension
					// content and nowikis.  Since we're primarily expecting
					// to find <translate> and <nowiki> here, this will do.
					return prev + next.textContent;
				}, '');
				if (token.constructor === TagTk) {
					i += 1;  // Skip the EndTagTK
					console.assert(i >= l || tokens[i].constructor === EndTagTk);
				}
			} else if (Array.isArray(token)) {
				out += this.tokensToString(token, strict, opts);
			}
		}
		return out;
	}

	public static function flattenAndAppendToks(array, prefix, t) {
		if (Array.isArray(t) || t.constructor === String) {
			if (t.length > 0) {
				if (prefix) {
					array.push(prefix);
				}
				array = array.concat(t);
			}
		} else {
			if (prefix) {
				array.push(prefix);
			}
			array.push(t);
		}

		return array;
	}

	//
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	//
	public static function kvToHash(kvs, convertValuesToString, useSrc) {
		if (!kvs) {
			console.warn("Invalid kvs!: " + JSON.stringify(kvs, null, 2));
			return Object.create(null);
		}
		var res = Object.create(null);
		for (var i = 0, l = kvs.length; i < l; i++) {
			var kv = kvs[i];
			var key = this.tokensToString(kv.k).trim();
			// SSS FIXME: Temporary fix to handle extensions which use
			// entities in attribute values. We need more robust handling
			// of non-string template attribute values in general.
			var val = (useSrc && kv.vsrc !== undefined) ? kv.vsrc :
				convertValuesToString ? this.tokensToString(kv.v) : kv.v;
			res[key.toLowerCase()] = this.tokenTrim(val);
		}
		return res;
	}

	//
	 * Trim space and newlines from leading and trailing text tokens.
	//
	public static function tokenTrim(tokens) {
		if (!Array.isArray(tokens)) {
			return tokens;
		}

		// Since the tokens array might be frozen,
		// we have to create a new array -- but, create it
		// only if needed
		//
		// FIXME: If tokens is not frozen, we can avoid
		// all this circus with leadingToks and trailingToks
		// but we will need a new function altogether -- so,
		// something worth considering if this is a perf. problem.

		var i, token;
		var n = tokens.length;

		// strip leading space
		var leadingToks = [];
		for (i = 0; i < n; i++) {
			token = tokens[i];
			if (token.constructor === NlTk) {
				leadingToks.push('');
			} else if (token.constructor === String) {
				leadingToks.push(token.replace(/^\s+/, ''));
				if (token !== '') {
					break;
				}
			} else {
				break;
			}
		}

		i = leadingToks.length;
		if (i > 0) {
			tokens = leadingToks.concat(tokens.slice(i));
		}

		// strip trailing space
		var trailingToks = [];
		for (i = n - 1; i >= 0; i--) {
			token = tokens[i];
			if (token.constructor === NlTk) {
				trailingToks.push(''); // replace newline with empty
			} else if (token.constructor === String) {
				trailingToks.push(token.replace(/\s+$/, ''));
				if (token !== '') {
					break;
				}
			} else {
				break;
			}
		}

		var j = trailingToks.length;
		if (j > 0) {
			tokens = tokens.slice(0, n - j).concat(trailingToks.reverse());
		}

		return tokens;
	}

	//
	 * Strip EOFTk token from token chunk.
	//
	public static function stripEOFTkfromTokens(tokens) {
		// this.dp( 'stripping end or whitespace tokens' );
		if (!Array.isArray(tokens)) {
			tokens = [ tokens ];
		}
		if (!tokens.length) {
			return tokens;
		}
		// Strip 'end' token
		if (tokens.length && lastItem(tokens).constructor === EOFTk) {
			var rank = tokens.rank;
			tokens = tokens.slice(0, -1);
			tokens.rank = rank;
		}

		return tokens;
	}

	public static function placeholder(content, dataAttribs, endAttribs) {
		if (content === null) {
			return [
				new SelfclosingTagTk('meta', [
					new KV('typeof', 'mw:Placeholder'),
				], dataAttribs),
			];
		} else {
			return [
				new TagTk('span', [
					new KV('typeof', 'mw:Placeholder'),
				], dataAttribs),
				content,
				new EndTagTk('span', [], endAttribs),
			];
		}
	}
------------------------------------------- */
}
