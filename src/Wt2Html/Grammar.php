<?php

namespace Parsoid\Wt2Html;


	use Parsoid\Utils\TokenUtils;
	use Parsoid\Utils\Util;
	use Parsoid\Utils\WTUtils;
	use Parsoid\Tokens\CommentTk;
	use Parsoid\Tokens\EndTagTk;
	use Parsoid\Tokens\EOFTk;
	use Parsoid\Tokens\KV;
	use Parsoid\Tokens\NlTk;
	use Parsoid\Tokens\SelfclosingTagTk;
	use Parsoid\Tokens\TagTk;
	use Parsoid\Tokens\Token;
	use Parsoid\Config\Env;
	use Parsoid\Config\SiteConfig;
	use Parsoid\Config\WikitextConstants;


class Grammar extends \WikiPEG\PEGParserBase {
  // initializer
  
  	/** @var Env */
  	private $env;
  
  	/** @var SiteConfig */
  	private $siteConfig;
  
  	/** @var array */
  	private $pipelineOpts;
  
  	/** @var int */
  	private $pipelineOffset;
  
  	private $extTags;
  
  	protected function initialize() {
  		$this->env = $this->options['env'];
  		$this->siteConfig = $this->env->getSiteConfig();
  
  		$tokenizer = $this->options['pegTokenizer'];
  		$this->pipelineOpts = $tokenizer->getOptions();
  		$this->pipelineOffset = $this->options['pipelineOffset'] ?? 0;
  		$this->extTags = $this->siteConfig->getExtensionTagNameMap();
  	}
  
  	private $prevOffset = 0;
  	private $headingIndex = 0;
  
  	private function assert( $condition, $text ) {
  		if ( !$condition ) {
  			throw new \Exception( "Grammar.pegphp assertion failure: $text" );
  		}
  	}
  
  	private function unreachable() {
  		throw new \Exception( "Grammar.pegphp: this should be unreachable" );
  	}
  
  	// Some shorthands for legibility
  	private function startOffset() {
  		return $this->savedPos;
  	}
  
  	private function endOffset() {
  		return $this->currPos;
  	}
  
  	private function tsrOffsets( $flag = 'default' ) {
  		switch ( $flag ) {
              case 'start':
                  return [ $this->savedPos, $this->savedPos ];
              case 'end':
                  return [ $this->currPos, $this->currPos ];
              default:
                  return [ $this->savedPos, $this->currPos ];
          }
  	}
  
  	/*
  	 * Emit a chunk of tokens to our consumers.  Once this has been done, the
  	 * current expression can return an empty list (true).
  	 */
  	private function emitChunk( $tokens ) {
  		// Shift tsr of all tokens by the pipeline offset
  		TokenUtils::shiftTokenTSR( $tokens, $this->pipelineOffset );
  		$this->env->log( 'trace/peg', $this->options['pipelineId'] ?? '', '---->  ', $tokens );
  
  		$i = null;
  		$n = count( $tokens );
  
  		// Enforce parsing resource limits
  		for ( $i = 0;  $i < $n;  $i++ ) {
  			TokenizerUtils::enforceParserResourceLimits( $this->env, $tokens[ $i ] );
  		}
  
  		// limit the size of individual chunks
  		$chunkLimit = 100000;
  		$cb = $this->options['cb'];
  		if ( $n > $chunkLimit ) {
  			$i = 0;
  			while ( $i < $n ) {
  				$cb( array_slice( $tokens, $i, $i + $chunkLimit ) );
  				$i += $chunkLimit;
  			}
  		} else {
  			$cb( $tokens );
  		}
  	}
  
  	/* ------------------------------------------------------------------------
  	 * Extension tags should be parsed with higher priority than anything else.
  	 *
  	 * The trick we use is to strip out the content inside a matching tag-pair
  	 * and not tokenize it. The content, if it needs to parsed (for example,
  	 * for <ref>, <*include*> tags), is parsed in a fresh tokenizer context
  	 * which means any error correction that needs to happen is restricted to
  	 * the scope of the extension content and doesn't spill over to the higher
  	 * level.  Ex: <math><!--foo</math>.
  	 *
  	 * IGNORE: {{ this just balances the blocks in this comment for pegjs
  	 *
  	 * This trick also lets us prevent extension content (that don't accept WT)
  	 * from being parsed as wikitext (Ex: <math>\frac{foo\frac{bar}}</math>)
  	 * We don't want the "}}" being treated as a template closing tag and
  	 * closing outer templates.
  	 * --------------------------------------------------------------------- */
  
  	private function isXMLTag( string $name, bool $block ): bool {
  		$lName = strtolower( $name );
  		return $block ?
  			TokenUtils::isBlockTag( $lName ) :
  			isset( WikitextConstants::$HTML['HTML5Tags'][$lName] )
  			|| isset( WikitextConstants::$HTML['OlderHTMLTags'][$lName] );
  	}
  
  	private function isExtTag( string $name ): bool {
  		$lName = strtolower( $name );
  		$isInstalledExt = isset( $this->extTags[$lName] );
  		$isIncludeTag = TokenizerUtils::isIncludeTag( $lName );
  		return $isInstalledExt || $isIncludeTag;
  	}
  
  	private function maybeExtensionTag( Token $t ) {
  		$tagName = strtolower( $t->getName() );
  
  		$isInstalledExt = isset( $this->extTags[$tagName] );
  		$isIncludeTag = TokenizerUtils::isIncludeTag( $tagName );
  
  		// Extensions have higher precedence when they shadow html tags.
  		if ( !( $isInstalledExt || $isIncludeTag ) ) {
  			return $t;
  		}
  
  		$dp = $t->dataAttribs;
  		$skipLen = 0;
  
  		switch ( get_class( $t ) ) {
  			case EndTagTk::class:
  				if ( $isIncludeTag ) {
  					return $t;
  				}
  				// Similar to TagTk, we rely on the sanitizer to convert to text
  				// where necessary and emit tokens to ease the wikitext escaping
  				// code.  However, extension tags that shadow html tags will see
  				// their unmatched end tags dropped while tree building, since
  				// the sanitizer will let them through.
  				return $t; // not text()
  
  			case SelfclosingTagTk::class:
  				$dp->src = substr( $this->input, $dp->tsr[0], $dp->tsr[1] - $dp->tsr[0] );
  				$dp->tagWidths = [ $dp->tsr[1] - $dp->tsr[0], 0 ];
  				if ( $isIncludeTag ) {
  					return $t;
  				}
  				break;
  
  			case TagTk::class:
  				$tsr0 = $dp->tsr[0];
  				$endTagRE = '~.*?(</\s*' . preg_quote( $tagName, '~' ) . '\s*>)~isA';
  				$tagContentFound = preg_match( $endTagRE, $this->input, $tagContent, 0, $tsr0 );
  
  				if ( !$tagContentFound ) {
  					$dp->src = substr( $this->input, $dp->tsr[0], $dp->tsr[1] - $dp->tsr[0] );
  					$dp->tagWidths = [ $dp->tsr[1] - $dp->tsr[0], 0 ];
  					if ( $isIncludeTag ) {
  						return $t;
  					} else {
  						// This is undefined behaviour.  The old parser currently
  						// returns text here (see core commit 674e8388cba),
  						// whereas this results in unclosed
  						// extension tags that shadow html tags falling back to
  						// their html equivalent.  The sanitizer will take care
  						// of converting to text where necessary.  We do this to
  						// simplify `hasWikitextTokens` when escaping wikitext,
  						// which wants these as tokens because it's otherwise
  						// lacking in context.
  						return $t; // not text()
  					}
  				}
  
  				$extSrc = $tagContent[0];
  				$endTagWidth = strlen( $tagContent[1] );
  
  				if ( !empty( $this->pipelineOpts['inTemplate'] ) ) {
  					// Support 1-level of nesting in extensions tags while
  					// tokenizing in templates to support the #tag parser function.
  					//
  					// It's necessary to permit this broadly in templates because
  					// there's no way to distinguish whether the nesting happened
  					// while expanding the #tag parser function, or just a general
  					// syntax errors.  In other words,
  					//
  					//   hi<ref>ho<ref>hi</ref>ho</ref>
  					//
  					// and
  					//
  					//   hi{{#tag:ref|ho<ref>hi</ref>ho}}
  					//
  					// found in template are returned indistinguishably after a
  					// preprocessing request, though the old parser renders them
  					// differently.  #tag in template is probably a common enough
  					// use case that we want to accept these false positives,
  					// though another approach could be to drop this code here, and
  					// invoke a native #tag handler and forgo those in templates.
  					//
  					// Expand `extSrc` as long as there is a <tagName> found in the
  					// extension source body.
  					$startTagRE = '~<' . preg_quote( $tagName, '~' ) . '[^/<>]*>~i';
  					$s = substr( $extSrc, $this->endOffset() - $tsr0 );
  					while ( strlen( $s ) ) {
  						if ( !preg_match( $startTagRE, $s, $m ) ) {
  							break;
  						}
  						if ( !preg_match( $endTagRE, $this->input, $tagContent, 0, strlen( $extSrc ) ) ) {
  							break;
  						}
  						$s = $tagContent[0];
  						$endTagWidth = strlen( $m[1] );
  						$extSrc .= $tagContent[0];
  					}
  				}
  
  				// Extension content source
  				$dp->src = $extSrc;
  				$dp->tagWidths = [ $this->endOffset() - $tsr0, $endTagWidth ];
  
  				$skipLen = strlen( $extSrc ) - $dp->tagWidths[0] - $dp->tagWidths[1];
  
  				// If the xml-tag is a known installed (not native) extension,
  				// skip the end-tag as well.
  				if ( $isInstalledExt ) {
  					$skipLen += $endTagWidth;
  				}
  				break;
  
  			default:
  				$this->unreachable();
  		}
  
  		$this->currPos += $skipLen;
  
  		if ( $isInstalledExt ) {
  			// update tsr[1] to span the start and end tags.
  			$dp->tsr[1] = $this->endOffset(); // was just modified above
  			return new SelfclosingTagTk( 'extension', [
  					new KV( 'typeof', 'mw:Extension' ),
  					new KV( 'name', $tagName ),
  					new KV( 'about', $this->env->newAboutId() ),
  					new KV( 'source', $dp->src ),
  					new KV( 'options', $t->attribs )
  				], $dp
  			);
  		} elseif ( $isIncludeTag ) {
  			// Parse ext-content, strip eof, and shift tsr
  			$extContent = substr( $dp->src, $dp->tagWidths[ 0 ],
  				strlen( $dp->src ) - $dp->tagWidths[1] - $dp->tagWidths[0] );
  			$extContentToks = ( new PegTokenizer( $this->env ) )->tokenizeSync( $extContent );
  			if ( $dp->tagWidths[1] > 0 ) {
  				TokenUtils::stripEOFTkFromTokens( $extContentToks );
  			}
  			TokenUtils::shiftTokenTSR( $extContentToks, $dp->tsr[0] + $dp->tagWidths[0] );
  			array_unshift( $extContentToks, $t );
  			return $extContentToks;
  		} else {
  			$this->unreachable();
  		}
  	}
  
  	private function lastItem( array $array ) {
  		return $array[ count( $array ) - 1 ] ?? null;
  	}
  

  // cache init
    protected $cache = [];

  // consts
  protected $consts = [
    0 => ["type" => "end", "description" => "end of input"],
    1 => ["type" => "other", "description" => "start"],
    2 => ["type" => "other", "description" => "table_start_tag"],
    3 => ["type" => "class", "value" => "[.:,']", "description" => "[.:,']"],
    4 => ["type" => "class", "value" => "[&%{]", "description" => "[&%{]"],
    5 => ["type" => "other", "description" => "table_attributes"],
    6 => ["type" => "other", "description" => "generic_newline_attributes"],
    7 => ["type" => "any", "description" => "any character"],
    8 => ["type" => "other", "description" => "extlink"],
    9 => ["type" => "other", "description" => "tlb"],
    10 => ["type" => "class", "value" => "[ \\t]", "description" => "[ \\t]"],
    11 => ["type" => "literal", "value" => "<!--", "description" => "\"<!--\""],
    12 => ["type" => "literal", "value" => "-->", "description" => "\"-->\""],
    13 => ["type" => "literal", "value" => "|", "description" => "\"|\""],
    14 => ["type" => "literal", "value" => "{{!}}", "description" => "\"{{!}}\""],
    15 => ["type" => "literal", "value" => "//", "description" => "\"//\""],
    16 => ["type" => "class", "value" => "[A-Za-z]", "description" => "[A-Za-z]"],
    17 => ["type" => "class", "value" => "[-A-Za-z0-9+.]", "description" => "[-A-Za-z0-9+.]"],
    18 => ["type" => "literal", "value" => ":", "description" => "\":\""],
    19 => ["type" => "literal", "value" => "[", "description" => "\"[\""],
    20 => ["type" => "class", "value" => "[0-9A-Fa-f:.]", "description" => "[0-9A-Fa-f:.]"],
    21 => ["type" => "literal", "value" => "]", "description" => "\"]\""],
    22 => ["type" => "class", "value" => "[^ :\\]\\[\\r\\n\"'<>\\x00-\\x20\\x7f,.&%\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000{]", "description" => "[^ :\\]\\[\\r\\n\"'<>\\x00-\\x20\\x7f,.&%\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000{]"],
    23 => ["type" => "literal", "value" => "=", "description" => "\"=\""],
    24 => ["type" => "class", "value" => "[\\0/=>]", "description" => "[\\0/=>]"],
    25 => ["type" => "class", "value" => "[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]", "description" => "[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]"],
    26 => ["type" => "class", "value" => "[^\\r\\n]", "description" => "[^\\r\\n]"],
    27 => ["type" => "literal", "value" => "\x0a", "description" => "\"\\n\""],
    28 => ["type" => "literal", "value" => "\x0d\x0a", "description" => "\"\\r\\n\""],
    29 => ["type" => "literal", "value" => "{", "description" => "\"{\""],
    30 => ["type" => "literal", "value" => "&", "description" => "\"&\""],
    31 => ["type" => "class", "value" => "[#0-9a-zA-Z]", "description" => "[#0-9a-zA-Z]"],
    32 => ["type" => "literal", "value" => ";", "description" => "\";\""],
    33 => ["type" => "class", "value" => "[\"'=]", "description" => "[\"'=]"],
    34 => ["type" => "class", "value" => "[^ \\t\\r\\n\\0/=><&{}\\-!|\\[]", "description" => "[^ \\t\\r\\n\\0/=><&{}\\-!|\\[]"],
    35 => ["type" => "literal", "value" => "'", "description" => "\"'\""],
    36 => ["type" => "literal", "value" => "\"", "description" => "\"\\\"\""],
    37 => ["type" => "literal", "value" => "/", "description" => "\"/\""],
    38 => ["type" => "class", "value" => "[^ \\t\\r\\n\\0/=><&{}\\-!|]", "description" => "[^ \\t\\r\\n\\0/=><&{}\\-!|]"],
    39 => ["type" => "class", "value" => "[ \\t\\n\\r\\x0c]", "description" => "[ \\t\\n\\r\\x0c]"],
    40 => ["type" => "class", "value" => "[^'<~[{\\n\\r|!\\]}\\-\\t&=\"' \\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000]", "description" => "[^'<~[{\\n\\r|!\\]}\\-\\t&=\"' \\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000]"],
    41 => ["type" => "class", "value" => "[&|{\\-]", "description" => "[&|{\\-]"],
    42 => ["type" => "class", "value" => "[.:,]", "description" => "[.:,]"],
    43 => ["type" => "class", "value" => "[']", "description" => "[']"],
    44 => ["type" => "class", "value" => "[^-'<~[{\\n/A-Za-z_|!:;\\]} &=]", "description" => "[^-'<~[{\\n/A-Za-z_|!:;\\]} &=]"],
    45 => ["type" => "literal", "value" => " ", "description" => "\" \""],
    46 => ["type" => "literal", "value" => "[[", "description" => "\"[[\""],
    47 => ["type" => "literal", "value" => "<", "description" => "\"<\""],
    48 => ["type" => "literal", "value" => "{{", "description" => "\"{{\""],
    49 => ["type" => "class", "value" => "[^{}&<\\-!\\['\\r\\n|]", "description" => "[^{}&<\\-!\\['\\r\\n|]"],
    50 => ["type" => "class", "value" => "[{}&<\\-!\\[]", "description" => "[{}&<\\-!\\[]"],
    51 => ["type" => "class", "value" => "[^{}&<\\-!\\[\"\\r\\n|]", "description" => "[^{}&<\\-!\\[\"\\r\\n|]"],
    52 => ["type" => "class", "value" => "[^{}&<\\-!\\[ \\t\\n\\r\\x0c|]", "description" => "[^{}&<\\-!\\[ \\t\\n\\r\\x0c|]"],
    53 => ["type" => "class", "value" => "[^{}&<\\-|/'>]", "description" => "[^{}&<\\-|/'>]"],
    54 => ["type" => "class", "value" => "[{}&\\-|/]", "description" => "[{}&\\-|/]"],
    55 => ["type" => "class", "value" => "[^{}&<\\-|/\">]", "description" => "[^{}&<\\-|/\">]"],
    56 => ["type" => "class", "value" => "[^{}&<\\-|/ \\t\\n\\r\\x0c>]", "description" => "[^{}&<\\-|/ \\t\\n\\r\\x0c>]"],
    57 => ["type" => "literal", "value" => "__", "description" => "\"__\""],
    58 => ["type" => "class", "value" => "[^-'<~[{\\n\\r:;\\]}|!=]", "description" => "[^-'<~[{\\n\\r:;\\]}|!=]"],
    59 => ["type" => "literal", "value" => "-", "description" => "\"-\""],
    60 => ["type" => "literal", "value" => "''", "description" => "\"''\""],
    61 => ["type" => "class", "value" => "[ \\t\\n\\r\\0\\x0b]", "description" => "[ \\t\\n\\r\\0\\x0b]"],
    62 => ["type" => "literal", "value" => "----", "description" => "\"----\""],
    63 => ["type" => "literal", "value" => ">", "description" => "\">\""],
    64 => ["type" => "literal", "value" => "{{{", "description" => "\"{{{\""],
    65 => ["type" => "literal", "value" => "}}}", "description" => "\"}}}\""],
    66 => ["type" => "literal", "value" => "}}", "description" => "\"}}\""],
    67 => ["type" => "literal", "value" => "]]", "description" => "\"]]\""],
    68 => ["type" => "literal", "value" => "RFC", "description" => "\"RFC\""],
    69 => ["type" => "literal", "value" => "PMID", "description" => "\"PMID\""],
    70 => ["type" => "class", "value" => "[0-9]", "description" => "[0-9]"],
    71 => ["type" => "literal", "value" => "ISBN", "description" => "\"ISBN\""],
    72 => ["type" => "class", "value" => "[xX]", "description" => "[xX]"],
    73 => ["type" => "class", "value" => "[^'\"<~[{\\n\\r:;\\]}|!=]", "description" => "[^'\"<~[{\\n\\r:;\\]}|!=]"],
    74 => ["type" => "class", "value" => "[\\n\\r\\t ]", "description" => "[\\n\\r\\t ]"],
    75 => ["type" => "literal", "value" => "}", "description" => "\"}\""],
    76 => ["type" => "class", "value" => "[^<[{\\n\\r\\t|!\\]}{ &\\-]", "description" => "[^<[{\\n\\r\\t|!\\]}{ &\\-]"],
    77 => ["type" => "class", "value" => "[!<\\-\\}\\]\\n\\r]", "description" => "[!<\\-\\}\\]\\n\\r]"],
    78 => ["type" => "literal", "value" => "-{", "description" => "\"-{\""],
    79 => ["type" => "literal", "value" => "}-", "description" => "\"}-\""],
    80 => ["type" => "class", "value" => "[*#:;]", "description" => "[*#:;]"],
    81 => ["type" => "literal", "value" => "+", "description" => "\"+\""],
    82 => ["type" => "class", "value" => "[^\\t\\n\\v />\\0]", "description" => "[^\\t\\n\\v />\\0]"],
    83 => ["type" => "literal", "value" => "!", "description" => "\"!\""],
    84 => ["type" => "literal", "value" => "!!", "description" => "\"!!\""],
    85 => ["type" => "literal", "value" => "=>", "description" => "\"=>\""],
    86 => ["type" => "literal", "value" => "||", "description" => "\"||\""],
    87 => ["type" => "literal", "value" => "{{!}}{{!}}", "description" => "\"{{!}}{{!}}\""],
    88 => ["type" => "class", "value" => "[-+A-Z]", "description" => "[-+A-Z]"],
    89 => ["type" => "class", "value" => "[^{}|;]", "description" => "[^{}|;]"],
    90 => ["type" => "class", "value" => "[a-z]", "description" => "[a-z]"],
    91 => ["type" => "class", "value" => "[-a-z]", "description" => "[-a-z]"],
  ];

  // actions
  private function a0() {
  
  			if ( $this->endOffset() === $this->inputLength ) {
  				$this->emitChunk( [ new EOFTk() ] );
  			}
  			// terminate the loop
  			return false;
  		
  }
  private function a1() {
  
  		// end is passed inline as a token, as well as a separate event for now.
  		$this->emitChunk( [ new EOFTk() ] );
  		return true;
  	
  }
  private function a2($sc) {
   return $this->endOffset(); 
  }
  private function a3($sc, $startPos, $b, $p) {
   $this->unreachable(); 
  }
  private function a4($sc, $startPos, $b, $p, $ta) {
   return $this->endOffset(); 
  }
  private function a5($sc, $startPos, $b, $p, $ta, $tsEndPos, $s2) {
  
  		$coms = TokenizerUtils::popComments( $ta );
  		if ( $coms ) {
  			$tsEndPos = $coms['commentStartPos'];
  		}
  
  		$da = (object)[ 'tsr' => [ $startPos, $tsEndPos ] ];
  		if ( $p !== '|' ) {
  			// Variation from default
  			$da->startTagSrc = $b . $p;
  		}
  
  		return array_merge( $sc,
  			[ new TagTk( 'table', $ta, $da ) ],
  			$coms ? $coms['buf'] : [],
  			$s2 );
  	
  }
  private function a6($proto, $addr, $c) {
   return $c; 
  }
  private function a7($proto, $addr, $s) {
   return $s; 
  }
  private function a8($proto, $addr, $he) {
   return $he; 
  }
  private function a9($proto, $addr, $r) {
   return $r; 
  }
  private function a10($proto, $addr, $path) {
   return $addr !== '' || count( $path ) > 0; 
  }
  private function a11($proto, $addr, $path) {
  
  		return TokenizerUtils::flattenString( array_merge( [ $proto, $addr ], $path ) );
  	
  }
  private function a12($as, $s, $p) {
  
  		return [ $as, $s, $p ];
  	
  }
  private function a13($b) {
   return $b; 
  }
  private function a14($r) {
   return TokenizerUtils::flattenIfArray( $r ); 
  }
  private function a15($addr, $target) {
  
  			// Protocol must be valid and there ought to be at least one
  			// post-protocol character.  So strip last char off target
  			// before testing protocol.
  			$flat = TokenizerUtils::flattenString( [ $addr, $target ] );
  			if ( is_array( $flat ) ) {
  				// There are templates present, alas.
  				return count( $flat ) > 0;
  			}
  			return Util::isProtocolValid( substr( $flat, 0, -1 ), $this->env );
  		
  }
  private function a16($addr, $target, $sp) {
   return $this->endOffset(); 
  }
  private function a17($addr, $target, $sp, $targetOff, $content) {
  
  			return [
  				new SelfclosingTagTk( 'extlink', [
  						new KV( 'href', TokenizerUtils::flattenString( [ $addr, $target ] ) ),
  						new KV( 'mw:content', $content ?? '' ),
  						new KV( 'spaces', $sp )
  					], (object)[
  						'targetOff' => $targetOff,
  						'tsr' => $this->tsrOffsets(),
  						'contentOffsets' => [ $targetOff, $this->endOffset() - 1 ]
  					]
  				)
  			]; 
  }
  private function a18($r) {
   return $r; 
  }
  private function a19($b) {
  
  		// Clear the tokenizer's backtracking cache after matching each
  		// toplevelblock. There won't be any backtracking as a document is just a
  		// sequence of toplevelblocks, so the cache for previous toplevelblocks
  		// will never be needed.
  		$end = $this->startOffset();
  		for ( ;  $this->prevOffset < $end;  $this->prevOffset++ ) {
  			unset( $this->cache[$this->prevOffset] );
  		}
  
  		$tokens = null;
  		if ( is_array( $b ) && count( $b ) ) {
  			$tokens = TokenizerUtils::flattenIfArray( $b );
  		} elseif ( is_string( $b ) ) {
  			$tokens = [ $b ];
  		}
  
  		// Emit tokens for this toplevelblock. This feeds a chunk to the parser pipeline.
  		if ( $tokens ) {
  			$this->emitChunk( $tokens );
  		}
  
  		// We don't return any tokens to the start rule to save memory. We
  		// just emitted them already to our consumers.
  		return true;
  	
  }
  private function a20() {
   return [ new NlTk( $this->tsrOffsets() ) ]; 
  }
  private function a21($c) {
  
  		$data = WTUtils::encodeComment( $c );
  		return [ new CommentTk( $data, (object)[ 'tsr' => $this->tsrOffsets() ] ) ];
  	
  }
  private function a22($p) {
   return Util::isProtocolValid( $p, $this->env ); 
  }
  private function a23($p) {
   return $p; 
  }
  private function a24($extTag, $h, $extlink, $templatedepth, &$preproc, $equal, $table, $templateArg, $tableCellArg, $semicolon, $arrow, $linkdesc, $colon, &$th) {
  
  			return TokenizerUtils::inlineBreaks( $this->input, $this->endOffset(), [
  				'extTag' => $extTag,
  				'h' => $h,
  				'extlink' => $extlink,
  				'templatedepth' => $templatedepth,
  				'preproc' => $preproc,
  				'equal' => $equal,
  				'table' => $table,
  				'templateArg' => $templateArg,
  				'tableCellArg' => $tableCellArg,
  				'semicolon' => $semicolon,
  				'arrow' => $arrow,
  				'linkdesc' => $linkdesc,
  				'colon' => $colon,
  				'th' => $th
  			] );
  		
  }
  private function a25($templatedepth) {
  
  		// Refuse to recurse beyond `maxDepth` levels. Default in the old parser
  		// is $wgMaxTemplateDepth = 40; This is to prevent crashing from
  		// buggy wikitext with lots of unclosed template calls, as in
  		// eswiki/Usuario:C%C3%A1rdenas/PRUEBAS?oldid=651094
  		return $templatedepth + 1 < $this->siteConfig->getMaxTemplateDepth();
  	
  }
  private function a26($templatedepth, $t) {
  
  		return $t;
  	
  }
  private function a27($cc) {
  
  		// if this is an invalid entity, don't tag it with 'mw:Entity'
  		if ( mb_strlen( $cc ) > 1 /* decoded entity would be 1 character */ ) {
  			return $cc;
  		}
  		return [
  			// If this changes, the nowiki extension's toDOM will need to follow suit
  			new TagTk( 'span', [ new KV( 'typeof', 'mw:Entity' ) ],
  				(object)[ 'src' => $this->text(), 'srcContent' => $cc, 'tsr' => $this->tsrOffsets( 'start' ) ] ),
  			$cc,
  			new EndTagTk( 'span', [], (object)[ 'tsr' => $this->tsrOffsets( 'end' ) ] )
  		];
  	
  }
  private function a28($s) {
   return $this->endOffset(); 
  }
  private function a29($s, $namePos0, $name) {
   return $this->endOffset(); 
  }
  private function a30($s, $namePos0, $name, $namePos, $v) {
   return $v; 
  }
  private function a31($s, $namePos0, $name, $namePos, $vd) {
  
  	// NB: Keep in sync w/ generic_newline_attribute
  	$res = null;
  	// Encapsulate protected attributes.
  	if ( gettype( $name ) === 'string' ) {
  		$name = TokenizerUtils::protectAttrs( $name );
  	}
  	if ( $vd !== null ) {
  		$res = new KV( $name, $vd['value'], [ $namePos0, $namePos, $vd['srcOffsets'][0], $vd['srcOffsets'][1] ] );
  		$res->vsrc = substr( $this->input, $vd['srcOffsets'][0], $vd['srcOffsets'][1]  - $vd['srcOffsets'][0] );
  	} else {
  		$res = new KV( $name, '', [ $namePos0, $namePos, $namePos, $namePos ] );
  	}
  	if ( is_array( $name ) ) {
  		$res->ksrc = substr( $this->input, $namePos0, $namePos - $namePos0 );
  	}
  	return $res;
  
  }
  private function a32($s) {
  
  		if ( $s !== '' ) {
  			return [ $s ];
  		} else {
  			return [];
  		}
  	
  }
  private function a33($c) {
   return new KV( $c, '' ); 
  }
  private function a34() {
   return $this->endOffset(); 
  }
  private function a35($namePos0, $name) {
   return $this->endOffset(); 
  }
  private function a36($namePos0, $name, $namePos, $v) {
   return $v; 
  }
  private function a37($namePos0, $name, $namePos, $vd) {
  
  	// NB: Keep in sync w/ table_attibute
  	$res = null;
  	// Encapsulate protected attributes.
  	if ( is_string( $name ) ) {
  		$name = TokenizerUtils::protectAttrs( $name );
  	}
  	if ( $vd !== null ) {
  		$res = new KV( $name, $vd['value'], [ $namePos0, $namePos, $vd['srcOffsets'][0], $vd['srcOffsets'][1] ] );
  		$res->vsrc = substr( $this->input, $vd['srcOffsets'][0], $vd['srcOffsets'][1]  - $vd['srcOffsets'][0] );
  	} else {
  		$res = new KV( $name, '', [ $namePos0, $namePos, $namePos, $namePos ] );
  	}
  	if ( is_array( $name ) ) {
  		$res->ksrc = substr( $this->input, $namePos0, $namePos - $namePos0 );
  	}
  	return $res;
  
  }
  private function a38($c) {
  
  		return TokenizerUtils::flattenStringlist( $c );
  	
  }
  private function a39() {
   return $this->endOffset() === $this->inputLength; 
  }
  private function a40($r, $cil, $bl) {
  
  		return array_merge( [ $r ], $cil, $bl ?: [] );
  	
  }
  private function a41($c) {
   return $c; 
  }
  private function a42($rs) {
   return $rs; 
  }
  private function a43($s) {
   return $s; 
  }
  private function a44($a) {
   return $a; 
  }
  private function a45($a, $b) {
   return [ $a, $b ]; 
  }
  private function a46($m) {
  
  		return Util::decodeWtEntities( $m );
  	
  }
  private function a47($q, $ill) {
   return $ill; 
  }
  private function a48($q, $t) {
   return $t; 
  }
  private function a49($q, $r) {
   return count( $r ) > 0 || $q !== ''; 
  }
  private function a50($q, $r) {
  
  		array_unshift( $r, $q );
  		return TokenizerUtils::flattenString( $r );
  	
  }
  private function a51($s, $t, $q) {
  
  		return TokenizerUtils::getAttrVal( $t, $this->startOffset() + strlen( $s ), $this->endOffset() - strlen( $q ) );
  	
  }
  private function a52($s, $t) {
  
  		return TokenizerUtils::getAttrVal( $t, $this->startOffset() + strlen( $s ), $this->endOffset() );
  	
  }
  private function a53($r) {
  
  		return TokenizerUtils::flattenString( $r );
  	
  }
  private function a54($al) {
   return $al; 
  }
  private function a55($he) {
   return $he; 
  }
  private function a56() {
  
  			$toks = TokenUtils::placeholder( " ", (object)[
  					'src' => ' ',
  					'tsr' => $this->tsrOffsets( 'start' ),
  					'isDisplayHack' => true
  				], (object)[ 'tsr' => $this->tsrOffsets( 'end' ), 'isDisplayHack' => true ]
  			);
  			$typeOf = $toks[0]->getAttribute( 'typeof' );
  			$toks[0]->setAttribute( 'typeof', 'mw:DisplaySpace ' . $typeOf );
  			return $toks;
  		
  }
  private function a57($bs) {
   return $bs; 
  }
  private function a58() {
   return $this->endOffset() === 0 && !$this->pipelineOffset; 
  }
  private function a59($rw, $sp, $c, $wl) {
  
  		return count( $wl ) === 1 && $wl[0] instanceof Token;
  	
  }
  private function a60($rw, $sp, $c, $wl) {
  
  		$link = $wl[0];
  		if ( $sp ) {
  			$rw .= $sp;
  		}
  		if ( $c ) {
  			$rw .= $c;
  		}
  		// Build a redirect token
  		$redirect = new SelfclosingTagTk( 'mw:redirect',
  			// Put 'href' into attributes so it gets template-expanded
  			[ KV::lookupKV( $link->attribs, 'href' ) ],
  			(object)[
  				'src' => $rw,
  				'tsr' => $this->tsrOffsets(),
  				'linkTk' => $link
  			]
  		);
  		return $redirect;
  	
  }
  private function a61($st, $tl) {
   return $tl; 
  }
  private function a62($st, $bt, $stl) {
   return array_merge( $bt, $stl ); 
  }
  private function a63($st, $bts) {
   return $bts; 
  }
  private function a64($st, $r) {
  
  		return array_merge( $st, $r );
  	
  }
  private function a65($s, $os, $so) {
   return array_merge( $os, $so ); 
  }
  private function a66($s, $s2, $bl) {
  
  		return array_merge( $s, $s2 ?: [], is_array( $bl ) ? $bl : [ $bl ] );
  	
  }
  private function a67($tag) {
   return $tag; 
  }
  private function a68($s1, $s2, $c) {
  
  		return array_merge( $s1, $s2, $c );
  	
  }
  private function a69(&$preproc, $t) {
  
  		$preproc = null;
  		return $t;
  	
  }
  private function a70($v) {
   return $v; 
  }
  private function a71($e) {
   return $e; 
  }
  private function a72() {
   return preg_match( '/\w/', $this->input[$this->endOffset() - 1] ?? '' ); 
  }
  private function a73($target) {
  
  			$res = [ new SelfclosingTagTk( 'urllink', [ new KV( 'href', $target ) ], (object)[ 'tsr' => $this->tsrOffsets() ] ) ];
  			return $res;
  		
  }
  private function a74($bs) {
  
  		if ( $this->siteConfig->isMagicWord( $bs ) ) {
  			return [
  				new SelfclosingTagTk( 'behavior-switch', [ new KV( 'word', $bs ) ],
  					(object)[ 'tsr' => $this->tsrOffsets(), 'src' => $bs, 'magicSrc' => $bs ]
  				)
  			];
  		} else {
  			return [ $bs ];
  		}
  	
  }
  private function a75($quotes) {
  
  		// sequences of four or more than five quotes are assumed to start
  		// with some number of plain-text apostrophes.
  		$plainticks = 0;
  		$result = [];
  		if ( strlen( $quotes ) === 4 ) {
  			$plainticks = 1;
  		} elseif ( strlen( $quotes ) > 5 ) {
  			$plainticks = strlen( $quotes ) - 5;
  		}
  		if ( $plainticks > 0 ) {
  			$result[] = substr( $quotes, 0, $plainticks );
  		}
  		// mw-quote token will be consumed in token transforms
  		$tsr = $this->tsrOffsets();
  		$tsr[0] += $plainticks;
  		$mwq = new SelfclosingTagTk( 'mw-quote',
  			[ new KV( 'value', substr( $quotes, $plainticks ) ) ],
  			(object)[ 'tsr' => $tsr ] );
  		if ( strlen( $quotes ) > 2 ) {
  			$mwq->addAttribute( 'preceding-2chars', substr( $this->input, $tsr[0] - 2, 2 ) );
  		}
  		$result[] = $mwq;
  		return $result;
  	
  }
  private function a76($rw) {
  
  			return preg_match( $this->env->getSiteConfig()->getMagicWordMatcher( 'redirect' ), $rw );
  		
  }
  private function a77($il, $sol_il) {
  
  		$il = $il[0];
  		$lname = strtolower( $il->getName() );
  		if ( !TokenizerUtils::isIncludeTag( $lname ) ) { return false;  }
  		// Preserve SOL where necessary (for onlyinclude and noinclude)
  		// Note that this only works because we encounter <*include*> tags in
  		// the toplevel content and we rely on the php preprocessor to expand
  		// templates, so we shouldn't ever be tokenizing inInclude.
  		// Last line should be empty (except for comments)
  		if ( $lname !== 'includeonly' && $sol_il && $il instanceof TagTk ) {
  			$dp = $il->dataAttribs;
  			$inclContent = substr( $dp->src, $dp->tagWidths[0],
  				strlen( $dp->src ) - $dp->tagWidths[ 1 ] - $dp->tagWidths[0] );
  			$nlpos = strrpos( $inclContent, "\n" );
  			$last = $nlpos === false ? $inclContent : substr( $inclContent, $nlpos + 1 );
  			if ( !preg_match( '/^(<!--([^-]|-(?!->))*-->)*$/', $last ) ) {
  				return false;
  			}
  		}
  		return true;
  	
  }
  private function a78($il, $sol_il) {
  
  		return $il;
  	
  }
  private function a79($s, $ill) {
   return $ill ?: []; 
  }
  private function a80($s, $ce) {
   return $ce || strlen( $s ) > 2; 
  }
  private function a81($s, $ce) {
   return $this->endOffset(); 
  }
  private function a82($s, $ce, $endTPos, $spc) {
  
  			$c = null;
  			$e = null;
  			$level = null;
  			if ( $ce ) {
  				$c = $ce[0];
  				$e = $ce[1];
  				$level = min( strlen( $s ), strlen( $e ) );
  			} else {
  				// split up equal signs into two equal parts, with at least
  				// one character in the middle.
  				$level = floor( ( strlen( $s ) - 1 ) / 2 );
  				$c = [ str_repeat( '=', strlen( $s ) - 2 * $level ) ];
  				$s = $e = str_repeat( '=', $level );
  			}
  			$level = min( 6, $level );
  			// convert surplus equals into text
  			if ( strlen( $s ) > $level ) {
  				$extras1 = substr( $s, 0, strlen( $s ) - $level );
  				if ( is_string( $c[0] ) ) {
  					$c[0] = $extras1 . $c[0];
  				} else {
  					array_unshift( $c, $extras1 );
  				}
  			}
  			if ( strlen( $e ) > $level ) {
  				$extras2 = substr( $e, 0, strlen( $e ) - $level );
  				$lastElem = $this->lastItem( $c );
  				if ( is_string( $lastElem ) ) {
  					$c[count( $c ) - 1] .= $extras2;
  				} else {
  					$c[] = $extras2;
  				}
  			}
  
  			$tsr = $this->tsrOffsets( 'start' );
  			$tsr[1] += $level;
  			// Match the old parser's behavior by (a) making headingIndex part of tokenizer
  			// state(don't reuse pipeline!) and (b) assigning the index when
  			// ==*== is tokenized, even if we're inside a template argument
  			// or other context which won't end up putting the heading
  			// on the output page.  T213468/T214538
  			$this->headingIndex++;
  			return array_merge(
  				[ new TagTk( 'h' . $level, [], (object)[
  					'tsr' => $tsr,
  					'tmp' => (object)[ 'headingIndex' => $this->headingIndex ]
  				] ) ],
  				$c,
  				[
  					new EndTagTk( 'h' . $level, [], (object)[ 'tsr' => [ $endTPos - $level, $endTPos ] ] ),
  					$spc
  				]
  			);
  		
  }
  private function a83($d) {
   return null; 
  }
  private function a84($d) {
   return true; 
  }
  private function a85($d, $lineContent) {
  
  		$dataAttribs = (object)[
  			'tsr' => $this->tsrOffsets(),
  			'lineContent' => $lineContent
  		];
  		if ( strlen( $d ) > 0 ) {
  			$dataAttribs->extra_dashes = strlen( $d );
  		}
  		return new SelfclosingTagTk( 'hr', [], $dataAttribs );
  	
  }
  private function a86($tl) {
  
  		return $tl;
  	
  }
  private function a87($end, $name, $extTag, $isBlock) {
  
  		if ( $extTag ) {
  			return $this->isExtTag( $name );
  		} else {
  			return $this->isXMLTag( $name, $isBlock );
  		}
  	
  }
  private function a88($end, $name, $extTag, $isBlock, $attribs, $selfclose) {
  
  		$lcName = strtolower( $name );
  
  		// Extension tags don't necessarily have the same semantics as html tags,
  		// so don't treat them as void elements.
  		$isVoidElt = Util::isVoidElement( $lcName ) && !$extTag;
  
  		// Support </br>
  		if ( $lcName === 'br' && $end ) {
  			$end = null;
  		}
  
  		$tsr = $this->tsrOffsets();
  		$tsr[0]--; // For "<" matched at the start of xmlish_tag rule
  		$res = TokenizerUtils::buildXMLTag( $name, $lcName, $attribs, $end, !!$selfclose || $isVoidElt, $tsr );
  
  		// change up data-attribs in one scenario
  		// void-elts that aren't self-closed ==> useful for accurate RT-ing
  		if ( !$selfclose && $isVoidElt ) {
  			$res->dataAttribs->selfClose = null;
  			$res->dataAttribs->noClose = true;
  		}
  
  		$met = $this->maybeExtensionTag( $res );
  		return ( is_array( $met ) ) ? $met : [ $met ];
  	
  }
  private function a89($sp) {
   return $this->endOffset(); 
  }
  private function a90($sp, $p, $c) {
  
  		return [
  			$sp,
  			new SelfclosingTagTk( 'meta', [ new KV( 'typeof', 'mw:EmptyLine' ) ], (object)[
  					'tokens' => TokenizerUtils::flattenIfArray( $c ),
  					'tsr' => [ $p, $this->endOffset() ]
  				]
  			)
  		];
  	
  }
  private function a91() {
  
  		// Use the sol flag only at the start of the input
  		// Flag should always be an actual boolean (not falsy or undefined)
  		$this->assert( is_bool( $this->options['sol'] ), 'sol should be boolean' );
  		return $this->endOffset() === 0 && $this->options['sol'];
  	
  }
  private function a92() {
  
  		return [];
  	
  }
  private function a93($p, $target) {
   return $this->endOffset(); 
  }
  private function a94($p, $target, $p0, $v) {
   return $this->endOffset(); 
  }
  private function a95($p, $target, $p0, $v, $p1) {
  
  				// empty argument
  				return [ 'tokens' => $v, 'srcOffsets' => [ $p0, $p1 ] ];
  			
  }
  private function a96($p, $target, $r) {
   return $r; 
  }
  private function a97($p, $target, $params) {
  
  		$kvs = [];
  
  		if ( $target === null ) {
  			$target = [ 'tokens' => '', 'srcOffsets' => [ $p, $p, $p, $p ] ];
  		}
  		// Insert target as first positional attribute, so that it can be
  		// generically expanded. The TemplateHandler then needs to shift it out
  		// again.
  		$kvs[] = new KV( TokenizerUtils::flattenIfArray( $target['tokens'] ), '', $target['srcOffsets'] );
  
  		foreach ( $params as $o ) {
  			$s = $o['srcOffsets'];
  			$kvs[] = new KV( '', TokenizerUtils::flattenIfArray( $o['tokens'] ), [ $s[ 0 ], $s[ 0 ], $s[ 0 ], $s[ 1 ] ] );
  		}
  
  		$obj = new SelfclosingTagTk( 'templatearg', $kvs, (object)[ 'tsr' => $this->tsrOffsets(), 'src' => $this->text() ] );
  		return $obj;
  	
  }
  private function a98($target) {
   return $this->endOffset(); 
  }
  private function a99($target, $p0, $v) {
   return $this->endOffset(); 
  }
  private function a100($target, $p0, $v, $p) {
  
  				// empty argument
  				return new KV( '', TokenizerUtils::flattenIfArray( $v ), [ $p0, $p0, $p0, $p ] );
  			
  }
  private function a101($target, $r) {
   return $r; 
  }
  private function a102($target, $params) {
  
  		// Insert target as first positional attribute, so that it can be
  		// generically expanded. The TemplateHandler then needs to shift it out
  		// again.
  		array_unshift( $params, new KV( TokenizerUtils::flattenIfArray( $target['tokens'] ), '', $target['srcOffsets'] ) );
  		$obj = new SelfclosingTagTk( 'template', $params, (object)[ 'tsr' => $this->tsrOffsets(), 'src' => $this->text() ] );
  		return $obj;
  	
  }
  private function a103($target, $tpos, $lcs) {
  
  		$pipeTrick = ( count( $lcs ) === 1 && $lcs[0]->v === null );
  		$textTokens = [];
  		if ( $target === null || $pipeTrick ) {
  			$textTokens[] = '[[';
  			if ( $target ) {
  				$textTokens[] = $target;
  			}
  			foreach ( $lcs as $a ) {
  				// a is a mw:maybeContent attribute
  				$textTokens[] = '|';
  				if ( $a->v !== null ) {
  					$textTokens[] = $a->v;
  				}
  			}
  			$textTokens[] = ']]';
  			return $textTokens;
  		}
  		$obj = new SelfclosingTagTk( 'wikilink' );
  		$hrefKV = new KV( 'href', $target );
  		$hrefKV->vsrc = substr( $this->input, $this->startOffset() + 2, $tpos - $this->startOffset() - 2 );
  		// XXX: Point to object with path, revision and input information
  		// obj.source = input;
  		$obj->attribs[] = $hrefKV;
  		$obj->attribs = array_merge( $obj->attribs, $lcs );
  		$obj->dataAttribs = (object)[
  			'tsr' => $this->tsrOffsets(),
  			'src' => $this->text()
  		];
  		return [ $obj ];
  	
  }
  private function a104(&$preproc) {
   $preproc =  null; return true; 
  }
  private function a105(&$preproc, $a) {
  
  		return $a;
  	
  }
  private function a106($extToken) {
   return $extToken[0]->getName() === 'extension'; 
  }
  private function a107($extToken) {
   return $extToken[0]; 
  }
  private function a108($proto, $addr, $rhe) {
  	return $rhe === '<' || $rhe === '>' || $rhe === "\u{A0}"; 
  }
  private function a109($proto, $addr, $path) {
  
  			// as in Parser.php::makeFreeExternalLink, we're going to
  			// yank trailing punctuation out of this match.
  			$url = TokenizerUtils::flattenStringlist( array_merge( [ $proto, $addr ], $path ) );
  			// only need to look at last element; HTML entities are strip-proof.
  			$last = $this->lastItem( $url );
  			$trim = 0;
  			if ( is_string( $last ) ) {
  				$strip = ',;\.:!?';
  				if ( array_search( '(', $path ) === false ) {
  					$strip .= ')';
  				}
  				$trim = strspn( strrev( $last ), $strip );
  				$url[ count( $url ) - 1 ] = substr( $last, 0, strlen( $last ) - $trim );
  			}
  			$url = TokenizerUtils::flattenStringlist( $url );
  			if ( count( $url ) === 1 && is_string( $url[0] ) && strlen( $url[0] ) <= strlen( $proto ) ) {
  				return null; // ensure we haven't stripped everything: T106945
  			}
  			$this->currPos -= $trim;
  			return $url;
  		
  }
  private function a110($r) {
   return $r !== null; 
  }
  private function a111($ref, $sp, $identifier) {
  
  		$base_urls = [
  			'RFC' => 'https://tools.ietf.org/html/rfc%s',
  			'PMID' => '//www.ncbi.nlm.nih.gov/pubmed/%s?dopt=Abstract'
  		];
  		return [
  			new SelfclosingTagTk( 'extlink', [
  					new KV( 'href', sprintf( $base_urls[ $ref ], $identifier ) ),
  					new KV( 'mw:content', TokenizerUtils::flattenString( [ $ref, $sp, $identifier ] ) ),
  					new KV( 'typeof', 'mw:ExtLink/' . $ref )
  				],
  				(object)[ 'stx' => 'magiclink', 'tsr' => $this->tsrOffsets() ]
  			)
  		];
  	
  }
  private function a112($sp, $s) {
   return $s; 
  }
  private function a113($sp, $isbn) {
  
  			// Convert isbn token-and-entity array to stripped string.
  			$stripped = '';
  			foreach ( TokenizerUtils::flattenStringlist( $isbn ) as $part ) {
  				if ( is_string( $part ) ) {
  					$stripped .= $part;
  				}
  			}
  			return strtoupper( preg_replace( '/[^\dX]/i', '', $stripped ) );
  		
  }
  private function a114($sp, $isbn, $isbncode) {
  
  		// ISBNs can only be 10 or 13 digits long (with a specific format)
  		return strlen( $isbncode ) === 10
  			|| ( strlen( $isbncode ) === 13 && preg_match( '/^97[89]/', $isbncode ) );
  	
  }
  private function a115($sp, $isbn, $isbncode) {
  
  		return [
  			new SelfclosingTagTk( 'extlink', [
  					new KV( 'href', 'Special:BookSources/' . $isbncode ),
  					new KV( 'mw:content', TokenizerUtils::flattenString( [ 'ISBN', $sp, $isbn ] ) ),
  					new KV( 'typeof', 'mw:WikiLink/ISBN' )
  				],
  				(object)[ 'stx' => 'magiclink', 'tsr' => $this->tsrOffsets() ]
  			)
  		];
  	
  }
  private function a116($lc) {
   return $lc; 
  }
  private function a117($bullets, $c) {
   return $this->endOffset(); 
  }
  private function a118($bullets, $c, $cpos, $d) {
  
  		// Leave bullets as an array -- list handler expects this
  		// TSR: +1 for the leading ";"
  		$numBullets = count( $bullets ) + 1;
  		$tsr = $this->tsrOffsets( 'start' );
  		$tsr[1] += $numBullets;
  		$li1Bullets = $bullets;
  		$li1Bullets[] = ';';
  		$li1 = new TagTk( 'listItem', [ new KV( 'bullets', $li1Bullets ) ], (object)[ 'tsr' => $tsr ] );
  		// TSR: -1 for the intermediate ":"
  		$li2Bullets = $bullets;
  		$li2Bullets[] = ':';
  		$li2 = new TagTk( 'listItem', [ new KV( 'bullets', $li2Bullets ) ],
  			(object)[ 'tsr' => [ $cpos - 1, $cpos ], 'stx' => 'row' ] );
  
  		return array_merge( [ $li1 ], $c ?: [], [ $li2 ], $d ?: [] );
  	
  }
  private function a119($bullets, $tbl, $line) {
  
  	// Leave bullets as an array -- list handler expects this
  	$tsr = $this->tsrOffsets( 'start' );
  	$tsr[1] += count( $bullets );
  	$li = new TagTk( 'listItem', [ new KV( 'bullets', $bullets ) ], (object)[ 'tsr' => $tsr ] );
  	return TokenizerUtils::flattenIfArray( [ $li, $tbl, $line ?: [] ] );
  
  }
  private function a120($bullets, $c) {
  
  		// Leave bullets as an array -- list handler expects this
  		$tsr = $this->tsrOffsets( 'start' );
  		$tsr[1] += count( $bullets );
  		$li = new TagTk( 'listItem', [ new KV( 'bullets', $bullets ) ], (object)[ 'tsr' => $tsr ] );
  		return array_merge( [ $li ], $c ?: [] );
  	
  }
  private function a121($spc) {
  
  		if ( strlen( $spc ) ) {
  			return [ $spc ];
  		} else {
  			return [];
  		}
  	
  }
  private function a122($sc, $startPos, $p, $b) {
  
  		$tblEnd = new EndTagTk( 'table', [], (object)[ 'tsr' => [ $startPos, $this->endOffset() ] ] );
  		if ( $p !== '|' ) {
  			// p+"<brace-char>" is triggering some bug in pegJS
  			// I cannot even use that expression in the comment!
  			$tblEnd->dataAttribs->endTagSrc = $p . $b;
  		}
  		array_push( $sc, $tblEnd );
  		return $sc;
  	
  }
  private function a123($tpt) {
  
  		return [ 'tokens' => $tpt, 'srcOffsets' => $this->tsrOffsets() ];
  	
  }
  private function a124($name) {
   return $this->endOffset(); 
  }
  private function a125($name, $kEndPos) {
   return $this->endOffset(); 
  }
  private function a126($name, $kEndPos, $vStartPos, $tpv) {
  
  			return [
  				'kEndPos' => $kEndPos,
  				'vStartPos' => $vStartPos,
  				'value' => $tpv ? $tpv['tokens'] : []
  			];
  		
  }
  private function a127($name, $val) {
  
  		if ( $val !== null ) {
  			if ( $val['value'] !== null ) {
  				return new KV( $name,
  					TokenizerUtils::flattenIfArray( $val['value'] ),
  					[ $this->startOffset(), $val['kEndPos'], $val['vStartPos'], $this->endOffset() ] );
  			} else {
  				return new KV( TokenizerUtils::flattenIfArray( $name ), '',
  					[ $this->startOffset(), $val['kEndPos'], $val['vStartPos'], $this->endOffset() ] );
  			}
  		} else {
  			return new KV( '', TokenizerUtils::flattenIfArray( $name ),
  				[ $this->startOffset(), $this->startOffset(), $this->startOffset(), $this->endOffset() ] );
  		}
  	
  }
  private function a128() {
  
  		return new KV( '', '',
  			[ $this->startOffset(), $this->startOffset(), $this->startOffset(), $this->endOffset() ] );
  	
  }
  private function a129($t, $wr) {
   return $wr; 
  }
  private function a130($r) {
  
  		return TokenizerUtils::flattenStringlist( $r );
  	
  }
  private function a131($startPos, $lt) {
  
  			$maybeContent = new KV( 'mw:maybeContent', $lt, [ $startPos, $this->endOffset() ] );
  			$maybeContent->vsrc = substr( $this->input, $startPos, $this->endOffset() - $startPos );
  			return $maybeContent;
  		
  }
  private function a132($he) {
   return is_array( $he ) && preg_match( '/^\u00A0$/', $he[ 1 ] ); 
  }
  private function a133() {
   return $this->startOffset(); 
  }
  private function a134($lv0) {
   return $this->env->langConverterEnabled(); 
  }
  private function a135($lv0, $ff) {
  
  			// if flags contains 'R', then don't treat ; or : specially inside.
  			if ( isset( $ff['flags'] ) ) {
  				$ff['raw'] = isset( $ff['flags']['R'] ) || isset( $ff['flags']['N'] );
  			} elseif ( $ff->variants ) {
  				$ff['raw'] = true;
  			}
  			return $ff;
  		
  }
  private function a136($lv0) {
   return !$this->env->langConverterEnabled(); 
  }
  private function a137($lv0) {
  
  			// if language converter not enabled, don't try to parse inside.
  			return [ 'raw' => true ];
  		
  }
  private function a138($lv0, $f) {
   return $f['raw']; 
  }
  private function a139($lv0, $f, $lv) {
   return [ [ 'text' => $lv ] ]; 
  }
  private function a140($lv0, $f) {
   return !$f['raw']; 
  }
  private function a141($lv0, $f, $lv) {
   return $lv; 
  }
  private function a142($lv0, $f, $ts) {
   return $this->endOffset(); 
  }
  private function a143($lv0, $f, $ts, $lv1) {
  
  		if ( !$this->env->langConverterEnabled() ) {
  			return [ '-{', $ts[0]['text']['tokens'], '}-' ];
  		}
  		$lvsrc = substr( $this->input, $lv0, $lv1 - $lv0 );
  		$attribs = [];
  
  		foreach ( $ts as &$t ) {
  			// move token strings into KV attributes so that they are
  			// properly expanded by early stages of the token pipeline
  			foreach ( [ 'text', 'from', 'to' ] as $fld ) {
  				if ( !isset( $t[$fld] ) ) {
  					continue;
  				}
  				$name = 'mw:lv' . count( $attribs );
  				// Note that AttributeExpander will expect the tokens array to be
  				// flattened.  We do that in lang_variant_text / lang_variant_nowiki
  				$attribs[] = new KV( $name, $t[$fld]['tokens'], $t[$fld]['srcOffsets'] );
  				$t[$fld] = $name;
  			}
  		}
  		unset( $t );
  
  		$flags = isset( $f['flags'] ) ? array_keys( $f['flags'] ) : [];
  		sort( $flags );
  		$variants = isset( $f['variants'] ) ? array_keys( $f['variants'] ) : [];
  		sort( $variants );
  
  		return [
  			new SelfclosingTagTk(
  				'language-variant',
  				$attribs,
  				(object)[
  					'tsr' => [ $lv0, $lv1 ],
  					'src' => $lvsrc,
  					'flags' => $flags,
  					'variants' => $flags,
  					'original' => $f['original'],
  					'flagSp' => $f['sp'],
  					'texts' => $ts
  				]
  			)
  		];
  	
  }
  private function a144($r, &$preproc) {
  
  		$preproc = null;
  		return $r;
  	
  }
  private function a145($ill) {
   return $ill; 
  }
  private function a146($p, $dashes) {
   $this->unreachable(); 
  }
  private function a147($p, $dashes, $a) {
   return $this->endOffset(); 
  }
  private function a148($p, $dashes, $a, $tagEndPos) {
  
  		$coms = TokenizerUtils::popComments( $a );
  		if ( $coms ) {
  			$tagEndPos = $coms['commentStartPos'];
  		}
  
  		$da = (object)[
  			'tsr' => [ $this->startOffset(), $tagEndPos ],
  			'startTagSrc' => $p . $dashes
  		];
  
  		// We rely on our tree builder to close the row as needed. This is
  		// needed to support building tables from fragment templates with
  		// individual cells or rows.
  		$trToken = new TagTk( 'tr', $a, $da );
  
  		return array_merge( [ $trToken ], $coms ? $coms['buf'] : [] );
  	
  }
  private function a149($p, $td) {
   return $this->endOffset(); 
  }
  private function a150($p, $td, $tagEndPos, $tds) {
  
  		// Avoid modifying a cached result
  		$td[0] = clone $td[0];
  		$da = $td[0]->dataAttribs = clone $td[0]->dataAttribs;
  
  		$da->tsr[0] -= strlen( $p ); // include "|"
  		if ( $p !== '|' ) {
  			// Variation from default
  			$da->startTagSrc = $p;
  		}
  		return array_merge( $td, $tds );
  	
  }
  private function a151($p, $args) {
   return $this->endOffset(); 
  }
  private function a152($p, $args, $tagEndPos, $c) {
  
  		return TokenizerUtils::buildTableTokens(
  			'caption', '|+', $args, [ $this->startOffset(), $tagEndPos ], $this->endOffset(), $c, true );
  	
  }
  private function a153($il) {
  
  		// il is guaranteed to be an array -- so, tu.flattenIfArray will
  		// always return an array
  		$r = TokenizerUtils::flattenIfArray( $il );
  		if ( count( $r ) === 1 && is_string( $r[0] ) ) {
  			$r = $r[0];
  		}
  		return $r;
  	
  }
  private function a154() {
   return ''; 
  }
  private function a155($tpt) {
  
  		return $tpt;
  	
  }
  private function a156($ff) {
   return $ff; 
  }
  private function a157($f) {
  
  		// Collect & separate flags and variants into a hashtable (by key) and ordered list
  		$flags = [];
  		$variants = [];
  		$flagList = [];
  		$flagSpace = [];
  		$variantList = [];
  		$variantSpace = [];
  		$useVariants = false;
  		if ( $f !== null ) {
  			// lang_variant_flags returns arrays in reverse order.
  			$spPtr = count( $f['sp'] ) - 1;
  			for ( $i = count( $f['flags'] ) - 1; $i >= 0; $i--) {
  				$item = $f['flags'][$i];
  				if ( isset( $item['flag'] ) ) {
  					$flagSpace[] = $f['sp'][$spPtr--];
  					$flags[$item['flag']] = true;
  					$flagList[] = $item['flag'];
  					$flagSpace[] = $f['sp'][$spPtr--];
  				}
  				if ( isset( $item['variant'] ) ) {
  					$variantSpace[] = $f['sp'][$spPtr--];
  					$variants[$item['variant']] = true;
  					$variantList[] = $item['variant'];
  					$variantSpace[] = $f['sp'][$spPtr--];
  				}
  			}
  			if ( $spPtr >= 0 ) {
  				// handle space after a trailing semicolon
  				$flagSpace[] = $f['sp'][$spPtr];
  				$variantSpace[] = $f['sp'][$spPtr];
  			}
  		}
  		// Parse flags (this logic is from core/languages/ConverterRule.php
  		// in the parseFlags() function)
  		if ( count( $flags ) === 0 && count( $variants ) === 0 ) {
  			$flags['$S'] = true;
  		} elseif ( isset( $flags['R'] ) ) {
  			$flags = [ 'R' => true ]; // remove other flags
  		} elseif ( isset( $flags['N'] ) ) {
  			$flags = [ 'N' => true ]; // remove other flags
  		} elseif ( isset( $flags['-'] ) ) {
  			$flags = [ '-' => true ]; // remove other flags
  		} elseif ( isset( $flags['T'] ) && count( $flags ) === 1 ) {
  			$flags['H'] = true;
  		} elseif ( isset( $flags['H'] ) ) {
  			// Replace A flag, and remove other flags except T and D
  			$nf = [ '$+' => true, 'H' => true ];
  			if ( isset( $flags['T'] ) ) { $nf['T'] = true; }
  			if ( isset( $flags['D'] ) ) { $nf['D'] = true; }
  			$flags = $nf;
  		} elseif ( count( $variants ) > 0 ) {
  			$useVariants = true;
  		} else {
  			if ( isset( $flags['A'] ) ) {
  				$flags['$+'] = true;
  				$flags['$S'] = true;
  			}
  			if ( isset( $flags['D'] ) ) {
  				unset( $flags['$S'] );
  			}
  		}
  		if ( $useVariants ) {
  			return [ 'variants' => $variants, 'original' => $variantList, 'sp' => $variantSpace ];
  		} else {
  			return [ 'flags' => $flags, 'original' => $flagList, 'sp' => $flagSpace ];
  		}
  	
  }
  private function a158($tokens) {
  
  		return [
  			'tokens' => TokenizerUtils::flattenStringlist( $tokens ),
  			'srcOffsets' => [ $this->startOffset(), $this->endOffset() ]
  		];
  	
  }
  private function a159($o, $oo) {
   return $oo; 
  }
  private function a160($o, $rest, $tr) {
  
  		array_unshift( $rest, $o );
  		if ( $tr ) {
  			$rest[] = [ 'semi' => true, 'sp' => $tr[1] ];
  		}
  		return $rest;
  	
  }
  private function a161($lvtext) {
   return [ [ 'text' => $lvtext ] ]; 
  }
  private function a162($thTag, $pp, $tht) {
  
  			// Avoid modifying a cached result
  			$tht[0] = clone $tht[0];
  			$da = $tht[0]->dataAttribs = clone $tht[0]->dataAttribs;
  
  			$da->stx = 'row';
  			$da->tsr[0] -= strlen( $pp ); // include "!!" or "||"
  
  			if ( $pp !== '!!' || ( isset( $da->startTagSrc ) && $da->startTagSrc !== $pp ) ) {
  				// Variation from default
  				$da->startTagSrc = $pp . ( isset( $da->startTagSrc ) ? substr( $da->startTagSrc, 1 ) : '' );
  			}
  			return $tht;
  		
  }
  private function a163($thTag, $thTags) {
  
  		$thTag[0] = clone $thTag[0];
  		$da = $thTag[0]->dataAttribs = clone $thTag[0]->dataAttribs;
  		$da->tsr[0]--; // include "!"
  		array_unshift( $thTags, $thTag );
  		return $thTags;
  	
  }
  private function a164($arg) {
   return $this->endOffset(); 
  }
  private function a165($arg, $tagEndPos, $td) {
  
  		return TokenizerUtils::buildTableTokens( 'td', '|', $arg,
  			[ $this->startOffset(), $tagEndPos ], $this->endOffset(), $td );
  	
  }
  private function a166($pp, $tdt) {
  
  			// Avoid modifying cached dataAttribs object
  			$tdt[0] = clone $tdt[0];
  			$da = $tdt[0]->dataAttribs = clone $tdt[0]->dataAttribs;
  
  			$da->stx = 'row';
  			$da->tsr[0] -= strlen( $pp ); // include "||"
  			if ( $pp !== '||' || ( isset( $da->startTagSrc ) && $da->startTagSrc !== $pp ) ) {
  				// Variation from default
  				$da->startTagSrc = $pp . ( isset( $da->startTagSrc ) ? substr( $da->startTagSrc, 1 ) : '' );
  			}
  			return $tdt;
  		
  }
  private function a167($b) {
  
  		return $b;
  	
  }
  private function a168($sp1, $f, $sp2, $more) {
  
  		$r = ( $more && $more[1] ) ? $more[1] : [ 'sp' => [], 'flags' => [] ];
  		// Note that sp and flags are in reverse order, since we're using
  		// right recursion and want to push instead of unshift.
  		$r['sp'][] = $sp2;
  		$r['sp'][] = $sp1;
  		$r['flags'][] = $f;
  		return $r;
  	
  }
  private function a169($sp) {
  
  		return [ 'sp' => [ $sp ], 'flags' => [] ];
  	
  }
  private function a170($sp1, $lang, $sp2, $sp3, $lvtext) {
  
  		return [
  			'twoway' => true,
  			'lang' => $lang,
  			'text' => $lvtext,
  			'sp' => [ $sp1, $sp2, $sp3 ]
  		];
  	
  }
  private function a171($sp1, $from, $sp2, $lang, $sp3, $sp4, $to) {
  
  		return [
  			'oneway' => true,
  			'from' => $from,
  			'lang' => $lang,
  			'to' => $to,
  			'sp' => [ $sp1, $sp2, $sp3, $sp4 ]
  		];
  	
  }
  private function a172($arg, $tagEndPos, &$th, $d) {
  
  			if ( $th !== false && strpos( $this->text(), "\n" ) !== false ) {
  				// There's been a newline. Remove the break and continue
  				// tokenizing nested_block_in_tables.
  				$th = false;
  			}
  			return $d;
  		
  }
  private function a173($arg, $tagEndPos, $c) {
  
  		return TokenizerUtils::buildTableTokens( 'th', '!', $arg,
  			[ $this->startOffset(), $tagEndPos ], $this->endOffset(), $c );
  	
  }
  private function a174($r) {
  
  		return $r;
  	
  }
  private function a175($f) {
   return [ 'flag' => $f ]; 
  }
  private function a176($v) {
   return [ 'variant' => $v ]; 
  }
  private function a177($b) {
   return [ 'bogus' => $b ]; /* bad flag */
  }
  private function a178($n, $sp) {
  
  		return [
  			'tokens' => [ $n ],
  			'srcOffsets' => [ $this->startOffset(), $this->endOffset() - strlen( $sp ) ]
  		];
  	
  }
  private function a179($tbl) {
  
  		return $tbl;
  	
  }
  private function a180($extToken) {
   return $extToken->getAttribute( 'name' ) === 'nowiki'; 
  }
  private function a181($extToken) {
   return $extToken; 
  }
  private function a182($extToken) {
  
  		$txt = Util::getExtArgInfo( $extToken )->dict->body->extsrc;
  		return Util::decodeWtEntities( $txt );
  	
  }

  // generated
  private function streamstart_async($silence, &$param_preproc) {
    while (true) {
      // start choice_1
      $r1 = $this->parsetlb($silence, $param_preproc);
      if ($r1!==self::$FAILED) {
        goto choice_1;
      }
      // start seq_1
      $p2 = $this->currPos;
      $r3 = [];
      $r4 = $this->parsenewlineToken($silence);
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        $r4 = $this->parsenewlineToken($silence);
      }
      // free $r4
      $this->savedPos = $this->currPos;
      $r4 = $this->a0();
      if ($r4) {
        $r4 = false;
      } else {
        $r4 = self::$FAILED;
        $this->currPos = $p2;
        $r1 = self::$FAILED;
        goto seq_1;
      }
      $r1 = [$r3,$r4];
      seq_1:
      // free $p2
      choice_1:
      if ($r1!==self::$FAILED) {
        yield $r1;
      } else {
        if ($this->currPos < $this->inputLength) {
          $this->fail(0);
          throw $this->buildParseException();
        }
        break;
      }
    }
  }
  private function parsestart($silence, &$param_preproc) {
    $key = implode(':', [282, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r5 = $this->discardtlb(true, $param_preproc);
    while ($r5 !== self::$FAILED) {
      $r5 = $this->discardtlb(true, $param_preproc);
    }
    // free $r5
    $r4 = true;
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r4
    $r5 = $this->discardnewlineToken(true);
    while ($r5 !== self::$FAILED) {
      $r5 = $this->discardnewlineToken(true);
    }
    // free $r5
    $r4 = true;
    if ($r4===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r4
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a1();
    } else {
      if (!$silence) {$this->fail(1);}
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_start_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [464, $this->currPos, $boolParams & 0x3bee, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = [];
    // start choice_1
    $r5 = $this->parsespace(true);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $r5 = $this->parsecomment(true);
    choice_1:
    while ($r5 !== self::$FAILED) {
      $r4[] = $r5;
      // start choice_2
      $r5 = $this->parsespace(true);
      if ($r5!==self::$FAILED) {
        goto choice_2;
      }
      $r5 = $this->parsecomment(true);
      choice_2:
    }
    // sc <- $r4
    // free $r5
    $p6 = $this->currPos;
    $r5 = '';
    // startPos <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a2($r4);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // b <- $r7
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r7 = "{";
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r8 = $this->parsepipe(true);
    // p <- $r8
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_3
    $r9 = $this->parsetable_attributes(true, $boolParams & ~0x10, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_3;
    }
    $this->savedPos = $this->currPos;
    $r9 = $this->a3($r4, $r5, $r7, $r8);
    if ($r9) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
    }
    choice_3:
    // ta <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p11 = $this->currPos;
    $r10 = '';
    // tsEndPos <- $r10
    if ($r10!==self::$FAILED) {
      $this->savedPos = $p11;
      $r10 = $this->a4($r4, $r5, $r7, $r8, $r9);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r12 = [];
    $r13 = $this->parsespace(true);
    while ($r13 !== self::$FAILED) {
      $r12[] = $r13;
      $r13 = $this->parsespace(true);
    }
    // s2 <- $r12
    // free $r13
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a5($r4, $r5, $r7, $r8, $r9, $r10, $r12);
    } else {
      if (!$silence) {$this->fail(2);}
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseurl($silence, &$param_preproc) {
    $key = implode(':', [338, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parseurl_protocol($silence);
    // proto <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    $r5 = $this->parseurladdr($silence);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $r5 = '';
    choice_1:
    // addr <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = [];
    // start choice_2
    $p8 = $this->currPos;
    // start seq_2
    $p9 = $this->currPos;
    $p10 = $this->currPos;
    $r11 = $this->discardinline_breaks(true, 0x0, 0, $param_preproc, self::newRef(null));
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p10;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $p10
    $r12 = $this->parseno_punctuation_char($silence);
    // c <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a6($r4, $r5, $r12);
      goto choice_2;
    }
    // free $p9
    $p9 = $this->currPos;
    // s <- $r13
    if (strspn($this->input, ".:,'", $this->currPos, 1) !== 0) {
      $r13 = $this->input[$this->currPos++];
    } else {
      $r13 = self::$FAILED;
      if (!$silence) {$this->fail(3);}
    }
    $r7 = $r13;
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p9;
      $r7 = $this->a7($r4, $r5, $r13);
      goto choice_2;
    }
    $r7 = $this->parsecomment($silence);
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    $r7 = $this->parsetplarg_or_template($silence, 0x0, 0, self::newRef(null), $param_preproc);
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    $p10 = $this->currPos;
    // start seq_3
    $p14 = $this->currPos;
    $p15 = $this->currPos;
    // start seq_4
    $p17 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r18 = "&";
    } else {
      $r18 = self::$FAILED;
      $r16 = self::$FAILED;
      goto seq_4;
    }
    // start choice_3
    // start seq_5
    $p20 = $this->currPos;
    $r21 = $this->input[$this->currPos] ?? '';
    if ($r21 === "l" || $r21 === "L") {
      $this->currPos++;
    } else {
      $r21 = self::$FAILED;
      $r19 = self::$FAILED;
      goto seq_5;
    }
    $r22 = $this->input[$this->currPos] ?? '';
    if ($r22 === "t" || $r22 === "T") {
      $this->currPos++;
    } else {
      $r22 = self::$FAILED;
      $this->currPos = $p20;
      $r19 = self::$FAILED;
      goto seq_5;
    }
    $r19 = true;
    seq_5:
    if ($r19!==self::$FAILED) {
      goto choice_3;
    }
    // free $p20
    // start seq_6
    $p20 = $this->currPos;
    $r23 = $this->input[$this->currPos] ?? '';
    if ($r23 === "g" || $r23 === "G") {
      $this->currPos++;
    } else {
      $r23 = self::$FAILED;
      $r19 = self::$FAILED;
      goto seq_6;
    }
    $r24 = $this->input[$this->currPos] ?? '';
    if ($r24 === "t" || $r24 === "T") {
      $this->currPos++;
    } else {
      $r24 = self::$FAILED;
      $this->currPos = $p20;
      $r19 = self::$FAILED;
      goto seq_6;
    }
    $r19 = true;
    seq_6:
    // free $p20
    choice_3:
    if ($r19===self::$FAILED) {
      $this->currPos = $p17;
      $r16 = self::$FAILED;
      goto seq_4;
    }
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r25 = ";";
    } else {
      $r25 = self::$FAILED;
      $this->currPos = $p17;
      $r16 = self::$FAILED;
      goto seq_4;
    }
    $r16 = true;
    seq_4:
    // free $p17
    if ($r16 === self::$FAILED) {
      $r16 = false;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p15;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    // free $p15
    // start choice_4
    $p15 = $this->currPos;
    // start seq_7
    $p17 = $this->currPos;
    $p20 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r27 = "&";
      $r27 = false;
      $this->currPos = $p20;
    } else {
      $r27 = self::$FAILED;
      $r26 = self::$FAILED;
      goto seq_7;
    }
    // free $p20
    $r28 = $this->parsehtmlentity($silence);
    // he <- $r28
    if ($r28===self::$FAILED) {
      $this->currPos = $p17;
      $r26 = self::$FAILED;
      goto seq_7;
    }
    $r26 = true;
    seq_7:
    if ($r26!==self::$FAILED) {
      $this->savedPos = $p15;
      $r26 = $this->a8($r4, $r5, $r28);
      goto choice_4;
    }
    // free $p17
    if (strspn($this->input, "&%{", $this->currPos, 1) !== 0) {
      $r26 = $this->input[$this->currPos++];
    } else {
      $r26 = self::$FAILED;
      if (!$silence) {$this->fail(4);}
    }
    choice_4:
    // r <- $r26
    if ($r26===self::$FAILED) {
      $this->currPos = $p14;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    $r7 = true;
    seq_3:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p10;
      $r7 = $this->a9($r4, $r5, $r26);
    }
    // free $p14
    choice_2:
    while ($r7 !== self::$FAILED) {
      $r6[] = $r7;
      // start choice_5
      $p14 = $this->currPos;
      // start seq_8
      $p17 = $this->currPos;
      $p20 = $this->currPos;
      $r29 = $this->discardinline_breaks(true, 0x0, 0, $param_preproc, self::newRef(null));
      if ($r29 === self::$FAILED) {
        $r29 = false;
      } else {
        $r29 = self::$FAILED;
        $this->currPos = $p20;
        $r7 = self::$FAILED;
        goto seq_8;
      }
      // free $p20
      $r30 = $this->parseno_punctuation_char($silence);
      // c <- $r30
      if ($r30===self::$FAILED) {
        $this->currPos = $p17;
        $r7 = self::$FAILED;
        goto seq_8;
      }
      $r7 = true;
      seq_8:
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p14;
        $r7 = $this->a6($r4, $r5, $r30);
        goto choice_5;
      }
      // free $p17
      $p17 = $this->currPos;
      // s <- $r31
      if (strspn($this->input, ".:,'", $this->currPos, 1) !== 0) {
        $r31 = $this->input[$this->currPos++];
      } else {
        $r31 = self::$FAILED;
        if (!$silence) {$this->fail(3);}
      }
      $r7 = $r31;
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p17;
        $r7 = $this->a7($r4, $r5, $r31);
        goto choice_5;
      }
      $r7 = $this->parsecomment($silence);
      if ($r7!==self::$FAILED) {
        goto choice_5;
      }
      $r7 = $this->parsetplarg_or_template($silence, 0x0, 0, self::newRef(null), $param_preproc);
      if ($r7!==self::$FAILED) {
        goto choice_5;
      }
      $p20 = $this->currPos;
      // start seq_9
      $p32 = $this->currPos;
      $p33 = $this->currPos;
      // start seq_10
      $p35 = $this->currPos;
      if (($this->input[$this->currPos] ?? null) === "&") {
        $this->currPos++;
        $r36 = "&";
      } else {
        $r36 = self::$FAILED;
        $r34 = self::$FAILED;
        goto seq_10;
      }
      // start choice_6
      // start seq_11
      $p38 = $this->currPos;
      $r39 = $this->input[$this->currPos] ?? '';
      if ($r39 === "l" || $r39 === "L") {
        $this->currPos++;
      } else {
        $r39 = self::$FAILED;
        $r37 = self::$FAILED;
        goto seq_11;
      }
      $r40 = $this->input[$this->currPos] ?? '';
      if ($r40 === "t" || $r40 === "T") {
        $this->currPos++;
      } else {
        $r40 = self::$FAILED;
        $this->currPos = $p38;
        $r37 = self::$FAILED;
        goto seq_11;
      }
      $r37 = true;
      seq_11:
      if ($r37!==self::$FAILED) {
        goto choice_6;
      }
      // free $p38
      // start seq_12
      $p38 = $this->currPos;
      $r41 = $this->input[$this->currPos] ?? '';
      if ($r41 === "g" || $r41 === "G") {
        $this->currPos++;
      } else {
        $r41 = self::$FAILED;
        $r37 = self::$FAILED;
        goto seq_12;
      }
      $r42 = $this->input[$this->currPos] ?? '';
      if ($r42 === "t" || $r42 === "T") {
        $this->currPos++;
      } else {
        $r42 = self::$FAILED;
        $this->currPos = $p38;
        $r37 = self::$FAILED;
        goto seq_12;
      }
      $r37 = true;
      seq_12:
      // free $p38
      choice_6:
      if ($r37===self::$FAILED) {
        $this->currPos = $p35;
        $r34 = self::$FAILED;
        goto seq_10;
      }
      if (($this->input[$this->currPos] ?? null) === ";") {
        $this->currPos++;
        $r43 = ";";
      } else {
        $r43 = self::$FAILED;
        $this->currPos = $p35;
        $r34 = self::$FAILED;
        goto seq_10;
      }
      $r34 = true;
      seq_10:
      // free $p35
      if ($r34 === self::$FAILED) {
        $r34 = false;
      } else {
        $r34 = self::$FAILED;
        $this->currPos = $p33;
        $r7 = self::$FAILED;
        goto seq_9;
      }
      // free $p33
      // start choice_7
      $p33 = $this->currPos;
      // start seq_13
      $p35 = $this->currPos;
      $p38 = $this->currPos;
      if (($this->input[$this->currPos] ?? null) === "&") {
        $this->currPos++;
        $r45 = "&";
        $r45 = false;
        $this->currPos = $p38;
      } else {
        $r45 = self::$FAILED;
        $r44 = self::$FAILED;
        goto seq_13;
      }
      // free $p38
      $r46 = $this->parsehtmlentity($silence);
      // he <- $r46
      if ($r46===self::$FAILED) {
        $this->currPos = $p35;
        $r44 = self::$FAILED;
        goto seq_13;
      }
      $r44 = true;
      seq_13:
      if ($r44!==self::$FAILED) {
        $this->savedPos = $p33;
        $r44 = $this->a8($r4, $r5, $r46);
        goto choice_7;
      }
      // free $p35
      if (strspn($this->input, "&%{", $this->currPos, 1) !== 0) {
        $r44 = $this->input[$this->currPos++];
      } else {
        $r44 = self::$FAILED;
        if (!$silence) {$this->fail(4);}
      }
      choice_7:
      // r <- $r44
      if ($r44===self::$FAILED) {
        $this->currPos = $p32;
        $r7 = self::$FAILED;
        goto seq_9;
      }
      $r7 = true;
      seq_9:
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p20;
        $r7 = $this->a9($r4, $r5, $r44);
      }
      // free $p32
      choice_5:
    }
    // path <- $r6
    // free $r7
    $this->savedPos = $this->currPos;
    $r7 = $this->a10($r4, $r5, $r6);
    if ($r7) {
      $r7 = false;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a11($r4, $r5, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parserow_syntax_table_args($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [484, $this->currPos, $boolParams & 0x3bbe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsetable_attributes($silence, $boolParams | 0x40, $param_templatedepth, $param_preproc, $param_th);
    // as <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parseoptional_spaces($silence);
    // s <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsepipe($silence);
    // p <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p7 = $this->currPos;
    $r8 = $this->discardpipe(true);
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p7;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a12($r4, $r5, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_attributes($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [288, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = [];
    // start choice_1
    $r2 = $this->parsetable_attribute(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r2!==self::$FAILED) {
      goto choice_1;
    }
    $p3 = $this->currPos;
    // start seq_1
    $p4 = $this->currPos;
    $r5 = $this->discardoptionalSpaceToken(true);
    if ($r5===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsebroken_table_attribute_name_char(true);
    // b <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p4;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p3;
      $r2 = $this->a13($r6);
    }
    // free $p4
    choice_1:
    while ($r2 !== self::$FAILED) {
      $r1[] = $r2;
      // start choice_2
      $r2 = $this->parsetable_attribute(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r2!==self::$FAILED) {
        goto choice_2;
      }
      $p4 = $this->currPos;
      // start seq_2
      $p7 = $this->currPos;
      $r8 = $this->discardoptionalSpaceToken(true);
      if ($r8===self::$FAILED) {
        $r2 = self::$FAILED;
        goto seq_2;
      }
      $r9 = $this->parsebroken_table_attribute_name_char(true);
      // b <- $r9
      if ($r9===self::$FAILED) {
        $this->currPos = $p7;
        $r2 = self::$FAILED;
        goto seq_2;
      }
      $r2 = true;
      seq_2:
      if ($r2!==self::$FAILED) {
        $this->savedPos = $p4;
        $r2 = $this->a13($r9);
      }
      // free $p7
      choice_2:
    }
    // free $r2
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsegeneric_newline_attributes($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [286, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = [];
    $r2 = $this->parsegeneric_newline_attribute(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    while ($r2 !== self::$FAILED) {
      $r1[] = $r2;
      $r2 = $this->parsegeneric_newline_attribute(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    }
    // free $r2
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetplarg_or_template_or_bust($silence, &$param_preproc) {
    $key = implode(':', [348, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start choice_1
    $r4 = $this->parsetplarg_or_template($silence, 0x0, 0, self::newRef(null), $param_preproc);
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    if ($this->currPos < $this->inputLength) {
      $r4 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r4 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
    }
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_2
        $r4 = $this->parsetplarg_or_template($silence, 0x0, 0, self::newRef(null), $param_preproc);
        if ($r4!==self::$FAILED) {
          goto choice_2;
        }
        if ($this->currPos < $this->inputLength) {
          $r4 = self::consumeChar($this->input, $this->currPos);;
        } else {
          $r4 = self::$FAILED;
          if (!$silence) {$this->fail(7);}
        }
        choice_2:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a14($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseextlink($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [328, $this->currPos, $boolParams & 0x19fe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (!(/*extlink*/($boolParams & 0x4) !== 0)) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r8 = "[";
    } else {
      $r8 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    // start seq_3
    $p10 = $this->currPos;
    $r11 = $this->parseurl_protocol(true);
    if ($r11===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_3;
    }
    $r12 = $this->parseurladdr(true);
    if ($r12===self::$FAILED) {
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    $r9 = [$r11,$r12];
    seq_3:
    if ($r9!==self::$FAILED) {
      goto choice_1;
    }
    // free $p10
    $r9 = '';
    choice_1:
    // addr <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // start choice_2
    $r13 = $this->parseextlink_preprocessor_text(true, $boolParams | 0x4, $param_templatedepth, $param_preproc, $param_th);
    if ($r13!==self::$FAILED) {
      goto choice_2;
    }
    $r13 = '';
    choice_2:
    // target <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $this->savedPos = $this->currPos;
    $r14 = $this->a15($r9, $r13);
    if ($r14) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $p10 = $this->currPos;
    // start choice_3
    $r16 = $this->discardspace(true);
    if ($r16!==self::$FAILED) {
      goto choice_3;
    }
    $r16 = $this->discardunispace(true);
    choice_3:
    while ($r16 !== self::$FAILED) {
      // start choice_4
      $r16 = $this->discardspace(true);
      if ($r16!==self::$FAILED) {
        goto choice_4;
      }
      $r16 = $this->discardunispace(true);
      choice_4:
    }
    // free $r16
    $r15 = true;
    // sp <- $r15
    if ($r15!==self::$FAILED) {
      $r15 = substr($this->input, $p10, $this->currPos - $p10);
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p10
    $p10 = $this->currPos;
    $r16 = '';
    // targetOff <- $r16
    if ($r16!==self::$FAILED) {
      $this->savedPos = $p10;
      $r16 = $this->a16($r9, $r13, $r15);
    } else {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r17 = $this->parseinlineline(true, $boolParams | 0x4, $param_templatedepth, $param_preproc, $param_th);
    if ($r17===self::$FAILED) {
      $r17 = null;
    }
    // content <- $r17
    if (($this->input[$this->currPos] ?? null) === "]") {
      $this->currPos++;
      $r18 = "]";
    } else {
      $r18 = self::$FAILED;
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    // r <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a17($r9, $r13, $r15, $r16, $r17);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a18($r5);
    } else {
      if (!$silence) {$this->fail(8);}
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetlb($silence, &$param_preproc) {
    $key = implode(':', [294, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    $r5 = $this->discardeof(true);
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r6 = $this->parseblock(true, 0x0, 0, self::newRef(null), $param_preproc);
    // b <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a19($r6);
    } else {
      if (!$silence) {$this->fail(9);}
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsenewlineToken($silence) {
    $key = implode(':', [534, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $r1 = $this->discardnewline($silence);
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a20();
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardtlb($silence, &$param_preproc) {
    $key = implode(':', [295, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    $r5 = $this->discardeof(true);
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r6 = $this->parseblock(true, 0x0, 0, self::newRef(null), $param_preproc);
    // b <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a19($r6);
    } else {
      if (!$silence) {$this->fail(9);}
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardnewlineToken($silence) {
    $key = implode(':', [535, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $r1 = $this->discardnewline($silence);
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a20();
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsespace($silence) {
    $key = implode(':', [498, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $r1 = $this->input[$this->currPos] ?? '';
    if ($r1 === " " || $r1 === "\x09") {
      $this->currPos++;
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(10);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsecomment($silence) {
    $key = implode(':', [320, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "<!--", $this->currPos, 4, false) === 0) {
      $r4 = "<!--";
      $this->currPos += 4;
    } else {
      if (!$silence) {$this->fail(11);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $p9 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r10 = "-->";
      $this->currPos += 3;
    } else {
      $r10 = self::$FAILED;
    }
    if ($r10 === self::$FAILED) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    if ($this->currPos < $this->inputLength) {
      $r11 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
      $this->currPos = $p8;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    // free $p8
    while ($r7 !== self::$FAILED) {
      // start seq_3
      $p8 = $this->currPos;
      $p9 = $this->currPos;
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
        $r12 = "-->";
        $this->currPos += 3;
      } else {
        $r12 = self::$FAILED;
      }
      if ($r12 === self::$FAILED) {
        $r12 = false;
      } else {
        $r12 = self::$FAILED;
        $this->currPos = $p9;
        $r7 = self::$FAILED;
        goto seq_3;
      }
      // free $p9
      if ($this->currPos < $this->inputLength) {
        $r13 = self::consumeChar($this->input, $this->currPos);;
      } else {
        $r13 = self::$FAILED;
        if (!$silence) {$this->fail(7);}
        $this->currPos = $p8;
        $r7 = self::$FAILED;
        goto seq_3;
      }
      $r7 = true;
      seq_3:
      // free $p8
    }
    // free $r7
    $r5 = true;
    // c <- $r5
    if ($r5!==self::$FAILED) {
      $r5 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r7 = "-->";
      $this->currPos += 3;
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(12);}
      $r7 = self::$FAILED;
    }
    $r7 = $this->discardeof($silence);
    choice_1:
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a21($r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsepipe($silence) {
    $key = implode(':', [560, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r1 = "|";
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(13);}
      $r1 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r1 = "{{!}}";
      $this->currPos += 5;
    } else {
      if (!$silence) {$this->fail(14);}
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseurl_protocol($silence) {
    $key = implode(':', [334, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
      $r4 = "//";
      $this->currPos += 2;
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(15);}
      $r4 = self::$FAILED;
    }
    // start seq_2
    $p6 = $this->currPos;
    $r7 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[A-Za-z]/", $r7)) {
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) {$this->fail(16);}
      $r4 = self::$FAILED;
      goto seq_2;
    }
    $r9 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[\\-A-Za-z0-9+.]/", $r9)) {
      $this->currPos++;
    } else {
      $r9 = self::$FAILED;
      if (!$silence) {$this->fail(17);}
    }
    while ($r9 !== self::$FAILED) {
      $r9 = $this->input[$this->currPos] ?? '';
      if (preg_match("/^[\\-A-Za-z0-9+.]/", $r9)) {
        $this->currPos++;
      } else {
        $r9 = self::$FAILED;
        if (!$silence) {$this->fail(17);}
      }
    }
    // free $r9
    $r8 = true;
    if ($r8===self::$FAILED) {
      $this->currPos = $p6;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    // free $r8
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r8 = ":";
    } else {
      if (!$silence) {$this->fail(18);}
      $r8 = self::$FAILED;
      $this->currPos = $p6;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
      $r9 = "//";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(15);}
      $r9 = self::$FAILED;
      $r9 = null;
    }
    $r4 = true;
    seq_2:
    // free $p6
    choice_1:
    // p <- $r4
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    $this->savedPos = $this->currPos;
    $r10 = $this->a22($r4);
    if ($r10) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a23($r4);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseurladdr($silence) {
    $key = implode(':', [342, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r4 = "[";
    } else {
      if (!$silence) {$this->fail(19);}
      $r4 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[0-9A-Fa-f:.]/", $r6)) {
      $this->currPos++;
      $r5 = true;
      while ($r6 !== self::$FAILED) {
        $r6 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[0-9A-Fa-f:.]/", $r6)) {
          $this->currPos++;
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(20);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(20);}
      $r5 = self::$FAILED;
    }
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $r6
    if (($this->input[$this->currPos] ?? null) === "]") {
      $this->currPos++;
      $r6 = "]";
    } else {
      if (!$silence) {$this->fail(21);}
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $p3
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function discardinline_breaks($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [313, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start seq_1
    $p1 = $this->currPos;
    $p3 = $this->currPos;
    if (strspn($this->input, "=|!{}:;\x0d\x0a[]-", $this->currPos, 1) !== 0) {
      $r4 = $this->input[$this->currPos++];
      $r4 = false;
      $this->currPos = $p3;
    } else {
      $r4 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $p3
    // start seq_2
    $p3 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r6 = $this->a24(/*extTag*/($boolParams & 0x800) !== 0, /*h*/($boolParams & 0x2) !== 0, /*extlink*/($boolParams & 0x4) !== 0, $param_templatedepth, $param_preproc, /*equal*/($boolParams & 0x8) !== 0, /*table*/($boolParams & 0x10) !== 0, /*templateArg*/($boolParams & 0x20) !== 0, /*tableCellArg*/($boolParams & 0x40) !== 0, /*semicolon*/($boolParams & 0x80) !== 0, /*arrow*/($boolParams & 0x100) !== 0, /*linkdesc*/($boolParams & 0x200) !== 0, /*colon*/($boolParams & 0x1000) !== 0, $param_th);
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5===self::$FAILED) {
      $this->currPos = $p1;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $r5,$p3
    $r2 = true;
    seq_1:
    // free $r2,$p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parseno_punctuation_char($silence) {
    $key = implode(':', [336, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $r1 = self::charAt($this->input, $this->currPos);
    if (preg_match("/^[^ :\\]\\[\\x0d\\x0a\"'<>\\x00- \\x7f,.&%\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}{]/u", $r1)) {
      $this->currPos += strlen($r1);
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(22);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetplarg_or_template($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [344, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r5 = "{{";
      $this->currPos += 2;
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r5 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $this->savedPos = $this->currPos;
    $r6 = $this->a25($param_templatedepth);
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsetplarg_or_template_guarded($silence, $boolParams, $param_templatedepth + 1, $param_th, $param_preproc);
    // t <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a26($param_templatedepth, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsehtmlentity($silence) {
    $key = implode(':', [492, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $r3 = $this->parseraw_htmlentity($silence);
    // cc <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a27($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseoptional_spaces($silence) {
    $key = implode(':', [496, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    $r3 = $this->input[$this->currPos] ?? '';
    if ($r3 === " " || $r3 === "\x09") {
      $this->currPos++;
    } else {
      $r3 = self::$FAILED;
      if (!$silence) {$this->fail(10);}
    }
    while ($r3 !== self::$FAILED) {
      $r3 = $this->input[$this->currPos] ?? '';
      if ($r3 === " " || $r3 === "\x09") {
        $this->currPos++;
      } else {
        $r3 = self::$FAILED;
        if (!$silence) {$this->fail(10);}
      }
    }
    // free $r3
    $r2 = true;
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function discardpipe($silence) {
    $key = implode(':', [561, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r1 = "|";
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(13);}
      $r1 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r1 = "{{!}}";
      $this->currPos += 5;
    } else {
      if (!$silence) {$this->fail(14);}
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_attribute($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [430, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parseoptionalSpaceToken($silence);
    // s <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r5 = '';
    // namePos0 <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a28($r4);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsetable_attribute_name($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // name <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p9 = $this->currPos;
    $r8 = '';
    // namePos <- $r8
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a29($r4, $r5, $r7);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p11 = $this->currPos;
    // start seq_2
    $p12 = $this->currPos;
    $r13 = $this->discardoptionalSpaceToken($silence);
    if ($r13===self::$FAILED) {
      $r10 = self::$FAILED;
      goto seq_2;
    }
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r14 = "=";
    } else {
      if (!$silence) {$this->fail(23);}
      $r14 = self::$FAILED;
      $this->currPos = $p12;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    $r15 = $this->parsetable_att_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r15===self::$FAILED) {
      $r15 = null;
    }
    // v <- $r15
    $r10 = true;
    seq_2:
    if ($r10!==self::$FAILED) {
      $this->savedPos = $p11;
      $r10 = $this->a30($r4, $r5, $r7, $r8, $r15);
    } else {
      $r10 = null;
    }
    // free $p12
    // vd <- $r10
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a31($r4, $r5, $r7, $r8, $r10);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardoptionalSpaceToken($silence) {
    $key = implode(':', [501, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $r3 = $this->parseoptional_spaces($silence);
    // s <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a32($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsebroken_table_attribute_name_char($silence) {
    $key = implode(':', [436, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // c <- $r3
    if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
      $r3 = $this->input[$this->currPos++];
    } else {
      $r3 = self::$FAILED;
      if (!$silence) {$this->fail(24);}
    }
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a33($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsegeneric_newline_attribute($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [428, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r5 = $this->discardspace_or_newline_or_solidus($silence);
    while ($r5 !== self::$FAILED) {
      $r5 = $this->discardspace_or_newline_or_solidus($silence);
    }
    // free $r5
    $r4 = true;
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r4
    $p6 = $this->currPos;
    $r4 = '';
    // namePos0 <- $r4
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p6;
      $r4 = $this->a34();
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsegeneric_attribute_name($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // name <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p8 = $this->currPos;
    $r7 = '';
    // namePos <- $r7
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a35($r4, $r5);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p10 = $this->currPos;
    // start seq_2
    $p11 = $this->currPos;
    $r13 = $this->discardspace_or_newline($silence);
    while ($r13 !== self::$FAILED) {
      $r13 = $this->discardspace_or_newline($silence);
    }
    // free $r13
    $r12 = true;
    if ($r12===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_2;
    }
    // free $r12
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r12 = "=";
    } else {
      if (!$silence) {$this->fail(23);}
      $r12 = self::$FAILED;
      $this->currPos = $p11;
      $r9 = self::$FAILED;
      goto seq_2;
    }
    $r13 = $this->parsegeneric_att_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r13===self::$FAILED) {
      $r13 = null;
    }
    // v <- $r13
    $r9 = true;
    seq_2:
    if ($r9!==self::$FAILED) {
      $this->savedPos = $p10;
      $r9 = $this->a36($r4, $r5, $r7, $r13);
    } else {
      $r9 = null;
    }
    // free $p11
    // vd <- $r9
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a37($r4, $r5, $r7, $r9);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseextlink_preprocessor_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [544, $this->currPos, $boolParams & 0x19fe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = $this->parseextlink_preprocessor_text_parameterized($silence, $boolParams & ~0x200, $param_templatedepth, $param_preproc, $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardspace($silence) {
    $key = implode(':', [499, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $r1 = $this->input[$this->currPos] ?? '';
    if ($r1 === " " || $r1 === "\x09") {
      $this->currPos++;
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(10);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardunispace($silence) {
    $key = implode(':', [507, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $r1 = self::charAt($this->input, $this->currPos);
    if (preg_match("/^[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/u", $r1)) {
      $this->currPos += strlen($r1);
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(25);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseinlineline($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [314, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $r4 = $this->parseurltext($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    $p5 = $this->currPos;
    // start seq_1
    $p6 = $this->currPos;
    $p7 = $this->currPos;
    $r8 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    // start choice_2
    $r9 = $this->parseinline_element($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_2;
    }
    $r9 = self::charAt($this->input, $this->currPos);
    if ($r9 !== '' && !($r9 === "\x0d" || $r9 === "\x0a")) {
      $this->currPos += strlen($r9);
    } else {
      $r9 = self::$FAILED;
      if (!$silence) {$this->fail(26);}
    }
    choice_2:
    // r <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p6;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a18($r9);
    }
    // free $p6
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_3
        $r4 = $this->parseurltext($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r4!==self::$FAILED) {
          goto choice_3;
        }
        $p6 = $this->currPos;
        // start seq_2
        $p7 = $this->currPos;
        $p10 = $this->currPos;
        $r11 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r11 === self::$FAILED) {
          $r11 = false;
        } else {
          $r11 = self::$FAILED;
          $this->currPos = $p10;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        // free $p10
        // start choice_4
        $r12 = $this->parseinline_element($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r12!==self::$FAILED) {
          goto choice_4;
        }
        $r12 = self::charAt($this->input, $this->currPos);
        if ($r12 !== '' && !($r12 === "\x0d" || $r12 === "\x0a")) {
          $this->currPos += strlen($r12);
        } else {
          $r12 = self::$FAILED;
          if (!$silence) {$this->fail(26);}
        }
        choice_4:
        // r <- $r12
        if ($r12===self::$FAILED) {
          $this->currPos = $p7;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        $r4 = true;
        seq_2:
        if ($r4!==self::$FAILED) {
          $this->savedPos = $p6;
          $r4 = $this->a18($r12);
        }
        // free $p7
        choice_3:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // c <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a38($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardeof($silence) {
    $key = implode(':', [531, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $this->savedPos = $this->currPos;
    $r1 = $this->a39();
    if ($r1) {
      $r1 = false;
    } else {
      $r1 = self::$FAILED;
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseblock($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [296, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    $r5 = $this->discardsof(true);
    if ($r5!==self::$FAILED) {
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r6 = $this->parseredirect($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // r <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsecomment_or_includes($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // cil <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r8 = $this->parseblock_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8===self::$FAILED) {
      $r8 = null;
    }
    // bl <- $r8
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a40($r6, $r7, $r8);
      goto choice_1;
    }
    // free $p3
    $r1 = $this->parseblock_lines($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p3 = $this->currPos;
    // start seq_2
    $p4 = $this->currPos;
    $p9 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r10 = "<";
      $r10 = false;
      $this->currPos = $p9;
    } else {
      $r10 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    // start choice_2
    $p9 = $this->currPos;
    // start seq_3
    $p12 = $this->currPos;
    $r13 = $this->parsecomment($silence);
    // c <- $r13
    if ($r13===self::$FAILED) {
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $p14 = $this->currPos;
    $r15 = $this->discardeolf(true);
    if ($r15!==self::$FAILED) {
      $r15 = false;
      $this->currPos = $p14;
    } else {
      $this->currPos = $p12;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p14
    $r11 = true;
    seq_3:
    if ($r11!==self::$FAILED) {
      $this->savedPos = $p9;
      $r11 = $this->a41($r13);
      goto choice_2;
    }
    // free $p12
    $r16 = $this->parseblock_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // bt <- $r16
    $r11 = $r16;
    choice_2:
    // rs <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $r1 = true;
    seq_2:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a42($r11);
      goto choice_1;
    }
    // free $p4
    $r1 = $this->parseparagraph($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p4 = $this->currPos;
    // start seq_4
    $p12 = $this->currPos;
    $r17 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // s <- $r17
    if ($r17===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_4;
    }
    $p14 = $this->currPos;
    $r18 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r18 === self::$FAILED) {
      $r18 = false;
    } else {
      $r18 = self::$FAILED;
      $this->currPos = $p14;
      $this->currPos = $p12;
      $r1 = self::$FAILED;
      goto seq_4;
    }
    // free $p14
    $r1 = true;
    seq_4:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p4;
      $r1 = $this->a43($r17);
    }
    // free $p12
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardnewline($silence) {
    $key = implode(':', [533, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $this->currPos++;
      $r1 = "\x0a";
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(27);}
      $r1 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r1 = "\x0d\x0a";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(28);}
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetplarg_or_template_guarded($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [346, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r7 = "{{";
      $this->currPos += 2;
    } else {
      $r7 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $p8 = $this->currPos;
    // start seq_3
    $p10 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r12 = "{{{";
      $this->currPos += 3;
      $r11 = true;
      while ($r12 !== self::$FAILED) {
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
          $r12 = "{{{";
          $this->currPos += 3;
        } else {
          $r12 = self::$FAILED;
        }
      }
    } else {
      $r12 = self::$FAILED;
      $r11 = self::$FAILED;
    }
    if ($r11===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_3;
    }
    // free $r12
    $p13 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r12 = "{";
    } else {
      $r12 = self::$FAILED;
    }
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p13;
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    // free $p13
    $r9 = true;
    seq_3:
    if ($r9!==self::$FAILED) {
      $r9 = false;
      $this->currPos = $p8;
    } else {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p10
    // free $p8
    $r14 = $this->discardtplarg(true, $boolParams, $param_templatedepth, $param_th);
    if ($r14===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // free $p4
    // start choice_2
    $r15 = $this->parsetemplate($silence, $boolParams, $param_templatedepth, $param_th);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    $r15 = $this->parsebroken_template($silence, $param_preproc);
    choice_2:
    // a <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a44($r15);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_4
    $p4 = $this->currPos;
    $p6 = $this->currPos;
    // start seq_5
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r17 = "{";
    } else {
      if (!$silence) {$this->fail(29);}
      $r17 = self::$FAILED;
      $r16 = self::$FAILED;
      goto seq_5;
    }
    $p10 = $this->currPos;
    // start seq_6
    $p13 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r20 = "{{{";
      $this->currPos += 3;
      $r19 = true;
      while ($r20 !== self::$FAILED) {
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
          $r20 = "{{{";
          $this->currPos += 3;
        } else {
          $r20 = self::$FAILED;
        }
      }
    } else {
      $r20 = self::$FAILED;
      $r19 = self::$FAILED;
    }
    if ($r19===self::$FAILED) {
      $r18 = self::$FAILED;
      goto seq_6;
    }
    // free $r20
    $p21 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r20 = "{";
    } else {
      $r20 = self::$FAILED;
    }
    if ($r20 === self::$FAILED) {
      $r20 = false;
    } else {
      $r20 = self::$FAILED;
      $this->currPos = $p21;
      $this->currPos = $p13;
      $r18 = self::$FAILED;
      goto seq_6;
    }
    // free $p21
    $r18 = true;
    seq_6:
    if ($r18!==self::$FAILED) {
      $r18 = false;
      $this->currPos = $p10;
    } else {
      $this->currPos = $p8;
      $r16 = self::$FAILED;
      goto seq_5;
    }
    // free $p13
    // free $p10
    $r16 = true;
    seq_5:
    if ($r16===self::$FAILED) {
      $r16 = null;
    }
    // free $p8
    // a <- $r16
    $r16 = substr($this->input, $p6, $this->currPos - $p6);
    // free $p6
    $r22 = $this->parsetplarg($silence, $boolParams, $param_templatedepth, $param_th);
    // b <- $r22
    if ($r22===self::$FAILED) {
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_4;
    }
    $r1 = true;
    seq_4:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a45($r16, $r22);
      goto choice_1;
    }
    // free $p4
    $p4 = $this->currPos;
    // start seq_7
    $p6 = $this->currPos;
    $p8 = $this->currPos;
    // start seq_8
    $p10 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r24 = "{";
    } else {
      if (!$silence) {$this->fail(29);}
      $r24 = self::$FAILED;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    $p13 = $this->currPos;
    // start seq_9
    $p21 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r26 = "{{";
      $this->currPos += 2;
    } else {
      $r26 = self::$FAILED;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    $p27 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r28 = "{";
    } else {
      $r28 = self::$FAILED;
    }
    if ($r28 === self::$FAILED) {
      $r28 = false;
    } else {
      $r28 = self::$FAILED;
      $this->currPos = $p27;
      $this->currPos = $p21;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    // free $p27
    $r25 = true;
    seq_9:
    if ($r25!==self::$FAILED) {
      $r25 = false;
      $this->currPos = $p13;
    } else {
      $this->currPos = $p10;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    // free $p21
    // free $p13
    $r23 = true;
    seq_8:
    if ($r23===self::$FAILED) {
      $r23 = null;
    }
    // free $p10
    // a <- $r23
    $r23 = substr($this->input, $p8, $this->currPos - $p8);
    // free $p8
    $r29 = $this->parsetemplate($silence, $boolParams, $param_templatedepth, $param_th);
    // b <- $r29
    if ($r29===self::$FAILED) {
      $this->currPos = $p6;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    $r1 = true;
    seq_7:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p4;
      $r1 = $this->a45($r23, $r29);
      goto choice_1;
    }
    // free $p6
    $p6 = $this->currPos;
    $r30 = $this->parsebroken_template($silence, $param_preproc);
    // a <- $r30
    $r1 = $r30;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p6;
      $r1 = $this->a44($r30);
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseraw_htmlentity($silence) {
    $key = implode(':', [490, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_1
    $p5 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r6 = "&";
    } else {
      if (!$silence) {$this->fail(30);}
      $r6 = self::$FAILED;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r8 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[#0-9a-zA-Z]/", $r8)) {
      $this->currPos++;
      $r7 = true;
      while ($r8 !== self::$FAILED) {
        $r8 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[#0-9a-zA-Z]/", $r8)) {
          $this->currPos++;
        } else {
          $r8 = self::$FAILED;
          if (!$silence) {$this->fail(31);}
        }
      }
    } else {
      $r8 = self::$FAILED;
      if (!$silence) {$this->fail(31);}
      $r7 = self::$FAILED;
    }
    if ($r7===self::$FAILED) {
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r8 = ";";
    } else {
      if (!$silence) {$this->fail(32);}
      $r8 = self::$FAILED;
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r3 = true;
    seq_1:
    // m <- $r3
    if ($r3!==self::$FAILED) {
      $r3 = substr($this->input, $p4, $this->currPos - $p4);
    } else {
      $r3 = self::$FAILED;
    }
    // free $p5
    // free $p4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a46($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseoptionalSpaceToken($silence) {
    $key = implode(':', [500, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $r3 = $this->parseoptional_spaces($silence);
    // s <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a32($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_attribute_name($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [438, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    if (strspn($this->input, "\"'=", $this->currPos, 1) !== 0) {
      $r4 = $this->input[$this->currPos++];
    } else {
      $r4 = self::$FAILED;
      if (!$silence) {$this->fail(33);}
      $r4 = null;
    }
    // q <- $r4
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
    // free $p5
    $r6 = [];
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|[", $this->currPos, 1) !== 0) {
      $r8 = self::consumeChar($this->input, $this->currPos);
      $r7 = true;
      while ($r8 !== self::$FAILED) {
        if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|[", $this->currPos, 1) !== 0) {
          $r8 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r8 = self::$FAILED;
          if (!$silence) {$this->fail(34);}
        }
      }
    } else {
      $r8 = self::$FAILED;
      if (!$silence) {$this->fail(34);}
      $r7 = self::$FAILED;
    }
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
    }
    // free $r8
    // free $p5
    $p5 = $this->currPos;
    // start seq_2
    $p9 = $this->currPos;
    $p10 = $this->currPos;
    $r8 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p10;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $p10
    // start choice_2
    $p10 = $this->currPos;
    $r11 = $this->discardwikilink($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    if ($r11!==self::$FAILED) {
      $r11 = substr($this->input, $p10, $this->currPos - $p10);
      goto choice_2;
    } else {
      $r11 = self::$FAILED;
    }
    // free $p10
    $r11 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $p10 = $this->currPos;
    // start seq_3
    $p12 = $this->currPos;
    $p13 = $this->currPos;
    $r14 = $this->discardxmlish_tag(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r14!==self::$FAILED) {
      $r14 = false;
      $this->currPos = $p13;
    } else {
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p13
    $r15 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // ill <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p12;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r11 = true;
    seq_3:
    if ($r11!==self::$FAILED) {
      $this->savedPos = $p10;
      $r11 = $this->a47($r4, $r15);
      goto choice_2;
    }
    // free $p12
    $p12 = $this->currPos;
    // start seq_4
    $p13 = $this->currPos;
    $p16 = $this->currPos;
    // start choice_3
    $r17 = $this->discardspace_or_newline(true);
    if ($r17!==self::$FAILED) {
      goto choice_3;
    }
    if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
      $r17 = $this->input[$this->currPos++];
    } else {
      $r17 = self::$FAILED;
    }
    choice_3:
    if ($r17 === self::$FAILED) {
      $r17 = false;
    } else {
      $r17 = self::$FAILED;
      $this->currPos = $p16;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    // free $p16
    if ($this->currPos < $this->inputLength) {
      $r18 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r18 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
      $this->currPos = $p13;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    $r11 = true;
    seq_4:
    if ($r11!==self::$FAILED) {
      $r11 = substr($this->input, $p12, $this->currPos - $p12);
    } else {
      $r11 = self::$FAILED;
    }
    // free $p13
    // free $p12
    choice_2:
    // t <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p5;
      $r7 = $this->a48($r4, $r11);
    }
    // free $p9
    choice_1:
    while ($r7 !== self::$FAILED) {
      $r6[] = $r7;
      // start choice_4
      $p9 = $this->currPos;
      if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|[", $this->currPos, 1) !== 0) {
        $r19 = self::consumeChar($this->input, $this->currPos);
        $r7 = true;
        while ($r19 !== self::$FAILED) {
          if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|[", $this->currPos, 1) !== 0) {
            $r19 = self::consumeChar($this->input, $this->currPos);
          } else {
            $r19 = self::$FAILED;
            if (!$silence) {$this->fail(34);}
          }
        }
      } else {
        $r19 = self::$FAILED;
        if (!$silence) {$this->fail(34);}
        $r7 = self::$FAILED;
      }
      if ($r7!==self::$FAILED) {
        $r7 = substr($this->input, $p9, $this->currPos - $p9);
        goto choice_4;
      } else {
        $r7 = self::$FAILED;
      }
      // free $r19
      // free $p9
      $p9 = $this->currPos;
      // start seq_5
      $p12 = $this->currPos;
      $p13 = $this->currPos;
      $r19 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r19 === self::$FAILED) {
        $r19 = false;
      } else {
        $r19 = self::$FAILED;
        $this->currPos = $p13;
        $r7 = self::$FAILED;
        goto seq_5;
      }
      // free $p13
      // start choice_5
      $p13 = $this->currPos;
      $r20 = $this->discardwikilink($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
      if ($r20!==self::$FAILED) {
        $r20 = substr($this->input, $p13, $this->currPos - $p13);
        goto choice_5;
      } else {
        $r20 = self::$FAILED;
      }
      // free $p13
      $r20 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r20!==self::$FAILED) {
        goto choice_5;
      }
      $p13 = $this->currPos;
      // start seq_6
      $p16 = $this->currPos;
      $p21 = $this->currPos;
      $r22 = $this->discardxmlish_tag(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r22!==self::$FAILED) {
        $r22 = false;
        $this->currPos = $p21;
      } else {
        $r20 = self::$FAILED;
        goto seq_6;
      }
      // free $p21
      $r23 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      // ill <- $r23
      if ($r23===self::$FAILED) {
        $this->currPos = $p16;
        $r20 = self::$FAILED;
        goto seq_6;
      }
      $r20 = true;
      seq_6:
      if ($r20!==self::$FAILED) {
        $this->savedPos = $p13;
        $r20 = $this->a47($r4, $r23);
        goto choice_5;
      }
      // free $p16
      $p16 = $this->currPos;
      // start seq_7
      $p21 = $this->currPos;
      $p24 = $this->currPos;
      // start choice_6
      $r25 = $this->discardspace_or_newline(true);
      if ($r25!==self::$FAILED) {
        goto choice_6;
      }
      if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
        $r25 = $this->input[$this->currPos++];
      } else {
        $r25 = self::$FAILED;
      }
      choice_6:
      if ($r25 === self::$FAILED) {
        $r25 = false;
      } else {
        $r25 = self::$FAILED;
        $this->currPos = $p24;
        $r20 = self::$FAILED;
        goto seq_7;
      }
      // free $p24
      if ($this->currPos < $this->inputLength) {
        $r26 = self::consumeChar($this->input, $this->currPos);;
      } else {
        $r26 = self::$FAILED;
        if (!$silence) {$this->fail(7);}
        $this->currPos = $p21;
        $r20 = self::$FAILED;
        goto seq_7;
      }
      $r20 = true;
      seq_7:
      if ($r20!==self::$FAILED) {
        $r20 = substr($this->input, $p16, $this->currPos - $p16);
      } else {
        $r20 = self::$FAILED;
      }
      // free $p21
      // free $p16
      choice_5:
      // t <- $r20
      if ($r20===self::$FAILED) {
        $this->currPos = $p12;
        $r7 = self::$FAILED;
        goto seq_5;
      }
      $r7 = true;
      seq_5:
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p9;
        $r7 = $this->a48($r4, $r20);
      }
      // free $p12
      choice_4:
    }
    // r <- $r6
    // free $r7
    $this->savedPos = $this->currPos;
    $r7 = $this->a49($r4, $r6);
    if ($r7) {
      $r7 = false;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a50($r4, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_att_value($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [442, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    $r8 = $this->discardspace($silence);
    while ($r8 !== self::$FAILED) {
      $r8 = $this->discardspace($silence);
    }
    // free $r8
    $r7 = true;
    if ($r7===self::$FAILED) {
      $r4 = self::$FAILED;
      goto seq_2;
    }
    // free $r7
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r7 = "'";
    } else {
      if (!$silence) {$this->fail(35);}
      $r7 = self::$FAILED;
      $this->currPos = $p6;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    $r4 = true;
    seq_2:
    // s <- $r4
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // free $p5
    $r8 = $this->parsetable_attribute_preprocessor_text_single($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8===self::$FAILED) {
      $r8 = null;
    }
    // t <- $r8
    $p5 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r9 = "'";
      goto choice_2;
    } else {
      if (!$silence) {$this->fail(35);}
      $r9 = self::$FAILED;
    }
    $p6 = $this->currPos;
    // start choice_3
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
      $r9 = "!!";
      $this->currPos += 2;
      goto choice_3;
    } else {
      $r9 = self::$FAILED;
    }
    if (strspn($this->input, "|\x0d\x0a", $this->currPos, 1) !== 0) {
      $r9 = $this->input[$this->currPos++];
    } else {
      $r9 = self::$FAILED;
    }
    choice_3:
    if ($r9!==self::$FAILED) {
      $r9 = false;
      $this->currPos = $p6;
    }
    // free $p6
    choice_2:
    // q <- $r9
    if ($r9!==self::$FAILED) {
      $r9 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a51($r4, $r8, $r9);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_3
    $p5 = $this->currPos;
    $p6 = $this->currPos;
    // start seq_4
    $p11 = $this->currPos;
    $r13 = $this->discardspace($silence);
    while ($r13 !== self::$FAILED) {
      $r13 = $this->discardspace($silence);
    }
    // free $r13
    $r12 = true;
    if ($r12===self::$FAILED) {
      $r10 = self::$FAILED;
      goto seq_4;
    }
    // free $r12
    if (($this->input[$this->currPos] ?? null) === "\"") {
      $this->currPos++;
      $r12 = "\"";
    } else {
      if (!$silence) {$this->fail(36);}
      $r12 = self::$FAILED;
      $this->currPos = $p11;
      $r10 = self::$FAILED;
      goto seq_4;
    }
    $r10 = true;
    seq_4:
    // s <- $r10
    if ($r10!==self::$FAILED) {
      $r10 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r10 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_3;
    }
    // free $p11
    // free $p6
    $r13 = $this->parsetable_attribute_preprocessor_text_double($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r13===self::$FAILED) {
      $r13 = null;
    }
    // t <- $r13
    $p6 = $this->currPos;
    // start choice_4
    if (($this->input[$this->currPos] ?? null) === "\"") {
      $this->currPos++;
      $r14 = "\"";
      goto choice_4;
    } else {
      if (!$silence) {$this->fail(36);}
      $r14 = self::$FAILED;
    }
    $p11 = $this->currPos;
    // start choice_5
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
      $r14 = "!!";
      $this->currPos += 2;
      goto choice_5;
    } else {
      $r14 = self::$FAILED;
    }
    if (strspn($this->input, "|\x0d\x0a", $this->currPos, 1) !== 0) {
      $r14 = $this->input[$this->currPos++];
    } else {
      $r14 = self::$FAILED;
    }
    choice_5:
    if ($r14!==self::$FAILED) {
      $r14 = false;
      $this->currPos = $p11;
    }
    // free $p11
    choice_4:
    // q <- $r14
    if ($r14!==self::$FAILED) {
      $r14 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_3;
    }
    // free $p6
    $r1 = true;
    seq_3:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a51($r10, $r13, $r14);
      goto choice_1;
    }
    // free $p5
    $p5 = $this->currPos;
    // start seq_5
    $p6 = $this->currPos;
    $p11 = $this->currPos;
    $r16 = $this->discardspace($silence);
    while ($r16 !== self::$FAILED) {
      $r16 = $this->discardspace($silence);
    }
    // free $r16
    $r15 = true;
    // s <- $r15
    if ($r15!==self::$FAILED) {
      $r15 = substr($this->input, $p11, $this->currPos - $p11);
    } else {
      $r15 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_5;
    }
    // free $p11
    $r16 = $this->parsetable_attribute_preprocessor_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // t <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p6;
      $r1 = self::$FAILED;
      goto seq_5;
    }
    $p11 = $this->currPos;
    // start choice_6
    $r17 = $this->discardspace_or_newline(true);
    if ($r17!==self::$FAILED) {
      goto choice_6;
    }
    $r17 = $this->discardeof(true);
    if ($r17!==self::$FAILED) {
      goto choice_6;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
      $r17 = "!!";
      $this->currPos += 2;
      goto choice_6;
    } else {
      $r17 = self::$FAILED;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r17 = "|";
    } else {
      $r17 = self::$FAILED;
    }
    choice_6:
    if ($r17!==self::$FAILED) {
      $r17 = false;
      $this->currPos = $p11;
    } else {
      $this->currPos = $p6;
      $r1 = self::$FAILED;
      goto seq_5;
    }
    // free $p11
    $r1 = true;
    seq_5:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p5;
      $r1 = $this->a52($r15, $r16);
    }
    // free $p6
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardspace_or_newline_or_solidus($silence) {
    $key = implode(':', [421, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->discardspace_or_newline($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    // s <- $r4
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r4 = "/";
    } else {
      if (!$silence) {$this->fail(37);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p5 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ">") {
      $this->currPos++;
      $r6 = ">";
    } else {
      $r6 = self::$FAILED;
    }
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p5;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a43($r4);
    }
    // free $p3
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsegeneric_attribute_name($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [434, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    if (strspn($this->input, "\"'=", $this->currPos, 1) !== 0) {
      $r4 = $this->input[$this->currPos++];
    } else {
      $r4 = self::$FAILED;
      if (!$silence) {$this->fail(33);}
      $r4 = null;
    }
    // q <- $r4
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
    // free $p5
    $r6 = [];
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|", $this->currPos, 1) !== 0) {
      $r8 = self::consumeChar($this->input, $this->currPos);
      $r7 = true;
      while ($r8 !== self::$FAILED) {
        if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|", $this->currPos, 1) !== 0) {
          $r8 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r8 = self::$FAILED;
          if (!$silence) {$this->fail(38);}
        }
      }
    } else {
      $r8 = self::$FAILED;
      if (!$silence) {$this->fail(38);}
      $r7 = self::$FAILED;
    }
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
    }
    // free $r8
    // free $p5
    $p5 = $this->currPos;
    // start seq_2
    $p9 = $this->currPos;
    $p10 = $this->currPos;
    $r8 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p10;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $p10
    // start choice_2
    $r11 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $r11 = $this->parseless_than($silence, $boolParams);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $p10 = $this->currPos;
    // start seq_3
    $p12 = $this->currPos;
    $p13 = $this->currPos;
    // start choice_3
    $r14 = $this->discardspace_or_newline(true);
    if ($r14!==self::$FAILED) {
      goto choice_3;
    }
    if (strspn($this->input, "\x00/=><", $this->currPos, 1) !== 0) {
      $r14 = $this->input[$this->currPos++];
    } else {
      $r14 = self::$FAILED;
    }
    choice_3:
    if ($r14 === self::$FAILED) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p13;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p13
    if ($this->currPos < $this->inputLength) {
      $r15 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r15 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
      $this->currPos = $p12;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r11 = true;
    seq_3:
    if ($r11!==self::$FAILED) {
      $r11 = substr($this->input, $p10, $this->currPos - $p10);
    } else {
      $r11 = self::$FAILED;
    }
    // free $p12
    // free $p10
    choice_2:
    // t <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p5;
      $r7 = $this->a48($r4, $r11);
    }
    // free $p9
    choice_1:
    while ($r7 !== self::$FAILED) {
      $r6[] = $r7;
      // start choice_4
      $p9 = $this->currPos;
      if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|", $this->currPos, 1) !== 0) {
        $r16 = self::consumeChar($this->input, $this->currPos);
        $r7 = true;
        while ($r16 !== self::$FAILED) {
          if (strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|", $this->currPos, 1) !== 0) {
            $r16 = self::consumeChar($this->input, $this->currPos);
          } else {
            $r16 = self::$FAILED;
            if (!$silence) {$this->fail(38);}
          }
        }
      } else {
        $r16 = self::$FAILED;
        if (!$silence) {$this->fail(38);}
        $r7 = self::$FAILED;
      }
      if ($r7!==self::$FAILED) {
        $r7 = substr($this->input, $p9, $this->currPos - $p9);
        goto choice_4;
      } else {
        $r7 = self::$FAILED;
      }
      // free $r16
      // free $p9
      $p9 = $this->currPos;
      // start seq_4
      $p10 = $this->currPos;
      $p12 = $this->currPos;
      $r16 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r16 === self::$FAILED) {
        $r16 = false;
      } else {
        $r16 = self::$FAILED;
        $this->currPos = $p12;
        $r7 = self::$FAILED;
        goto seq_4;
      }
      // free $p12
      // start choice_5
      $r17 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r17!==self::$FAILED) {
        goto choice_5;
      }
      $r17 = $this->parseless_than($silence, $boolParams);
      if ($r17!==self::$FAILED) {
        goto choice_5;
      }
      $p12 = $this->currPos;
      // start seq_5
      $p13 = $this->currPos;
      $p18 = $this->currPos;
      // start choice_6
      $r19 = $this->discardspace_or_newline(true);
      if ($r19!==self::$FAILED) {
        goto choice_6;
      }
      if (strspn($this->input, "\x00/=><", $this->currPos, 1) !== 0) {
        $r19 = $this->input[$this->currPos++];
      } else {
        $r19 = self::$FAILED;
      }
      choice_6:
      if ($r19 === self::$FAILED) {
        $r19 = false;
      } else {
        $r19 = self::$FAILED;
        $this->currPos = $p18;
        $r17 = self::$FAILED;
        goto seq_5;
      }
      // free $p18
      if ($this->currPos < $this->inputLength) {
        $r20 = self::consumeChar($this->input, $this->currPos);;
      } else {
        $r20 = self::$FAILED;
        if (!$silence) {$this->fail(7);}
        $this->currPos = $p13;
        $r17 = self::$FAILED;
        goto seq_5;
      }
      $r17 = true;
      seq_5:
      if ($r17!==self::$FAILED) {
        $r17 = substr($this->input, $p12, $this->currPos - $p12);
      } else {
        $r17 = self::$FAILED;
      }
      // free $p13
      // free $p12
      choice_5:
      // t <- $r17
      if ($r17===self::$FAILED) {
        $this->currPos = $p10;
        $r7 = self::$FAILED;
        goto seq_4;
      }
      $r7 = true;
      seq_4:
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p9;
        $r7 = $this->a48($r4, $r17);
      }
      // free $p10
      choice_4:
    }
    // r <- $r6
    // free $r7
    $this->savedPos = $this->currPos;
    $r7 = $this->a49($r4, $r6);
    if ($r7) {
      $r7 = false;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a50($r4, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardspace_or_newline($silence) {
    $key = implode(':', [503, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
      $r1 = $this->input[$this->currPos++];
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(39);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsegeneric_att_value($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [440, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    $r8 = $this->discardspace_or_newline($silence);
    while ($r8 !== self::$FAILED) {
      $r8 = $this->discardspace_or_newline($silence);
    }
    // free $r8
    $r7 = true;
    if ($r7===self::$FAILED) {
      $r4 = self::$FAILED;
      goto seq_2;
    }
    // free $r7
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r7 = "'";
    } else {
      if (!$silence) {$this->fail(35);}
      $r7 = self::$FAILED;
      $this->currPos = $p6;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    $r4 = true;
    seq_2:
    // s <- $r4
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // free $p5
    $r8 = $this->parseattribute_preprocessor_text_single($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8===self::$FAILED) {
      $r8 = null;
    }
    // t <- $r8
    $p5 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r9 = "'";
      goto choice_2;
    } else {
      if (!$silence) {$this->fail(35);}
      $r9 = self::$FAILED;
    }
    $p6 = $this->currPos;
    // start seq_3
    $p10 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r11 = "/";
    } else {
      $r11 = self::$FAILED;
      $r11 = null;
    }
    if (($this->input[$this->currPos] ?? null) === ">") {
      $this->currPos++;
      $r12 = ">";
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    $r9 = true;
    seq_3:
    if ($r9!==self::$FAILED) {
      $r9 = false;
      $this->currPos = $p6;
    }
    // free $p10
    // free $p6
    choice_2:
    // q <- $r9
    if ($r9!==self::$FAILED) {
      $r9 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a51($r4, $r8, $r9);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_4
    $p5 = $this->currPos;
    $p6 = $this->currPos;
    // start seq_5
    $p10 = $this->currPos;
    $r15 = $this->discardspace_or_newline($silence);
    while ($r15 !== self::$FAILED) {
      $r15 = $this->discardspace_or_newline($silence);
    }
    // free $r15
    $r14 = true;
    if ($r14===self::$FAILED) {
      $r13 = self::$FAILED;
      goto seq_5;
    }
    // free $r14
    if (($this->input[$this->currPos] ?? null) === "\"") {
      $this->currPos++;
      $r14 = "\"";
    } else {
      if (!$silence) {$this->fail(36);}
      $r14 = self::$FAILED;
      $this->currPos = $p10;
      $r13 = self::$FAILED;
      goto seq_5;
    }
    $r13 = true;
    seq_5:
    // s <- $r13
    if ($r13!==self::$FAILED) {
      $r13 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r13 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_4;
    }
    // free $p10
    // free $p6
    $r15 = $this->parseattribute_preprocessor_text_double($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r15===self::$FAILED) {
      $r15 = null;
    }
    // t <- $r15
    $p6 = $this->currPos;
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "\"") {
      $this->currPos++;
      $r16 = "\"";
      goto choice_3;
    } else {
      if (!$silence) {$this->fail(36);}
      $r16 = self::$FAILED;
    }
    $p10 = $this->currPos;
    // start seq_6
    $p17 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r18 = "/";
    } else {
      $r18 = self::$FAILED;
      $r18 = null;
    }
    if (($this->input[$this->currPos] ?? null) === ">") {
      $this->currPos++;
      $r19 = ">";
    } else {
      $r19 = self::$FAILED;
      $this->currPos = $p17;
      $r16 = self::$FAILED;
      goto seq_6;
    }
    $r16 = true;
    seq_6:
    if ($r16!==self::$FAILED) {
      $r16 = false;
      $this->currPos = $p10;
    }
    // free $p17
    // free $p10
    choice_3:
    // q <- $r16
    if ($r16!==self::$FAILED) {
      $r16 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_4;
    }
    // free $p6
    $r1 = true;
    seq_4:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a51($r13, $r15, $r16);
      goto choice_1;
    }
    // free $p5
    $p5 = $this->currPos;
    // start seq_7
    $p6 = $this->currPos;
    $p10 = $this->currPos;
    $r21 = $this->discardspace_or_newline($silence);
    while ($r21 !== self::$FAILED) {
      $r21 = $this->discardspace_or_newline($silence);
    }
    // free $r21
    $r20 = true;
    // s <- $r20
    if ($r20!==self::$FAILED) {
      $r20 = substr($this->input, $p10, $this->currPos - $p10);
    } else {
      $r20 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    // free $p10
    $r21 = $this->parseattribute_preprocessor_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // t <- $r21
    if ($r21===self::$FAILED) {
      $this->currPos = $p6;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    $p10 = $this->currPos;
    // start choice_4
    $r22 = $this->discardspace_or_newline(true);
    if ($r22!==self::$FAILED) {
      goto choice_4;
    }
    $r22 = $this->discardeof(true);
    if ($r22!==self::$FAILED) {
      goto choice_4;
    }
    // start seq_8
    $p17 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r23 = "/";
    } else {
      $r23 = self::$FAILED;
      $r23 = null;
    }
    if (($this->input[$this->currPos] ?? null) === ">") {
      $this->currPos++;
      $r24 = ">";
    } else {
      $r24 = self::$FAILED;
      $this->currPos = $p17;
      $r22 = self::$FAILED;
      goto seq_8;
    }
    $r22 = true;
    seq_8:
    // free $p17
    choice_4:
    if ($r22!==self::$FAILED) {
      $r22 = false;
      $this->currPos = $p10;
    } else {
      $this->currPos = $p6;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    // free $p10
    $r1 = true;
    seq_7:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p5;
      $r1 = $this->a52($r20, $r21);
    }
    // free $p6
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseextlink_preprocessor_text_parameterized($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [546, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $p5 = $this->currPos;
    $r6 = self::charAt($this->input, $this->currPos);
    if (preg_match("/^[^'<~\\[{\\x0a\\x0d|!\\]}\\-\\x09&=\"' \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/u", $r6)) {
      $this->currPos += strlen($r6);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        $r6 = self::charAt($this->input, $this->currPos);
        if (preg_match("/^[^'<~\\[{\\x0a\\x0d|!\\]}\\-\\x09&=\"' \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/u", $r6)) {
          $this->currPos += strlen($r6);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(40);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(40);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r9 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_2;
    }
    $r9 = $this->parseno_punctuation_char($silence);
    if ($r9!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "&|{-", $this->currPos, 1) !== 0) {
      $r9 = $this->input[$this->currPos++];
    } else {
      $r9 = self::$FAILED;
      if (!$silence) {$this->fail(41);}
    }
    choice_2:
    // s <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r9);
      goto choice_1;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    if (strspn($this->input, ".:,", $this->currPos, 1) !== 0) {
      $r10 = $this->input[$this->currPos++];
    } else {
      $r10 = self::$FAILED;
      if (!$silence) {$this->fail(42);}
      $r4 = self::$FAILED;
      goto seq_2;
    }
    $p11 = $this->currPos;
    // start choice_3
    $r12 = $this->discardspace(true);
    if ($r12!==self::$FAILED) {
      goto choice_3;
    }
    $r12 = $this->discardeolf(true);
    choice_3:
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p11;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    // free $p11
    $r4 = true;
    seq_2:
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $p8
    // free $p7
    $p7 = $this->currPos;
    // start seq_3
    $p8 = $this->currPos;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "'") {
      $this->currPos++;
    } else {
      $r13 = self::$FAILED;
      if (!$silence) {$this->fail(43);}
      $r4 = self::$FAILED;
      goto seq_3;
    }
    $p11 = $this->currPos;
    $r14 = $this->input[$this->currPos] ?? '';
    if ($r14 === "'") {
      $this->currPos++;
    } else {
      $r14 = self::$FAILED;
    }
    if ($r14 === self::$FAILED) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p11;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_3;
    }
    // free $p11
    $r4 = true;
    seq_3:
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p7, $this->currPos - $p7);
    } else {
      $r4 = self::$FAILED;
    }
    // free $p8
    // free $p7
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_4
        $p7 = $this->currPos;
        $r15 = self::charAt($this->input, $this->currPos);
        if (preg_match("/^[^'<~\\[{\\x0a\\x0d|!\\]}\\-\\x09&=\"' \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/u", $r15)) {
          $this->currPos += strlen($r15);
          $r4 = true;
          while ($r15 !== self::$FAILED) {
            $r15 = self::charAt($this->input, $this->currPos);
            if (preg_match("/^[^'<~\\[{\\x0a\\x0d|!\\]}\\-\\x09&=\"' \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/u", $r15)) {
              $this->currPos += strlen($r15);
            } else {
              $r15 = self::$FAILED;
              if (!$silence) {$this->fail(40);}
            }
          }
        } else {
          $r15 = self::$FAILED;
          if (!$silence) {$this->fail(40);}
          $r4 = self::$FAILED;
        }
        if ($r4!==self::$FAILED) {
          $r4 = substr($this->input, $p7, $this->currPos - $p7);
          goto choice_4;
        } else {
          $r4 = self::$FAILED;
        }
        // free $r15
        // free $p7
        $p7 = $this->currPos;
        // start seq_4
        $p8 = $this->currPos;
        $p11 = $this->currPos;
        $r15 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r15 === self::$FAILED) {
          $r15 = false;
        } else {
          $r15 = self::$FAILED;
          $this->currPos = $p11;
          $r4 = self::$FAILED;
          goto seq_4;
        }
        // free $p11
        // start choice_5
        $r16 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r16!==self::$FAILED) {
          goto choice_5;
        }
        $r16 = $this->parseno_punctuation_char($silence);
        if ($r16!==self::$FAILED) {
          goto choice_5;
        }
        if (strspn($this->input, "&|{-", $this->currPos, 1) !== 0) {
          $r16 = $this->input[$this->currPos++];
        } else {
          $r16 = self::$FAILED;
          if (!$silence) {$this->fail(41);}
        }
        choice_5:
        // s <- $r16
        if ($r16===self::$FAILED) {
          $this->currPos = $p8;
          $r4 = self::$FAILED;
          goto seq_4;
        }
        $r4 = true;
        seq_4:
        if ($r4!==self::$FAILED) {
          $this->savedPos = $p7;
          $r4 = $this->a43($r16);
          goto choice_4;
        }
        // free $p8
        $p8 = $this->currPos;
        // start seq_5
        $p11 = $this->currPos;
        if (strspn($this->input, ".:,", $this->currPos, 1) !== 0) {
          $r17 = $this->input[$this->currPos++];
        } else {
          $r17 = self::$FAILED;
          if (!$silence) {$this->fail(42);}
          $r4 = self::$FAILED;
          goto seq_5;
        }
        $p18 = $this->currPos;
        // start choice_6
        $r19 = $this->discardspace(true);
        if ($r19!==self::$FAILED) {
          goto choice_6;
        }
        $r19 = $this->discardeolf(true);
        choice_6:
        if ($r19 === self::$FAILED) {
          $r19 = false;
        } else {
          $r19 = self::$FAILED;
          $this->currPos = $p18;
          $this->currPos = $p11;
          $r4 = self::$FAILED;
          goto seq_5;
        }
        // free $p18
        $r4 = true;
        seq_5:
        if ($r4!==self::$FAILED) {
          $r4 = substr($this->input, $p8, $this->currPos - $p8);
          goto choice_4;
        } else {
          $r4 = self::$FAILED;
        }
        // free $p11
        // free $p8
        $p8 = $this->currPos;
        // start seq_6
        $p11 = $this->currPos;
        $r20 = $this->input[$this->currPos] ?? '';
        if ($r20 === "'") {
          $this->currPos++;
        } else {
          $r20 = self::$FAILED;
          if (!$silence) {$this->fail(43);}
          $r4 = self::$FAILED;
          goto seq_6;
        }
        $p18 = $this->currPos;
        $r21 = $this->input[$this->currPos] ?? '';
        if ($r21 === "'") {
          $this->currPos++;
        } else {
          $r21 = self::$FAILED;
        }
        if ($r21 === self::$FAILED) {
          $r21 = false;
        } else {
          $r21 = self::$FAILED;
          $this->currPos = $p18;
          $this->currPos = $p11;
          $r4 = self::$FAILED;
          goto seq_6;
        }
        // free $p18
        $r4 = true;
        seq_6:
        if ($r4!==self::$FAILED) {
          $r4 = substr($this->input, $p8, $this->currPos - $p8);
        } else {
          $r4 = self::$FAILED;
        }
        // free $p11
        // free $p8
        choice_4:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseurltext($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [488, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p3 = $this->currPos;
    $r4 = self::charAt($this->input, $this->currPos);
    if (preg_match("/^[^\\-'<~\\[{\\x0a\\/A-Za-z_|!:;\\]} &=]/", $r4)) {
      $this->currPos += strlen($r4);
      $r2 = true;
      while ($r4 !== self::$FAILED) {
        $r4 = self::charAt($this->input, $this->currPos);
        if (preg_match("/^[^\\-'<~\\[{\\x0a\\/A-Za-z_|!:;\\]} &=]/", $r4)) {
          $this->currPos += strlen($r4);
        } else {
          $r4 = self::$FAILED;
          if (!$silence) {$this->fail(44);}
        }
      }
    } else {
      $r4 = self::$FAILED;
      if (!$silence) {$this->fail(44);}
      $r2 = self::$FAILED;
    }
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p3, $this->currPos - $p3);
      goto choice_1;
    } else {
      $r2 = self::$FAILED;
    }
    // free $r4
    // free $p3
    $p3 = $this->currPos;
    // start seq_1
    $p5 = $this->currPos;
    $p6 = $this->currPos;
    $r4 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[\\/A-Za-z]/", $r4)) {
      $this->currPos++;
      $r4 = false;
      $this->currPos = $p6;
    } else {
      $r4 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $r7 = $this->parseautolink($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // al <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p5;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p3;
      $r2 = $this->a54($r7);
      goto choice_1;
    }
    // free $p5
    $p5 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r9 = "&";
      $r9 = false;
      $this->currPos = $p8;
    } else {
      $r9 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_2;
    }
    // free $p8
    $r10 = $this->parsehtmlentity($silence);
    // he <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p6;
      $r2 = self::$FAILED;
      goto seq_2;
    }
    $r2 = true;
    seq_2:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p5;
      $r2 = $this->a55($r10);
      goto choice_1;
    }
    // free $p6
    $p6 = $this->currPos;
    // start seq_3
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === " ") {
      $this->currPos++;
      $r11 = " ";
    } else {
      if (!$silence) {$this->fail(45);}
      $r11 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_3;
    }
    $p12 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r13 = ":";
      $r13 = false;
      $this->currPos = $p12;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p8;
      $r2 = self::$FAILED;
      goto seq_3;
    }
    // free $p12
    $r2 = true;
    seq_3:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p6;
      $r2 = $this->a56();
      goto choice_1;
    }
    // free $p8
    $p8 = $this->currPos;
    // start seq_4
    $p12 = $this->currPos;
    $p14 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r15 = "__";
      $this->currPos += 2;
      $r15 = false;
      $this->currPos = $p14;
    } else {
      $r15 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_4;
    }
    // free $p14
    $r16 = $this->parsebehavior_switch($silence);
    // bs <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p12;
      $r2 = self::$FAILED;
      goto seq_4;
    }
    $r2 = true;
    seq_4:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p8;
      $r2 = $this->a57($r16);
      goto choice_1;
    }
    // free $p12
    $r2 = $this->parsetext_char($silence);
    choice_1:
    if ($r2!==self::$FAILED) {
      $r1 = [];
      while ($r2 !== self::$FAILED) {
        $r1[] = $r2;
        // start choice_2
        $p12 = $this->currPos;
        $r17 = self::charAt($this->input, $this->currPos);
        if (preg_match("/^[^\\-'<~\\[{\\x0a\\/A-Za-z_|!:;\\]} &=]/", $r17)) {
          $this->currPos += strlen($r17);
          $r2 = true;
          while ($r17 !== self::$FAILED) {
            $r17 = self::charAt($this->input, $this->currPos);
            if (preg_match("/^[^\\-'<~\\[{\\x0a\\/A-Za-z_|!:;\\]} &=]/", $r17)) {
              $this->currPos += strlen($r17);
            } else {
              $r17 = self::$FAILED;
              if (!$silence) {$this->fail(44);}
            }
          }
        } else {
          $r17 = self::$FAILED;
          if (!$silence) {$this->fail(44);}
          $r2 = self::$FAILED;
        }
        if ($r2!==self::$FAILED) {
          $r2 = substr($this->input, $p12, $this->currPos - $p12);
          goto choice_2;
        } else {
          $r2 = self::$FAILED;
        }
        // free $r17
        // free $p12
        $p12 = $this->currPos;
        // start seq_5
        $p14 = $this->currPos;
        $p18 = $this->currPos;
        $r17 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[\\/A-Za-z]/", $r17)) {
          $this->currPos++;
          $r17 = false;
          $this->currPos = $p18;
        } else {
          $r17 = self::$FAILED;
          $r2 = self::$FAILED;
          goto seq_5;
        }
        // free $p18
        $r19 = $this->parseautolink($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        // al <- $r19
        if ($r19===self::$FAILED) {
          $this->currPos = $p14;
          $r2 = self::$FAILED;
          goto seq_5;
        }
        $r2 = true;
        seq_5:
        if ($r2!==self::$FAILED) {
          $this->savedPos = $p12;
          $r2 = $this->a54($r19);
          goto choice_2;
        }
        // free $p14
        $p14 = $this->currPos;
        // start seq_6
        $p18 = $this->currPos;
        $p20 = $this->currPos;
        if (($this->input[$this->currPos] ?? null) === "&") {
          $this->currPos++;
          $r21 = "&";
          $r21 = false;
          $this->currPos = $p20;
        } else {
          $r21 = self::$FAILED;
          $r2 = self::$FAILED;
          goto seq_6;
        }
        // free $p20
        $r22 = $this->parsehtmlentity($silence);
        // he <- $r22
        if ($r22===self::$FAILED) {
          $this->currPos = $p18;
          $r2 = self::$FAILED;
          goto seq_6;
        }
        $r2 = true;
        seq_6:
        if ($r2!==self::$FAILED) {
          $this->savedPos = $p14;
          $r2 = $this->a55($r22);
          goto choice_2;
        }
        // free $p18
        $p18 = $this->currPos;
        // start seq_7
        $p20 = $this->currPos;
        if (($this->input[$this->currPos] ?? null) === " ") {
          $this->currPos++;
          $r23 = " ";
        } else {
          if (!$silence) {$this->fail(45);}
          $r23 = self::$FAILED;
          $r2 = self::$FAILED;
          goto seq_7;
        }
        $p24 = $this->currPos;
        if (($this->input[$this->currPos] ?? null) === ":") {
          $this->currPos++;
          $r25 = ":";
          $r25 = false;
          $this->currPos = $p24;
        } else {
          $r25 = self::$FAILED;
          $this->currPos = $p20;
          $r2 = self::$FAILED;
          goto seq_7;
        }
        // free $p24
        $r2 = true;
        seq_7:
        if ($r2!==self::$FAILED) {
          $this->savedPos = $p18;
          $r2 = $this->a56();
          goto choice_2;
        }
        // free $p20
        $p20 = $this->currPos;
        // start seq_8
        $p24 = $this->currPos;
        $p26 = $this->currPos;
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
          $r27 = "__";
          $this->currPos += 2;
          $r27 = false;
          $this->currPos = $p26;
        } else {
          $r27 = self::$FAILED;
          $r2 = self::$FAILED;
          goto seq_8;
        }
        // free $p26
        $r28 = $this->parsebehavior_switch($silence);
        // bs <- $r28
        if ($r28===self::$FAILED) {
          $this->currPos = $p24;
          $r2 = self::$FAILED;
          goto seq_8;
        }
        $r2 = true;
        seq_8:
        if ($r2!==self::$FAILED) {
          $this->savedPos = $p20;
          $r2 = $this->a57($r28);
          goto choice_2;
        }
        // free $p24
        $r2 = $this->parsetext_char($silence);
        choice_2:
      }
    } else {
      $r1 = self::$FAILED;
    }
    // free $r2
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseinline_element($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [316, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r5 = "<";
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r5 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    // start choice_2
    $r6 = $this->parsexmlish_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_2;
    }
    $r6 = $this->parsecomment($silence);
    choice_2:
    // r <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a18($r6);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_2
    $p4 = $this->currPos;
    $p7 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r8 = "{";
      $r8 = false;
      $this->currPos = $p7;
    } else {
      $r8 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p7
    $r9 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // r <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $r1 = true;
    seq_2:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a18($r9);
      goto choice_1;
    }
    // free $p4
    $p4 = $this->currPos;
    // start seq_3
    $p7 = $this->currPos;
    $p10 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
      $r11 = "-{";
      $this->currPos += 2;
      $r11 = false;
      $this->currPos = $p10;
    } else {
      $r11 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_3;
    }
    // free $p10
    $r12 = $this->parselang_variant_or_tpl($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // r <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p7;
      $r1 = self::$FAILED;
      goto seq_3;
    }
    $r1 = true;
    seq_3:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p4;
      $r1 = $this->a18($r12);
      goto choice_1;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_4
    $p10 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r14 = "[[";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(46);}
      $r14 = self::$FAILED;
      $r13 = self::$FAILED;
      goto seq_4;
    }
    $p15 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r16 = "[";
      $r16 = false;
      $this->currPos = $p15;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p10;
      $r13 = self::$FAILED;
      goto seq_4;
    }
    // free $p15
    $r13 = true;
    seq_4:
    if ($r13!==self::$FAILED) {
      $r1 = true;
      while ($r13 !== self::$FAILED) {
        // start seq_5
        $p10 = $this->currPos;
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
          $r17 = "[[";
          $this->currPos += 2;
        } else {
          if (!$silence) {$this->fail(46);}
          $r17 = self::$FAILED;
          $r13 = self::$FAILED;
          goto seq_5;
        }
        $p15 = $this->currPos;
        if (($this->input[$this->currPos] ?? null) === "[") {
          $this->currPos++;
          $r18 = "[";
          $r18 = false;
          $this->currPos = $p15;
        } else {
          $r18 = self::$FAILED;
          $this->currPos = $p10;
          $r13 = self::$FAILED;
          goto seq_5;
        }
        // free $p15
        $r13 = true;
        seq_5:
        // free $p10
      }
    } else {
      $r1 = self::$FAILED;
    }
    // free $p10
    if ($r1!==self::$FAILED) {
      $r1 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r1 = self::$FAILED;
    }
    // free $r13
    // free $p7
    $p7 = $this->currPos;
    // start seq_6
    $p10 = $this->currPos;
    $p15 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r13 = "[";
      $r13 = false;
      $this->currPos = $p15;
    } else {
      $r13 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_6;
    }
    // free $p15
    // start choice_3
    $r19 = $this->parsewikilink($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    if ($r19!==self::$FAILED) {
      goto choice_3;
    }
    $r19 = $this->parseextlink($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_3:
    // r <- $r19
    if ($r19===self::$FAILED) {
      $this->currPos = $p10;
      $r1 = self::$FAILED;
      goto seq_6;
    }
    $r1 = true;
    seq_6:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p7;
      $r1 = $this->a18($r19);
      goto choice_1;
    }
    // free $p10
    $p10 = $this->currPos;
    // start seq_7
    $p15 = $this->currPos;
    $p20 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r21 = "'";
      $r21 = false;
      $this->currPos = $p20;
    } else {
      $r21 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    // free $p20
    $r22 = $this->parsequote($silence);
    // r <- $r22
    if ($r22===self::$FAILED) {
      $this->currPos = $p15;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    $r1 = true;
    seq_7:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p10;
      $r1 = $this->a18($r22);
    }
    // free $p15
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardsof($silence) {
    $key = implode(':', [529, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $this->savedPos = $this->currPos;
    $r1 = $this->a58();
    if ($r1) {
      $r1 = false;
    } else {
      $r1 = self::$FAILED;
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseredirect($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [284, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parseredirect_word($silence);
    // rw <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r7 = $this->discardspace_or_newline($silence);
    while ($r7 !== self::$FAILED) {
      $r7 = $this->discardspace_or_newline($silence);
    }
    // free $r7
    $r5 = true;
    // sp <- $r5
    if ($r5!==self::$FAILED) {
      $r5 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $p6 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r9 = ":";
    } else {
      if (!$silence) {$this->fail(18);}
      $r9 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r11 = $this->discardspace_or_newline($silence);
    while ($r11 !== self::$FAILED) {
      $r11 = $this->discardspace_or_newline($silence);
    }
    // free $r11
    $r10 = true;
    if ($r10===self::$FAILED) {
      $this->currPos = $p8;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $r10
    $r7 = true;
    seq_2:
    if ($r7===self::$FAILED) {
      $r7 = null;
    }
    // free $p8
    // c <- $r7
    $r7 = substr($this->input, $p6, $this->currPos - $p6);
    // free $p6
    $r10 = $this->parsewikilink($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // wl <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r11 = $this->a59($r4, $r5, $r7, $r10);
    if ($r11) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a60($r4, $r5, $r7, $r10);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsecomment_or_includes($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [514, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = [];
    // start choice_1
    $r2 = $this->parsecomment($silence);
    if ($r2!==self::$FAILED) {
      goto choice_1;
    }
    $r2 = $this->parseinclude_limits($silence, $boolParams | 0x2000, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    while ($r2 !== self::$FAILED) {
      $r1[] = $r2;
      // start choice_2
      $r2 = $this->parsecomment($silence);
      if ($r2!==self::$FAILED) {
        goto choice_2;
      }
      $r2 = $this->parseinclude_limits($silence, $boolParams | 0x2000, $param_templatedepth, $param_preproc, $param_th);
      choice_2:
    }
    // free $r2
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseblock_line($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [306, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $r1 = $this->parseheading($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parselist_item($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsehr($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parseoptionalSpaceToken($silence);
    // st <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    if (strspn($this->input, " <{}|!", $this->currPos, 1) !== 0) {
      $r9 = $this->input[$this->currPos++];
      $r9 = false;
      $this->currPos = $p8;
    } else {
      $r9 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p8
    $r10 = $this->parsetable_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // tl <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a61($r4, $r10);
      goto choice_2;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_3
    $p8 = $this->currPos;
    $p13 = $this->currPos;
    // start seq_4
    $p14 = $this->currPos;
    $r15 = $this->parseblock_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // bt <- $r15
    if ($r15===self::$FAILED) {
      $r12 = self::$FAILED;
      goto seq_4;
    }
    $r16 = $this->parseoptionalSpaceToken($silence);
    // stl <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p14;
      $r12 = self::$FAILED;
      goto seq_4;
    }
    $r12 = true;
    seq_4:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p13;
      $r12 = $this->a62($r4, $r15, $r16);
      $r11 = [];
      while ($r12 !== self::$FAILED) {
        $r11[] = $r12;
        $p14 = $this->currPos;
        // start seq_5
        $p17 = $this->currPos;
        $r18 = $this->parseblock_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        // bt <- $r18
        if ($r18===self::$FAILED) {
          $r12 = self::$FAILED;
          goto seq_5;
        }
        $r19 = $this->parseoptionalSpaceToken($silence);
        // stl <- $r19
        if ($r19===self::$FAILED) {
          $this->currPos = $p17;
          $r12 = self::$FAILED;
          goto seq_5;
        }
        $r12 = true;
        seq_5:
        if ($r12!==self::$FAILED) {
          $this->savedPos = $p14;
          $r12 = $this->a62($r4, $r18, $r19);
        }
        // free $p17
      }
    } else {
      $r11 = self::$FAILED;
    }
    // free $p14
    // bts <- $r11
    if ($r11===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_3;
    }
    // free $r12
    $p17 = $this->currPos;
    $r12 = $this->discardeolf(true);
    if ($r12!==self::$FAILED) {
      $r12 = false;
      $this->currPos = $p17;
    } else {
      $this->currPos = $p8;
      $r5 = self::$FAILED;
      goto seq_3;
    }
    // free $p17
    $r5 = true;
    seq_3:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p7;
      $r5 = $this->a63($r4, $r11);
    }
    // free $p8
    choice_2:
    // r <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a64($r4, $r5);
    }
    // free $p3
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseblock_lines($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [302, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // s <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $r8 = $this->parseoptionalSpaceToken($silence);
    // os <- $r8
    if ($r8===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r9 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // so <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a65($r4, $r8, $r9);
    } else {
      $r5 = null;
    }
    // free $p7
    // s2 <- $r5
    $r10 = $this->parseblock_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // bl <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a66($r4, $r5, $r10);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardeolf($silence) {
    $key = implode(':', [537, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->discardnewline($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->discardeof($silence);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseblock_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [426, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r4 = "<";
    } else {
      if (!$silence) {$this->fail(47);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    $r5 = $this->parsexmlish_tag_opened($silence, $boolParams | 0xc00, $param_templatedepth, $param_preproc, $param_th);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $r5 = $this->parsexmlish_tag_opened($silence, ($boolParams & ~0x800) | 0x400, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    // tag <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a67($r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseparagraph($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [308, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // s1 <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // s2 <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // c <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a68($r4, $r5, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsesol($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [516, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start seq_1
    $p1 = $this->currPos;
    // start choice_1
    $r3 = $this->parseempty_line_with_comments($silence);
    if ($r3!==self::$FAILED) {
      goto choice_1;
    }
    $r3 = $this->parsesol_prefix($silence);
    choice_1:
    if ($r3===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r4 = $this->parsecomment_or_includes($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4===self::$FAILED) {
      $this->currPos = $p1;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = [$r3,$r4];
    seq_1:
    // free $r2,$p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function discardtplarg($silence, $boolParams, $param_templatedepth, &$param_th) {
    $key = implode(':', [357, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_th=$param_th;
    $r1 = $this->discardtplarg_preproc($silence, $boolParams, $param_templatedepth, self::newRef("}}"), $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetemplate($silence, $boolParams, $param_templatedepth, &$param_th) {
    $key = implode(':', [350, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_th=$param_th;
    $r1 = $this->parsetemplate_preproc($silence, $boolParams, $param_templatedepth, self::newRef("}}"), $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsebroken_template($silence, &$param_preproc) {
    $key = implode(':', [352, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    // t <- $r4
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r4 = "{{";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(48);}
      $r4 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a69($param_preproc, $r4);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetplarg($silence, $boolParams, $param_templatedepth, &$param_th) {
    $key = implode(':', [356, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_th=$param_th;
    $r1 = $this->parsetplarg_preproc($silence, $boolParams, $param_templatedepth, self::newRef("}}"), $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardwikilink($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [399, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    // start choice_1
    $r1 = $this->discardwikilink_preproc($silence, $boolParams, $param_templatedepth, self::newRef("]]"), $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->discardbroken_wikilink($silence, $boolParams, $param_preproc, $param_templatedepth, $param_th);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsedirective($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [540, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $r1 = $this->parsecomment($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parseextension_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
      $r5 = "-{";
      $this->currPos += 2;
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r5 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r6 = $this->parselang_variant_or_tpl($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // v <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a70($r6);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_2
    $p4 = $this->currPos;
    $p7 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r8 = "&";
      $r8 = false;
      $this->currPos = $p7;
    } else {
      $r8 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p7
    $r9 = $this->parsehtmlentity($silence);
    // e <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $r1 = true;
    seq_2:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a71($r9);
      goto choice_1;
    }
    // free $p4
    $r1 = $this->parseinclude_limits($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardxmlish_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [423, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r4 = "<";
    } else {
      if (!$silence) {$this->fail(47);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    $r5 = $this->parsexmlish_tag_opened($silence, ($boolParams & ~0x400) | 0x800, $param_templatedepth, $param_preproc, $param_th);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $r5 = $this->parsexmlish_tag_opened($silence, $boolParams & ~0xc00, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    // tag <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a67($r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_attribute_preprocessor_text_single($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [556, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = [];
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, "{}&<-!['\x0d\x0a|", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        if (strcspn($this->input, "{}&<-!['\x0d\x0a|", $this->currPos, 1) !== 0) {
          $r6 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(49);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(49);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r9 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
      $r9 = $this->input[$this->currPos++];
    } else {
      $r9 = self::$FAILED;
      if (!$silence) {$this->fail(50);}
    }
    choice_2:
    // s <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r9);
    }
    // free $p7
    choice_1:
    while ($r4 !== self::$FAILED) {
      $r3[] = $r4;
      // start choice_3
      $p7 = $this->currPos;
      if (strcspn($this->input, "{}&<-!['\x0d\x0a|", $this->currPos, 1) !== 0) {
        $r10 = self::consumeChar($this->input, $this->currPos);
        $r4 = true;
        while ($r10 !== self::$FAILED) {
          if (strcspn($this->input, "{}&<-!['\x0d\x0a|", $this->currPos, 1) !== 0) {
            $r10 = self::consumeChar($this->input, $this->currPos);
          } else {
            $r10 = self::$FAILED;
            if (!$silence) {$this->fail(49);}
          }
        }
      } else {
        $r10 = self::$FAILED;
        if (!$silence) {$this->fail(49);}
        $r4 = self::$FAILED;
      }
      if ($r4!==self::$FAILED) {
        $r4 = substr($this->input, $p7, $this->currPos - $p7);
        goto choice_3;
      } else {
        $r4 = self::$FAILED;
      }
      // free $r10
      // free $p7
      $p7 = $this->currPos;
      // start seq_2
      $p8 = $this->currPos;
      $p11 = $this->currPos;
      $r10 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r10 === self::$FAILED) {
        $r10 = false;
      } else {
        $r10 = self::$FAILED;
        $this->currPos = $p11;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      // free $p11
      // start choice_4
      $r12 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r12!==self::$FAILED) {
        goto choice_4;
      }
      if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
        $r12 = $this->input[$this->currPos++];
      } else {
        $r12 = self::$FAILED;
        if (!$silence) {$this->fail(50);}
      }
      choice_4:
      // s <- $r12
      if ($r12===self::$FAILED) {
        $this->currPos = $p8;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      $r4 = true;
      seq_2:
      if ($r4!==self::$FAILED) {
        $this->savedPos = $p7;
        $r4 = $this->a43($r12);
      }
      // free $p8
      choice_3:
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_attribute_preprocessor_text_double($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [558, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = [];
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, "{}&<-![\"\x0d\x0a|", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        if (strcspn($this->input, "{}&<-![\"\x0d\x0a|", $this->currPos, 1) !== 0) {
          $r6 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(51);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(51);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r9 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
      $r9 = $this->input[$this->currPos++];
    } else {
      $r9 = self::$FAILED;
      if (!$silence) {$this->fail(50);}
    }
    choice_2:
    // s <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r9);
    }
    // free $p7
    choice_1:
    while ($r4 !== self::$FAILED) {
      $r3[] = $r4;
      // start choice_3
      $p7 = $this->currPos;
      if (strcspn($this->input, "{}&<-![\"\x0d\x0a|", $this->currPos, 1) !== 0) {
        $r10 = self::consumeChar($this->input, $this->currPos);
        $r4 = true;
        while ($r10 !== self::$FAILED) {
          if (strcspn($this->input, "{}&<-![\"\x0d\x0a|", $this->currPos, 1) !== 0) {
            $r10 = self::consumeChar($this->input, $this->currPos);
          } else {
            $r10 = self::$FAILED;
            if (!$silence) {$this->fail(51);}
          }
        }
      } else {
        $r10 = self::$FAILED;
        if (!$silence) {$this->fail(51);}
        $r4 = self::$FAILED;
      }
      if ($r4!==self::$FAILED) {
        $r4 = substr($this->input, $p7, $this->currPos - $p7);
        goto choice_3;
      } else {
        $r4 = self::$FAILED;
      }
      // free $r10
      // free $p7
      $p7 = $this->currPos;
      // start seq_2
      $p8 = $this->currPos;
      $p11 = $this->currPos;
      $r10 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r10 === self::$FAILED) {
        $r10 = false;
      } else {
        $r10 = self::$FAILED;
        $this->currPos = $p11;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      // free $p11
      // start choice_4
      $r12 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r12!==self::$FAILED) {
        goto choice_4;
      }
      if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
        $r12 = $this->input[$this->currPos++];
      } else {
        $r12 = self::$FAILED;
        if (!$silence) {$this->fail(50);}
      }
      choice_4:
      // s <- $r12
      if ($r12===self::$FAILED) {
        $this->currPos = $p8;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      $r4 = true;
      seq_2:
      if ($r4!==self::$FAILED) {
        $this->savedPos = $p7;
        $r4 = $this->a43($r12);
      }
      // free $p8
      choice_3:
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_attribute_preprocessor_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [554, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, "{}&<-![ \x09\x0a\x0d\x0c|", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        if (strcspn($this->input, "{}&<-![ \x09\x0a\x0d\x0c|", $this->currPos, 1) !== 0) {
          $r6 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(52);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(52);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r9 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
      $r9 = $this->input[$this->currPos++];
    } else {
      $r9 = self::$FAILED;
      if (!$silence) {$this->fail(50);}
    }
    choice_2:
    // s <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r9);
    }
    // free $p7
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_3
        $p7 = $this->currPos;
        if (strcspn($this->input, "{}&<-![ \x09\x0a\x0d\x0c|", $this->currPos, 1) !== 0) {
          $r10 = self::consumeChar($this->input, $this->currPos);
          $r4 = true;
          while ($r10 !== self::$FAILED) {
            if (strcspn($this->input, "{}&<-![ \x09\x0a\x0d\x0c|", $this->currPos, 1) !== 0) {
              $r10 = self::consumeChar($this->input, $this->currPos);
            } else {
              $r10 = self::$FAILED;
              if (!$silence) {$this->fail(52);}
            }
          }
        } else {
          $r10 = self::$FAILED;
          if (!$silence) {$this->fail(52);}
          $r4 = self::$FAILED;
        }
        if ($r4!==self::$FAILED) {
          $r4 = substr($this->input, $p7, $this->currPos - $p7);
          goto choice_3;
        } else {
          $r4 = self::$FAILED;
        }
        // free $r10
        // free $p7
        $p7 = $this->currPos;
        // start seq_2
        $p8 = $this->currPos;
        $p11 = $this->currPos;
        $r10 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r10 === self::$FAILED) {
          $r10 = false;
        } else {
          $r10 = self::$FAILED;
          $this->currPos = $p11;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        // free $p11
        // start choice_4
        $r12 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r12!==self::$FAILED) {
          goto choice_4;
        }
        if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
          $r12 = $this->input[$this->currPos++];
        } else {
          $r12 = self::$FAILED;
          if (!$silence) {$this->fail(50);}
        }
        choice_4:
        // s <- $r12
        if ($r12===self::$FAILED) {
          $this->currPos = $p8;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        $r4 = true;
        seq_2:
        if ($r4!==self::$FAILED) {
          $this->savedPos = $p7;
          $r4 = $this->a43($r12);
        }
        // free $p8
        choice_3:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseless_than($silence, $boolParams) {
    $key = implode(':', [432, $this->currPos, $boolParams & 0x800]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (/*extTag*/($boolParams & 0x800) !== 0) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r5 = "<";
    } else {
      if (!$silence) {$this->fail(47);}
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $p3
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parseattribute_preprocessor_text_single($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [550, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = [];
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, "{}&<-|/'>", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        if (strcspn($this->input, "{}&<-|/'>", $this->currPos, 1) !== 0) {
          $r6 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(53);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(53);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    $p8 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
      $r9 = "/>";
      $this->currPos += 2;
    } else {
      $r9 = self::$FAILED;
    }
    if ($r9 === self::$FAILED) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p8;
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r10 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    $r10 = $this->parseless_than($silence, $boolParams);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
      $r10 = $this->input[$this->currPos++];
    } else {
      $r10 = self::$FAILED;
      if (!$silence) {$this->fail(54);}
    }
    choice_2:
    // s <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r10);
    }
    // free $p7
    choice_1:
    while ($r4 !== self::$FAILED) {
      $r3[] = $r4;
      // start choice_3
      $p7 = $this->currPos;
      if (strcspn($this->input, "{}&<-|/'>", $this->currPos, 1) !== 0) {
        $r11 = self::consumeChar($this->input, $this->currPos);
        $r4 = true;
        while ($r11 !== self::$FAILED) {
          if (strcspn($this->input, "{}&<-|/'>", $this->currPos, 1) !== 0) {
            $r11 = self::consumeChar($this->input, $this->currPos);
          } else {
            $r11 = self::$FAILED;
            if (!$silence) {$this->fail(53);}
          }
        }
      } else {
        $r11 = self::$FAILED;
        if (!$silence) {$this->fail(53);}
        $r4 = self::$FAILED;
      }
      if ($r4!==self::$FAILED) {
        $r4 = substr($this->input, $p7, $this->currPos - $p7);
        goto choice_3;
      } else {
        $r4 = self::$FAILED;
      }
      // free $r11
      // free $p7
      $p7 = $this->currPos;
      // start seq_2
      $p8 = $this->currPos;
      $p12 = $this->currPos;
      $r11 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r11 === self::$FAILED) {
        $r11 = false;
      } else {
        $r11 = self::$FAILED;
        $this->currPos = $p12;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      // free $p12
      $p12 = $this->currPos;
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
        $r13 = "/>";
        $this->currPos += 2;
      } else {
        $r13 = self::$FAILED;
      }
      if ($r13 === self::$FAILED) {
        $r13 = false;
      } else {
        $r13 = self::$FAILED;
        $this->currPos = $p12;
        $this->currPos = $p8;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      // free $p12
      // start choice_4
      $r14 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r14!==self::$FAILED) {
        goto choice_4;
      }
      $r14 = $this->parseless_than($silence, $boolParams);
      if ($r14!==self::$FAILED) {
        goto choice_4;
      }
      if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
        $r14 = $this->input[$this->currPos++];
      } else {
        $r14 = self::$FAILED;
        if (!$silence) {$this->fail(54);}
      }
      choice_4:
      // s <- $r14
      if ($r14===self::$FAILED) {
        $this->currPos = $p8;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      $r4 = true;
      seq_2:
      if ($r4!==self::$FAILED) {
        $this->savedPos = $p7;
        $r4 = $this->a43($r14);
      }
      // free $p8
      choice_3:
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseattribute_preprocessor_text_double($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [552, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = [];
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, "{}&<-|/\">", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        if (strcspn($this->input, "{}&<-|/\">", $this->currPos, 1) !== 0) {
          $r6 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(55);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(55);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    $p8 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
      $r9 = "/>";
      $this->currPos += 2;
    } else {
      $r9 = self::$FAILED;
    }
    if ($r9 === self::$FAILED) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p8;
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r10 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    $r10 = $this->parseless_than($silence, $boolParams);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
      $r10 = $this->input[$this->currPos++];
    } else {
      $r10 = self::$FAILED;
      if (!$silence) {$this->fail(54);}
    }
    choice_2:
    // s <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r10);
    }
    // free $p7
    choice_1:
    while ($r4 !== self::$FAILED) {
      $r3[] = $r4;
      // start choice_3
      $p7 = $this->currPos;
      if (strcspn($this->input, "{}&<-|/\">", $this->currPos, 1) !== 0) {
        $r11 = self::consumeChar($this->input, $this->currPos);
        $r4 = true;
        while ($r11 !== self::$FAILED) {
          if (strcspn($this->input, "{}&<-|/\">", $this->currPos, 1) !== 0) {
            $r11 = self::consumeChar($this->input, $this->currPos);
          } else {
            $r11 = self::$FAILED;
            if (!$silence) {$this->fail(55);}
          }
        }
      } else {
        $r11 = self::$FAILED;
        if (!$silence) {$this->fail(55);}
        $r4 = self::$FAILED;
      }
      if ($r4!==self::$FAILED) {
        $r4 = substr($this->input, $p7, $this->currPos - $p7);
        goto choice_3;
      } else {
        $r4 = self::$FAILED;
      }
      // free $r11
      // free $p7
      $p7 = $this->currPos;
      // start seq_2
      $p8 = $this->currPos;
      $p12 = $this->currPos;
      $r11 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r11 === self::$FAILED) {
        $r11 = false;
      } else {
        $r11 = self::$FAILED;
        $this->currPos = $p12;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      // free $p12
      $p12 = $this->currPos;
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
        $r13 = "/>";
        $this->currPos += 2;
      } else {
        $r13 = self::$FAILED;
      }
      if ($r13 === self::$FAILED) {
        $r13 = false;
      } else {
        $r13 = self::$FAILED;
        $this->currPos = $p12;
        $this->currPos = $p8;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      // free $p12
      // start choice_4
      $r14 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r14!==self::$FAILED) {
        goto choice_4;
      }
      $r14 = $this->parseless_than($silence, $boolParams);
      if ($r14!==self::$FAILED) {
        goto choice_4;
      }
      if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
        $r14 = $this->input[$this->currPos++];
      } else {
        $r14 = self::$FAILED;
        if (!$silence) {$this->fail(54);}
      }
      choice_4:
      // s <- $r14
      if ($r14===self::$FAILED) {
        $this->currPos = $p8;
        $r4 = self::$FAILED;
        goto seq_2;
      }
      $r4 = true;
      seq_2:
      if ($r4!==self::$FAILED) {
        $this->savedPos = $p7;
        $r4 = $this->a43($r14);
      }
      // free $p8
      choice_3:
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseattribute_preprocessor_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [548, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $p5 = $this->currPos;
    if (strcspn($this->input, "{}&<-|/ \x09\x0a\x0d\x0c>", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
      $r4 = true;
      while ($r6 !== self::$FAILED) {
        if (strcspn($this->input, "{}&<-|/ \x09\x0a\x0d\x0c>", $this->currPos, 1) !== 0) {
          $r6 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(56);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(56);}
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
    }
    // free $r6
    // free $p5
    $p5 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r6 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    $p8 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
      $r9 = "/>";
      $this->currPos += 2;
    } else {
      $r9 = self::$FAILED;
    }
    if ($r9 === self::$FAILED) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p8;
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    // start choice_2
    $r10 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    $r10 = $this->parseless_than($silence, $boolParams);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
      $r10 = $this->input[$this->currPos++];
    } else {
      $r10 = self::$FAILED;
      if (!$silence) {$this->fail(54);}
    }
    choice_2:
    // s <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a43($r10);
    }
    // free $p7
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_3
        $p7 = $this->currPos;
        if (strcspn($this->input, "{}&<-|/ \x09\x0a\x0d\x0c>", $this->currPos, 1) !== 0) {
          $r11 = self::consumeChar($this->input, $this->currPos);
          $r4 = true;
          while ($r11 !== self::$FAILED) {
            if (strcspn($this->input, "{}&<-|/ \x09\x0a\x0d\x0c>", $this->currPos, 1) !== 0) {
              $r11 = self::consumeChar($this->input, $this->currPos);
            } else {
              $r11 = self::$FAILED;
              if (!$silence) {$this->fail(56);}
            }
          }
        } else {
          $r11 = self::$FAILED;
          if (!$silence) {$this->fail(56);}
          $r4 = self::$FAILED;
        }
        if ($r4!==self::$FAILED) {
          $r4 = substr($this->input, $p7, $this->currPos - $p7);
          goto choice_3;
        } else {
          $r4 = self::$FAILED;
        }
        // free $r11
        // free $p7
        $p7 = $this->currPos;
        // start seq_2
        $p8 = $this->currPos;
        $p12 = $this->currPos;
        $r11 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r11 === self::$FAILED) {
          $r11 = false;
        } else {
          $r11 = self::$FAILED;
          $this->currPos = $p12;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        // free $p12
        $p12 = $this->currPos;
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
          $r13 = "/>";
          $this->currPos += 2;
        } else {
          $r13 = self::$FAILED;
        }
        if ($r13 === self::$FAILED) {
          $r13 = false;
        } else {
          $r13 = self::$FAILED;
          $this->currPos = $p12;
          $this->currPos = $p8;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        // free $p12
        // start choice_4
        $r14 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r14!==self::$FAILED) {
          goto choice_4;
        }
        $r14 = $this->parseless_than($silence, $boolParams);
        if ($r14!==self::$FAILED) {
          goto choice_4;
        }
        if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
          $r14 = $this->input[$this->currPos++];
        } else {
          $r14 = self::$FAILED;
          if (!$silence) {$this->fail(54);}
        }
        choice_4:
        // s <- $r14
        if ($r14===self::$FAILED) {
          $this->currPos = $p8;
          $r4 = self::$FAILED;
          goto seq_2;
        }
        $r4 = true;
        seq_2:
        if ($r4!==self::$FAILED) {
          $this->savedPos = $p7;
          $r4 = $this->a43($r14);
        }
        // free $p8
        choice_3:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a53($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseautolink($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [326, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (!(/*extlink*/($boolParams & 0x4) !== 0)) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r5 = $this->a72();
    if (!$r5) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    $p7 = $this->currPos;
    $r8 = $this->parseautourl($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // target <- $r8
    $r6 = $r8;
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a73($r8);
      goto choice_1;
    }
    $r6 = $this->parseautoref($silence);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    $r6 = $this->parseisbn($silence);
    choice_1:
    // r <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a18($r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsebehavior_switch($silence) {
    $key = implode(':', [322, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_1
    $p5 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r6 = "__";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(57);}
      $r6 = self::$FAILED;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->discardbehavior_text($silence);
    if ($r7===self::$FAILED) {
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r8 = "__";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(57);}
      $r8 = self::$FAILED;
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r3 = true;
    seq_1:
    // bs <- $r3
    if ($r3!==self::$FAILED) {
      $r3 = substr($this->input, $p4, $this->currPos - $p4);
    } else {
      $r3 = self::$FAILED;
    }
    // free $p5
    // free $p4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a74($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetext_char($silence) {
    $key = implode(':', [486, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    if (strcspn($this->input, "-'<~[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
      $r1 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(58);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsexmlish_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [422, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r4 = "<";
    } else {
      if (!$silence) {$this->fail(47);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    $r5 = $this->parsexmlish_tag_opened($silence, ($boolParams & ~0x400) | 0x800, $param_templatedepth, $param_preproc, $param_th);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $r5 = $this->parsexmlish_tag_opened($silence, $boolParams & ~0xc00, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    // tag <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a67($r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_or_tpl($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [368, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
      $r7 = "-{";
      $this->currPos += 2;
    } else {
      $r7 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $p8 = $this->currPos;
    // start seq_3
    $p10 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r12 = "{{{";
      $this->currPos += 3;
      $r11 = true;
      while ($r12 !== self::$FAILED) {
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
          $r12 = "{{{";
          $this->currPos += 3;
        } else {
          $r12 = self::$FAILED;
        }
      }
    } else {
      $r12 = self::$FAILED;
      $r11 = self::$FAILED;
    }
    if ($r11===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_3;
    }
    // free $r12
    $p13 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r12 = "{";
    } else {
      $r12 = self::$FAILED;
    }
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p13;
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    // free $p13
    $r9 = true;
    seq_3:
    if ($r9!==self::$FAILED) {
      $r9 = false;
      $this->currPos = $p8;
    } else {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p10
    // free $p8
    $r14 = $this->discardtplarg(true, $boolParams, $param_templatedepth, $param_th);
    if ($r14===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // free $p4
    $r15 = $this->parselang_variant($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // a <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a44($r15);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_4
    $p4 = $this->currPos;
    $p6 = $this->currPos;
    // start seq_5
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r17 = "-";
    } else {
      if (!$silence) {$this->fail(59);}
      $r17 = self::$FAILED;
      $r16 = self::$FAILED;
      goto seq_5;
    }
    $p10 = $this->currPos;
    // start seq_6
    $p13 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r20 = "{{{";
      $this->currPos += 3;
      $r19 = true;
      while ($r20 !== self::$FAILED) {
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
          $r20 = "{{{";
          $this->currPos += 3;
        } else {
          $r20 = self::$FAILED;
        }
      }
    } else {
      $r20 = self::$FAILED;
      $r19 = self::$FAILED;
    }
    if ($r19===self::$FAILED) {
      $r18 = self::$FAILED;
      goto seq_6;
    }
    // free $r20
    $p21 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r20 = "{";
    } else {
      $r20 = self::$FAILED;
    }
    if ($r20 === self::$FAILED) {
      $r20 = false;
    } else {
      $r20 = self::$FAILED;
      $this->currPos = $p21;
      $this->currPos = $p13;
      $r18 = self::$FAILED;
      goto seq_6;
    }
    // free $p21
    $r18 = true;
    seq_6:
    if ($r18!==self::$FAILED) {
      $r18 = false;
      $this->currPos = $p10;
    } else {
      $this->currPos = $p8;
      $r16 = self::$FAILED;
      goto seq_5;
    }
    // free $p13
    // free $p10
    $r16 = true;
    seq_5:
    // a <- $r16
    if ($r16!==self::$FAILED) {
      $r16 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r16 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_4;
    }
    // free $p8
    // free $p6
    $r22 = $this->parsetplarg($silence, $boolParams, $param_templatedepth, $param_th);
    // b <- $r22
    if ($r22===self::$FAILED) {
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_4;
    }
    $r1 = true;
    seq_4:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a45($r16, $r22);
      goto choice_1;
    }
    // free $p4
    $p4 = $this->currPos;
    // start seq_7
    $p6 = $this->currPos;
    $p8 = $this->currPos;
    // start seq_8
    $p10 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r24 = "-";
    } else {
      if (!$silence) {$this->fail(59);}
      $r24 = self::$FAILED;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    $p13 = $this->currPos;
    // start seq_9
    $p21 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r26 = "{{";
      $this->currPos += 2;
    } else {
      $r26 = self::$FAILED;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r28 = "{{{";
      $this->currPos += 3;
    } else {
      $r28 = self::$FAILED;
    }
    while ($r28 !== self::$FAILED) {
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
        $r28 = "{{{";
        $this->currPos += 3;
      } else {
        $r28 = self::$FAILED;
      }
    }
    // free $r28
    $r27 = true;
    if ($r27===self::$FAILED) {
      $this->currPos = $p21;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    // free $r27
    $p29 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r27 = "{";
    } else {
      $r27 = self::$FAILED;
    }
    if ($r27 === self::$FAILED) {
      $r27 = false;
    } else {
      $r27 = self::$FAILED;
      $this->currPos = $p29;
      $this->currPos = $p21;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    // free $p29
    $r25 = true;
    seq_9:
    if ($r25!==self::$FAILED) {
      $r25 = false;
      $this->currPos = $p13;
    } else {
      $this->currPos = $p10;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    // free $p21
    // free $p13
    $r23 = true;
    seq_8:
    // a <- $r23
    if ($r23!==self::$FAILED) {
      $r23 = substr($this->input, $p8, $this->currPos - $p8);
    } else {
      $r23 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    // free $p10
    // free $p8
    $r28 = $this->parsetemplate($silence, $boolParams, $param_templatedepth, $param_th);
    // b <- $r28
    if ($r28===self::$FAILED) {
      $this->currPos = $p6;
      $r1 = self::$FAILED;
      goto seq_7;
    }
    $r1 = true;
    seq_7:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p4;
      $r1 = $this->a45($r23, $r28);
      goto choice_1;
    }
    // free $p6
    $p6 = $this->currPos;
    // start seq_10
    $p8 = $this->currPos;
    $p10 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
      $r30 = "-{";
      $this->currPos += 2;
      $r30 = false;
      $this->currPos = $p10;
    } else {
      $r30 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_10;
    }
    // free $p10
    $r31 = $this->parselang_variant($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // a <- $r31
    if ($r31===self::$FAILED) {
      $this->currPos = $p8;
      $r1 = self::$FAILED;
      goto seq_10;
    }
    $r1 = true;
    seq_10:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p6;
      $r1 = $this->a44($r31);
    }
    // free $p8
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsewikilink($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [398, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    // start choice_1
    $r1 = $this->parsewikilink_preproc($silence, $boolParams, $param_templatedepth, self::newRef("]]"), $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsebroken_wikilink($silence, $boolParams, $param_preproc, $param_templatedepth, $param_th);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsequote($silence) {
    $key = implode(':', [408, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_1
    $p5 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "''", $this->currPos, 2, false) === 0) {
      $r6 = "''";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(60);}
      $r6 = self::$FAILED;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r8 = "'";
    } else {
      if (!$silence) {$this->fail(35);}
      $r8 = self::$FAILED;
    }
    while ($r8 !== self::$FAILED) {
      if (($this->input[$this->currPos] ?? null) === "'") {
        $this->currPos++;
        $r8 = "'";
      } else {
        if (!$silence) {$this->fail(35);}
        $r8 = self::$FAILED;
      }
    }
    // free $r8
    $r7 = true;
    if ($r7===self::$FAILED) {
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    // free $r7
    $r3 = true;
    seq_1:
    // quotes <- $r3
    if ($r3!==self::$FAILED) {
      $r3 = substr($this->input, $p4, $this->currPos - $p4);
    } else {
      $r3 = self::$FAILED;
    }
    // free $p5
    // free $p4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a75($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseredirect_word($silence) {
    $key = implode(':', [290, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (strspn($this->input, " \x09\x0a\x0d\x00\x0b", $this->currPos, 1) !== 0) {
      $r5 = $this->input[$this->currPos++];
    } else {
      $r5 = self::$FAILED;
      if (!$silence) {$this->fail(61);}
    }
    while ($r5 !== self::$FAILED) {
      if (strspn($this->input, " \x09\x0a\x0d\x00\x0b", $this->currPos, 1) !== 0) {
        $r5 = $this->input[$this->currPos++];
      } else {
        $r5 = self::$FAILED;
        if (!$silence) {$this->fail(61);}
      }
    }
    // free $r5
    $r4 = true;
    if ($r4===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $r4
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    $r9 = $this->discardspace_or_newline(true);
    if ($r9 === self::$FAILED) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p8;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p8
    $p8 = $this->currPos;
    $r10 = $this->input[$this->currPos] ?? '';
    if ($r10 === ":" || $r10 === "[") {
      $this->currPos++;
    } else {
      $r10 = self::$FAILED;
    }
    if ($r10 === self::$FAILED) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $this->currPos = $p8;
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p8
    if ($this->currPos < $this->inputLength) {
      $r11 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $r4 = true;
      while ($r5 !== self::$FAILED) {
        // start seq_3
        $p7 = $this->currPos;
        $p8 = $this->currPos;
        $r12 = $this->discardspace_or_newline(true);
        if ($r12 === self::$FAILED) {
          $r12 = false;
        } else {
          $r12 = self::$FAILED;
          $this->currPos = $p8;
          $r5 = self::$FAILED;
          goto seq_3;
        }
        // free $p8
        $p8 = $this->currPos;
        $r13 = $this->input[$this->currPos] ?? '';
        if ($r13 === ":" || $r13 === "[") {
          $this->currPos++;
        } else {
          $r13 = self::$FAILED;
        }
        if ($r13 === self::$FAILED) {
          $r13 = false;
        } else {
          $r13 = self::$FAILED;
          $this->currPos = $p8;
          $this->currPos = $p7;
          $r5 = self::$FAILED;
          goto seq_3;
        }
        // free $p8
        if ($this->currPos < $this->inputLength) {
          $r14 = self::consumeChar($this->input, $this->currPos);;
        } else {
          $r14 = self::$FAILED;
          if (!$silence) {$this->fail(7);}
          $this->currPos = $p7;
          $r5 = self::$FAILED;
          goto seq_3;
        }
        $r5 = true;
        seq_3:
        // free $p7
      }
    } else {
      $r4 = self::$FAILED;
    }
    // free $p7
    // rw <- $r4
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r4 = self::$FAILED;
      $this->currPos = $p3;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $r5
    // free $p6
    $this->savedPos = $this->currPos;
    $r5 = $this->a76($r4);
    if ($r5) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $p3
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parseinclude_limits($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [526, $this->currPos, $boolParams & 0x33ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r7 = "<";
    } else {
      $r7 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r8 = "/";
    } else {
      $r8 = self::$FAILED;
      $r8 = null;
    }
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "includeonly", $this->currPos, 11, true) === 0) {
      $r9 = substr($this->input, $this->currPos, 11);
      $this->currPos += 11;
      goto choice_1;
    } else {
      $r9 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "noinclude", $this->currPos, 9, true) === 0) {
      $r9 = substr($this->input, $this->currPos, 9);
      $this->currPos += 9;
      goto choice_1;
    } else {
      $r9 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "onlyinclude", $this->currPos, 11, true) === 0) {
      $r9 = substr($this->input, $this->currPos, 11);
      $this->currPos += 11;
    } else {
      $r9 = self::$FAILED;
    }
    choice_1:
    // n <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // free $p4
    $r10 = $this->parsexmlish_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // il <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r11 = $this->a77($r10, /*sol_il*/($boolParams & 0x2000) !== 0);
    if ($r11) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a78($r10, /*sol_il*/($boolParams & 0x2000) !== 0);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseheading($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [318, $this->currPos, $boolParams & 0x1bfc, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r5 = "=";
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r5 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $p4 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $p9 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r10 = "=";
      $r8 = true;
      while ($r10 !== self::$FAILED) {
        if (($this->input[$this->currPos] ?? null) === "=") {
          $this->currPos++;
          $r10 = "=";
        } else {
          if (!$silence) {$this->fail(23);}
          $r10 = self::$FAILED;
        }
      }
    } else {
      if (!$silence) {$this->fail(23);}
      $r10 = self::$FAILED;
      $r8 = self::$FAILED;
    }
    // s <- $r8
    if ($r8!==self::$FAILED) {
      $r8 = substr($this->input, $p9, $this->currPos - $p9);
    } else {
      $r8 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $r10
    // free $p9
    // start seq_3
    $p9 = $this->currPos;
    $p12 = $this->currPos;
    $r13 = $this->parseinlineline($silence, $boolParams | 0x2, $param_templatedepth, $param_preproc, $param_th);
    if ($r13===self::$FAILED) {
      $r13 = null;
    }
    // ill <- $r13
    $r11 = $r13;
    if ($r11!==self::$FAILED) {
      $this->savedPos = $p12;
      $r11 = $this->a79($r8, $r13);
    } else {
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $p14 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r16 = "=";
      $r15 = true;
      while ($r16 !== self::$FAILED) {
        if (($this->input[$this->currPos] ?? null) === "=") {
          $this->currPos++;
          $r16 = "=";
        } else {
          if (!$silence) {$this->fail(23);}
          $r16 = self::$FAILED;
        }
      }
    } else {
      if (!$silence) {$this->fail(23);}
      $r16 = self::$FAILED;
      $r15 = self::$FAILED;
    }
    if ($r15!==self::$FAILED) {
      $r15 = substr($this->input, $p14, $this->currPos - $p14);
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p9;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    // free $r16
    // free $p14
    $r10 = [$r11,$r15];
    seq_3:
    if ($r10===self::$FAILED) {
      $r10 = null;
    }
    // free $p9
    // ce <- $r10
    $this->savedPos = $this->currPos;
    $r16 = $this->a80($r8, $r10);
    if ($r16) {
      $r16 = false;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $p9 = $this->currPos;
    $r17 = '';
    // endTPos <- $r17
    if ($r17!==self::$FAILED) {
      $this->savedPos = $p9;
      $r17 = $this->a81($r8, $r10);
    } else {
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r18 = [];
    // start choice_1
    $r19 = $this->parsespaces($silence);
    if ($r19!==self::$FAILED) {
      goto choice_1;
    }
    $r19 = $this->parsecomment($silence);
    choice_1:
    while ($r19 !== self::$FAILED) {
      $r18[] = $r19;
      // start choice_2
      $r19 = $this->parsespaces($silence);
      if ($r19!==self::$FAILED) {
        goto choice_2;
      }
      $r19 = $this->parsecomment($silence);
      choice_2:
    }
    // spc <- $r18
    // free $r19
    $p14 = $this->currPos;
    $r19 = $this->discardeolf(true);
    if ($r19!==self::$FAILED) {
      $r19 = false;
      $this->currPos = $p14;
    } else {
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $p14
    $r6 = true;
    seq_2:
    // r <- $r6
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p4;
      $r6 = $this->a82($r8, $r10, $r17, $r18);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a18($r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselist_item($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [444, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $r1 = $this->parsedtdd($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsehacky_dl_uses($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parseli($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsehr($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [304, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "----", $this->currPos, 4, false) === 0) {
      $r4 = "----";
      $this->currPos += 4;
    } else {
      if (!$silence) {$this->fail(62);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r7 = "-";
    } else {
      if (!$silence) {$this->fail(59);}
      $r7 = self::$FAILED;
    }
    while ($r7 !== self::$FAILED) {
      if (($this->input[$this->currPos] ?? null) === "-") {
        $this->currPos++;
        $r7 = "-";
      } else {
        if (!$silence) {$this->fail(59);}
        $r7 = self::$FAILED;
      }
    }
    // free $r7
    $r5 = true;
    // d <- $r5
    if ($r5!==self::$FAILED) {
      $r5 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // start choice_1
    $p6 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $p9 = $this->currPos;
    $r10 = $this->discardsol(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      $r10 = false;
      $this->currPos = $p9;
    } else {
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p6;
      $r7 = $this->a83($r5);
      goto choice_1;
    }
    // free $p8
    $p8 = $this->currPos;
    $r7 = '';
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a84($r5);
    }
    choice_1:
    // lineContent <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a85($r5, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_line($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [460, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    // start choice_1
    $p5 = $this->currPos;
    $r4 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4 === self::$FAILED) {
      $r4 = false;
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
      $this->currPos = $p5;
    }
    // free $p5
    $p5 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r4 = "{{!}}";
      $this->currPos += 5;
      $r4 = false;
      $this->currPos = $p5;
    } else {
      $r4 = self::$FAILED;
    }
    // free $p5
    choice_1:
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p5 = $this->currPos;
    $r7 = $this->parsetable_start_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r8 = $this->parseoptionalNewlines($silence);
    if ($r8===self::$FAILED) {
      $this->currPos = $p5;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = [$r7,$r8];
    seq_2:
    if ($r6!==self::$FAILED) {
      goto choice_2;
    }
    // free $p5
    // start seq_3
    $p5 = $this->currPos;
    $r9 = $this->parsetable_content_line($silence, $boolParams | 0x10, $param_templatedepth, $param_preproc, $param_th);
    if ($r9===self::$FAILED) {
      $r6 = self::$FAILED;
      goto seq_3;
    }
    $r10 = $this->parseoptionalNewlines($silence);
    if ($r10===self::$FAILED) {
      $this->currPos = $p5;
      $r6 = self::$FAILED;
      goto seq_3;
    }
    $r6 = [$r9,$r10];
    seq_3:
    if ($r6!==self::$FAILED) {
      goto choice_2;
    }
    // free $p5
    $r6 = $this->parsetable_end_tag($silence);
    choice_2:
    // tl <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a86($r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsexmlish_tag_opened($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [424, $this->currPos, $boolParams & 0x1fae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r4 = "/";
    } else {
      if (!$silence) {$this->fail(37);}
      $r4 = self::$FAILED;
      $r4 = null;
    }
    // end <- $r4
    $r5 = $this->parsetag_name($silence);
    // name <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r6 = $this->a87($r4, $r5, /*extTag*/($boolParams & 0x800) !== 0, /*isBlock*/($boolParams & 0x400) !== 0);
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsegeneric_newline_attributes($silence, $boolParams & ~0x50, $param_templatedepth, $param_preproc, $param_th);
    // attribs <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r9 = $this->discardspace_or_newline_or_solidus($silence);
    while ($r9 !== self::$FAILED) {
      $r9 = $this->discardspace_or_newline_or_solidus($silence);
    }
    // free $r9
    $r8 = true;
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r8 = "/";
    } else {
      if (!$silence) {$this->fail(37);}
      $r8 = self::$FAILED;
      $r8 = null;
    }
    // selfclose <- $r8
    $r10 = $this->discardspace($silence);
    while ($r10 !== self::$FAILED) {
      $r10 = $this->discardspace($silence);
    }
    // free $r10
    $r9 = true;
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r9
    if (($this->input[$this->currPos] ?? null) === ">") {
      $this->currPos++;
      $r9 = ">";
    } else {
      if (!$silence) {$this->fail(63);}
      $r9 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a88($r4, $r5, /*extTag*/($boolParams & 0x800) !== 0, /*isBlock*/($boolParams & 0x400) !== 0, $r7, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseempty_line_with_comments($silence) {
    $key = implode(':', [520, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsesol_prefix($silence);
    // sp <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r5 = '';
    // p <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a89($r4);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = [];
    $r11 = $this->parsespace($silence);
    while ($r11 !== self::$FAILED) {
      $r10[] = $r11;
      $r11 = $this->parsespace($silence);
    }
    // free $r11
    $r11 = $this->parsecomment($silence);
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r12 = [];
    // start choice_1
    $r13 = $this->parsespace($silence);
    if ($r13!==self::$FAILED) {
      goto choice_1;
    }
    $r13 = $this->parsecomment($silence);
    choice_1:
    while ($r13 !== self::$FAILED) {
      $r12[] = $r13;
      // start choice_2
      $r13 = $this->parsespace($silence);
      if ($r13!==self::$FAILED) {
        goto choice_2;
      }
      $r13 = $this->parsecomment($silence);
      choice_2:
    }
    // free $r13
    $r13 = $this->parsenewline($silence);
    if ($r13===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = [$r10,$r11,$r12,$r13];
    seq_2:
    if ($r8!==self::$FAILED) {
      $r7 = [];
      while ($r8 !== self::$FAILED) {
        $r7[] = $r8;
        // start seq_3
        $p9 = $this->currPos;
        $r14 = [];
        $r15 = $this->parsespace($silence);
        while ($r15 !== self::$FAILED) {
          $r14[] = $r15;
          $r15 = $this->parsespace($silence);
        }
        // free $r15
        $r15 = $this->parsecomment($silence);
        if ($r15===self::$FAILED) {
          $this->currPos = $p9;
          $r8 = self::$FAILED;
          goto seq_3;
        }
        $r16 = [];
        // start choice_3
        $r17 = $this->parsespace($silence);
        if ($r17!==self::$FAILED) {
          goto choice_3;
        }
        $r17 = $this->parsecomment($silence);
        choice_3:
        while ($r17 !== self::$FAILED) {
          $r16[] = $r17;
          // start choice_4
          $r17 = $this->parsespace($silence);
          if ($r17!==self::$FAILED) {
            goto choice_4;
          }
          $r17 = $this->parsecomment($silence);
          choice_4:
        }
        // free $r17
        $r17 = $this->parsenewline($silence);
        if ($r17===self::$FAILED) {
          $this->currPos = $p9;
          $r8 = self::$FAILED;
          goto seq_3;
        }
        $r8 = [$r14,$r15,$r16,$r17];
        seq_3:
        // free $p9
      }
    } else {
      $r7 = self::$FAILED;
    }
    // free $p9
    // c <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a90($r4, $r5, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsesol_prefix($silence) {
    $key = implode(':', [518, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->parsenewlineToken($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r1 = $this->a91();
    if ($r1) {
      $r1 = false;
      $this->savedPos = $p2;
      $r1 = $this->a92();
    } else {
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardtplarg_preproc($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [359, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r4 = "{{{";
      $this->currPos += 3;
    } else {
      if (!$silence) {$this->fail(64);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r5 = '';
    // p <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a34();
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $r7 = null;
    }
    // target <- $r7
    $r8 = [];
    $p10 = $this->currPos;
    // start seq_2
    $p11 = $this->currPos;
    $r13 = $this->discardnl_comment_space($silence);
    while ($r13 !== self::$FAILED) {
      $r13 = $this->discardnl_comment_space($silence);
    }
    // free $r13
    $r12 = true;
    if ($r12===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_2;
    }
    // free $r12
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r12 = "|";
    } else {
      if (!$silence) {$this->fail(13);}
      $r12 = self::$FAILED;
      $this->currPos = $p11;
      $r9 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $p14 = $this->currPos;
    // start seq_3
    $p15 = $this->currPos;
    $p17 = $this->currPos;
    $r16 = '';
    // p0 <- $r16
    if ($r16!==self::$FAILED) {
      $this->savedPos = $p17;
      $r16 = $this->a93($r5, $r7);
    } else {
      $r13 = self::$FAILED;
      goto seq_3;
    }
    $r18 = [];
    $r19 = $this->parsenl_comment_space($silence);
    while ($r19 !== self::$FAILED) {
      $r18[] = $r19;
      $r19 = $this->parsenl_comment_space($silence);
    }
    // v <- $r18
    // free $r19
    $p20 = $this->currPos;
    $r19 = '';
    // p1 <- $r19
    if ($r19!==self::$FAILED) {
      $this->savedPos = $p20;
      $r19 = $this->a94($r5, $r7, $r16, $r18);
    } else {
      $this->currPos = $p15;
      $r13 = self::$FAILED;
      goto seq_3;
    }
    $p21 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r22 = "|";
      goto choice_2;
    } else {
      $r22 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r22 = "}}}";
      $this->currPos += 3;
    } else {
      $r22 = self::$FAILED;
    }
    choice_2:
    if ($r22!==self::$FAILED) {
      $r22 = false;
      $this->currPos = $p21;
    } else {
      $this->currPos = $p15;
      $r13 = self::$FAILED;
      goto seq_3;
    }
    // free $p21
    $r13 = true;
    seq_3:
    if ($r13!==self::$FAILED) {
      $this->savedPos = $p14;
      $r13 = $this->a95($r5, $r7, $r16, $r18, $r19);
      goto choice_1;
    }
    // free $p15
    $r13 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    // r <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p11;
      $r9 = self::$FAILED;
      goto seq_2;
    }
    $r9 = true;
    seq_2:
    if ($r9!==self::$FAILED) {
      $this->savedPos = $p10;
      $r9 = $this->a96($r5, $r7, $r13);
    }
    // free $p11
    while ($r9 !== self::$FAILED) {
      $r8[] = $r9;
      $p11 = $this->currPos;
      // start seq_4
      $p15 = $this->currPos;
      $r24 = $this->discardnl_comment_space($silence);
      while ($r24 !== self::$FAILED) {
        $r24 = $this->discardnl_comment_space($silence);
      }
      // free $r24
      $r23 = true;
      if ($r23===self::$FAILED) {
        $r9 = self::$FAILED;
        goto seq_4;
      }
      // free $r23
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r23 = "|";
      } else {
        if (!$silence) {$this->fail(13);}
        $r23 = self::$FAILED;
        $this->currPos = $p15;
        $r9 = self::$FAILED;
        goto seq_4;
      }
      // start choice_3
      $p21 = $this->currPos;
      // start seq_5
      $p25 = $this->currPos;
      $p27 = $this->currPos;
      $r26 = '';
      // p0 <- $r26
      if ($r26!==self::$FAILED) {
        $this->savedPos = $p27;
        $r26 = $this->a93($r5, $r7);
      } else {
        $r24 = self::$FAILED;
        goto seq_5;
      }
      $r28 = [];
      $r29 = $this->parsenl_comment_space($silence);
      while ($r29 !== self::$FAILED) {
        $r28[] = $r29;
        $r29 = $this->parsenl_comment_space($silence);
      }
      // v <- $r28
      // free $r29
      $p30 = $this->currPos;
      $r29 = '';
      // p1 <- $r29
      if ($r29!==self::$FAILED) {
        $this->savedPos = $p30;
        $r29 = $this->a94($r5, $r7, $r26, $r28);
      } else {
        $this->currPos = $p25;
        $r24 = self::$FAILED;
        goto seq_5;
      }
      $p31 = $this->currPos;
      // start choice_4
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r32 = "|";
        goto choice_4;
      } else {
        $r32 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
        $r32 = "}}}";
        $this->currPos += 3;
      } else {
        $r32 = self::$FAILED;
      }
      choice_4:
      if ($r32!==self::$FAILED) {
        $r32 = false;
        $this->currPos = $p31;
      } else {
        $this->currPos = $p25;
        $r24 = self::$FAILED;
        goto seq_5;
      }
      // free $p31
      $r24 = true;
      seq_5:
      if ($r24!==self::$FAILED) {
        $this->savedPos = $p21;
        $r24 = $this->a95($r5, $r7, $r26, $r28, $r29);
        goto choice_3;
      }
      // free $p25
      $r24 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      choice_3:
      // r <- $r24
      if ($r24===self::$FAILED) {
        $this->currPos = $p15;
        $r9 = self::$FAILED;
        goto seq_4;
      }
      $r9 = true;
      seq_4:
      if ($r9!==self::$FAILED) {
        $this->savedPos = $p11;
        $r9 = $this->a96($r5, $r7, $r24);
      }
      // free $p15
    }
    // params <- $r8
    // free $r9
    $r33 = $this->discardnl_comment_space($silence);
    while ($r33 !== self::$FAILED) {
      $r33 = $this->discardnl_comment_space($silence);
    }
    // free $r33
    $r9 = true;
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r9
    $r9 = $this->discardinline_breaks($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r33 = "}}}";
      $this->currPos += 3;
    } else {
      if (!$silence) {$this->fail(65);}
      $r33 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a97($r5, $r7, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetemplate_preproc($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [354, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r4 = "{{";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(48);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->discardnl_comment_space($silence);
    while ($r6 !== self::$FAILED) {
      $r6 = $this->discardnl_comment_space($silence);
    }
    // free $r6
    $r5 = true;
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r5
    $r5 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // target <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = [];
    $p8 = $this->currPos;
    // start seq_2
    $p9 = $this->currPos;
    $r11 = $this->discardnl_comment_space($silence);
    while ($r11 !== self::$FAILED) {
      $r11 = $this->discardnl_comment_space($silence);
    }
    // free $r11
    $r10 = true;
    if ($r10===self::$FAILED) {
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $r10
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r10 = "|";
    } else {
      if (!$silence) {$this->fail(13);}
      $r10 = self::$FAILED;
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // start choice_2
    $p12 = $this->currPos;
    // start seq_3
    $p13 = $this->currPos;
    $p15 = $this->currPos;
    $r14 = '';
    // p0 <- $r14
    if ($r14!==self::$FAILED) {
      $this->savedPos = $p15;
      $r14 = $this->a98($r5);
    } else {
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r16 = [];
    $r17 = $this->parsenl_comment_space($silence);
    while ($r17 !== self::$FAILED) {
      $r16[] = $r17;
      $r17 = $this->parsenl_comment_space($silence);
    }
    // v <- $r16
    // free $r17
    $p18 = $this->currPos;
    $r17 = '';
    // p <- $r17
    if ($r17!==self::$FAILED) {
      $this->savedPos = $p18;
      $r17 = $this->a99($r5, $r14, $r16);
    } else {
      $this->currPos = $p13;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $p19 = $this->currPos;
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r20 = "|";
      goto choice_3;
    } else {
      $r20 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
      $r20 = "}}";
      $this->currPos += 2;
    } else {
      $r20 = self::$FAILED;
    }
    choice_3:
    if ($r20!==self::$FAILED) {
      $r20 = false;
      $this->currPos = $p19;
    } else {
      $this->currPos = $p13;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p19
    $r11 = true;
    seq_3:
    if ($r11!==self::$FAILED) {
      $this->savedPos = $p12;
      $r11 = $this->a100($r5, $r14, $r16, $r17);
      goto choice_2;
    }
    // free $p13
    $r11 = $this->parsetemplate_param($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_2:
    // r <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a101($r5, $r11);
    }
    // free $p9
    while ($r7 !== self::$FAILED) {
      $r6[] = $r7;
      $p9 = $this->currPos;
      // start seq_4
      $p13 = $this->currPos;
      $r22 = $this->discardnl_comment_space($silence);
      while ($r22 !== self::$FAILED) {
        $r22 = $this->discardnl_comment_space($silence);
      }
      // free $r22
      $r21 = true;
      if ($r21===self::$FAILED) {
        $r7 = self::$FAILED;
        goto seq_4;
      }
      // free $r21
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r21 = "|";
      } else {
        if (!$silence) {$this->fail(13);}
        $r21 = self::$FAILED;
        $this->currPos = $p13;
        $r7 = self::$FAILED;
        goto seq_4;
      }
      // start choice_4
      $p19 = $this->currPos;
      // start seq_5
      $p23 = $this->currPos;
      $p25 = $this->currPos;
      $r24 = '';
      // p0 <- $r24
      if ($r24!==self::$FAILED) {
        $this->savedPos = $p25;
        $r24 = $this->a98($r5);
      } else {
        $r22 = self::$FAILED;
        goto seq_5;
      }
      $r26 = [];
      $r27 = $this->parsenl_comment_space($silence);
      while ($r27 !== self::$FAILED) {
        $r26[] = $r27;
        $r27 = $this->parsenl_comment_space($silence);
      }
      // v <- $r26
      // free $r27
      $p28 = $this->currPos;
      $r27 = '';
      // p <- $r27
      if ($r27!==self::$FAILED) {
        $this->savedPos = $p28;
        $r27 = $this->a99($r5, $r24, $r26);
      } else {
        $this->currPos = $p23;
        $r22 = self::$FAILED;
        goto seq_5;
      }
      $p29 = $this->currPos;
      // start choice_5
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r30 = "|";
        goto choice_5;
      } else {
        $r30 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
        $r30 = "}}";
        $this->currPos += 2;
      } else {
        $r30 = self::$FAILED;
      }
      choice_5:
      if ($r30!==self::$FAILED) {
        $r30 = false;
        $this->currPos = $p29;
      } else {
        $this->currPos = $p23;
        $r22 = self::$FAILED;
        goto seq_5;
      }
      // free $p29
      $r22 = true;
      seq_5:
      if ($r22!==self::$FAILED) {
        $this->savedPos = $p19;
        $r22 = $this->a100($r5, $r24, $r26, $r27);
        goto choice_4;
      }
      // free $p23
      $r22 = $this->parsetemplate_param($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      choice_4:
      // r <- $r22
      if ($r22===self::$FAILED) {
        $this->currPos = $p13;
        $r7 = self::$FAILED;
        goto seq_4;
      }
      $r7 = true;
      seq_4:
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p9;
        $r7 = $this->a101($r5, $r22);
      }
      // free $p13
    }
    // params <- $r6
    // free $r7
    $r31 = $this->discardnl_comment_space($silence);
    while ($r31 !== self::$FAILED) {
      $r31 = $this->discardnl_comment_space($silence);
    }
    // free $r31
    $r7 = true;
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r7
    $r7 = $this->discardinline_breaks($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
      $r31 = "}}";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(66);}
      $r31 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a102($r5, $r6);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_6
    $p13 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
      $r32 = "{{";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(48);}
      $r32 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_6;
    }
    $r34 = $this->discardspace_or_newline($silence);
    while ($r34 !== self::$FAILED) {
      $r34 = $this->discardspace_or_newline($silence);
    }
    // free $r34
    $r33 = true;
    if ($r33===self::$FAILED) {
      $this->currPos = $p13;
      $r1 = self::$FAILED;
      goto seq_6;
    }
    // free $r33
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
      $r33 = "}}";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(66);}
      $r33 = self::$FAILED;
      $this->currPos = $p13;
      $r1 = self::$FAILED;
      goto seq_6;
    }
    $r1 = true;
    seq_6:
    if ($r1!==self::$FAILED) {
      $r1 = substr($this->input, $p3, $this->currPos - $p3);
    } else {
      $r1 = self::$FAILED;
    }
    // free $p13
    // free $p3
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetplarg_preproc($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [358, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r4 = "{{{";
      $this->currPos += 3;
    } else {
      if (!$silence) {$this->fail(64);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r5 = '';
    // p <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a34();
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $r7 = null;
    }
    // target <- $r7
    $r8 = [];
    $p10 = $this->currPos;
    // start seq_2
    $p11 = $this->currPos;
    $r13 = $this->discardnl_comment_space($silence);
    while ($r13 !== self::$FAILED) {
      $r13 = $this->discardnl_comment_space($silence);
    }
    // free $r13
    $r12 = true;
    if ($r12===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_2;
    }
    // free $r12
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r12 = "|";
    } else {
      if (!$silence) {$this->fail(13);}
      $r12 = self::$FAILED;
      $this->currPos = $p11;
      $r9 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $p14 = $this->currPos;
    // start seq_3
    $p15 = $this->currPos;
    $p17 = $this->currPos;
    $r16 = '';
    // p0 <- $r16
    if ($r16!==self::$FAILED) {
      $this->savedPos = $p17;
      $r16 = $this->a93($r5, $r7);
    } else {
      $r13 = self::$FAILED;
      goto seq_3;
    }
    $r18 = [];
    $r19 = $this->parsenl_comment_space($silence);
    while ($r19 !== self::$FAILED) {
      $r18[] = $r19;
      $r19 = $this->parsenl_comment_space($silence);
    }
    // v <- $r18
    // free $r19
    $p20 = $this->currPos;
    $r19 = '';
    // p1 <- $r19
    if ($r19!==self::$FAILED) {
      $this->savedPos = $p20;
      $r19 = $this->a94($r5, $r7, $r16, $r18);
    } else {
      $this->currPos = $p15;
      $r13 = self::$FAILED;
      goto seq_3;
    }
    $p21 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r22 = "|";
      goto choice_2;
    } else {
      $r22 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r22 = "}}}";
      $this->currPos += 3;
    } else {
      $r22 = self::$FAILED;
    }
    choice_2:
    if ($r22!==self::$FAILED) {
      $r22 = false;
      $this->currPos = $p21;
    } else {
      $this->currPos = $p15;
      $r13 = self::$FAILED;
      goto seq_3;
    }
    // free $p21
    $r13 = true;
    seq_3:
    if ($r13!==self::$FAILED) {
      $this->savedPos = $p14;
      $r13 = $this->a95($r5, $r7, $r16, $r18, $r19);
      goto choice_1;
    }
    // free $p15
    $r13 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    // r <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p11;
      $r9 = self::$FAILED;
      goto seq_2;
    }
    $r9 = true;
    seq_2:
    if ($r9!==self::$FAILED) {
      $this->savedPos = $p10;
      $r9 = $this->a96($r5, $r7, $r13);
    }
    // free $p11
    while ($r9 !== self::$FAILED) {
      $r8[] = $r9;
      $p11 = $this->currPos;
      // start seq_4
      $p15 = $this->currPos;
      $r24 = $this->discardnl_comment_space($silence);
      while ($r24 !== self::$FAILED) {
        $r24 = $this->discardnl_comment_space($silence);
      }
      // free $r24
      $r23 = true;
      if ($r23===self::$FAILED) {
        $r9 = self::$FAILED;
        goto seq_4;
      }
      // free $r23
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r23 = "|";
      } else {
        if (!$silence) {$this->fail(13);}
        $r23 = self::$FAILED;
        $this->currPos = $p15;
        $r9 = self::$FAILED;
        goto seq_4;
      }
      // start choice_3
      $p21 = $this->currPos;
      // start seq_5
      $p25 = $this->currPos;
      $p27 = $this->currPos;
      $r26 = '';
      // p0 <- $r26
      if ($r26!==self::$FAILED) {
        $this->savedPos = $p27;
        $r26 = $this->a93($r5, $r7);
      } else {
        $r24 = self::$FAILED;
        goto seq_5;
      }
      $r28 = [];
      $r29 = $this->parsenl_comment_space($silence);
      while ($r29 !== self::$FAILED) {
        $r28[] = $r29;
        $r29 = $this->parsenl_comment_space($silence);
      }
      // v <- $r28
      // free $r29
      $p30 = $this->currPos;
      $r29 = '';
      // p1 <- $r29
      if ($r29!==self::$FAILED) {
        $this->savedPos = $p30;
        $r29 = $this->a94($r5, $r7, $r26, $r28);
      } else {
        $this->currPos = $p25;
        $r24 = self::$FAILED;
        goto seq_5;
      }
      $p31 = $this->currPos;
      // start choice_4
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r32 = "|";
        goto choice_4;
      } else {
        $r32 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
        $r32 = "}}}";
        $this->currPos += 3;
      } else {
        $r32 = self::$FAILED;
      }
      choice_4:
      if ($r32!==self::$FAILED) {
        $r32 = false;
        $this->currPos = $p31;
      } else {
        $this->currPos = $p25;
        $r24 = self::$FAILED;
        goto seq_5;
      }
      // free $p31
      $r24 = true;
      seq_5:
      if ($r24!==self::$FAILED) {
        $this->savedPos = $p21;
        $r24 = $this->a95($r5, $r7, $r26, $r28, $r29);
        goto choice_3;
      }
      // free $p25
      $r24 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      choice_3:
      // r <- $r24
      if ($r24===self::$FAILED) {
        $this->currPos = $p15;
        $r9 = self::$FAILED;
        goto seq_4;
      }
      $r9 = true;
      seq_4:
      if ($r9!==self::$FAILED) {
        $this->savedPos = $p11;
        $r9 = $this->a96($r5, $r7, $r24);
      }
      // free $p15
    }
    // params <- $r8
    // free $r9
    $r33 = $this->discardnl_comment_space($silence);
    while ($r33 !== self::$FAILED) {
      $r33 = $this->discardnl_comment_space($silence);
    }
    // free $r33
    $r9 = true;
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r9
    $r9 = $this->discardinline_breaks($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r33 = "}}}";
      $this->currPos += 3;
    } else {
      if (!$silence) {$this->fail(65);}
      $r33 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a97($r5, $r7, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardwikilink_preproc($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [403, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r4 = "[[";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(46);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsewikilink_preprocessor_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r5===self::$FAILED) {
      $r5 = null;
    }
    // target <- $r5
    $p7 = $this->currPos;
    $r6 = '';
    // tpos <- $r6
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a98($r5);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r8 = $this->parsewikilink_content($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lcs <- $r8
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r9 = $this->discardinline_breaks($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r10 = "]]";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(67);}
      $r10 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a103($r5, $r6, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardbroken_wikilink($silence, $boolParams, &$param_preproc, $param_templatedepth, &$param_th) {
    $key = implode(':', [401, $this->currPos, $boolParams & 0x19fe, $param_preproc, $param_templatedepth, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r5 = "[[";
      $this->currPos += 2;
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r5 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $this->savedPos = $this->currPos;
    $r6 = $this->a104($param_preproc);
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start seq_2
    $p4 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r8 = "[";
    } else {
      if (!$silence) {$this->fail(19);}
      $r8 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $r9 = $this->parseextlink($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r9 = "[";
    } else {
      if (!$silence) {$this->fail(19);}
      $r9 = self::$FAILED;
    }
    choice_1:
    if ($r9===self::$FAILED) {
      $this->currPos = $p4;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = [$r8,$r9];
    seq_2:
    // a <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a105($param_preproc, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseextension_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [410, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (!(/*extTag*/($boolParams & 0x800) !== 0)) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsexmlish_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // extToken <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r6 = $this->a106($r5);
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a107($r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseautourl($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [340, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
      $r5 = "//";
      $this->currPos += 2;
    } else {
      $r5 = self::$FAILED;
    }
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $p4 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $r8 = $this->parseurl_protocol($silence);
    // proto <- $r8
    if ($r8===self::$FAILED) {
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $r9 = $this->parseurladdr($silence);
    if ($r9!==self::$FAILED) {
      goto choice_1;
    }
    $r9 = '';
    choice_1:
    // addr <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r10 = [];
    // start choice_2
    $p12 = $this->currPos;
    // start seq_3
    $p13 = $this->currPos;
    $p14 = $this->currPos;
    $r15 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r15 === self::$FAILED) {
      $r15 = false;
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p14;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p14
    $r16 = $this->parseno_punctuation_char($silence);
    // c <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p13;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r11 = true;
    seq_3:
    if ($r11!==self::$FAILED) {
      $this->savedPos = $p12;
      $r11 = $this->a6($r8, $r9, $r16);
      goto choice_2;
    }
    // free $p13
    if (strspn($this->input, ".:,", $this->currPos, 1) !== 0) {
      $r11 = $this->input[$this->currPos++];
      goto choice_2;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) {$this->fail(42);}
    }
    $p13 = $this->currPos;
    // start seq_4
    $p14 = $this->currPos;
    $r17 = $this->input[$this->currPos] ?? '';
    if ($r17 === "'") {
      $this->currPos++;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) {$this->fail(43);}
      $r11 = self::$FAILED;
      goto seq_4;
    }
    $p18 = $this->currPos;
    $r19 = $this->input[$this->currPos] ?? '';
    if ($r19 === "'") {
      $this->currPos++;
    } else {
      $r19 = self::$FAILED;
    }
    if ($r19 === self::$FAILED) {
      $r19 = false;
    } else {
      $r19 = self::$FAILED;
      $this->currPos = $p18;
      $this->currPos = $p14;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    // free $p18
    $r11 = true;
    seq_4:
    if ($r11!==self::$FAILED) {
      $r11 = substr($this->input, $p13, $this->currPos - $p13);
      goto choice_2;
    } else {
      $r11 = self::$FAILED;
    }
    // free $p14
    // free $p13
    $r11 = $this->parsecomment($silence);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $r11 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $p13 = $this->currPos;
    // start seq_5
    $p14 = $this->currPos;
    $p18 = $this->currPos;
    // start seq_6
    $p21 = $this->currPos;
    $r22 = $this->parseraw_htmlentity(true);
    // rhe <- $r22
    if ($r22===self::$FAILED) {
      $r20 = self::$FAILED;
      goto seq_6;
    }
    $this->savedPos = $this->currPos;
    $r23 = $this->a108($r8, $r9, $r22);
    if ($r23) {
      $r23 = false;
    } else {
      $r23 = self::$FAILED;
      $this->currPos = $p21;
      $r20 = self::$FAILED;
      goto seq_6;
    }
    $r20 = true;
    seq_6:
    // free $p21
    if ($r20 === self::$FAILED) {
      $r20 = false;
    } else {
      $r20 = self::$FAILED;
      $this->currPos = $p18;
      $r11 = self::$FAILED;
      goto seq_5;
    }
    // free $p18
    // start choice_3
    $p18 = $this->currPos;
    // start seq_7
    $p21 = $this->currPos;
    $p25 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r26 = "&";
      $r26 = false;
      $this->currPos = $p25;
    } else {
      $r26 = self::$FAILED;
      $r24 = self::$FAILED;
      goto seq_7;
    }
    // free $p25
    $r27 = $this->parsehtmlentity($silence);
    // he <- $r27
    if ($r27===self::$FAILED) {
      $this->currPos = $p21;
      $r24 = self::$FAILED;
      goto seq_7;
    }
    $r24 = true;
    seq_7:
    if ($r24!==self::$FAILED) {
      $this->savedPos = $p18;
      $r24 = $this->a8($r8, $r9, $r27);
      goto choice_3;
    }
    // free $p21
    if (strspn($this->input, "&%{", $this->currPos, 1) !== 0) {
      $r24 = $this->input[$this->currPos++];
    } else {
      $r24 = self::$FAILED;
      if (!$silence) {$this->fail(4);}
    }
    choice_3:
    // r <- $r24
    if ($r24===self::$FAILED) {
      $this->currPos = $p14;
      $r11 = self::$FAILED;
      goto seq_5;
    }
    $r11 = true;
    seq_5:
    if ($r11!==self::$FAILED) {
      $this->savedPos = $p13;
      $r11 = $this->a9($r8, $r9, $r24);
    }
    // free $p14
    choice_2:
    while ($r11 !== self::$FAILED) {
      $r10[] = $r11;
      // start choice_4
      $p14 = $this->currPos;
      // start seq_8
      $p21 = $this->currPos;
      $p25 = $this->currPos;
      $r28 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r28 === self::$FAILED) {
        $r28 = false;
      } else {
        $r28 = self::$FAILED;
        $this->currPos = $p25;
        $r11 = self::$FAILED;
        goto seq_8;
      }
      // free $p25
      $r29 = $this->parseno_punctuation_char($silence);
      // c <- $r29
      if ($r29===self::$FAILED) {
        $this->currPos = $p21;
        $r11 = self::$FAILED;
        goto seq_8;
      }
      $r11 = true;
      seq_8:
      if ($r11!==self::$FAILED) {
        $this->savedPos = $p14;
        $r11 = $this->a6($r8, $r9, $r29);
        goto choice_4;
      }
      // free $p21
      if (strspn($this->input, ".:,", $this->currPos, 1) !== 0) {
        $r11 = $this->input[$this->currPos++];
        goto choice_4;
      } else {
        $r11 = self::$FAILED;
        if (!$silence) {$this->fail(42);}
      }
      $p21 = $this->currPos;
      // start seq_9
      $p25 = $this->currPos;
      $r30 = $this->input[$this->currPos] ?? '';
      if ($r30 === "'") {
        $this->currPos++;
      } else {
        $r30 = self::$FAILED;
        if (!$silence) {$this->fail(43);}
        $r11 = self::$FAILED;
        goto seq_9;
      }
      $p31 = $this->currPos;
      $r32 = $this->input[$this->currPos] ?? '';
      if ($r32 === "'") {
        $this->currPos++;
      } else {
        $r32 = self::$FAILED;
      }
      if ($r32 === self::$FAILED) {
        $r32 = false;
      } else {
        $r32 = self::$FAILED;
        $this->currPos = $p31;
        $this->currPos = $p25;
        $r11 = self::$FAILED;
        goto seq_9;
      }
      // free $p31
      $r11 = true;
      seq_9:
      if ($r11!==self::$FAILED) {
        $r11 = substr($this->input, $p21, $this->currPos - $p21);
        goto choice_4;
      } else {
        $r11 = self::$FAILED;
      }
      // free $p25
      // free $p21
      $r11 = $this->parsecomment($silence);
      if ($r11!==self::$FAILED) {
        goto choice_4;
      }
      $r11 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
      if ($r11!==self::$FAILED) {
        goto choice_4;
      }
      $p21 = $this->currPos;
      // start seq_10
      $p25 = $this->currPos;
      $p31 = $this->currPos;
      // start seq_11
      $p34 = $this->currPos;
      $r35 = $this->parseraw_htmlentity(true);
      // rhe <- $r35
      if ($r35===self::$FAILED) {
        $r33 = self::$FAILED;
        goto seq_11;
      }
      $this->savedPos = $this->currPos;
      $r36 = $this->a108($r8, $r9, $r35);
      if ($r36) {
        $r36 = false;
      } else {
        $r36 = self::$FAILED;
        $this->currPos = $p34;
        $r33 = self::$FAILED;
        goto seq_11;
      }
      $r33 = true;
      seq_11:
      // free $p34
      if ($r33 === self::$FAILED) {
        $r33 = false;
      } else {
        $r33 = self::$FAILED;
        $this->currPos = $p31;
        $r11 = self::$FAILED;
        goto seq_10;
      }
      // free $p31
      // start choice_5
      $p31 = $this->currPos;
      // start seq_12
      $p34 = $this->currPos;
      $p38 = $this->currPos;
      if (($this->input[$this->currPos] ?? null) === "&") {
        $this->currPos++;
        $r39 = "&";
        $r39 = false;
        $this->currPos = $p38;
      } else {
        $r39 = self::$FAILED;
        $r37 = self::$FAILED;
        goto seq_12;
      }
      // free $p38
      $r40 = $this->parsehtmlentity($silence);
      // he <- $r40
      if ($r40===self::$FAILED) {
        $this->currPos = $p34;
        $r37 = self::$FAILED;
        goto seq_12;
      }
      $r37 = true;
      seq_12:
      if ($r37!==self::$FAILED) {
        $this->savedPos = $p31;
        $r37 = $this->a8($r8, $r9, $r40);
        goto choice_5;
      }
      // free $p34
      if (strspn($this->input, "&%{", $this->currPos, 1) !== 0) {
        $r37 = $this->input[$this->currPos++];
      } else {
        $r37 = self::$FAILED;
        if (!$silence) {$this->fail(4);}
      }
      choice_5:
      // r <- $r37
      if ($r37===self::$FAILED) {
        $this->currPos = $p25;
        $r11 = self::$FAILED;
        goto seq_10;
      }
      $r11 = true;
      seq_10:
      if ($r11!==self::$FAILED) {
        $this->savedPos = $p21;
        $r11 = $this->a9($r8, $r9, $r37);
      }
      // free $p25
      choice_4:
    }
    // path <- $r10
    // free $r11
    $r6 = true;
    seq_2:
    // r <- $r6
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p4;
      $r6 = $this->a109($r8, $r9, $r10);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    $this->savedPos = $this->currPos;
    $r11 = $this->a110($r6);
    if ($r11) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a18($r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseautoref($silence) {
    $key = implode(':', [330, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "RFC", $this->currPos, 3, false) === 0) {
      $r4 = "RFC";
      $this->currPos += 3;
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(68);}
      $r4 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "PMID", $this->currPos, 4, false) === 0) {
      $r4 = "PMID";
      $this->currPos += 4;
    } else {
      if (!$silence) {$this->fail(69);}
      $r4 = self::$FAILED;
    }
    choice_1:
    // ref <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsespace_or_nbsp($silence);
    if ($r6!==self::$FAILED) {
      $r5 = [];
      while ($r6 !== self::$FAILED) {
        $r5[] = $r6;
        $r6 = $this->parsespace_or_nbsp($silence);
      }
    } else {
      $r5 = self::$FAILED;
    }
    // sp <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r6
    $p7 = $this->currPos;
    $r8 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[0-9]/", $r8)) {
      $this->currPos++;
      $r6 = true;
      while ($r8 !== self::$FAILED) {
        $r8 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[0-9]/", $r8)) {
          $this->currPos++;
        } else {
          $r8 = self::$FAILED;
          if (!$silence) {$this->fail(70);}
        }
      }
    } else {
      $r8 = self::$FAILED;
      if (!$silence) {$this->fail(70);}
      $r6 = self::$FAILED;
    }
    // identifier <- $r6
    if ($r6!==self::$FAILED) {
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    // free $p7
    $r8 = $this->discardend_of_word($silence);
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a111($r4, $r5, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseisbn($silence) {
    $key = implode(':', [332, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "ISBN", $this->currPos, 4, false) === 0) {
      $r4 = "ISBN";
      $this->currPos += 4;
    } else {
      if (!$silence) {$this->fail(71);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsespace_or_nbsp($silence);
    if ($r6!==self::$FAILED) {
      $r5 = [];
      while ($r6 !== self::$FAILED) {
        $r5[] = $r6;
        $r6 = $this->parsespace_or_nbsp($silence);
      }
    } else {
      $r5 = self::$FAILED;
    }
    // sp <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r6
    // start seq_2
    $p7 = $this->currPos;
    $r8 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[0-9]/", $r8)) {
      $this->currPos++;
    } else {
      $r8 = self::$FAILED;
      if (!$silence) {$this->fail(70);}
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $p11 = $this->currPos;
    // start seq_3
    $p12 = $this->currPos;
    $r13 = $this->parsespace_or_nbsp_or_dash($silence);
    // s <- $r13
    if ($r13===self::$FAILED) {
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $p14 = $this->currPos;
    $r15 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[0-9]/", $r15)) {
      $this->currPos++;
      $r15 = false;
      $this->currPos = $p14;
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p12;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    // free $p14
    $r10 = true;
    seq_3:
    if ($r10!==self::$FAILED) {
      $this->savedPos = $p11;
      $r10 = $this->a112($r5, $r13);
      goto choice_1;
    }
    // free $p12
    $r10 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[0-9]/", $r10)) {
      $this->currPos++;
    } else {
      $r10 = self::$FAILED;
      if (!$silence) {$this->fail(70);}
    }
    choice_1:
    if ($r10!==self::$FAILED) {
      $r9 = [];
      while ($r10 !== self::$FAILED) {
        $r9[] = $r10;
        // start choice_2
        $p12 = $this->currPos;
        // start seq_4
        $p14 = $this->currPos;
        $r16 = $this->parsespace_or_nbsp_or_dash($silence);
        // s <- $r16
        if ($r16===self::$FAILED) {
          $r10 = self::$FAILED;
          goto seq_4;
        }
        $p17 = $this->currPos;
        $r18 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[0-9]/", $r18)) {
          $this->currPos++;
          $r18 = false;
          $this->currPos = $p17;
        } else {
          $r18 = self::$FAILED;
          $this->currPos = $p14;
          $r10 = self::$FAILED;
          goto seq_4;
        }
        // free $p17
        $r10 = true;
        seq_4:
        if ($r10!==self::$FAILED) {
          $this->savedPos = $p12;
          $r10 = $this->a112($r5, $r16);
          goto choice_2;
        }
        // free $p14
        $r10 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[0-9]/", $r10)) {
          $this->currPos++;
        } else {
          $r10 = self::$FAILED;
          if (!$silence) {$this->fail(70);}
        }
        choice_2:
      }
    } else {
      $r9 = self::$FAILED;
    }
    if ($r9===self::$FAILED) {
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $r10
    // start choice_3
    // start seq_5
    $p14 = $this->currPos;
    // start choice_4
    $r19 = $this->parsespace_or_nbsp_or_dash($silence);
    if ($r19!==self::$FAILED) {
      goto choice_4;
    }
    $r19 = '';
    choice_4:
    if ($r19===self::$FAILED) {
      $r10 = self::$FAILED;
      goto seq_5;
    }
    $r20 = $this->input[$this->currPos] ?? '';
    if ($r20 === "x" || $r20 === "X") {
      $this->currPos++;
    } else {
      $r20 = self::$FAILED;
      if (!$silence) {$this->fail(72);}
      $this->currPos = $p14;
      $r10 = self::$FAILED;
      goto seq_5;
    }
    $r10 = [$r19,$r20];
    seq_5:
    if ($r10!==self::$FAILED) {
      goto choice_3;
    }
    // free $p14
    $r10 = '';
    choice_3:
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = [$r8,$r9,$r10];
    seq_2:
    // isbn <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    $p7 = $this->currPos;
    $r21 = $this->discardend_of_word($silence);
    // isbncode <- $r21
    if ($r21!==self::$FAILED) {
      $this->savedPos = $p7;
      $r21 = $this->a113($r5, $r6);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r22 = $this->a114($r5, $r6, $r21);
    if ($r22) {
      $r22 = false;
    } else {
      $r22 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a115($r5, $r6, $r21);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardbehavior_text($silence) {
    $key = implode(':', [325, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    // start seq_1
    $p4 = $this->currPos;
    $p5 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r6 = "__";
      $this->currPos += 2;
    } else {
      $r6 = self::$FAILED;
    }
    if ($r6 === self::$FAILED) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    if (strcspn($this->input, "'\"<~[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
      $r7 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r7 = self::$FAILED;
      if (!$silence) {$this->fail(73);}
      $this->currPos = $p4;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r3 = true;
    seq_1:
    if ($r3!==self::$FAILED) {
      $r2 = true;
      while ($r3 !== self::$FAILED) {
        // start seq_2
        $p4 = $this->currPos;
        $p5 = $this->currPos;
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
          $r8 = "__";
          $this->currPos += 2;
        } else {
          $r8 = self::$FAILED;
        }
        if ($r8 === self::$FAILED) {
          $r8 = false;
        } else {
          $r8 = self::$FAILED;
          $this->currPos = $p5;
          $r3 = self::$FAILED;
          goto seq_2;
        }
        // free $p5
        if (strcspn($this->input, "'\"<~[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
          $r9 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r9 = self::$FAILED;
          if (!$silence) {$this->fail(73);}
          $this->currPos = $p4;
          $r3 = self::$FAILED;
          goto seq_2;
        }
        $r3 = true;
        seq_2:
        // free $p4
      }
    } else {
      $r2 = self::$FAILED;
    }
    // free $p4
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $r3
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parselang_variant($silence, $boolParams, $param_templatedepth, &$param_th, &$param_preproc) {
    $key = implode(':', [372, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_th, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_th=$param_th;
        $saved_preproc=$param_preproc;
    // start choice_1
    $r1 = $this->parselang_variant_preproc($silence, $boolParams, $param_templatedepth, self::newRef("}-"), $param_th);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsebroken_lang_variant($silence, $param_preproc);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsewikilink_preproc($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [402, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r4 = "[[";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(46);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsewikilink_preprocessor_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r5===self::$FAILED) {
      $r5 = null;
    }
    // target <- $r5
    $p7 = $this->currPos;
    $r6 = '';
    // tpos <- $r6
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a98($r5);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r8 = $this->parsewikilink_content($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lcs <- $r8
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r9 = $this->discardinline_breaks($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r10 = "]]";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(67);}
      $r10 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a103($r5, $r6, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsebroken_wikilink($silence, $boolParams, &$param_preproc, $param_templatedepth, &$param_th) {
    $key = implode(':', [400, $this->currPos, $boolParams & 0x19fe, $param_preproc, $param_templatedepth, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r5 = "[[";
      $this->currPos += 2;
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r5 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $this->savedPos = $this->currPos;
    $r6 = $this->a104($param_preproc);
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start seq_2
    $p4 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r8 = "[";
    } else {
      if (!$silence) {$this->fail(19);}
      $r8 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $r9 = $this->parseextlink($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r9 = "[";
    } else {
      if (!$silence) {$this->fail(19);}
      $r9 = self::$FAILED;
    }
    choice_1:
    if ($r9===self::$FAILED) {
      $this->currPos = $p4;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = [$r8,$r9];
    seq_2:
    // a <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a105($param_preproc, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsespaces($silence) {
    $key = implode(':', [494, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    $r3 = $this->input[$this->currPos] ?? '';
    if ($r3 === " " || $r3 === "\x09") {
      $this->currPos++;
      $r2 = true;
      while ($r3 !== self::$FAILED) {
        $r3 = $this->input[$this->currPos] ?? '';
        if ($r3 === " " || $r3 === "\x09") {
          $this->currPos++;
        } else {
          $r3 = self::$FAILED;
          if (!$silence) {$this->fail(10);}
        }
      }
    } else {
      $r3 = self::$FAILED;
      if (!$silence) {$this->fail(10);}
      $r2 = self::$FAILED;
    }
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $r3
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parsedtdd($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [450, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = [];
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $p8 = $this->currPos;
    // start seq_3
    $p10 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r11 = ";";
    } else {
      $r11 = self::$FAILED;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    $p12 = $this->currPos;
    $r13 = $this->discardlist_char(true);
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p12;
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    // free $p12
    $r9 = true;
    seq_3:
    // free $p10
    if ($r9 === self::$FAILED) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p8;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p8
    $r14 = $this->parselist_char($silence);
    // lc <- $r14
    if ($r14===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a116($r14);
    }
    // free $p7
    while ($r5 !== self::$FAILED) {
      $r4[] = $r5;
      $p7 = $this->currPos;
      // start seq_4
      $p8 = $this->currPos;
      $p10 = $this->currPos;
      // start seq_5
      $p12 = $this->currPos;
      if (($this->input[$this->currPos] ?? null) === ";") {
        $this->currPos++;
        $r16 = ";";
      } else {
        $r16 = self::$FAILED;
        $r15 = self::$FAILED;
        goto seq_5;
      }
      $p17 = $this->currPos;
      $r18 = $this->discardlist_char(true);
      if ($r18 === self::$FAILED) {
        $r18 = false;
      } else {
        $r18 = self::$FAILED;
        $this->currPos = $p17;
        $this->currPos = $p12;
        $r15 = self::$FAILED;
        goto seq_5;
      }
      // free $p17
      $r15 = true;
      seq_5:
      // free $p12
      if ($r15 === self::$FAILED) {
        $r15 = false;
      } else {
        $r15 = self::$FAILED;
        $this->currPos = $p10;
        $r5 = self::$FAILED;
        goto seq_4;
      }
      // free $p10
      $r19 = $this->parselist_char($silence);
      // lc <- $r19
      if ($r19===self::$FAILED) {
        $this->currPos = $p8;
        $r5 = self::$FAILED;
        goto seq_4;
      }
      $r5 = true;
      seq_4:
      if ($r5!==self::$FAILED) {
        $this->savedPos = $p7;
        $r5 = $this->a116($r19);
      }
      // free $p8
    }
    // bullets <- $r4
    // free $r5
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r5 = ";";
    } else {
      if (!$silence) {$this->fail(32);}
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r20 = $this->parseinlineline_break_on_colon($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r20===self::$FAILED) {
      $r20 = null;
    }
    // c <- $r20
    $p8 = $this->currPos;
    // cpos <- $r21
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r21 = ":";
      $this->savedPos = $p8;
      $r21 = $this->a117($r4, $r20);
    } else {
      if (!$silence) {$this->fail(18);}
      $r21 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r22 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r22===self::$FAILED) {
      $r22 = null;
    }
    // d <- $r22
    $p10 = $this->currPos;
    $r23 = $this->discardeolf(true);
    if ($r23!==self::$FAILED) {
      $r23 = false;
      $this->currPos = $p10;
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p10
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a118($r4, $r20, $r21, $r22);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsehacky_dl_uses($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [448, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r5 = ":";
      $r4 = [];
      while ($r5 !== self::$FAILED) {
        $r4[] = $r5;
        if (($this->input[$this->currPos] ?? null) === ":") {
          $this->currPos++;
          $r5 = ":";
        } else {
          if (!$silence) {$this->fail(18);}
          $r5 = self::$FAILED;
        }
      }
    } else {
      if (!$silence) {$this->fail(18);}
      $r5 = self::$FAILED;
      $r4 = self::$FAILED;
    }
    // bullets <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r5
    // start seq_2
    $p6 = $this->currPos;
    $r7 = $this->parsetable_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r8 = [];
    // start seq_3
    $p10 = $this->currPos;
    $r11 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r11===self::$FAILED) {
      $r9 = self::$FAILED;
      goto seq_3;
    }
    $r12 = $this->parsetable_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r12===self::$FAILED) {
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_3;
    }
    $r9 = [$r11,$r12];
    seq_3:
    // free $p10
    while ($r9 !== self::$FAILED) {
      $r8[] = $r9;
      // start seq_4
      $p10 = $this->currPos;
      $r13 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r13===self::$FAILED) {
        $r9 = self::$FAILED;
        goto seq_4;
      }
      $r14 = $this->parsetable_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r14===self::$FAILED) {
        $this->currPos = $p10;
        $r9 = self::$FAILED;
        goto seq_4;
      }
      $r9 = [$r13,$r14];
      seq_4:
      // free $p10
    }
    // free $r9
    $r5 = [$r7,$r8];
    seq_2:
    // tbl <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $r9 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r9===self::$FAILED) {
      $r9 = null;
    }
    // line <- $r9
    $p6 = $this->currPos;
    $r15 = $this->discardcomment_space_eolf(true);
    if ($r15!==self::$FAILED) {
      $r15 = false;
      $this->currPos = $p6;
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a119($r4, $r5, $r9);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseli($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [446, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r5 = $this->parselist_char($silence);
    if ($r5!==self::$FAILED) {
      $r4 = [];
      while ($r5 !== self::$FAILED) {
        $r4[] = $r5;
        $r5 = $this->parselist_char($silence);
      }
    } else {
      $r4 = self::$FAILED;
    }
    // bullets <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r5
    $r5 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r5===self::$FAILED) {
      $r5 = null;
    }
    // c <- $r5
    $p6 = $this->currPos;
    // start choice_1
    $r7 = $this->discardeolf(true);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    $r7 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    if ($r7!==self::$FAILED) {
      $r7 = false;
      $this->currPos = $p6;
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a120($r4, $r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardsol($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [517, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start seq_1
    $p1 = $this->currPos;
    // start choice_1
    $r3 = $this->discardempty_line_with_comments($silence);
    if ($r3!==self::$FAILED) {
      goto choice_1;
    }
    $r3 = $this->discardsol_prefix($silence);
    choice_1:
    if ($r3===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r4 = $this->discardcomment_or_includes($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4===self::$FAILED) {
      $this->currPos = $p1;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    // free $r2,$p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parseoptionalNewlines($silence) {
    $key = implode(':', [512, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_1
    $p6 = $this->currPos;
    if (strspn($this->input, "\x0a\x0d\x09 ", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos++];
    } else {
      $r7 = self::$FAILED;
      if (!$silence) {$this->fail(74);}
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $p8 = $this->currPos;
    $r9 = $this->input[$this->currPos] ?? '';
    if ($r9 === "\x0a" || $r9 === "\x0d") {
      $this->currPos++;
      $r9 = false;
      $this->currPos = $p8;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_1;
    }
    // free $p8
    $r5 = true;
    seq_1:
    // free $p6
    while ($r5 !== self::$FAILED) {
      // start seq_2
      $p6 = $this->currPos;
      if (strspn($this->input, "\x0a\x0d\x09 ", $this->currPos, 1) !== 0) {
        $r10 = $this->input[$this->currPos++];
      } else {
        $r10 = self::$FAILED;
        if (!$silence) {$this->fail(74);}
        $r5 = self::$FAILED;
        goto seq_2;
      }
      $p8 = $this->currPos;
      $r11 = $this->input[$this->currPos] ?? '';
      if ($r11 === "\x0a" || $r11 === "\x0d") {
        $this->currPos++;
        $r11 = false;
        $this->currPos = $p8;
      } else {
        $r11 = self::$FAILED;
        $this->currPos = $p6;
        $r5 = self::$FAILED;
        goto seq_2;
      }
      // free $p8
      $r5 = true;
      seq_2:
      // free $p6
    }
    // free $r5
    $r3 = true;
    // spc <- $r3
    if ($r3!==self::$FAILED) {
      $r3 = substr($this->input, $p4, $this->currPos - $p4);
    } else {
      $r3 = self::$FAILED;
    }
    // free $p4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a121($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_content_line($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [462, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start seq_1
    $p1 = $this->currPos;
    $r3 = [];
    // start choice_1
    $r4 = $this->parsespace($silence);
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    $r4 = $this->parsecomment($silence);
    choice_1:
    while ($r4 !== self::$FAILED) {
      $r3[] = $r4;
      // start choice_2
      $r4 = $this->parsespace($silence);
      if ($r4!==self::$FAILED) {
        goto choice_2;
      }
      $r4 = $this->parsecomment($silence);
      choice_2:
    }
    // free $r4
    // start choice_3
    $r4 = $this->parsetable_heading_tags($silence, $boolParams, $param_templatedepth, $param_preproc);
    if ($r4!==self::$FAILED) {
      goto choice_3;
    }
    $r4 = $this->parsetable_row_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4!==self::$FAILED) {
      goto choice_3;
    }
    $r4 = $this->parsetable_data_tags($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4!==self::$FAILED) {
      goto choice_3;
    }
    $r4 = $this->parsetable_caption_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_3:
    if ($r4===self::$FAILED) {
      $this->currPos = $p1;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = [$r3,$r4];
    seq_1:
    // free $r2,$p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parsetable_end_tag($silence) {
    $key = implode(':', [482, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = [];
    // start choice_1
    $r5 = $this->parsespace($silence);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $r5 = $this->parsecomment($silence);
    choice_1:
    while ($r5 !== self::$FAILED) {
      $r4[] = $r5;
      // start choice_2
      $r5 = $this->parsespace($silence);
      if ($r5!==self::$FAILED) {
        goto choice_2;
      }
      $r5 = $this->parsecomment($silence);
      choice_2:
    }
    // sc <- $r4
    // free $r5
    $p6 = $this->currPos;
    $r5 = '';
    // startPos <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a2($r4);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsepipe($silence);
    // p <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // b <- $r8
    if (($this->input[$this->currPos] ?? null) === "}") {
      $this->currPos++;
      $r8 = "}";
    } else {
      if (!$silence) {$this->fail(75);}
      $r8 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a122($r4, $r5, $r7, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetag_name($silence) {
    $key = implode(':', [418, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p1 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[A-Za-z]/", $r4)) {
      $this->currPos++;
    } else {
      $r4 = self::$FAILED;
      if (!$silence) {$this->fail(16);}
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->discardtag_name_chars($silence);
    while ($r6 !== self::$FAILED) {
      $r6 = $this->discardtag_name_chars($silence);
    }
    // free $r6
    $r5 = true;
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $r5
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $r2 = substr($this->input, $p1, $this->currPos - $p1);
    } else {
      $r2 = self::$FAILED;
    }
    // free $p3
    // free $p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function parsenewline($silence) {
    $key = implode(':', [532, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $this->currPos++;
      $r1 = "\x0a";
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(27);}
      $r1 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r1 = "\x0d\x0a";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(28);}
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetemplate_param_value($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [364, $this->currPos, $boolParams & 0x1b82, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = $this->parsetemplate_param_text($silence, $boolParams & ~0x8, $param_templatedepth, $param_preproc, $param_th);
    // tpt <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a123($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardnl_comment_space($silence) {
    $key = implode(':', [525, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->discardnewlineToken($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->discardcomment_space($silence);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsenl_comment_space($silence) {
    $key = implode(':', [524, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->parsenewlineToken($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsecomment_space($silence);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetemplate_param($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [360, $this->currPos, $boolParams & 0x1b82, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsetemplate_param_name($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // name <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $p9 = $this->currPos;
    $r8 = '';
    // kEndPos <- $r8
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a124($r4);
    } else {
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r10 = $this->discardoptionalSpaceToken($silence);
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r11 = "=";
    } else {
      if (!$silence) {$this->fail(23);}
      $r11 = self::$FAILED;
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $p13 = $this->currPos;
    $r12 = '';
    // vStartPos <- $r12
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p13;
      $r12 = $this->a125($r4, $r8);
    } else {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r14 = $this->discardoptionalSpaceToken($silence);
    if ($r14===self::$FAILED) {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r15 = $this->parsetemplate_param_value($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r15===self::$FAILED) {
      $r15 = null;
    }
    // tpv <- $r15
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a126($r4, $r8, $r12, $r15);
    } else {
      $r5 = null;
    }
    // free $p7
    // val <- $r5
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a127($r4, $r5);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    $p7 = $this->currPos;
    $r1 = $this->input[$this->currPos] ?? '';
    if ($r1 === "|" || $r1 === "}") {
      $this->currPos++;
      $r1 = false;
      $this->currPos = $p7;
      $this->savedPos = $p3;
      $r1 = $this->a128();
    } else {
      $r1 = self::$FAILED;
    }
    // free $p7
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsewikilink_preprocessor_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [542, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $p6 = $this->currPos;
    if (strcspn($this->input, "<[{\x0a\x0d\x09|!]}{ &-", $this->currPos, 1) !== 0) {
      $r7 = self::consumeChar($this->input, $this->currPos);
      $r5 = true;
      while ($r7 !== self::$FAILED) {
        if (strcspn($this->input, "<[{\x0a\x0d\x09|!]}{ &-", $this->currPos, 1) !== 0) {
          $r7 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r7 = self::$FAILED;
          if (!$silence) {$this->fail(76);}
        }
      }
    } else {
      $r7 = self::$FAILED;
      if (!$silence) {$this->fail(76);}
      $r5 = self::$FAILED;
    }
    // t <- $r5
    if ($r5!==self::$FAILED) {
      $r5 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r5 = self::$FAILED;
    }
    // free $r7
    // free $p6
    $r4 = $r5;
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    $p6 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $p9 = $this->currPos;
    $r7 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7 === self::$FAILED) {
      $r7 = false;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p9;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // free $p9
    // start choice_2
    $r10 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    $p9 = $this->currPos;
    // start seq_2
    $p11 = $this->currPos;
    $p12 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r13 = "]]";
      $this->currPos += 2;
    } else {
      $r13 = self::$FAILED;
    }
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p12;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    // free $p12
    // start choice_3
    $r14 = $this->discardtext_char($silence);
    if ($r14!==self::$FAILED) {
      goto choice_3;
    }
    if (strspn($this->input, "!<-}]\x0a\x0d", $this->currPos, 1) !== 0) {
      $r14 = $this->input[$this->currPos++];
    } else {
      $r14 = self::$FAILED;
      if (!$silence) {$this->fail(77);}
    }
    choice_3:
    if ($r14===self::$FAILED) {
      $this->currPos = $p11;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    $r10 = true;
    seq_2:
    if ($r10!==self::$FAILED) {
      $r10 = substr($this->input, $p9, $this->currPos - $p9);
    } else {
      $r10 = self::$FAILED;
    }
    // free $p11
    // free $p9
    choice_2:
    // wr <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = true;
    seq_1:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p6;
      $r4 = $this->a129($r5, $r10);
    }
    // free $p8
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_4
        $p8 = $this->currPos;
        if (strcspn($this->input, "<[{\x0a\x0d\x09|!]}{ &-", $this->currPos, 1) !== 0) {
          $r16 = self::consumeChar($this->input, $this->currPos);
          $r15 = true;
          while ($r16 !== self::$FAILED) {
            if (strcspn($this->input, "<[{\x0a\x0d\x09|!]}{ &-", $this->currPos, 1) !== 0) {
              $r16 = self::consumeChar($this->input, $this->currPos);
            } else {
              $r16 = self::$FAILED;
              if (!$silence) {$this->fail(76);}
            }
          }
        } else {
          $r16 = self::$FAILED;
          if (!$silence) {$this->fail(76);}
          $r15 = self::$FAILED;
        }
        // t <- $r15
        if ($r15!==self::$FAILED) {
          $r15 = substr($this->input, $p8, $this->currPos - $p8);
        } else {
          $r15 = self::$FAILED;
        }
        // free $r16
        // free $p8
        $r4 = $r15;
        if ($r4!==self::$FAILED) {
          goto choice_4;
        }
        $p8 = $this->currPos;
        // start seq_3
        $p9 = $this->currPos;
        $p11 = $this->currPos;
        $r16 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r16 === self::$FAILED) {
          $r16 = false;
        } else {
          $r16 = self::$FAILED;
          $this->currPos = $p11;
          $r4 = self::$FAILED;
          goto seq_3;
        }
        // free $p11
        // start choice_5
        $r17 = $this->parsedirective($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r17!==self::$FAILED) {
          goto choice_5;
        }
        $p11 = $this->currPos;
        // start seq_4
        $p12 = $this->currPos;
        $p18 = $this->currPos;
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
          $r19 = "]]";
          $this->currPos += 2;
        } else {
          $r19 = self::$FAILED;
        }
        if ($r19 === self::$FAILED) {
          $r19 = false;
        } else {
          $r19 = self::$FAILED;
          $this->currPos = $p18;
          $r17 = self::$FAILED;
          goto seq_4;
        }
        // free $p18
        // start choice_6
        $r20 = $this->discardtext_char($silence);
        if ($r20!==self::$FAILED) {
          goto choice_6;
        }
        if (strspn($this->input, "!<-}]\x0a\x0d", $this->currPos, 1) !== 0) {
          $r20 = $this->input[$this->currPos++];
        } else {
          $r20 = self::$FAILED;
          if (!$silence) {$this->fail(77);}
        }
        choice_6:
        if ($r20===self::$FAILED) {
          $this->currPos = $p12;
          $r17 = self::$FAILED;
          goto seq_4;
        }
        $r17 = true;
        seq_4:
        if ($r17!==self::$FAILED) {
          $r17 = substr($this->input, $p11, $this->currPos - $p11);
        } else {
          $r17 = self::$FAILED;
        }
        // free $p12
        // free $p11
        choice_5:
        // wr <- $r17
        if ($r17===self::$FAILED) {
          $this->currPos = $p9;
          $r4 = self::$FAILED;
          goto seq_3;
        }
        $r4 = true;
        seq_3:
        if ($r4!==self::$FAILED) {
          $this->savedPos = $p8;
          $r4 = $this->a129($r15, $r17);
        }
        // free $p9
        choice_4:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // r <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a130($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsewikilink_content($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [396, $this->currPos, $boolParams & 0x39f7, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = [];
    $p3 = $this->currPos;
    // start seq_1
    $p4 = $this->currPos;
    $r5 = $this->discardpipe($silence);
    if ($r5===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $p7 = $this->currPos;
    $r6 = '';
    // startPos <- $r6
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a34();
    } else {
      $this->currPos = $p4;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r8 = $this->parselink_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r8===self::$FAILED) {
      $r8 = null;
    }
    // lt <- $r8
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p3;
      $r2 = $this->a131($r6, $r8);
    }
    // free $p4
    while ($r2 !== self::$FAILED) {
      $r1[] = $r2;
      $p4 = $this->currPos;
      // start seq_2
      $p9 = $this->currPos;
      $r10 = $this->discardpipe($silence);
      if ($r10===self::$FAILED) {
        $r2 = self::$FAILED;
        goto seq_2;
      }
      $p12 = $this->currPos;
      $r11 = '';
      // startPos <- $r11
      if ($r11!==self::$FAILED) {
        $this->savedPos = $p12;
        $r11 = $this->a34();
      } else {
        $this->currPos = $p9;
        $r2 = self::$FAILED;
        goto seq_2;
      }
      $r13 = $this->parselink_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r13===self::$FAILED) {
        $r13 = null;
      }
      // lt <- $r13
      $r2 = true;
      seq_2:
      if ($r2!==self::$FAILED) {
        $this->savedPos = $p4;
        $r2 = $this->a131($r11, $r13);
      }
      // free $p9
    }
    // free $r2
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsespace_or_nbsp($silence) {
    $key = implode(':', [508, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->parsespace($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parseunispace($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsehtmlentity($silence);
    // he <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r5 = $this->a132($r4);
    if ($r5) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a55($r4);
    }
    // free $p3
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardend_of_word($silence) {
    $key = implode(':', [505, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->discardeof($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    $r1 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[A-Za-z0-9_]/", $r1)) {
      $this->currPos++;
    } else {
      $r1 = self::$FAILED;
    }
    if ($r1 === self::$FAILED) {
      $r1 = false;
    } else {
      $r1 = self::$FAILED;
      $this->currPos = $p2;
    }
    // free $p2
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsespace_or_nbsp_or_dash($silence) {
    $key = implode(':', [510, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->parsespace_or_nbsp($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r1 = "-";
    } else {
      if (!$silence) {$this->fail(59);}
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_preproc($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [374, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    // lv0 <- $r4
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
      $r4 = "-{";
      $this->currPos += 2;
      $this->savedPos = $p5;
      $r4 = $this->a133();
    } else {
      if (!$silence) {$this->fail(78);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    $p7 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r9 = $this->a134($r4);
    if ($r9) {
      $r9 = false;
    } else {
      $r9 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r10 = $this->parseopt_lang_variant_flags($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // ff <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a135($r4, $r10);
      goto choice_1;
    }
    // free $p8
    $p8 = $this->currPos;
    // start seq_3
    $p11 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r12 = $this->a136($r4);
    if ($r12) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_3;
    }
    $r6 = true;
    seq_3:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p8;
      $r6 = $this->a137($r4);
    }
    // free $p11
    choice_1:
    // f <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $p11 = $this->currPos;
    // start seq_4
    $p14 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r15 = $this->a138($r4, $r6);
    if ($r15) {
      $r15 = false;
    } else {
      $r15 = self::$FAILED;
      $r13 = self::$FAILED;
      goto seq_4;
    }
    $r16 = $this->parselang_variant_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lv <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p14;
      $r13 = self::$FAILED;
      goto seq_4;
    }
    $r13 = true;
    seq_4:
    if ($r13!==self::$FAILED) {
      $this->savedPos = $p11;
      $r13 = $this->a139($r4, $r6, $r16);
      goto choice_2;
    }
    // free $p14
    $p14 = $this->currPos;
    // start seq_5
    $p17 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r18 = $this->a140($r4, $r6);
    if ($r18) {
      $r18 = false;
    } else {
      $r18 = self::$FAILED;
      $r13 = self::$FAILED;
      goto seq_5;
    }
    $r19 = $this->parselang_variant_option_list($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lv <- $r19
    if ($r19===self::$FAILED) {
      $this->currPos = $p17;
      $r13 = self::$FAILED;
      goto seq_5;
    }
    $r13 = true;
    seq_5:
    if ($r13!==self::$FAILED) {
      $this->savedPos = $p14;
      $r13 = $this->a141($r4, $r6, $r19);
    }
    // free $p17
    choice_2:
    // ts <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r20 = $this->discardinline_breaks($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r20===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p17 = $this->currPos;
    // lv1 <- $r21
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}-", $this->currPos, 2, false) === 0) {
      $r21 = "}-";
      $this->currPos += 2;
      $this->savedPos = $p17;
      $r21 = $this->a142($r4, $r6, $r13);
    } else {
      if (!$silence) {$this->fail(79);}
      $r21 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a143($r4, $r6, $r13, $r21);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsebroken_lang_variant($silence, &$param_preproc) {
    $key = implode(':', [370, $this->currPos, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    // r <- $r4
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
      $r4 = "-{";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(78);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a144($r4, $param_preproc);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardlist_char($silence) {
    $key = implode(':', [453, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    if (strspn($this->input, "*#:;", $this->currPos, 1) !== 0) {
      $r1 = $this->input[$this->currPos++];
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(80);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselist_char($silence) {
    $key = implode(':', [452, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    if (strspn($this->input, "*#:;", $this->currPos, 1) !== 0) {
      $r1 = $this->input[$this->currPos++];
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(80);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseinlineline_break_on_colon($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [454, $this->currPos, $boolParams & 0xbfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = $this->parseinlineline($silence, $boolParams | 0x1000, $param_templatedepth, $param_preproc, $param_th);
    // ill <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a145($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardcomment_space_eolf($silence) {
    $key = implode(':', [539, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start seq_1
    $p1 = $this->currPos;
    // start choice_1
    $r5 = $this->discardspace($silence);
    if ($r5!==self::$FAILED) {
      $r4 = true;
      while ($r5 !== self::$FAILED) {
        $r5 = $this->discardspace($silence);
      }
    } else {
      $r4 = self::$FAILED;
    }
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    // free $r5
    $r4 = $this->discardcomment($silence);
    choice_1:
    while ($r4 !== self::$FAILED) {
      // start choice_2
      $r5 = $this->discardspace($silence);
      if ($r5!==self::$FAILED) {
        $r4 = true;
        while ($r5 !== self::$FAILED) {
          $r5 = $this->discardspace($silence);
        }
      } else {
        $r4 = self::$FAILED;
      }
      if ($r4!==self::$FAILED) {
        goto choice_2;
      }
      // free $r5
      $r4 = $this->discardcomment($silence);
      choice_2:
    }
    // free $r4
    $r3 = true;
    if ($r3===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    // free $r3
    $r3 = $this->discardeolf($silence);
    if ($r3===self::$FAILED) {
      $this->currPos = $p1;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    // free $r2,$p1
    $cached = ['nextPos' => $this->currPos, 'result' => $r2];
  
    $this->cache[$key] = $cached;
    return $r2;
  }
  private function discardempty_line_with_comments($silence) {
    $key = implode(':', [521, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsesol_prefix($silence);
    // sp <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r5 = '';
    // p <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a89($r4);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = [];
    $r11 = $this->parsespace($silence);
    while ($r11 !== self::$FAILED) {
      $r10[] = $r11;
      $r11 = $this->parsespace($silence);
    }
    // free $r11
    $r11 = $this->parsecomment($silence);
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r12 = [];
    // start choice_1
    $r13 = $this->parsespace($silence);
    if ($r13!==self::$FAILED) {
      goto choice_1;
    }
    $r13 = $this->parsecomment($silence);
    choice_1:
    while ($r13 !== self::$FAILED) {
      $r12[] = $r13;
      // start choice_2
      $r13 = $this->parsespace($silence);
      if ($r13!==self::$FAILED) {
        goto choice_2;
      }
      $r13 = $this->parsecomment($silence);
      choice_2:
    }
    // free $r13
    $r13 = $this->parsenewline($silence);
    if ($r13===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = [$r10,$r11,$r12,$r13];
    seq_2:
    if ($r8!==self::$FAILED) {
      $r7 = [];
      while ($r8 !== self::$FAILED) {
        $r7[] = $r8;
        // start seq_3
        $p9 = $this->currPos;
        $r14 = [];
        $r15 = $this->parsespace($silence);
        while ($r15 !== self::$FAILED) {
          $r14[] = $r15;
          $r15 = $this->parsespace($silence);
        }
        // free $r15
        $r15 = $this->parsecomment($silence);
        if ($r15===self::$FAILED) {
          $this->currPos = $p9;
          $r8 = self::$FAILED;
          goto seq_3;
        }
        $r16 = [];
        // start choice_3
        $r17 = $this->parsespace($silence);
        if ($r17!==self::$FAILED) {
          goto choice_3;
        }
        $r17 = $this->parsecomment($silence);
        choice_3:
        while ($r17 !== self::$FAILED) {
          $r16[] = $r17;
          // start choice_4
          $r17 = $this->parsespace($silence);
          if ($r17!==self::$FAILED) {
            goto choice_4;
          }
          $r17 = $this->parsecomment($silence);
          choice_4:
        }
        // free $r17
        $r17 = $this->parsenewline($silence);
        if ($r17===self::$FAILED) {
          $this->currPos = $p9;
          $r8 = self::$FAILED;
          goto seq_3;
        }
        $r8 = [$r14,$r15,$r16,$r17];
        seq_3:
        // free $p9
      }
    } else {
      $r7 = self::$FAILED;
    }
    // free $p9
    // c <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a90($r4, $r5, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardsol_prefix($silence) {
    $key = implode(':', [519, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->discardnewlineToken($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $p2 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r1 = $this->a91();
    if ($r1) {
      $r1 = false;
      $this->savedPos = $p2;
      $r1 = $this->a92();
    } else {
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardcomment_or_includes($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [515, $this->currPos, $boolParams & 0x13ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $r2 = $this->discardcomment($silence);
    if ($r2!==self::$FAILED) {
      goto choice_1;
    }
    $r2 = $this->discardinclude_limits($silence, $boolParams | 0x2000, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    while ($r2 !== self::$FAILED) {
      // start choice_2
      $r2 = $this->discardcomment($silence);
      if ($r2!==self::$FAILED) {
        goto choice_2;
      }
      $r2 = $this->discardinclude_limits($silence, $boolParams | 0x2000, $param_templatedepth, $param_preproc, $param_th);
      choice_2:
    }
    // free $r2
    $r1 = true;
    // free $r1
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_heading_tags($silence, $boolParams, $param_templatedepth, &$param_preproc) {
    $key = implode(':', [476, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
    $r1 = $this->parsetable_heading_tags_parameterized($silence, $boolParams, $param_templatedepth, $param_preproc, self::newRef(true));
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_row_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [468, $this->currPos, $boolParams & 0x3bef, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsepipe($silence);
    // p <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p7 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r8 = "-";
      $r6 = true;
      while ($r8 !== self::$FAILED) {
        if (($this->input[$this->currPos] ?? null) === "-") {
          $this->currPos++;
          $r8 = "-";
        } else {
          if (!$silence) {$this->fail(59);}
          $r8 = self::$FAILED;
        }
      }
    } else {
      if (!$silence) {$this->fail(59);}
      $r8 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // dashes <- $r6
    if ($r6!==self::$FAILED) {
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
    } else {
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    // free $p7
    // start choice_1
    $r8 = $this->parsetable_attributes($silence, $boolParams & ~0x10, $param_templatedepth, $param_preproc, $param_th);
    if ($r8!==self::$FAILED) {
      goto choice_1;
    }
    $this->savedPos = $this->currPos;
    $r8 = $this->a146($r5, $r6);
    if ($r8) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
    }
    choice_1:
    // a <- $r8
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p7 = $this->currPos;
    $r9 = '';
    // tagEndPos <- $r9
    if ($r9!==self::$FAILED) {
      $this->savedPos = $p7;
      $r9 = $this->a147($r5, $r6, $r8);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a148($r5, $r6, $r8, $r9);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_data_tags($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [472, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsepipe($silence);
    // p <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r7 = $this->input[$this->currPos] ?? '';
    if ($r7 === "+" || $r7 === "-") {
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    if ($r7 === self::$FAILED) {
      $r7 = false;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p6;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $r8 = $this->parsetable_data_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // td <- $r8
    if ($r8===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r9 = '';
    // tagEndPos <- $r9
    if ($r9!==self::$FAILED) {
      $this->savedPos = $p6;
      $r9 = $this->a149($r5, $r8);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r10 = $this->parsetds($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // tds <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a150($r5, $r8, $r9, $r10);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_caption_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [466, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
      $r4 = false;
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsepipe($silence);
    // p <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    if (($this->input[$this->currPos] ?? null) === "+") {
      $this->currPos++;
      $r6 = "+";
    } else {
      if (!$silence) {$this->fail(81);}
      $r6 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parserow_syntax_table_args($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $r7 = null;
    }
    // args <- $r7
    $p9 = $this->currPos;
    $r8 = '';
    // tagEndPos <- $r8
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a151($r5, $r7);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r10 = [];
    $r11 = $this->parsenested_block_in_table($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    while ($r11 !== self::$FAILED) {
      $r10[] = $r11;
      $r11 = $this->parsenested_block_in_table($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    }
    // c <- $r10
    // free $r11
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a152($r5, $r7, $r8, $r10);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardtag_name_chars($silence) {
    $key = implode(':', [417, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    if (strcspn($this->input, "\x09\x0a\x0b />\x00", $this->currPos, 1) !== 0) {
      $r1 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(82);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetemplate_param_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [366, $this->currPos, $boolParams & 0x1b8a, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $r4 = $this->parsenested_block($silence, ($boolParams & ~0x54) | 0x20, $param_templatedepth, $param_preproc, $param_th);
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    $r4 = $this->parsenewlineToken($silence);
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_2
        $r4 = $this->parsenested_block($silence, ($boolParams & ~0x54) | 0x20, $param_templatedepth, $param_preproc, $param_th);
        if ($r4!==self::$FAILED) {
          goto choice_2;
        }
        $r4 = $this->parsenewlineToken($silence);
        choice_2:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // il <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a153($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardcomment_space($silence) {
    $key = implode(':', [523, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->discardcomment($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->discardspace($silence);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsecomment_space($silence) {
    $key = implode(':', [522, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    $r1 = $this->parsecomment($silence);
    if ($r1!==self::$FAILED) {
      goto choice_1;
    }
    $r1 = $this->parsespace($silence);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetemplate_param_name($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [362, $this->currPos, $boolParams & 0x1b82, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    $r3 = $this->parsetemplate_param_text($silence, $boolParams | 0x8, $param_templatedepth, $param_preproc, $param_th);
    if ($r3!==self::$FAILED) {
      goto choice_1;
    }
    $p4 = $this->currPos;
    $p5 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r3 = "=";
      $r3 = false;
      $this->currPos = $p5;
      $this->savedPos = $p4;
      $r3 = $this->a154();
    } else {
      $r3 = self::$FAILED;
    }
    // free $p5
    choice_1:
    // tpt <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a155($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardtext_char($silence) {
    $key = implode(':', [487, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    if (strcspn($this->input, "-'<~[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
      $r1 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(58);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselink_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [404, $this->currPos, $boolParams & 0x39f7, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = $this->parselink_text_parameterized($silence, ($boolParams & ~0x8) | 0x200, $param_templatedepth, $param_preproc, $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseunispace($silence) {
    $key = implode(':', [506, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $r1 = self::charAt($this->input, $this->currPos);
    if (preg_match("/^[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/u", $r1)) {
      $this->currPos += strlen($r1);
    } else {
      $r1 = self::$FAILED;
      if (!$silence) {$this->fail(25);}
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parseopt_lang_variant_flags($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [376, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_1
    $p5 = $this->currPos;
    $r6 = $this->parselang_variant_flags($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // ff <- $r6
    if ($r6===self::$FAILED) {
      $r3 = self::$FAILED;
      goto seq_1;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r7 = "|";
    } else {
      if (!$silence) {$this->fail(13);}
      $r7 = self::$FAILED;
      $this->currPos = $p5;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r3 = true;
    seq_1:
    if ($r3!==self::$FAILED) {
      $this->savedPos = $p4;
      $r3 = $this->a156($r6);
    } else {
      $r3 = null;
    }
    // free $p5
    // f <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a157($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [390, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = [];
    // start choice_1
    $r4 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r4 = "|";
    } else {
      if (!$silence) {$this->fail(13);}
      $r4 = self::$FAILED;
    }
    choice_1:
    while ($r4 !== self::$FAILED) {
      $r3[] = $r4;
      // start choice_2
      $r4 = $this->parseinlineline($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r4!==self::$FAILED) {
        goto choice_2;
      }
      if (($this->input[$this->currPos] ?? null) === "|") {
        $this->currPos++;
        $r4 = "|";
      } else {
        if (!$silence) {$this->fail(13);}
        $r4 = self::$FAILED;
      }
      choice_2:
    }
    // tokens <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a158($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_option_list($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [384, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parselang_variant_option($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // o <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = [];
    $p7 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r9 = ";";
    } else {
      if (!$silence) {$this->fail(32);}
      $r9 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r10 = $this->parselang_variant_option($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // oo <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a159($r4, $r10);
    }
    // free $p8
    while ($r6 !== self::$FAILED) {
      $r5[] = $r6;
      $p8 = $this->currPos;
      // start seq_3
      $p11 = $this->currPos;
      if (($this->input[$this->currPos] ?? null) === ";") {
        $this->currPos++;
        $r12 = ";";
      } else {
        if (!$silence) {$this->fail(32);}
        $r12 = self::$FAILED;
        $r6 = self::$FAILED;
        goto seq_3;
      }
      $r13 = $this->parselang_variant_option($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      // oo <- $r13
      if ($r13===self::$FAILED) {
        $this->currPos = $p11;
        $r6 = self::$FAILED;
        goto seq_3;
      }
      $r6 = true;
      seq_3:
      if ($r6!==self::$FAILED) {
        $this->savedPos = $p8;
        $r6 = $this->a159($r4, $r13);
      }
      // free $p11
    }
    // rest <- $r5
    // free $r6
    // start seq_4
    $p11 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r14 = ";";
    } else {
      if (!$silence) {$this->fail(32);}
      $r14 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_4;
    }
    $p15 = $this->currPos;
    $r17 = $this->discardspace_or_newline($silence);
    while ($r17 !== self::$FAILED) {
      $r17 = $this->discardspace_or_newline($silence);
    }
    // free $r17
    $r16 = true;
    if ($r16!==self::$FAILED) {
      $r16 = substr($this->input, $p15, $this->currPos - $p15);
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p11;
      $r6 = self::$FAILED;
      goto seq_4;
    }
    // free $p15
    $r6 = [$r14,$r16];
    seq_4:
    if ($r6===self::$FAILED) {
      $r6 = null;
    }
    // free $p11
    // tr <- $r6
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a160($r4, $r5, $r6);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    $r17 = $this->parselang_variant_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lvtext <- $r17
    $r1 = $r17;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a161($r17);
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardcomment($silence) {
    $key = implode(':', [321, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "<!--", $this->currPos, 4, false) === 0) {
      $r4 = "<!--";
      $this->currPos += 4;
    } else {
      if (!$silence) {$this->fail(11);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $p9 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r10 = "-->";
      $this->currPos += 3;
    } else {
      $r10 = self::$FAILED;
    }
    if ($r10 === self::$FAILED) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    if ($this->currPos < $this->inputLength) {
      $r11 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
      $this->currPos = $p8;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    // free $p8
    while ($r7 !== self::$FAILED) {
      // start seq_3
      $p8 = $this->currPos;
      $p9 = $this->currPos;
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
        $r12 = "-->";
        $this->currPos += 3;
      } else {
        $r12 = self::$FAILED;
      }
      if ($r12 === self::$FAILED) {
        $r12 = false;
      } else {
        $r12 = self::$FAILED;
        $this->currPos = $p9;
        $r7 = self::$FAILED;
        goto seq_3;
      }
      // free $p9
      if ($this->currPos < $this->inputLength) {
        $r13 = self::consumeChar($this->input, $this->currPos);;
      } else {
        $r13 = self::$FAILED;
        if (!$silence) {$this->fail(7);}
        $this->currPos = $p8;
        $r7 = self::$FAILED;
        goto seq_3;
      }
      $r7 = true;
      seq_3:
      // free $p8
    }
    // free $r7
    $r5 = true;
    // c <- $r5
    if ($r5!==self::$FAILED) {
      $r5 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r7 = "-->";
      $this->currPos += 3;
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(12);}
      $r7 = self::$FAILED;
    }
    $r7 = $this->discardeof($silence);
    choice_1:
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a21($r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardinclude_limits($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [527, $this->currPos, $boolParams & 0x33ae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "<") {
      $this->currPos++;
      $r7 = "<";
    } else {
      $r7 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    if (($this->input[$this->currPos] ?? null) === "/") {
      $this->currPos++;
      $r8 = "/";
    } else {
      $r8 = self::$FAILED;
      $r8 = null;
    }
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "includeonly", $this->currPos, 11, true) === 0) {
      $r9 = substr($this->input, $this->currPos, 11);
      $this->currPos += 11;
      goto choice_1;
    } else {
      $r9 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "noinclude", $this->currPos, 9, true) === 0) {
      $r9 = substr($this->input, $this->currPos, 9);
      $this->currPos += 9;
      goto choice_1;
    } else {
      $r9 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "onlyinclude", $this->currPos, 11, true) === 0) {
      $r9 = substr($this->input, $this->currPos, 11);
      $this->currPos += 11;
    } else {
      $r9 = self::$FAILED;
    }
    choice_1:
    // n <- $r9
    if ($r9===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $r5 = false;
      $this->currPos = $p4;
    } else {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    // free $p4
    $r10 = $this->parsexmlish_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // il <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r11 = $this->a77($r10, /*sol_il*/($boolParams & 0x2000) !== 0);
    if ($r11) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a78($r10, /*sol_il*/($boolParams & 0x2000) !== 0);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_heading_tags_parameterized($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [478, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "!") {
      $this->currPos++;
      $r4 = "!";
    } else {
      if (!$silence) {$this->fail(83);}
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parsetable_heading_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // thTag <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = [];
    $p8 = $this->currPos;
    // start seq_2
    $p9 = $this->currPos;
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
      $r10 = "!!";
      $this->currPos += 2;
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(84);}
      $r10 = self::$FAILED;
    }
    $r10 = $this->parsepipe_pipe($silence);
    choice_1:
    // pp <- $r10
    if ($r10===self::$FAILED) {
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r11 = $this->parsetable_heading_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // tht <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a162($r5, $r10, $r11);
    }
    // free $p9
    while ($r7 !== self::$FAILED) {
      $r6[] = $r7;
      $p9 = $this->currPos;
      // start seq_3
      $p12 = $this->currPos;
      // start choice_2
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
        $r13 = "!!";
        $this->currPos += 2;
        goto choice_2;
      } else {
        if (!$silence) {$this->fail(84);}
        $r13 = self::$FAILED;
      }
      $r13 = $this->parsepipe_pipe($silence);
      choice_2:
      // pp <- $r13
      if ($r13===self::$FAILED) {
        $r7 = self::$FAILED;
        goto seq_3;
      }
      $r14 = $this->parsetable_heading_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      // tht <- $r14
      if ($r14===self::$FAILED) {
        $this->currPos = $p12;
        $r7 = self::$FAILED;
        goto seq_3;
      }
      $r7 = true;
      seq_3:
      if ($r7!==self::$FAILED) {
        $this->savedPos = $p9;
        $r7 = $this->a162($r5, $r13, $r14);
      }
      // free $p12
    }
    // thTags <- $r6
    // free $r7
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a163($r5, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_data_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [474, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "}") {
      $this->currPos++;
      $r5 = "}";
    } else {
      $r5 = self::$FAILED;
    }
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r6 = $this->parserow_syntax_table_args($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6===self::$FAILED) {
      $r6 = null;
    }
    // arg <- $r6
    $p4 = $this->currPos;
    $r7 = '';
    // tagEndPos <- $r7
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p4;
      $r7 = $this->a164($r6);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r8 = [];
    $r9 = $this->parsenested_block_in_table($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    while ($r9 !== self::$FAILED) {
      $r8[] = $r9;
      $r9 = $this->parsenested_block_in_table($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    }
    // td <- $r8
    // free $r9
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a165($r6, $r7, $r8);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetds($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [470, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = [];
    $p3 = $this->currPos;
    // start seq_1
    $p4 = $this->currPos;
    // start choice_1
    $r5 = $this->parsepipe_pipe($silence);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $r8 = $this->parsepipe($silence);
    // p <- $r8
    if ($r8===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $p9 = $this->currPos;
    $r10 = $this->discardrow_syntax_table_args(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      $r10 = false;
      $this->currPos = $p9;
    } else {
      $this->currPos = $p7;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a23($r8);
    }
    // free $p7
    choice_1:
    // pp <- $r5
    if ($r5===self::$FAILED) {
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r11 = $this->parsetable_data_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // tdt <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p4;
      $r2 = self::$FAILED;
      goto seq_1;
    }
    $r2 = true;
    seq_1:
    if ($r2!==self::$FAILED) {
      $this->savedPos = $p3;
      $r2 = $this->a166($r5, $r11);
    }
    // free $p4
    while ($r2 !== self::$FAILED) {
      $r1[] = $r2;
      $p4 = $this->currPos;
      // start seq_3
      $p7 = $this->currPos;
      // start choice_2
      $r12 = $this->parsepipe_pipe($silence);
      if ($r12!==self::$FAILED) {
        goto choice_2;
      }
      $p9 = $this->currPos;
      // start seq_4
      $p13 = $this->currPos;
      $r14 = $this->parsepipe($silence);
      // p <- $r14
      if ($r14===self::$FAILED) {
        $r12 = self::$FAILED;
        goto seq_4;
      }
      $p15 = $this->currPos;
      $r16 = $this->discardrow_syntax_table_args(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r16!==self::$FAILED) {
        $r16 = false;
        $this->currPos = $p15;
      } else {
        $this->currPos = $p13;
        $r12 = self::$FAILED;
        goto seq_4;
      }
      // free $p15
      $r12 = true;
      seq_4:
      if ($r12!==self::$FAILED) {
        $this->savedPos = $p9;
        $r12 = $this->a23($r14);
      }
      // free $p13
      choice_2:
      // pp <- $r12
      if ($r12===self::$FAILED) {
        $r2 = self::$FAILED;
        goto seq_3;
      }
      $r17 = $this->parsetable_data_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      // tdt <- $r17
      if ($r17===self::$FAILED) {
        $this->currPos = $p7;
        $r2 = self::$FAILED;
        goto seq_3;
      }
      $r2 = true;
      seq_3:
      if ($r2!==self::$FAILED) {
        $this->savedPos = $p4;
        $r2 = $this->a166($r12, $r17);
      }
      // free $p7
    }
    // free $r2
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsenested_block_in_table($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [300, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    // start seq_2
    $p6 = $this->currPos;
    $r7 = $this->discardsol(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // start seq_3
    $p9 = $this->currPos;
    $r11 = $this->discardspace(true);
    while ($r11 !== self::$FAILED) {
      $r11 = $this->discardspace(true);
    }
    // free $r11
    $r10 = true;
    if ($r10===self::$FAILED) {
      $r8 = self::$FAILED;
      goto seq_3;
    }
    // free $r10
    $r10 = $this->discardsol(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_3;
    }
    $r8 = true;
    seq_3:
    if ($r8===self::$FAILED) {
      $r8 = null;
    }
    // free $p9
    $r12 = $this->discardspace(true);
    while ($r12 !== self::$FAILED) {
      $r12 = $this->discardspace(true);
    }
    // free $r12
    $r11 = true;
    if ($r11===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $r11
    // start choice_1
    $r11 = $this->discardpipe(true);
    if ($r11!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "!") {
      $this->currPos++;
      $r11 = "!";
    } else {
      $r11 = self::$FAILED;
    }
    choice_1:
    if ($r11===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    // free $p6
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r12 = $this->parsenested_block($silence, $boolParams | 0x1, $param_templatedepth, $param_preproc, $param_th);
    // b <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a167($r12);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsenested_block($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [298, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p4 = $this->currPos;
    $r5 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p4
    $r6 = $this->parseblock($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    // b <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a13($r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselink_text_parameterized($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [406, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start choice_1
    // start seq_1
    $p5 = $this->currPos;
    $r6 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r6===self::$FAILED) {
      $r4 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r7 = $this->parseheading($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    $r7 = $this->parsehr($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    $r7 = $this->parsefull_table_in_link_caption($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p5;
      $r4 = self::$FAILED;
      goto seq_1;
    }
    $r4 = [$r6,$r7];
    seq_1:
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    // free $p5
    $r4 = $this->parseurltext($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4!==self::$FAILED) {
      goto choice_1;
    }
    $p5 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $p9 = $this->currPos;
    $r10 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10 === self::$FAILED) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $this->currPos = $p9;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    // start choice_3
    $r11 = $this->parseinline_element($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r11!==self::$FAILED) {
      goto choice_3;
    }
    // start seq_3
    $p9 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r12 = "[";
    } else {
      if (!$silence) {$this->fail(19);}
      $r12 = self::$FAILED;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r14 = $this->parsetext_char($silence);
    if ($r14!==self::$FAILED) {
      $r13 = [];
      while ($r14 !== self::$FAILED) {
        $r13[] = $r14;
        $r14 = $this->parsetext_char($silence);
      }
    } else {
      $r13 = self::$FAILED;
    }
    if ($r13===self::$FAILED) {
      $this->currPos = $p9;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $r14
    if (($this->input[$this->currPos] ?? null) === "]") {
      $this->currPos++;
      $r14 = "]";
    } else {
      if (!$silence) {$this->fail(21);}
      $r14 = self::$FAILED;
      $this->currPos = $p9;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $p15 = $this->currPos;
    $p17 = $this->currPos;
    // start choice_4
    $p18 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "]") {
      $this->currPos++;
      $r16 = "]";
    } else {
      $r16 = self::$FAILED;
    }
    if ($r16 === self::$FAILED) {
      $r16 = false;
      goto choice_4;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p18;
    }
    // free $p18
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r16 = "]]";
      $this->currPos += 2;
    } else {
      $r16 = self::$FAILED;
    }
    choice_4:
    if ($r16!==self::$FAILED) {
      $r16 = false;
      $this->currPos = $p17;
      $r16 = substr($this->input, $p15, $this->currPos - $p15);
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p9;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p17
    // free $p15
    $r11 = [$r12,$r13,$r14,$r16];
    seq_3:
    if ($r11!==self::$FAILED) {
      goto choice_3;
    }
    // free $p9
    if ($this->currPos < $this->inputLength) {
      $r11 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) {$this->fail(7);}
    }
    choice_3:
    // r <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p8;
      $r4 = self::$FAILED;
      goto seq_2;
    }
    $r4 = true;
    seq_2:
    if ($r4!==self::$FAILED) {
      $this->savedPos = $p5;
      $r4 = $this->a18($r11);
    }
    // free $p8
    choice_1:
    if ($r4!==self::$FAILED) {
      $r3 = [];
      while ($r4 !== self::$FAILED) {
        $r3[] = $r4;
        // start choice_5
        // start seq_4
        $p8 = $this->currPos;
        $r19 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r19===self::$FAILED) {
          $r4 = self::$FAILED;
          goto seq_4;
        }
        // start choice_6
        $r20 = $this->parseheading($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r20!==self::$FAILED) {
          goto choice_6;
        }
        $r20 = $this->parsehr($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r20!==self::$FAILED) {
          goto choice_6;
        }
        $r20 = $this->parsefull_table_in_link_caption($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        choice_6:
        if ($r20===self::$FAILED) {
          $this->currPos = $p8;
          $r4 = self::$FAILED;
          goto seq_4;
        }
        $r4 = [$r19,$r20];
        seq_4:
        if ($r4!==self::$FAILED) {
          goto choice_5;
        }
        // free $p8
        $r4 = $this->parseurltext($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r4!==self::$FAILED) {
          goto choice_5;
        }
        $p8 = $this->currPos;
        // start seq_5
        $p9 = $this->currPos;
        $p15 = $this->currPos;
        $r21 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r21 === self::$FAILED) {
          $r21 = false;
        } else {
          $r21 = self::$FAILED;
          $this->currPos = $p15;
          $r4 = self::$FAILED;
          goto seq_5;
        }
        // free $p15
        // start choice_7
        $r22 = $this->parseinline_element($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r22!==self::$FAILED) {
          goto choice_7;
        }
        // start seq_6
        $p15 = $this->currPos;
        if (($this->input[$this->currPos] ?? null) === "[") {
          $this->currPos++;
          $r23 = "[";
        } else {
          if (!$silence) {$this->fail(19);}
          $r23 = self::$FAILED;
          $r22 = self::$FAILED;
          goto seq_6;
        }
        $r25 = $this->parsetext_char($silence);
        if ($r25!==self::$FAILED) {
          $r24 = [];
          while ($r25 !== self::$FAILED) {
            $r24[] = $r25;
            $r25 = $this->parsetext_char($silence);
          }
        } else {
          $r24 = self::$FAILED;
        }
        if ($r24===self::$FAILED) {
          $this->currPos = $p15;
          $r22 = self::$FAILED;
          goto seq_6;
        }
        // free $r25
        if (($this->input[$this->currPos] ?? null) === "]") {
          $this->currPos++;
          $r25 = "]";
        } else {
          if (!$silence) {$this->fail(21);}
          $r25 = self::$FAILED;
          $this->currPos = $p15;
          $r22 = self::$FAILED;
          goto seq_6;
        }
        $p17 = $this->currPos;
        $p18 = $this->currPos;
        // start choice_8
        $p27 = $this->currPos;
        if (($this->input[$this->currPos] ?? null) === "]") {
          $this->currPos++;
          $r26 = "]";
        } else {
          $r26 = self::$FAILED;
        }
        if ($r26 === self::$FAILED) {
          $r26 = false;
          goto choice_8;
        } else {
          $r26 = self::$FAILED;
          $this->currPos = $p27;
        }
        // free $p27
        if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
          $r26 = "]]";
          $this->currPos += 2;
        } else {
          $r26 = self::$FAILED;
        }
        choice_8:
        if ($r26!==self::$FAILED) {
          $r26 = false;
          $this->currPos = $p18;
          $r26 = substr($this->input, $p17, $this->currPos - $p17);
        } else {
          $r26 = self::$FAILED;
          $this->currPos = $p15;
          $r22 = self::$FAILED;
          goto seq_6;
        }
        // free $p18
        // free $p17
        $r22 = [$r23,$r24,$r25,$r26];
        seq_6:
        if ($r22!==self::$FAILED) {
          goto choice_7;
        }
        // free $p15
        if ($this->currPos < $this->inputLength) {
          $r22 = self::consumeChar($this->input, $this->currPos);;
        } else {
          $r22 = self::$FAILED;
          if (!$silence) {$this->fail(7);}
        }
        choice_7:
        // r <- $r22
        if ($r22===self::$FAILED) {
          $this->currPos = $p9;
          $r4 = self::$FAILED;
          goto seq_5;
        }
        $r4 = true;
        seq_5:
        if ($r4!==self::$FAILED) {
          $this->savedPos = $p8;
          $r4 = $this->a18($r22);
        }
        // free $p9
        choice_5:
      }
    } else {
      $r3 = self::$FAILED;
    }
    // c <- $r3
    // free $r4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a38($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_flags($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [378, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    $r6 = $this->discardspace_or_newline($silence);
    while ($r6 !== self::$FAILED) {
      $r6 = $this->discardspace_or_newline($silence);
    }
    // free $r6
    $r4 = true;
    // sp1 <- $r4
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    $r6 = $this->parselang_variant_flag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // f <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p5 = $this->currPos;
    $r8 = $this->discardspace_or_newline($silence);
    while ($r8 !== self::$FAILED) {
      $r8 = $this->discardspace_or_newline($silence);
    }
    // free $r8
    $r7 = true;
    // sp2 <- $r7
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    // start seq_2
    $p5 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r9 = ";";
    } else {
      if (!$silence) {$this->fail(32);}
      $r9 = self::$FAILED;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r10 = $this->parselang_variant_flags($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10===self::$FAILED) {
      $r10 = null;
    }
    $r8 = [$r9,$r10];
    seq_2:
    if ($r8===self::$FAILED) {
      $r8 = null;
    }
    // free $p5
    // more <- $r8
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a168($r4, $r6, $r7, $r8);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    $r12 = $this->discardspace_or_newline($silence);
    while ($r12 !== self::$FAILED) {
      $r12 = $this->discardspace_or_newline($silence);
    }
    // free $r12
    $r11 = true;
    // sp <- $r11
    if ($r11!==self::$FAILED) {
      $r11 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r11 = self::$FAILED;
    }
    // free $p5
    $r1 = $r11;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a169($r11);
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_option($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [386, $this->currPos, $boolParams & 0x1bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $p5 = $this->currPos;
    $r6 = $this->discardspace_or_newline($silence);
    while ($r6 !== self::$FAILED) {
      $r6 = $this->discardspace_or_newline($silence);
    }
    // free $r6
    $r4 = true;
    // sp1 <- $r4
    if ($r4!==self::$FAILED) {
      $r4 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r4 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    $r6 = $this->parselang_variant_name($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lang <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p5 = $this->currPos;
    $r8 = $this->discardspace_or_newline($silence);
    while ($r8 !== self::$FAILED) {
      $r8 = $this->discardspace_or_newline($silence);
    }
    // free $r8
    $r7 = true;
    // sp2 <- $r7
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r8 = ":";
    } else {
      if (!$silence) {$this->fail(18);}
      $r8 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p5 = $this->currPos;
    $r10 = $this->discardspace_or_newline($silence);
    while ($r10 !== self::$FAILED) {
      $r10 = $this->discardspace_or_newline($silence);
    }
    // free $r10
    $r9 = true;
    // sp3 <- $r9
    if ($r9!==self::$FAILED) {
      $r9 = substr($this->input, $p5, $this->currPos - $p5);
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p5
    // start choice_2
    $r10 = $this->parselang_variant_nowiki($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      goto choice_2;
    }
    $r10 = $this->parselang_variant_text_no_semi($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_2:
    // lvtext <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a170($r4, $r6, $r7, $r9, $r10);
      goto choice_1;
    }
    // free $p3
    $p3 = $this->currPos;
    // start seq_2
    $p5 = $this->currPos;
    $p12 = $this->currPos;
    $r13 = $this->discardspace_or_newline($silence);
    while ($r13 !== self::$FAILED) {
      $r13 = $this->discardspace_or_newline($silence);
    }
    // free $r13
    $r11 = true;
    // sp1 <- $r11
    if ($r11!==self::$FAILED) {
      $r11 = substr($this->input, $p12, $this->currPos - $p12);
    } else {
      $r11 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p12
    // start choice_3
    $r13 = $this->parselang_variant_nowiki($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r13!==self::$FAILED) {
      goto choice_3;
    }
    $r13 = $this->parselang_variant_text_no_semi_or_arrow($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_3:
    // from <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "=>", $this->currPos, 2, false) === 0) {
      $r14 = "=>";
      $this->currPos += 2;
    } else {
      if (!$silence) {$this->fail(85);}
      $r14 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $p12 = $this->currPos;
    $r16 = $this->discardspace_or_newline($silence);
    while ($r16 !== self::$FAILED) {
      $r16 = $this->discardspace_or_newline($silence);
    }
    // free $r16
    $r15 = true;
    // sp2 <- $r15
    if ($r15!==self::$FAILED) {
      $r15 = substr($this->input, $p12, $this->currPos - $p12);
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p12
    $r16 = $this->parselang_variant_name($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // lang <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $p12 = $this->currPos;
    $r18 = $this->discardspace_or_newline($silence);
    while ($r18 !== self::$FAILED) {
      $r18 = $this->discardspace_or_newline($silence);
    }
    // free $r18
    $r17 = true;
    // sp3 <- $r17
    if ($r17!==self::$FAILED) {
      $r17 = substr($this->input, $p12, $this->currPos - $p12);
    } else {
      $r17 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p12
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r18 = ":";
    } else {
      if (!$silence) {$this->fail(18);}
      $r18 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $p12 = $this->currPos;
    $r20 = $this->discardspace_or_newline($silence);
    while ($r20 !== self::$FAILED) {
      $r20 = $this->discardspace_or_newline($silence);
    }
    // free $r20
    $r19 = true;
    // sp4 <- $r19
    if ($r19!==self::$FAILED) {
      $r19 = substr($this->input, $p12, $this->currPos - $p12);
    } else {
      $r19 = self::$FAILED;
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    // free $p12
    // start choice_4
    $r20 = $this->parselang_variant_nowiki($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r20!==self::$FAILED) {
      goto choice_4;
    }
    $r20 = $this->parselang_variant_text_no_semi($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_4:
    // to <- $r20
    if ($r20===self::$FAILED) {
      $this->currPos = $p5;
      $r1 = self::$FAILED;
      goto seq_2;
    }
    $r1 = true;
    seq_2:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p3;
      $r1 = $this->a171($r11, $r13, $r15, $r16, $r17, $r19, $r20);
    }
    // free $p5
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsetable_heading_tag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [480, $this->currPos, $boolParams & 0x3bfe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parserow_syntax_table_args($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4===self::$FAILED) {
      $r4 = null;
    }
    // arg <- $r4
    $p6 = $this->currPos;
    $r5 = '';
    // tagEndPos <- $r5
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a164($r4);
    } else {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = [];
    $p9 = $this->currPos;
    // start seq_2
    $p10 = $this->currPos;
    $r11 = $this->parsenested_block_in_table($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // d <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p10;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = true;
    seq_2:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a172($r4, $r5, $param_th, $r11);
    }
    // free $p10
    while ($r8 !== self::$FAILED) {
      $r7[] = $r8;
      $p10 = $this->currPos;
      // start seq_3
      $p12 = $this->currPos;
      $r13 = $this->parsenested_block_in_table($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      // d <- $r13
      if ($r13===self::$FAILED) {
        $this->currPos = $p12;
        $r8 = self::$FAILED;
        goto seq_3;
      }
      $r8 = true;
      seq_3:
      if ($r8!==self::$FAILED) {
        $this->savedPos = $p10;
        $r8 = $this->a172($r4, $r5, $param_th, $r13);
      }
      // free $p12
    }
    // c <- $r7
    // free $r8
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a173($r4, $r5, $r7);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsepipe_pipe($silence) {
    $key = implode(':', [562, $this->currPos]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
  
        return $cached['result'];
      }
  
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "||", $this->currPos, 2, false) === 0) {
      $r1 = "||";
      $this->currPos += 2;
      goto choice_1;
    } else {
      if (!$silence) {$this->fail(86);}
      $r1 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}{{!}}", $this->currPos, 10, false) === 0) {
      $r1 = "{{!}}{{!}}";
      $this->currPos += 10;
    } else {
      if (!$silence) {$this->fail(87);}
      $r1 = self::$FAILED;
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
  
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardrow_syntax_table_args($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [485, $this->currPos, $boolParams & 0x3bbe, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsetable_attributes($silence, $boolParams | 0x40, $param_templatedepth, $param_preproc, $param_th);
    // as <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r5 = $this->parseoptional_spaces($silence);
    // s <- $r5
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsepipe($silence);
    // p <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p7 = $this->currPos;
    $r8 = $this->discardpipe(true);
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p7;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p7
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a12($r4, $r5, $r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsefull_table_in_link_caption($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [456, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    // start choice_1
    $p5 = $this->currPos;
    $r4 = $this->discardinline_breaks(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r4 === self::$FAILED) {
      $r4 = false;
      goto choice_1;
    } else {
      $r4 = self::$FAILED;
      $this->currPos = $p5;
    }
    // free $p5
    $p5 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r4 = "{{!}}";
      $this->currPos += 5;
      $r4 = false;
      $this->currPos = $p5;
    } else {
      $r4 = self::$FAILED;
    }
    // free $p5
    choice_1:
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsefull_table_in_link_caption_parameterized($silence, ($boolParams & ~0x200) | 0x10, $param_templatedepth, $param_preproc, $param_th);
    // r <- $r6
    if ($r6===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a174($r6);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_flag($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [380, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    $r3 = $this->input[$this->currPos] ?? '';
    // f <- $r3
    if (preg_match("/^[\\-+A-Z]/", $r3)) {
      $this->currPos++;
    } else {
      $r3 = self::$FAILED;
      if (!$silence) {$this->fail(88);}
    }
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a175($r3);
      goto choice_1;
    }
    $p4 = $this->currPos;
    $r5 = $this->parselang_variant_name($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // v <- $r5
    $r1 = $r5;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p4;
      $r1 = $this->a176($r5);
      goto choice_1;
    }
    $p6 = $this->currPos;
    $p8 = $this->currPos;
    // start seq_1
    $p10 = $this->currPos;
    $p11 = $this->currPos;
    $r12 = $this->discardspace_or_newline(true);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p11;
      $r9 = self::$FAILED;
      goto seq_1;
    }
    // free $p11
    $p11 = $this->currPos;
    $r13 = $this->discardnowiki(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p11;
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_1;
    }
    // free $p11
    if (strcspn($this->input, "{}|;", $this->currPos, 1) !== 0) {
      $r14 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r14 = self::$FAILED;
      if (!$silence) {$this->fail(89);}
      $this->currPos = $p10;
      $r9 = self::$FAILED;
      goto seq_1;
    }
    $r9 = true;
    seq_1:
    if ($r9!==self::$FAILED) {
      $r7 = true;
      while ($r9 !== self::$FAILED) {
        // start seq_2
        $p10 = $this->currPos;
        $p11 = $this->currPos;
        $r15 = $this->discardspace_or_newline(true);
        if ($r15 === self::$FAILED) {
          $r15 = false;
        } else {
          $r15 = self::$FAILED;
          $this->currPos = $p11;
          $r9 = self::$FAILED;
          goto seq_2;
        }
        // free $p11
        $p11 = $this->currPos;
        $r16 = $this->discardnowiki(true, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r16 === self::$FAILED) {
          $r16 = false;
        } else {
          $r16 = self::$FAILED;
          $this->currPos = $p11;
          $this->currPos = $p10;
          $r9 = self::$FAILED;
          goto seq_2;
        }
        // free $p11
        if (strcspn($this->input, "{}|;", $this->currPos, 1) !== 0) {
          $r17 = self::consumeChar($this->input, $this->currPos);
        } else {
          $r17 = self::$FAILED;
          if (!$silence) {$this->fail(89);}
          $this->currPos = $p10;
          $r9 = self::$FAILED;
          goto seq_2;
        }
        $r9 = true;
        seq_2:
        // free $p10
      }
    } else {
      $r7 = self::$FAILED;
    }
    // free $p10
    // b <- $r7
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
    } else {
      $r7 = self::$FAILED;
    }
    // free $r9
    // free $p8
    $r1 = $r7;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p6;
      $r1 = $this->a177($r7);
    }
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_name($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [382, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    // start choice_1
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[a-z]/", $r4)) {
      $this->currPos++;
    } else {
      $r4 = self::$FAILED;
      if (!$silence) {$this->fail(90);}
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->input[$this->currPos] ?? '';
    if (preg_match("/^[\\-a-z]/", $r6)) {
      $this->currPos++;
      $r5 = true;
      while ($r6 !== self::$FAILED) {
        $r6 = $this->input[$this->currPos] ?? '';
        if (preg_match("/^[\\-a-z]/", $r6)) {
          $this->currPos++;
        } else {
          $r6 = self::$FAILED;
          if (!$silence) {$this->fail(91);}
        }
      }
    } else {
      $r6 = self::$FAILED;
      if (!$silence) {$this->fail(91);}
      $r5 = self::$FAILED;
    }
    if ($r5===self::$FAILED) {
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $r6
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $r1 = substr($this->input, $p2, $this->currPos - $p2);
      goto choice_1;
    } else {
      $r1 = self::$FAILED;
    }
    // free $p3
    // free $p2
    $r1 = $this->parsenowiki_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    choice_1:
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_nowiki($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [388, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parsenowiki_text($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // n <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $p6 = $this->currPos;
    $r7 = $this->discardspace_or_newline($silence);
    while ($r7 !== self::$FAILED) {
      $r7 = $this->discardspace_or_newline($silence);
    }
    // free $r7
    $r5 = true;
    // sp <- $r5
    if ($r5!==self::$FAILED) {
      $r5 = substr($this->input, $p6, $this->currPos - $p6);
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    // free $p6
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a178($r4, $r5);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_text_no_semi($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [392, $this->currPos, $boolParams & 0x1b7e, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = $this->parselang_variant_text($silence, $boolParams | 0x80, $param_templatedepth, $param_preproc, $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parselang_variant_text_no_semi_or_arrow($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [394, $this->currPos, $boolParams & 0x1a7e, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $r1 = $this->parselang_variant_text_no_semi($silence, $boolParams | 0x100, $param_templatedepth, $param_preproc, $param_th);
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsefull_table_in_link_caption_parameterized($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [458, $this->currPos, $boolParams & 0x3bff, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p4 = $this->currPos;
    $r5 = $this->parsetable_start_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r5===self::$FAILED) {
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parseoptionalNewlines($silence);
    if ($r6===self::$FAILED) {
      $this->currPos = $p4;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = [];
    // start seq_3
    $p12 = $this->currPos;
    $r13 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r13===self::$FAILED) {
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // start choice_1
    $r14 = $this->parsetable_content_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r14!==self::$FAILED) {
      goto choice_1;
    }
    $r14 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
    choice_1:
    if ($r14===self::$FAILED) {
      $this->currPos = $p12;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r15 = $this->parseoptionalNewlines($silence);
    if ($r15===self::$FAILED) {
      $this->currPos = $p12;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $r11 = [$r13,$r14,$r15];
    seq_3:
    // free $p12
    while ($r11 !== self::$FAILED) {
      $r10[] = $r11;
      // start seq_4
      $p12 = $this->currPos;
      $r16 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r16===self::$FAILED) {
        $r11 = self::$FAILED;
        goto seq_4;
      }
      // start choice_2
      $r17 = $this->parsetable_content_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
      if ($r17!==self::$FAILED) {
        goto choice_2;
      }
      $r17 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
      choice_2:
      if ($r17===self::$FAILED) {
        $this->currPos = $p12;
        $r11 = self::$FAILED;
        goto seq_4;
      }
      $r18 = $this->parseoptionalNewlines($silence);
      if ($r18===self::$FAILED) {
        $this->currPos = $p12;
        $r11 = self::$FAILED;
        goto seq_4;
      }
      $r11 = [$r16,$r17,$r18];
      seq_4:
      // free $p12
    }
    // free $r11
    $r11 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r19 = $this->parsetable_end_tag($silence);
    if ($r19===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = [$r10,$r11,$r19];
    seq_2:
    if ($r8!==self::$FAILED) {
      $r7 = [];
      while ($r8 !== self::$FAILED) {
        $r7[] = $r8;
        // start seq_5
        $p9 = $this->currPos;
        $r20 = [];
        // start seq_6
        $p12 = $this->currPos;
        $r22 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r22===self::$FAILED) {
          $r21 = self::$FAILED;
          goto seq_6;
        }
        // start choice_3
        $r23 = $this->parsetable_content_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r23!==self::$FAILED) {
          goto choice_3;
        }
        $r23 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
        choice_3:
        if ($r23===self::$FAILED) {
          $this->currPos = $p12;
          $r21 = self::$FAILED;
          goto seq_6;
        }
        $r24 = $this->parseoptionalNewlines($silence);
        if ($r24===self::$FAILED) {
          $this->currPos = $p12;
          $r21 = self::$FAILED;
          goto seq_6;
        }
        $r21 = [$r22,$r23,$r24];
        seq_6:
        // free $p12
        while ($r21 !== self::$FAILED) {
          $r20[] = $r21;
          // start seq_7
          $p12 = $this->currPos;
          $r25 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
          if ($r25===self::$FAILED) {
            $r21 = self::$FAILED;
            goto seq_7;
          }
          // start choice_4
          $r26 = $this->parsetable_content_line($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
          if ($r26!==self::$FAILED) {
            goto choice_4;
          }
          $r26 = $this->parsetplarg_or_template($silence, $boolParams, $param_templatedepth, $param_th, $param_preproc);
          choice_4:
          if ($r26===self::$FAILED) {
            $this->currPos = $p12;
            $r21 = self::$FAILED;
            goto seq_7;
          }
          $r27 = $this->parseoptionalNewlines($silence);
          if ($r27===self::$FAILED) {
            $this->currPos = $p12;
            $r21 = self::$FAILED;
            goto seq_7;
          }
          $r21 = [$r25,$r26,$r27];
          seq_7:
          // free $p12
        }
        // free $r21
        $r21 = $this->parsesol($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
        if ($r21===self::$FAILED) {
          $this->currPos = $p9;
          $r8 = self::$FAILED;
          goto seq_5;
        }
        $r28 = $this->parsetable_end_tag($silence);
        if ($r28===self::$FAILED) {
          $this->currPos = $p9;
          $r8 = self::$FAILED;
          goto seq_5;
        }
        $r8 = [$r20,$r21,$r28];
        seq_5:
        // free $p9
      }
    } else {
      $r7 = self::$FAILED;
    }
    // free $p9
    if ($r7===self::$FAILED) {
      $this->currPos = $p4;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    // free $r8
    $r3 = [$r5,$r6,$r7];
    seq_1:
    // tbl <- $r3
    // free $p4
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a179($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function discardnowiki($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [413, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parseextension_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // extToken <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r5 = $this->a180($r4);
    if ($r5) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a181($r4);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsenowiki_text($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [414, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    $r3 = $this->parsenowiki($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // extToken <- $r3
    $r1 = $r3;
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a182($r3);
    }
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }
  private function parsenowiki($silence, $boolParams, $param_templatedepth, &$param_preproc, &$param_th) {
    $key = implode(':', [412, $this->currPos, $boolParams & 0x1bae, $param_templatedepth, $param_preproc, $param_th]);
    $cached = $this->cache[$key] ?? null;
      if ($cached) {
        $this->currPos = $cached['nextPos'];
        if (isset($cached['refs']["preproc"])) $param_preproc = $cached['refs']["preproc"];
        if (isset($cached['refs']["th"])) $param_th = $cached['refs']["th"];
        return $cached['result'];
      }
        $saved_preproc=$param_preproc;
        $saved_th=$param_th;
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $this->parseextension_tag($silence, $boolParams, $param_templatedepth, $param_preproc, $param_th);
    // extToken <- $r4
    if ($r4===self::$FAILED) {
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r5 = $this->a180($r4);
    if ($r5) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p3;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a181($r4);
    }
    // free $p3
    $cached = ['nextPos' => $this->currPos, 'result' => $r1];
      if ($saved_preproc !== $param_preproc) $cached['refs']["preproc"] = $param_preproc;
      if ($saved_th !== $param_th) $cached['refs']["th"] = $param_th;
    $this->cache[$key] = $cached;
    return $r1;
  }

  public function parse($input, $options = []) {
    $this->initInternal($input, $options);
    $startRule = $options['startRule'] ?? '(DEFAULT)';
    $result = null;

    if (!empty($options['stream'])) {
      switch ($startRule) {
        case '(DEFAULT)':
        case "start_async":
          return $this->streamstart_async(false, self::newRef(null));
          break;
        default:
          throw new \WikiPEG\InternalError("Can't stream rule $startRule.");
      }
    } else {
      switch ($startRule) {
        case '(DEFAULT)':
        case "start":
          $result = $this->parsestart(false, self::newRef(null));
          break;
        
        case "table_start_tag":
          $result = $this->parsetable_start_tag(false, 0, 0, self::newRef(null), self::newRef(null));
          break;
        
        case "url":
          $result = $this->parseurl(false, self::newRef(null));
          break;
        
        case "row_syntax_table_args":
          $result = $this->parserow_syntax_table_args(false, 0, 0, self::newRef(null), self::newRef(null));
          break;
        
        case "table_attributes":
          $result = $this->parsetable_attributes(false, 0, 0, self::newRef(null), self::newRef(null));
          break;
        
        case "generic_newline_attributes":
          $result = $this->parsegeneric_newline_attributes(false, 0, 0, self::newRef(null), self::newRef(null));
          break;
        
        case "tplarg_or_template_or_bust":
          $result = $this->parsetplarg_or_template_or_bust(false, self::newRef(null));
          break;
        
        case "extlink":
          $result = $this->parseextlink(false, 0, 0, self::newRef(null), self::newRef(null));
          break;
        default:
          throw new \WikiPEG\InternalError("Can't start parsing from rule $startRule.");
      }
    }

    if ($result !== self::$FAILED && $this->currPos === $this->inputLength) {
      return $result;
    } else {
      if ($result !== self::$FAILED && $this->currPos < $this->inputLength) {
        $this->fail(0);
      }
      throw $this->buildParseException();
    }
  }
}
