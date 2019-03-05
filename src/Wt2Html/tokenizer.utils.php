<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Utilities used in the tokenizer.
 * @module wt2html/tokenizer_utils
 */

namespace Parsoid;

use Parsoid\JSUtils as JSUtils;
use Parsoid\KV as KV;
use Parsoid\TagTk as TagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\CommentTk as CommentTk;

$tu = $module->exports = [

	'PREPROC_BRACE_BRACE' => 1, // {{ ... }}
	'PREPROC_BRACE_DASH' => 2, // -{ ... }-
	'PREPROC_BRACKET_BRACKET' => 3, // [[ ... ]]
	'PREPROC_BROKEN' => 4, // unclosed

	'flattenIfArray' => function ( $a ) use ( &$undefined ) {
		function internalFlatten( $e, $res ) use ( &$undefined ) {
			// Don't bother flattening if we dont have an array
			if ( !is_array( $e ) ) {
				return $e;
			}

			for ( $i = 0;  $i < count( $e );  $i++ ) {
				$v = $e[ $i ];
				if ( is_array( $v ) ) {
					// Change in assumption from a shallow array to a nested array.
					if ( $res === null ) { $res = array_slice( $e, 0, $i/*CHECK THIS*/ );
		   }
					internalFlatten( $v, $res );
				} elseif ( $v !== null && $v !== null ) {
					if ( $res !== null ) {
						$res[] = $v;
					}
				} else {
					throw new Error( 'falsy ' . $e );
				}
			}

			if ( $res ) {
				$e = $res;
			}
			return $e;
		}
		return internalFlatten( $a, null );
	},

	'flattenString' => function ( $c ) use ( &$tu ) {
		$out = $tu->flattenStringlist( $c );
		if ( count( $out ) === 1 && $out[ 0 ]->constructor === $String ) {
			return $out[ 0 ];
		} else {
			return $out;
		}
	},

	'flattenStringlist' => function ( $c ) use ( &$tu ) {
		$out = [];
		$text = '';
		// c will always be an array
		$c = $tu->flattenIfArray( $c );
		for ( $i = 0,  $l = count( $c );  $i < $l;  $i++ ) {
			$ci = $c[ $i ];
			if ( $ci->constructor === $String ) {
				if ( $ci !== '' ) {
					$text += $ci;
				}
			} else {
				if ( $text !== '' ) {
					$out[] = $text;
					$text = '';
				}
				$out[] = $ci;
			}
		}
		if ( $text !== '' ) {
			$out[] = $text;
		}
		return $out;
	},

	/** Simple string formatting using `%s`. */
	'sprintf' => function ( $format ) {
		$args = array_slice( $arguments, 1 );
		return preg_replace( '/%s/', function () {
				return ( count( $args ) ) ? array_shift( $args ) : '';
		}, $format );
	},

	'getAttrVal' => function ( $value, $start, $end ) {
		return [ 'value' => $value, 'srcOffsets' => [ $start, $end ] ];
	},

	'buildTableTokens' => function ( $tagName, $wtChar, $attrInfo, $tsr, $endPos, $content, $addEndTag ) use ( &$EndTagTk, &$SelfclosingTagTk, &$KV, &$TagTk ) {
		$a = null;
		$dp = [ 'tsr' => $tsr ];

		if ( !$attrInfo ) {
			$a = [];
			if ( $tagName === 'td' || $tagName === 'th' ) {
				// Add a flag that indicates that the tokenizer didn't
				// encounter a "|...|" attribute box. This is useful when
				// deciding which <td>/<th> cells need attribute fixups.
				$dp->tmp = [ 'noAttrs' => true ];
			}
		} else {
			$a = $attrInfo[ 0 ];
			if ( count( $a ) === 0 ) {
				$dp->startTagSrc = $wtChar + implode( '', $attrInfo[ 1 ] );
			}
			if ( ( count( $a ) === 0 && $attrInfo[ 2 ] ) || $attrInfo[ 2 ] !== '|' ) {
				// Variation from default
				// 1. Separator present with an empty attribute block
				// 2. Not "|"
				$dp->attrSepSrc = $attrInfo[ 2 ];
			}
		}

		$dataAttribs = [ 'tsr' => [ $endPos, $endPos ] ];
		$endTag = null;
		if ( $addEndTag ) {
			$endTag = new EndTagTk( $tagName, [], $dataAttribs );
		} else {
			// We rely on our tree builder to close the table cell (td/th) as needed.
			// We cannot close the cell here because cell content can come from
			// multiple parsing contexts and we cannot close the tag in the same
			// parsing context in which the td was opened:
			// Ex: {{echo|{{!}}foo}}{{echo|bar}} has to output <td>foobar</td>
			//
			// But, add a marker meta-tag to capture tsr info.
			// SSS FIXME: Unsure if this is actually helpful, but adding it in just in case.
			// Can test later and strip it out if it doesn't make any diff to rting.
			$endTag = new SelfclosingTagTk( 'meta', [
					new KV( 'typeof', 'mw:TSRMarker' ),
					new KV( 'data-etag', $tagName )
				], $dataAttribs
			);
		}

		return [ new TagTk( $tagName, $a, $dp ) ]->concat( $content, $endTag );
	},

	'buildXMLTag' => function ( $name, $lcName, $attribs, $endTag, $selfClose, $tsr ) use ( &$EndTagTk, &$SelfclosingTagTk, &$TagTk ) {
		$tok = null;
		$da = [ 'tsr' => $tsr, 'stx' => 'html' ];

		if ( $name !== $lcName ) {
			$da->srcTagName = $name;
		}

		if ( $endTag !== null ) {
			$tok = new EndTagTk( $lcName, $attribs, $da );
		} elseif ( $selfClose ) {
			$da->selfClose = true;
			$tok = new SelfclosingTagTk( $lcName, $attribs, $da );
		} else {
			$tok = new TagTk( $lcName, $attribs, $da );
		}

		return $tok;
	},

	/**
	 * Inline breaks, flag-enabled rule which detects end positions for
	 * active higher-level rules in inline and other nested rules.
	 * Those inner rules are then exited, so that the outer rule can
	 * handle the end marker.
	 */
	'inlineBreaks' => function ( $input, $pos, $stops ) use ( &$tu ) {
		$c = $input[ $pos ];
		if ( !preg_match( '/[=|!{}:;\r\n[\]\-]/', $c ) ) {
			return false;
		}

		switch ( $c ) {
			case '=':
			if ( $stops->onStack( 'arrow' ) && $input[ $pos + 1 ] === '>' ) {
				return true;
			}
			return $stops->onStack( 'equal' )
|| $stops->onStack( 'h' )
&& ( $pos === count( $input ) - 1
					// possibly more equals followed by spaces or comments
					 || preg_match( '/^=*(?:[ \t]|<\!--(?:(?!-->)[^])*-->)*(?:[\r\n]|$)/',
							substr( $input, $pos + 1 )
						) );
			case '|':
			return ( $stops->onStack( 'templateArg' )
&& !$stops->onStack( 'extTag' ) )
|| $stops->onStack( 'tableCellArg' )
|| $stops->onStack( 'linkdesc' )
|| ( $stops->onStack( 'table' )
&& $pos < count( $input ) - 1
&& preg_match( '/[}|]/', $input[ $pos + 1 ] ) );
			case '!':
			return $stops->onStack( 'th' ) !== false
&& !$stops->onStack( 'templatedepth' )
&& $input[ $pos + 1 ] === '!';
			case '{':
			// {{!}} pipe templates..
			// FIXME: Presumably these should mix with and match | above.
			return ( $stops->onStack( 'tableCellArg' )
&& substr( $input, $pos, 5 ) === '{{!}}' )
|| ( $stops->onStack( 'table' )
&& substr( $input, $pos, 10 ) === '{{!}}{{!}}' );

			case '}':
			$c2 = $input[ $pos + 1 ];
			$preproc = $stops->onStack( 'preproc' );
			return ( $c2 === '}' && $preproc === $tu::PREPROC_BRACE_BRACE )
|| ( $c2 === '-' && $preproc === $tu::PREPROC_BRACE_DASH );
			case ':':
			return $stops->onStack( 'colon' )
&& !$stops->onStack( 'extlink' )
&& !$stops->onStack( 'templatedepth' )
&& !$stops->onStack( 'linkdesc' )
&& !( $stops->onStack( 'preproc' ) === $tu::PREPROC_BRACE_DASH );
			case ';':
			return $stops->onStack( 'semicolon' );
			case "\r":
			return $stops->onStack( 'table' )
&& preg_match( '/\r\n?\s*[!|]/', substr( $input, $pos ) );
			case "\n":
			// The code below is just a manual / efficient
			// version of this check.
			//
			// stops.onStack('table') && /^\n\s*[!|]/.test(input.substr(pos));
			//
			// It eliminates a substr on the string and eliminates
			// a potential perf problem since "\n" and the inline_breaks
			// test is common during tokenization.
			if ( !$stops->onStack( 'table' ) ) {
				return false;
			}

			// Allow leading whitespace in tables

			// Since we switched on 'c' which is input[pos],
			// we know that input[pos] is "\n".
			// So, the /^\n/ part of the regexp is already satisfied.
			// Look for /\s*[!|]/ below.
			$n = count( $input );
			for ( $i = $pos + 1;  $i < $n;  $i++ ) {
				$d = $input[ $i ];
				if ( preg_match( '/[!|]/', $d ) ) {
					return true;
				} elseif ( !( preg_match( '/\s/', $d ) ) ) {
					return false;
				}
			}
			return false;
			case '[':
			// This is a special case in php's doTableStuff, added in
			// response to T2553.  If it encounters a `[[`, it bails on
			// parsing attributes and interprets it all as content.
			return $stops->onStack( 'tableCellArg' )
&& substr( $input, $pos, 2 ) === '[[';
			case '-':
			// Same as above: a special case in doTableStuff, added
			// as part of T153140
			return $stops->onStack( 'tableCellArg' )
&& substr( $input, $pos, 2 ) === '-{';
			case ']':
			if ( $stops->onStack( 'extlink' ) ) { return true;
   }
			return $stops->onStack( 'preproc' ) === $tu::PREPROC_BRACKET_BRACKET
&& $input[ $pos + 1 ] === ']';
			default:
			throw new Error( 'Unhandled case!' );
		}
	},

	/** Pop off the end comments, if any. */
	'popComments' => function ( $attrs ) use ( &$CommentTk ) {
		$buf = [];
		for ( $i = count( $attrs ) - 1;  $i > -1;  $i-- ) {
			$kv = $attrs[ $i ];
			if ( gettype( $kv->k ) === 'string' && !$kv->v && preg_match( '/^\s*$/', $kv->k ) ) {
				// permit whitespace
				array_unshift( $buf, $kv->k );
			} elseif ( is_array( $kv->k ) && !$kv->v ) {
				// all should be comments
				if ( $kv->k->some( function ( $k ) use ( &$CommentTk ) {
							return !( $k instanceof CommentTk::class );
				}
					)
				) { break;
	   }
				call_user_func_array( [ $buf, 'unshift' ], $kv->k );
			} else {
				break;
			}
		}
		// ensure we found a comment
		while ( count( $buf ) && !( $buf[ 0 ] instanceof CommentTk::class ) ) {
			array_shift( $buf );
		}
		if ( count( $buf ) ) {
			array_splice( $attrs, -count( $buf ), count( $buf ) );
			return [ 'buf' => $buf, 'commentStartPos' => $buf[ 0 ]->dataAttribs->tsr[ 0 ] ];
		} else {
			return null;
		}
	},

	'tsrOffsets' => function ( $location, $flag ) {
		switch ( $flag ) {
			case 'start':
			return [ $location->start->offset, $location->start->offset ];
			case 'end':
			return [ $location->end->offset, $location->end->offset ];
			default:
			return [ $location->start->offset, $location->end->offset ];
		}
	},

	'enforceParserResourceLimits' => function ( $env, $token ) use ( &$TagTk, &$SelfclosingTagTk ) {
		if ( $token && ( $token->constructor === TagTk::class || $token->constructor === SelfclosingTagTk::class ) ) {
			switch ( $token->name ) {
				case 'listItem':
				$env->bumpParserResourceUse( 'listItem' );
				break;
				case 'template':
				$env->bumpParserResourceUse( 'transclusion' );
				break;
				case 'td':

				case 'th':
				$env->bumpParserResourceUse( 'tableCell' );
				break;
			}
		}
	},

	'protectAttrsRegExp' => new RegExp( "^(about|data-mw.*|data-parsoid.*|data-x.*|{DOMDataUtils\DataObjectAttrName()}|property|rel|typeof)\$", 'i' ),
	'protectAttrs' => function ( $name ) {
		return str_replace( $this->protectAttrsRegExp, 'data-x-$1', $name );
	},

	'isIncludeTag' => function ( $name ) {
		return $name === 'includeonly' || $name === 'noinclude' || $name === 'onlyinclude';
	}
];

/**
 * Syntax stops: Avoid eating significant tokens for higher-level rules
 * in nested inline rules.
 *
 * Flags for specific parse environments (inside tables, links etc). Flags
 * trigger syntactic stops in the inline_breaks rule, which
 * terminates inline and attribute matches. Flags merely reduce the number
 * of rules needed: The grammar is still context-free as the
 * rules can just be unrolled for all combinations of environments
 * at the cost of a much larger grammar.
 * @class
 */
function SyntaxStops() {
	$this->stacks = [];
	$this->key = '';
}

/**
 * A stack for nested, but not cumulative syntactic stops.
 * Example: '=' is allowed in values of template arguments, even if those
 * are nested in attribute names.
 */
SyntaxStops::prototype::push = function ( $name, $value ) use ( &$undefined ) {
	if ( $this->stacks[ $name ] === null ) {
		$this->stacks[ $name ] = [ $value ];
	} else {
		$this->stacks[ $name ][] = $value;
	}
	$this->_updateStackKey();
	return count( $this->stacks[ $name ] ); // always truthy
};

SyntaxStops::prototype::pop = function ( $name ) use ( &$undefined ) {
	if ( $this->stacks[ $name ] !== null ) {
		array_pop( $this->stacks[ $name ] );
	} else {
		throw 'SyntaxStops.pop: unknown stop for ' . $name;
	}
	$this->_updateStackKey();
	return false;
};

SyntaxStops::prototype::popTo = function ( $name, $len ) use ( &$undefined ) {
	if ( $this->stacks[ $name ] === null ) {
		throw 'SyntaxStops.popTo: unknown stop for ' . $name;
	} elseif ( count( $this->stacks[ $name ] ) < ( $len - 1 ) ) {
		throw 'SyntaxStops.popTo: stop stack too short for ' . $name;
	} else {
		count( $this->stacks[ $name ] ) = $len - 1;
	}
	$this->_updateStackKey();
	return false;
};

SyntaxStops::prototype::onStack = function ( $name ) use ( &$undefined, &$JSUtils ) {
	$stack = $this->stacks[ $name ];
	if ( $stack === null || count( $stack ) === 0 ) {
		return false;
	} else {
		return JSUtils::lastItem( $stack );
	}
};

SyntaxStops::prototype::_updateStackKey = function () {
	$stackStops = '';
	foreach ( $this->stacks as $key => $___ ) {
		$value = $this->onStack( $key );
		if ( $value !== false ) {
			$stackStops += "\n" . $key . "\n" . ( +$value );
		}
	}
	$this->key = $stackStops;
};

$tu::SyntaxStops = $SyntaxStops;
