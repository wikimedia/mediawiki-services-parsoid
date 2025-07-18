<?php
/*
 * DO NOT EDIT MANUALLY.
 * File generated from Grammar.pegphp with `npm run regen-php-tokenizer`.
 */





declare( strict_types = 1 );
namespace Wikimedia\Parsoid\Wt2Html;

	use Wikimedia\Assert\UnreachableException;
	use Wikimedia\JsonCodec\JsonCodec;
	use Wikimedia\Parsoid\Config\Env;
	use Wikimedia\Parsoid\Config\SiteConfig;
	use Wikimedia\Parsoid\Core\DomSourceRange;
	use Wikimedia\Parsoid\NodeData\DataMw;
	use Wikimedia\Parsoid\NodeData\DataParsoid;
	use Wikimedia\Parsoid\NodeData\TempData;
	use Wikimedia\Parsoid\Tokens\CommentTk;
	use Wikimedia\Parsoid\Tokens\EOFTk;
	use Wikimedia\Parsoid\Tokens\EmptyLineTk;
	use Wikimedia\Parsoid\Tokens\EndTagTk;
	use Wikimedia\Parsoid\Tokens\KV;
	use Wikimedia\Parsoid\Tokens\KVSourceRange;
	use Wikimedia\Parsoid\Tokens\NlTk;
	use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
	use Wikimedia\Parsoid\Tokens\SourceRange;
	use Wikimedia\Parsoid\Tokens\TagTk;
	use Wikimedia\Parsoid\Tokens\Token;
	use Wikimedia\Parsoid\Utils\DOMDataUtils;
	use Wikimedia\Parsoid\Utils\PHPUtils;
	use Wikimedia\Parsoid\Utils\TokenUtils;
	use Wikimedia\Parsoid\Utils\Utils;
	use Wikimedia\Parsoid\Utils\WTUtils;
	use Wikimedia\Parsoid\Wikitext\Consts;



class GrammarCacheEntry {
	public $nextPos;
	public $result;
	public $preproc;
	public $th;


	public function __construct( $nextPos, $result, $preproc, $th ) {
		$this->nextPos = $nextPos;
		$this->result = $result;
		$this->preproc = $preproc;
		$this->th = $th;

	}
}


class Grammar extends \Wikimedia\WikiPEG\PEGParserBase {
	// initializer
	
	private Env $env;
	private SiteConfig $siteConfig;
	private array $pipelineOpts;
	private int $pipelineOffset;
	private array $extTags;
	/** @var int|float */
	private $startTime;
	private string $reUrltextLookahead;
	private string $urltextPlainSegment = '';
	private bool $urltextFoundAutolink = false;
	private bool $annotationsEnabledOnWiki = false;

	protected function initialize() {
		$this->env = $this->options['env'];
		$this->siteConfig = $this->env->getSiteConfig();

		$tokenizer = $this->options['pegTokenizer'];
		$this->pipelineOpts = $tokenizer->getOptions();
		// FIXME: inTemplate option may not always be set in
		// standalone tokenizers user by some pipelines handlers.
		$this->pipelineOffset = $this->options['pipelineOffset'] ?? 0;
		$this->extTags = $this->siteConfig->getExtensionTagNameMap();
		$this->annotationsEnabledOnWiki = count( $this->siteConfig->getAnnotationTags() ) > 0;

		// Non-greedy text_char sequence: stop at ampersand, double-underscore,
		 // magic link prefix or protocol
		$this->reUrltextLookahead = '!(?:' .
			'([^-\'<[{\n\r:;\]}|\!=&]*?)' .
			'(?:__|$|[-\'<[{\n\r:;\]}|\!=&]|(RFC|PMID|ISBN|' .
			'(?i)' . $this->siteConfig->getProtocolsRegex( true ) .
			')))!A';

		// Flag should always be an actual boolean (not falsy or undefined)
		$this->assert( is_bool( $this->options['sol'] ), 'sol should be boolean' );
	}

	private $prevOffset = 0;
	private $headingIndex = 0;
	private $hasSOLTransparentAtStart = false;

	public function resetState() {
		$this->prevOffset = 0;
		$this->headingIndex = 0;
		$this->hasSOLTransparentAtStart = false;
	}

	private function assert( $condition, $text ) {
		if ( !$condition ) {
			throw new \RuntimeException( "Grammar.pegphp assertion failure: $text" );
		}
	}

	private function unreachable() {
		throw new UnreachableException( "Grammar.pegphp: this should be unreachable" );
	}

	// Some shorthands for legibility
	private function startOffset() {
		return $this->savedPos;
	}

	private function endOffset() {
		return $this->currPos;
	}

	private function tsrOffsets( $flag = 'default' ): SourceRange {
		switch ( $flag ) {
			case 'start':
				return new SourceRange( $this->savedPos, $this->savedPos );
			case 'end':
				return new SourceRange( $this->currPos, $this->currPos );
			default:
				return new SourceRange( $this->savedPos, $this->currPos );
		}
	}

	/*
	 * Emit a chunk of tokens to our consumers.  Once this has been done, the
	 * current expression can return an empty list (true).
	 */
	private function emitChunk( $tokens ) {
		// FIXME: We don't expect nulls here, but looks like
		// hack from I1c695ab6cdd3655e98877c175ddbabdee9dc44b7
		// introduces them. Work around it for now!
		if ( !$tokens ) {
			return [];
		}

		// Shift tsr of all tokens by the pipeline offset
		TokenUtils::shiftTokenTSR( $tokens, $this->pipelineOffset );
		$this->env->trace( 'peg', $this->options['pipelineId'] ?? '0', '---->   ', $tokens );

		$i = null;
		$n = count( $tokens );

		// Enforce parsing resource limits
		for ( $i = 0;  $i < $n;  $i++ ) {
			TokenizerUtils::enforceParserResourceLimits( $this->env, $tokens[ $i ] );
		}

		return $tokens;
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

	private function isXMLTag( string $name ): bool {
		$lName = mb_strtolower( $name );
		return isset( Consts::$HTML['HTML5Tags'][$lName] ) ||
			isset( Consts::$HTML['OlderHTMLTags'][$lName] );
	}



	// cache init
	  protected $cache = [];

	// expectations
	protected $expectations = [
		0 => ["type" => "end", "description" => "end of input"],
1 => ["type" => "other", "description" => "start"],
2 => ["type" => "other", "description" => "table_start_tag"],
3 => ["type" => "class", "value" => "[^ \\]\\[\\r\\n\"'<>\\x00-\\x20\\x7f&\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000{]", "description" => "[^ \\]\\[\\r\\n\"'<>\\x00-\\x20\\x7f&\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000{]"],
4 => ["type" => "class", "value" => "['{]", "description" => "['{]"],
5 => ["type" => "literal", "value" => "&", "description" => "\"&\""],
6 => ["type" => "class", "value" => "[ \\t]", "description" => "[ \\t]"],
7 => ["type" => "other", "description" => "table_attributes"],
8 => ["type" => "other", "description" => "generic_newline_attributes"],
9 => ["type" => "any", "description" => "any character"],
10 => ["type" => "other", "description" => "extlink"],
11 => ["type" => "other", "description" => "tlb"],
12 => ["type" => "literal", "value" => "|", "description" => "\"|\""],
13 => ["type" => "literal", "value" => "{{!}}", "description" => "\"{{!}}\""],
14 => ["type" => "literal", "value" => "//", "description" => "\"//\""],
15 => ["type" => "class", "value" => "[A-Za-z]", "description" => "[A-Za-z]"],
16 => ["type" => "class", "value" => "[-A-Za-z0-9+.]", "description" => "[-A-Za-z0-9+.]"],
17 => ["type" => "literal", "value" => ":", "description" => "\":\""],
18 => ["type" => "literal", "value" => "[", "description" => "\"[\""],
19 => ["type" => "class", "value" => "[0-9A-Fa-f:.]", "description" => "[0-9A-Fa-f:.]"],
20 => ["type" => "literal", "value" => "]", "description" => "\"]\""],
21 => ["type" => "literal", "value" => "<!--", "description" => "\"<!--\""],
22 => ["type" => "literal", "value" => "-->", "description" => "\"-->\""],
23 => ["type" => "literal", "value" => "{", "description" => "\"{\""],
24 => ["type" => "class", "value" => "[*#:;]", "description" => "[*#:;]"],
25 => ["type" => "literal", "value" => ";", "description" => "\";\""],
26 => ["type" => "literal", "value" => "{{", "description" => "\"{{\""],
27 => ["type" => "class", "value" => "[#0-9a-zA-Z\u{5e8}\u{5dc}\u{5de}\u{631}\u{644}\u{645}]", "description" => "[#0-9a-zA-Z\u{5e8}\u{5dc}\u{5de}\u{631}\u{644}\u{645}]"],
28 => ["type" => "class", "value" => "[^-'<[{\\n\\r:;\\]}|!=]", "description" => "[^-'<[{\\n\\r:;\\]}|!=]"],
29 => ["type" => "literal", "value" => "[[", "description" => "\"[[\""],
30 => ["type" => "class", "value" => "[ \\t\\n\\r\\x0c]", "description" => "[ \\t\\n\\r\\x0c]"],
31 => ["type" => "literal", "value" => "}}", "description" => "\"}}\""],
32 => ["type" => "literal", "value" => "{{{", "description" => "\"{{{\""],
33 => ["type" => "literal", "value" => "}}}", "description" => "\"}}}\""],
34 => ["type" => "literal", "value" => "__", "description" => "\"__\""],
35 => ["type" => "literal", "value" => "-", "description" => "\"-\""],
36 => ["type" => "literal", "value" => "''", "description" => "\"''\""],
37 => ["type" => "literal", "value" => "'", "description" => "\"'\""],
38 => ["type" => "class", "value" => "[ \\t\\n\\r\\0\\x0b]", "description" => "[ \\t\\n\\r\\0\\x0b]"],
39 => ["type" => "class", "value" => "[^ \\t\\n\\r\\x0c:\\[]", "description" => "[^ \\t\\n\\r\\x0c:\\[]"],
40 => ["type" => "literal", "value" => "=", "description" => "\"=\""],
41 => ["type" => "literal", "value" => "----", "description" => "\"----\""],
42 => ["type" => "literal", "value" => "#parsoid\x00fragment:", "description" => "\"#parsoid\\u0000fragment:\""],
43 => ["type" => "class", "value" => "[0-9]", "description" => "[0-9]"],
44 => ["type" => "literal", "value" => "ISBN", "description" => "\"ISBN\""],
45 => ["type" => "class", "value" => "[xX]", "description" => "[xX]"],
46 => ["type" => "literal", "value" => "]]", "description" => "\"]]\""],
47 => ["type" => "literal", "value" => "/", "description" => "\"/\""],
48 => ["type" => "literal", "value" => ">", "description" => "\">\""],
49 => ["type" => "literal", "value" => "</>", "description" => "\"</>\""],
50 => ["type" => "literal", "value" => "}", "description" => "\"}\""],
51 => ["type" => "literal", "value" => "\x0a", "description" => "\"\\n\""],
52 => ["type" => "literal", "value" => "\x0d\x0a", "description" => "\"\\r\\n\""],
53 => ["type" => "literal", "value" => "RFC", "description" => "\"RFC\""],
54 => ["type" => "literal", "value" => "PMID", "description" => "\"PMID\""],
55 => ["type" => "class", "value" => "[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]", "description" => "[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]"],
56 => ["type" => "literal", "value" => "-{", "description" => "\"-{\""],
57 => ["type" => "literal", "value" => "}-", "description" => "\"}-\""],
58 => ["type" => "class", "value" => "[^<[{\\n\\r\\t|!\\]}{ &\\-]", "description" => "[^<[{\\n\\r\\t|!\\]}{ &\\-]"],
59 => ["type" => "class", "value" => "[!<\\-\\}\\]\\n\\r]", "description" => "[!<\\-\\}\\]\\n\\r]"],
60 => ["type" => "literal", "value" => "<", "description" => "\"<\""],
61 => ["type" => "class", "value" => "[^\\t\\n\\v />\\0]", "description" => "[^\\t\\n\\v />\\0]"],
62 => ["type" => "literal", "value" => "+", "description" => "\"+\""],
63 => ["type" => "literal", "value" => "!", "description" => "\"!\""],
64 => ["type" => "literal", "value" => "=>", "description" => "\"=>\""],
65 => ["type" => "literal", "value" => "!!", "description" => "\"!!\""],
66 => ["type" => "literal", "value" => "||", "description" => "\"||\""],
67 => ["type" => "literal", "value" => "{{!}}{{!}}", "description" => "\"{{!}}{{!}}\""],
68 => ["type" => "class", "value" => "[-+A-Z]", "description" => "[-+A-Z]"],
69 => ["type" => "class", "value" => "[^{}|;]", "description" => "[^{}|;]"],
70 => ["type" => "class", "value" => "[a-z]", "description" => "[a-z]"],
71 => ["type" => "class", "value" => "[-a-zA-Z]", "description" => "[-a-zA-Z]"],
	];

	// actions
	private function a0() {

				$this->startTime = null;
				if ( $this->env->profiling() ) {
					$profile = $this->env->getCurrentProfile();
					$this->startTime = hrtime( true );
				}
				return true;
			
}
private function a1($t) {

				if ( $this->env->profiling() ) {
					$profile = $this->env->getCurrentProfile();
					$profile->bumpTimeUse(
						'PEG', hrtime( true ) - $this->startTime, 'PEG' );
				}
				return true;
			
}
private function a2($t) {
 return $t; 
}
private function a3($t, $n) {

		if ( count( $t ) ) {
			$ret = TokenizerUtils::flattenIfArray( $t );
		} else {
			$ret = [];
		}
		if ( count( $n ) ) {
			PHPUtils::pushArray($ret, $n);
		}
		$ret[] = new EOFTk();
		return $ret;
	
}
private function a4($b, $p) {
 $this->unreachable(); 
}
private function a5($b, $p, $ta) {
 return $this->endOffset(); 
}
private function a6($b, $p, $ta, $tsEndPos, $s2) {

		$coms = TokenizerUtils::popComments( $ta );
		if ( $coms ) {
			$tsEndPos = $coms['commentStartPos'];
		}

		$dp = new DataParsoid;
		$dp->tsr = new SourceRange( $this->startOffset(), $tsEndPos );
		if ( $p !== '|' ) {
			// Variation from default
			$dp->startTagSrc = $b . $p;
		}

		return array_merge(
			[ new TagTk( 'table', $ta, $dp ) ],
			$coms ? $coms['buf'] : [],
			$s2
		);
	
}
private function a7($proto, $addr, $he) {
 return $he; 
}
private function a8($proto, $addr, $r) {
 return $r; 
}
private function a9($proto, $addr, $c) {
 return $c; 
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
private function a15() {
 return $this->endOffset(); 
}
private function a16($p0, $addr, $target) {
 return TokenizerUtils::flattenString( [ $addr, $target ] ); 
}
private function a17($p0, $flat) {

			// Protocol must be valid and there ought to be at least one
			// post-protocol character.  So strip last char off target
			// before testing protocol.
			if ( is_array( $flat ) ) {
				// There are templates present, alas.
				return count( $flat ) > 0;
			}
			return Utils::isProtocolValid( substr( $flat, 0, -1 ), $this->env );
		
}
private function a18($p0, $flat) {
 return $this->endOffset(); 
}
private function a19($p0, $flat, $p1, $sp) {
 return $this->endOffset(); 
}
private function a20($p0, $flat, $p1, $sp, $p2, $content) {
 return $this->endOffset(); 
}
private function a21($p0, $flat, $p1, $sp, $p2, $content, $p3) {

			$tsr1 = new SourceRange( $p0, $p1 );
			$tsr2 = new SourceRange( $p2, $p3 );
			$dp = new DataParsoid;
			$dp->tsr = $this->tsrOffsets();
			$dp->getTemp()->extLinkContentOffsets = $tsr2;
			return [
				new SelfclosingTagTk(
					'extlink',
					[
						new KV( 'href', $flat, $tsr1->expandTsrV() ),
						new KV( 'mw:content', $content ?? '', $tsr2->expandTsrV() ),
						new KV( 'spaces', $sp )
					],
					$dp
				)
			]; 
}
private function a22($r) {
 return $r; 
}
private function a23($b) {

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
		return $this->emitChunk( $tokens );
	
}
private function a24() {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a25($p) {
 return Utils::isProtocolValid( $p, $this->env ); 
}
private function a26($p) {
 return $p; 
}
private function a27($tagType, $h, $extlink, &$preproc, $equal, $table, $templateArg, $tableCellArg, $semicolon, $arrow, $linkdesc, $colon, &$th) {

			return TokenizerUtils::inlineBreaks( $this->input, $this->endOffset(), [
				'tagType' => $tagType,
				'h' => $h,
				'extlink' => $extlink,
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
			], $this->env );
		
}
private function a28($c, $cEnd) {

		$data = WTUtils::encodeComment( $c );
		$dp = new DataParsoid;
		$dp->tsr = $this->tsrOffsets();
		if ( $cEnd !== '-->' ) {
			$dp->unclosedComment = true;
		}
		return [ new CommentTk( $data, $dp ) ];
	
}
private function a29($a) {
 return $a; 
}
private function a30($a, $b) {
 return [ $a, $b ]; 
}
private function a31($cc) {

		// if this is an invalid entity, don't tag it with 'mw:Entity'
		// note that some entities (like &acE;) decode to 2 codepoints!
		if ( mb_strlen( $cc ) > 2 /* decoded entity would be 1-2 codepoints */ ) {
			return $cc;
		}
		$dpStart = new DataParsoid;
		$dpStart->src = $this->text();
		$dpStart->srcContent = $cc;
		$dpStart->tsr = $this->tsrOffsets( 'start' );
		$dpEnd = new DataParsoid;
		$dpEnd->tsr = $this->tsrOffsets( 'end' );
		return [
			// If this changes, the nowiki extension's toDOM will need to follow suit
			new TagTk( 'span', [ new KV( 'typeof', 'mw:Entity' ) ], $dpStart ),
			$cc,
			new EndTagTk( 'span', [], $dpEnd )
		];
	
}
private function a32($namePos0, $name) {
 return $this->endOffset(); 
}
private function a33($namePos0, $name, $namePos1, $v) {
 return $v; 
}
private function a34($namePos0, $name, $namePos1, $vd) {

	// NB: Keep in sync w/ generic_newline_attribute
	$res = null;
	// Encapsulate protected attributes.
	if ( gettype( $name ) === 'string' ) {
		$name = TokenizerUtils::protectAttrs( $name );
	}
	$nameSO = new SourceRange( $namePos0, $namePos1 );
	if ( $vd !== null ) {
		$res = new KV( $name, $vd['value'], $nameSO->join( $vd['srcOffsets'] ) );
		$res->vsrc = $vd['srcOffsets']->substr( $this->input );
	} else {
		$res = new KV( $name, '', $nameSO->expandTsrK() );
	}
	if ( is_array( $name ) ) {
		$res->ksrc = $nameSO->substr( $this->input );
	}
	return $res;

}
private function a35($c) {
 return new KV( $c, '' ); 
}
private function a36($namePos0, $name, $namePos1, $vd) {

	// NB: Keep in sync w/ table_attibute
	$res = null;
	// Encapsulate protected attributes.
	if ( is_string( $name ) ) {
		$name = TokenizerUtils::protectAttrs( $name );
	}
	$nameSO = new SourceRange( $namePos0, $namePos1 );
	if ( $vd !== null ) {
		$res = new KV( $name, $vd['value'], $nameSO->join( $vd['srcOffsets'] ) );
		$res->vsrc = $vd['srcOffsets']->substr( $this->input );
	} else {
		$res = new KV( $name, '', $nameSO->expandTsrK() );
	}
	if ( is_array( $name ) ) {
		$res->ksrc = $nameSO->substr( $this->input );
	}
	return $res;

}
private function a37($s) {
 return $s; 
}
private function a38($c) {

		return TokenizerUtils::flattenStringlist( $c );
	
}
private function a39($lc) {
 return $lc; 
}
private function a40($bullets, $colons, $d) {

		$bulletToks = [];
		// Leave bullets as an array -- list handler expects this
		// TSR: +1 for the leading ";"
		$numBullets = count( $bullets ) + 1;
		$tsr = $this->tsrOffsets( 'start' );
		$tsr->end += $numBullets;
		$li1Bullets = $bullets;
		$li1Bullets[] = ';';
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$bulletToks[] = new TagTk( 'listItem', [ new KV( 'bullets', $li1Bullets, $tsr->expandTsrV() ) ], $dp );
		foreach ( $colons as $colon) {
			if ( $colon[0] ) { // can be null because of "?" in dtdd_colon
				$bulletToks[] = $colon[0];
			}
			$cpos = $colon[1];
			// TSR: -1 for the intermediate ":"
			$li2Bullets = $bullets;
			$li2Bullets[] = ':';
			$tsr2 = new SourceRange( $cpos - 1, $cpos );
			$dp2 = new DataParsoid;
			$dp2->tsr = $tsr2;
			$dp2->stx = 'row';
			$bulletToks[] = new TagTk( 'listItem', [ new KV( 'bullets', $li2Bullets, $tsr2->expandTsrV() ) ], $dp2 );
		}

		if ( $d ) {
			$bulletToks = array_merge( $bulletToks, $d );
		}
		return $bulletToks;
	
}
private function a41($bullets, $sc, $tbl) {

	// Leave bullets as an array -- list handler expects this
	$tsr = $this->tsrOffsets( 'start' );
	$tsr->end += count( $bullets );
	$dp = new DataParsoid;
	$dp->tsr = $tsr;
	$li = new TagTk( 'listItem', [ new KV( 'bullets', $bullets, $tsr->expandTsrV() ) ], $dp );
	return array_merge( [ $li ], $sc, $tbl );

}
private function a42($bullets, $c) {

		// Leave bullets as an array -- list handler expects this
		$tsr = $this->tsrOffsets( 'start' );
		$tsr->end += count( $bullets );
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$li = new TagTk( 'listItem', [ new KV( 'bullets', $bullets, $tsr->expandTsrV() ) ], $dp );
		return array_merge( [ $li ], $c ?: [] );
	
}
private function a43() {
 return $this->endOffset() === $this->inputLength; 
}
private function a44($r, $cil, $bl) {

		$this->hasSOLTransparentAtStart = true;
		return array_merge( [ $r ], $cil, $bl ?: [] );
	
}
private function a45(&$preproc, $t) {

		$preproc = null;
		return $t;
	
}
private function a46($m) {

		return Utils::decodeWtEntities( $m );
	
}
private function a47($first, $rest) {

		array_unshift( $rest, $first );
		return TokenizerUtils::flattenString( $rest );
	
}
private function a48($s, $t, $q) {

		return TokenizerUtils::getAttrVal( $t, $this->startOffset() + strlen( $s ), $this->endOffset() - strlen( $q ) );
	
}
private function a49($s, $t) {

		return TokenizerUtils::getAttrVal( $t, $this->startOffset() + strlen( $s ), $this->endOffset() );
	
}
private function a50($r) {

		return TokenizerUtils::flattenString( $r );
	
}
private function a51() {

			if ( preg_match( $this->reUrltextLookahead, $this->input, $m, 0, $this->currPos ) ) {
				$plain = $m[1];
				$this->urltextPlainSegment = $plain;
				$this->urltextFoundAutolink = ( $m[2] ?? '' ) !== '';
				return (bool)strlen( $plain );
			} else {
				$this->urltextFoundAutolink = false;
				return false;
			}
		
}
private function a52() {

			$this->currPos += strlen( $this->urltextPlainSegment );
			return $this->urltextPlainSegment;
		
}
private function a53() {
 return $this->urltextFoundAutolink; 
}
private function a54($al) {
 return $al; 
}
private function a55($he) {
 return $he; 
}
private function a56($bs) {
 return $bs; 
}
private function a57($c) {
 return $this->endOffset(); 
}
private function a58($c, $cpos) {

	return [ $c, $cpos ];

}
private function a59() {
 return $this->endOffset() === 0 && !$this->pipelineOffset; 
}
private function a60($rw, $sp, $c, $wl) {

		return count( $wl ) === 1 && $wl[0] instanceof Token;
	
}
private function a61($rw, $sp, $c, $wl) {

		$link = $wl[0];
		if ( $sp ) {
			$rw .= $sp;
		}
		if ( $c ) {
			$rw .= $c;
		}
		// Build a redirect token
		$dp = new DataParsoid;
		$dp->src = $rw;
		$dp->tsr = $this->tsrOffsets();
		$dp->linkTk = $link;
		$redirect = new SelfclosingTagTk( 'mw:redirect',
			// Put 'href' into attributes so it gets template-expanded
			[ $link->getAttributeKV( 'href' ) ],
			$dp
		);
		return $redirect;
	
}
private function a62($tl) {
 return $tl; 
}
private function a63($s, $os, $so) {
 return array_merge( $os, $so ); 
}
private function a64($s, $s2, $bl) {

		return array_merge( $s, $s2 ?: [], $bl );
	
}
private function a65() {
 return $this->endOffset() === 0 || strspn($this->input, "\r\n", $this->currPos, 1) > 0; 
}
private function a66($sp, $elc, $st) {

	$this->hasSOLTransparentAtStart = ( count( $st ) > 0 );
	return [ $sp, $elc ?? [], $st ];

}
private function a67($p, $target) {
 return $this->endOffset(); 
}
private function a68($p, $target, $p0, $v) {
 return $this->endOffset(); 
}
private function a69($p, $target, $p0, $v, $p1) {

				// empty argument
				return [ 'tokens' => $v, 'srcOffsets' => new SourceRange( $p0, $p1 ) ];
			
}
private function a70($p, $target, $r) {
 return $r; 
}
private function a71($p, $target, $params) {

		$kvs = [];

		if ( $target === null ) {
			$target = [ 'tokens' => '', 'srcOffsets' => new SourceRange( $p, $p ) ];
		}
		// Insert target as first positional attribute, so that it can be
		// generically expanded. The TemplateHandler then needs to shift it out
		// again.
		$kvs[] = new KV( TokenizerUtils::flattenIfArray( $target['tokens'] ), '', $target['srcOffsets']->expandTsrK() );

		foreach ( $params as $o ) {
			$s = $o['srcOffsets'];
			$kvs[] = new KV( '', TokenizerUtils::flattenIfArray( $o['tokens'] ), $s->expandTsrV() );
		}

		$dp = new DataParsoid;
		$dp->tsr = $this->tsrOffsets();
		$dp->src = $this->text();
		$obj = new SelfclosingTagTk( 'templatearg', $kvs, $dp );
		return $obj;
	
}
private function a72($target) {
 return $this->endOffset(); 
}
private function a73($target, $p0, $v) {
 return $this->endOffset(); 
}
private function a74($target, $p0, $v, $p1) {

				// empty argument
				$tsr0 = new SourceRange( $p0, $p1 );
				return new KV( '', TokenizerUtils::flattenIfArray( $v ), $tsr0->expandTsrV() );
			
}
private function a75($target, $r) {
 return $r; 
}
private function a76($target, $params) {

		// Insert target as first positional attribute, so that it can be
		// generically expanded. The TemplateHandler then needs to shift it out
		// again.
		array_unshift( $params, new KV( TokenizerUtils::flattenIfArray( $target['tokens'] ), '', $target['srcOffsets']->expandTsrK() ) );
		$dp = new DataParsoid;
		$dp->tsr = $this->tsrOffsets();
		$dp->src = $this->text();
		$obj = new SelfclosingTagTk( 'template', $params, $dp );
		return $obj;
	
}
private function a77($x, $ill) {
 return array_merge( [$x], $ill ?: [] ); 
}
private function a78($v) {
 return $v; 
}
private function a79($e) {
 return $e; 
}
private function a80() {
 return Utils::isUniWord(Utils::lastUniChar( $this->input, $this->endOffset() ) ); 
}
private function a81($bs) {

		if ( $this->siteConfig->isBehaviorSwitch( $bs ) ) {
			$dp = new DataParsoid;
			$dp->tsr = $this->tsrOffsets();
			$dp->src = $bs;
			$dp->magicSrc = $bs;
			return [
				new SelfclosingTagTk( 'behavior-switch', [ new KV( 'word', $bs ) ], $dp )
			];
		} else {
			return [ $bs ];
		}
	
}
private function a82($quotes) {

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
		$tsr->start += $plainticks;
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$mwq = new SelfclosingTagTk( 'mw-quote',
			[ new KV( 'value', substr( $quotes, $plainticks ) ) ],
			$dp );
		if ( strlen( $quotes ) > 2 ) {
			$mwq->addAttribute( 'isSpace_1', $tsr->start > 0 && substr( $this->input, $tsr->start - 1, 1 ) === ' ');
			$mwq->addAttribute( 'isSpace_2', $tsr->start > 1 && substr( $this->input, $tsr->start - 2, 1 ) === ' ');
		}
		$result[] = $mwq;
		return $result;
	
}
private function a83($rw) {

			return preg_match( $this->env->getSiteConfig()->getMagicWordMatcher( 'redirect' ), $rw );
		
}
private function a84($t) {

		$tagName = mb_strtolower( $t->getName() );
		switch ( $tagName ) {
			case 'includeonly':
				$typeOf = 'mw:Includes/IncludeOnly';
				break;
			case 'noinclude':
				$typeOf = 'mw:Includes/NoInclude';
				break;
			case 'onlyinclude':
				$typeOf = 'mw:Includes/OnlyInclude';
				break;
			default:
				$this->unreachable();
		}

		$isEnd = ( $t instanceof EndTagTk );
		if ( $isEnd ) {
			$typeOf .= '/End';
		}

		$dp = new DataParsoid;
		$dp->tsr = $t->dataParsoid->tsr;
		$dp->src = $dp->tsr->substr( $this->input );

		$meta = new SelfclosingTagTk(
			'meta', [ new KV( 'typeof', $typeOf ) ], $dp
		);

		$startTagWithContent = false;
		if ( $t instanceof TagTk ) {
			$endTagRE = '~.*?(</' . preg_quote( $tagName, '~' ) . '\s*>)~iusA';
			$startTagWithContent = preg_match(
				$endTagRE, $this->input, $content, 0, $dp->tsr->start
			);
		}

		if ( !empty( $this->pipelineOpts['inTemplate'] ) ) {
			switch ( $tagName ) {
				case 'includeonly':
					// Drop the tag
					return [];
				case 'noinclude':
					if ( $startTagWithContent ) {
						// Skip the content
						$this->currPos = $dp->tsr->start + strlen( $content[0] );
					}
					// Drop it all
					return [];
				case 'onlyinclude':
					if ( $startTagWithContent ) {
						// Parse the content, strip eof, and shift tsr
						$contentSrc = $content[0];
						$endOffset = $dp->tsr->start + strlen( $contentSrc );
						$endTagWidth = strlen( $content[1] );
						$tagOffsets = new DomSourceRange(
							$dp->tsr->start, $endOffset,
							$dp->tsr->length(), $endTagWidth
						);
						$this->currPos = $tagOffsets->innerEnd();
						$justContent = $tagOffsets->stripTags( $contentSrc );
						// FIXME: What about the pipelineOpts of the current pipeline?
						$tokenizer = new PegTokenizer( $this->env );
						$tokenizer->setSourceOffsets( $tagOffsets->innerRange() );
						$contentToks = $tokenizer->tokenizeSync(
							$justContent, [ 'sol' => true ]
						);
						TokenUtils::stripEOFTkFromTokens( $contentToks );
						array_unshift( $contentToks, $t );
						return $contentToks;
					} else {
						return [$t];
					}
			}
		} else {
			$tokens = [ $meta ];
			if ( $tagName === 'includeonly' ) {
				if ( $startTagWithContent ) {
					// Add the content / end tag to the meta for roundtripping
					$dp->tsr->end = $dp->tsr->start + strlen( $content[0] );
					$dp->src = $dp->tsr->substr( $this->input );
					$meta->dataMw = new DataMw( [ 'src' => $dp->src ] );
					$this->currPos = $dp->tsr->end;
					// FIXME: We shouldn't bother with this because SelfclosingTk
					// was never balanced to begin with
					if ( strlen( $content[1] ) ) {
						$eDp = new DataParsoid;
						$eDp->tsr = new SourceRange( $dp->tsr->end, $dp->tsr->end );
						$eDp->src = $eDp->tsr->substr( $this->input );
						$tokens[] = new SelfclosingTagTk( 'meta', [
							new KV( 'typeof', 'mw:Includes/IncludeOnly/End' )
						], $eDp );
					}
				} elseif ( !( $t instanceof EndTagTk ) ) {
					$meta->dataMw = new DataMw( [ 'src' => $dp->src ] );
				} else {
					// Compatibility with the legacy parser which leaves these in
					// as strings, which the sanitizer will do for us
					array_pop( $tokens );
					$tokens[] = $t;
				}
			}
			return $tokens;
		}
	
}
private function a85() {
 return $this->annotationsEnabledOnWiki; /* short-circuit! */ 
}
private function a86($t) {

			$end = ( $t instanceof EndTagTk );
			$attribs = $t->attribs;
			$tagName = mb_strtolower( $t->getName() );
			$tsr = $t->dataParsoid->tsr;

			// We already applied this logic in WTUtils::isAnnotationTag
			// to get here so we can make some assumptions.
			if ( !$this->siteConfig->isAnnotationTag( $tagName ) ) {
				$pipepos = strpos( $tagName, '|' );
				$strBeforePipe = substr( $tagName, 0, $pipepos );
				$newName = substr( $tagName, $pipepos + 1, strlen( $tagName ) - $pipepos - 1 );
				$attribs = [ new KV( "name", $newName ) ];
				$tagName = $strBeforePipe;
			}

			$metaAttrs = [ new KV( 'typeof', 'mw:Annotation/' . $tagName . ( $end ? '/End' : '' ) ) ];
			$datamw = null;
			if ( count( $attribs ) > 0 ) {
				$datamw = new DataMw();
				foreach ( $attribs as $attr ) {
					// If the key or the value is not a string,
					// we replace it by the thing that generated it and
					// consider that wikitext as a raw string instead.
					$k = is_string( $attr->k ) ? $attr->k : $attr->ksrc;
					$v = is_string( $attr->v ) ? $attr->v : $attr->vsrc;
					// Possible follow-up in T295168 for attribute sanitation
					$datamw->setExtAttrib( $k, $v );
				}
			}
			$dp = new DataParsoid();
			$dp->tsr = $tsr;
			$this->env->hasAnnotations = true;

			return new SelfclosingTagTk ( 'meta', $metaAttrs, $dp, $datamw );
		
}
private function a87($tag) {

		// FIXME: Suppress annotation meta tokens from template pipelines
		// since they may not have TSR values and won't get recognized as
		// annotation ranges. Without TSR, they might end up stuck in
		// fosterable positions and cause havoc on edits by breaking selser.
		if ( empty( $this->pipelineOpts['inTemplate'] ) ) {
			return $tag;
		} else {
			return '';
		}
	
}
private function a88($s, $ill) {
 return $ill ?: []; 
}
private function a89($s, $ce) {
 return $ce || strlen( $s ) > 2; 
}
private function a90($s, $ce) {
 return $this->endOffset(); 
}
private function a91($s, $ce, $endTPos, $spc) {

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
				$level = (int)floor( ( strlen( $s ) - 1 ) / 2 );
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
				$lastElem = PHPUtils::lastItem( $c );
				if ( is_string( $lastElem ) ) {
					$c[count( $c ) - 1] .= $extras2;
				} else {
					$c[] = $extras2;
				}
			}

			$tagDP = new DataParsoid;
			$tagDP->tsr = $this->tsrOffsets( 'start' );
			$tagDP->tsr->end += $level;

			// Match the old parser's behavior by
			// (a) making headingIndex part of tokenizer state
			//   (don't reuse pipeline! see $this->resetState above)
			// (b) assigning the index when ==*== is tokenized,
			//   even if we're inside a template argument
			//   or other context which won't end up putting the heading
			//   on the output page.  T213468/T214538

			// Unlike hasSOLTransparentAtStart, trailing whitespace and comments
			// are allowed
			$hasSOLTransparentAtEnd = !preg_match(
				Utils::COMMENT_OR_WS_REGEXP,
				substr( $this->input, $endTPos, $this->endOffset() - $endTPos )
			);

			// If either of these are true, the legacy preprocessor won't tokenize
			// a heading and therefore won't assign them a heading index.  They
			// will however parse as headings in the legacy parser's second pass,
			// once sol transparent tokens have been stripped.
			if ( !$this->hasSOLTransparentAtStart && !$hasSOLTransparentAtEnd ) {
				$this->headingIndex++;
				$tagDP->getTemp()->headingIndex = $this->headingIndex;
			}

			$res = [ new TagTk( 'h' . $level, [], $tagDP ) ];
			PHPUtils::pushArray( $res, $c );
			$endTagDP = new DataParsoid;
			$endTagDP->tsr = new SourceRange( $endTPos - $level, $endTPos );
			$res[] = new EndTagTk( 'h' . $level, [], $endTagDP );
			PHPUtils::pushArray( $res, $spc );
			return $res;
		
}
private function a92($d) {
 return null; 
}
private function a93($d) {
 return true; 
}
private function a94($d, $lineContent) {

		$dataParsoid = new DataParsoid;
		$dataParsoid->tsr = $this->tsrOffsets();
		if ( $lineContent !== null ) {
			$dataParsoid->lineContent = $lineContent;
		}
		if ( strlen( $d ) > 0 ) {
			$dataParsoid->extra_dashes = strlen( $d );
		}
		return [new SelfclosingTagTk( 'hr', [], $dataParsoid )];
	
}
private function a95($sc, $tl) {

		return array_merge($sc, $tl);
	
}
private function a96($s) {

		if ( $s !== '' ) {
			return [ $s ];
		} else {
			return [];
		}
	
}
private function a97() {

		// Use the sol flag only at the start of the input
		return $this->endOffset() === 0 && $this->options['sol'];
	
}
private function a98() {

		return [];
	
}
private function a99($p, $c) {

		$dp = new DataParsoid;
		$dp->tsr = new SourceRange( $p, $this->endOffset() );
		return [ new EmptyLineTk( TokenizerUtils::flattenIfArray( $c ), $dp ) ];
	
}
private function a100($il) {

		// il is guaranteed to be an array -- so, tu.flattenIfArray will
		// always return an array
		$r = TokenizerUtils::flattenIfArray( $il );
		if ( count( $r ) === 1 && is_string( $r[0] ) ) {
			$r = $r[0];
		}
		return [ 'tokens' => $r, 'srcOffsets' => $this->tsrOffsets() ];
	
}
private function a101($tpt) {

		return [ 'tokens' => $tpt, 'srcOffsets' => $this->tsrOffsets() ];
	
}
private function a102($name) {
 return $this->endOffset(); 
}
private function a103($name, $kEndPos) {
 return $this->endOffset(); 
}
private function a104($name, $kEndPos, $vStartPos, $optSp, $tpv) {

			return [
				'kEndPos' => $kEndPos,
				'vStartPos' => $vStartPos,
				'value' => ( $tpv === null ) ? '' :
					TokenizerUtils::flattenString( [ $optSp, $tpv['tokens'] ] ),
			];
		
}
private function a105($name, $val) {

		if ( $val !== null ) {
			$so = new KVSourceRange(
				$this->startOffset(), $val['kEndPos'],
				$val['vStartPos'], $this->endOffset()
			);
			return new KV(
				$name,
				TokenizerUtils::flattenIfArray( $val['value'] ),
				$so
			);
		} else {
			$so = new SourceRange( $this->startOffset(), $this->endOffset() );
			return new KV(
				'',
				TokenizerUtils::flattenIfArray( $name ),
				$so->expandTsrV()
			);
		}
	
}
private function a106() {

		$so = new SourceRange( $this->startOffset(), $this->endOffset() );
		return new KV( '', '', $so->expandTsrV() );
	
}
private function a107($extToken) {
 return $extToken->getName() === 'extension'; 
}
private function a108($extToken) {
 return $extToken; 
}
private function a109($proto, $addr, $rhe) {
 return $rhe === '<' || $rhe === '>' || $rhe === "\u{A0}"; 
}
private function a110($proto, $addr, $path) {

			// as in Parser.php::makeFreeExternalLink, we're going to
			// yank trailing punctuation out of this match.
			$url = TokenizerUtils::flattenStringlist( array_merge( [ $proto, $addr ], $path ) );
			// only need to look at last element; HTML entities are strip-proof.
			$last = PHPUtils::lastItem( $url );
			$trim = 0;
			if ( is_string( $last ) ) {
				$strip = TokenizerUtils::getAutoUrlTerminatingChars( in_array( '(', $path, true ) );
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
private function a111($r) {
 return $r !== null; 
}
private function a112($r) {

		$tsr = $this->tsrOffsets();
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$res = [ new SelfclosingTagTk( 'urllink', [ new KV( 'href', $r, $tsr->expandTsrV() ) ], $dp ) ];
		return $res;
	
}
private function a113($ref, $sp, $identifier) {

		$base_urls = [
			'RFC' => 'https://datatracker.ietf.org/doc/html/rfc%s',
			'PMID' => '//www.ncbi.nlm.nih.gov/pubmed/%s?dopt=Abstract'
		];
		$tsr = $this->tsrOffsets();
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$dp->stx = 'magiclink';
		$this->env->getDataAccess()->addTrackingCategory(
			$this->env->getPageConfig(),
			$this->env->getMetadata(),
			'magiclink-tracking-' . strtolower($ref)
		);
		return [
			new SelfclosingTagTk( 'extlink', [
					new KV( 'href', sprintf( $base_urls[$ref], $identifier ) ),
					new KV( 'mw:content', TokenizerUtils::flattenString( [ $ref, $sp, $identifier ] ), $tsr->expandTsrV() ),
					new KV( 'typeof', 'mw:ExtLink/' . $ref )
				],
				$dp
			)
		];
	
}
private function a114() {
 return $this->siteConfig->magicLinkEnabled("ISBN"); 
}
private function a115($sp, $isbn) {

			// Convert isbn token-and-entity array to stripped string.
			$stripped = '';
			foreach ( TokenizerUtils::flattenStringlist( $isbn ) as $part ) {
				if ( is_string( $part ) ) {
					$stripped .= $part;
				}
			}
			return strtoupper( preg_replace( '/[^\dX]/i', '', $stripped ) );
		
}
private function a116($sp, $isbn, $isbncode) {

		// ISBNs can only be 10 or 13 digits long (with a specific format)
		return strlen( $isbncode ) === 10
			|| ( strlen( $isbncode ) === 13 && preg_match( '/^97[89]/', $isbncode ) );
	
}
private function a117($sp, $isbn, $isbncode) {

		$tsr = $this->tsrOffsets();
		$dp = new DataParsoid;
		$dp->stx = 'magiclink';
		$dp->tsr = $tsr;
		$this->env->getDataAccess()->addTrackingCategory(
			$this->env->getPageConfig(),
			$this->env->getMetadata(),
			'magiclink-tracking-isbn'
		);
		return [
			new SelfclosingTagTk( 'extlink', [
					new KV( 'href', 'Special:BookSources/' . $isbncode ),
					new KV( 'mw:content', TokenizerUtils::flattenString( [ 'ISBN', $sp, $isbn ] ), $tsr->expandTsrV() ),
					new KV( 'typeof', 'mw:WikiLink/ISBN' )
				],
				$dp
			)
		];
	
}
private function a118($t) {

		$tagName = mb_strtolower( $t->getName() );
		$dp = $t->dataParsoid;
		$endTagRE = '~.*?(</' . preg_quote( $tagName, '~' ) . '\s*>)~iusA';

		switch ( get_class( $t ) ) {
			case EndTagTk::class:
				// Similar to TagTk, we rely on the sanitizer to convert to text
				// where necessary and emit tokens to ease the wikitext escaping
				// code.  However, extension tags that shadow html tags will see
				// their unmatched end tags dropped while tree building, since
				// the sanitizer will let them through.
				return $t; // not text()

			case SelfclosingTagTk::class:
				$dp->src = $dp->tsr->substr( $this->input );
				$dp->extTagOffsets = new DomSourceRange(
					$dp->tsr->start, $dp->tsr->end,
					$dp->tsr->length(), 0
				);
				break;

			case TagTk::class:
				$tagContentFound = preg_match( $endTagRE, $this->input, $tagContent, 0, $dp->tsr->start );
				if ( !$tagContentFound ) {
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

				$extSrc = $tagContent[0];
				$extEndOffset = $dp->tsr->start + strlen( $extSrc );
				$extEndTagWidth = strlen( $tagContent[1] );

				if ( !empty( $this->pipelineOpts['inTemplate'] ) ) {
					// Support nesting in extensions tags while tokenizing in templates
					// to support the #tag parser function.
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
					$startTagRE = '~<' . preg_quote( $tagName, '~' ) . '(?:[^/>]|/(?!>))*>~i';
					$s = substr( $extSrc, $dp->tsr->end - $dp->tsr->start );
					$openTags = 0;
					while ( true ) {
						if ( preg_match_all( $startTagRE, $s, $matches ) ) {
							$openTags += count( $matches[0] );
						}
						if ( !$openTags ) {
							break;
						}
						if ( !preg_match( $endTagRE, $this->input, $tagContent, 0, $extEndOffset ) ) {
							break;
						}
						$openTags -= 1;
						$s = $tagContent[0];
						$extEndOffset += strlen( $s );
						$extEndTagWidth = strlen( $tagContent[1] );
						$extSrc .= $s;
					}
				}

				// Extension content source
				$dp->src = $extSrc;
				$dp->extTagOffsets = new DomSourceRange(
					$dp->tsr->start, $extEndOffset,
					$dp->tsr->length(), $extEndTagWidth
				);

				$this->currPos = $dp->extTagOffsets->end;

				// update tsr->end to span the start and end tags.
				$dp->tsr->end = $this->endOffset(); // was just modified above
				break;

			default:
				$this->unreachable();
		}

		return new SelfclosingTagTk( 'extension', [
			new KV( 'typeof', 'mw:Extension' ),
			new KV( 'name', $tagName ),
			new KV( 'source', $dp->src ),
			new KV( 'options', $t->attribs )
		], $dp );
	
}
private function a119($spos, $target) {
 return $this->endOffset(); 
}
private function a120($spos, $target, $tpos, $l) {
 return [$l,null]; 
}
private function a121($spos, $target, $tpos, $l) {
 return [null,$l]; 
}
private function a122($spos, $target, $tpos, $lcs) {

		[$lcs, $not_wikilink] = $lcs;
		$pipeTrick = $lcs && count( $lcs ) === 1 && count( $lcs[0][1]->v ) === 0;
		if ( $target === null || $pipeTrick || $not_wikilink) {
			$textTokens = [];
			$textTokens[] = '[[';
			if ( $target ) {
				$textTokens[] = $target;
			}
			foreach ( $lcs ?? [] as $a ) {
				// $a[0] is a pipe
				// FIXME: Account for variation, emit a template tag
				$textTokens[] = '|';
				// $a[1] is a mw:maybeContent attribute
				if ( count( $a[1]->v ) > 0 ) {
					$textTokens[] = $a[1]->v;
				}
			}
			if ( $not_wikilink ) {
			   $textTokens[] = $not_wikilink;
			}
			$textTokens[] = ']]';
			return $textTokens;
		}
		$tsr = new SourceRange( $spos, $tpos );
		$hrefKV = new KV(
			'href', $target, $tsr->expandTsrV(), null,
			$tsr->substr( $this->input )
		);
		$obj = new SelfclosingTagTk( 'wikilink' );
		$attribs = array_map( static fn ( $lc ) => $lc[1], $lcs );
		$obj->attribs = array_merge( [$hrefKV], $attribs );
		$dp = new DataParsoid;
		$dp->tsr = $this->tsrOffsets();
		$dp->src = $this->text();
		// Capture a variation in the separator between target
		// and contents.  Note that target might have other templates
		// that emit pipes, so this might not actually be the first
		// separator, but the WikiLinkHandler doesn't support that
		// yet, see onWikiLink.
		if ( $lcs && $lcs[0][0] !== '|' ) {
			$dp->firstPipeSrc = $lcs[0][0];
		}
		$obj->dataParsoid = $dp;
		return [ $obj ];
	
}
private function a123(&$preproc) {
 $preproc = null; return true; 
}
private function a124(&$preproc, $a) {

		return $a;
	
}
private function a125($start) {

		list(,$name) = $start;
		return WTUtils::isIncludeTag( mb_strtolower( $name ) );
	
}
private function a126($tagType, $start) {

		// Only enforce ascii alpha first char for non-extension tags.
		// See tag_name above for the details.
		list(,$name) = $start;
		return $tagType !== 'html' ||
			( preg_match( '/^[A-Za-z]/', $name ) && $this->isXMLTag( $name ) );
	
}
private function a127($tagType, $start, $attribs, $selfclose) {

		list($end, $name) = $start;
		$lcName = mb_strtolower( $name );

		// Extension tags don't necessarily have the same semantics as html tags,
		// so don't treat them as void elements.
		$isVoidElt = Utils::isVoidElement( $lcName ) && $tagType === 'html';

		// Support </br>
		if ( $lcName === 'br' && $end ) {
			$end = null;
		}

		$tsr = $this->tsrOffsets();
		$res = TokenizerUtils::buildXMLTag(
			$name, $lcName, $attribs, $end, !!$selfclose || $isVoidElt, $tsr
		);

		// change up data-attribs in one scenario
		// void-elts that aren't self-closed ==> useful for accurate RT-ing
		if ( !$selfclose && $isVoidElt ) {
			unset( $res->dataParsoid->selfClose );
			$res->dataParsoid->noClose = true;
		}

		return $res;
	
}
private function a128($tagType) {

		return $tagType !== 'anno';
	
}
private function a129($tagType) {
 return $this->env->hasAnnotations && $this->siteConfig->isAnnotationTag( 'tvar' ); 
}
private function a130($tagType) {

		$metaAttrs = [ new KV( 'typeof', 'mw:Annotation/tvar/End' ) ];
		$dp = new DataParsoid();
		$dp->tsr = $this->tsrOffsets();
		return new SelfclosingTagTk ( 'meta', $metaAttrs, $dp );
	
}
private function a131($tagType, $start) {

		list(,$name) = $start;
		return WTUtils::isAnnotationTag( $this->env, $name );
	
}
private function a132($p, $b) {

		$dp = new DataParsoid;
		$dp->tsr = new SourceRange( $this->startOffset(), $this->endOffset() );
		$tblEnd = new EndTagTk( 'table', [], $dp );
		if ( $p !== '|' ) {
			// p+"<brace-char>" is triggering some bug in pegJS
			// I cannot even use that expression in the comment!
			$tblEnd->dataParsoid->endTagSrc = $p . $b;
		}
		return [ $tblEnd ];
	
}
private function a133($i) {
 return $i; 
}
private function a134($il) {

		// il is guaranteed to be an array -- so, tu.flattenIfArray will
		// always return an array
		$r = TokenizerUtils::flattenIfArray( $il );
		if ( count( $r ) === 1 && is_string( $r[0] ) ) {
			$r = $r[0];
		}
		return $r;
	
}
private function a135() {
 return ''; 
}
private function a136($tagType) {

		return ( $tagType === 'html' || $tagType === '' );
	
}
private function a137() {
 return $this->siteConfig->magicLinkEnabled("RFC"); 
}
private function a138() {

	return 'RFC';

}
private function a139() {
 return $this->siteConfig->magicLinkEnabled("PMID"); 
}
private function a140() {

	return 'PMID';

}
private function a141($he) {
 return is_array( $he ) && $he[ 1 ] === "\u{A0}"; 
}
private function a142($start) {

		list(,$name) = $start;
		return isset( $this->extTags[mb_strtolower( $name )] ) &&
			// NOTE: This check is redundant with the precedence of the current
			// rules ( annotation_tag / *_extension_tag ) but kept as a precaution
			// since annotation tags are in extTags and we want them handled
			// elsewhere.
			!WTUtils::isAnnotationTag( $this->env, $name );
	
}
private function a143() {
 return $this->startOffset(); 
}
private function a144($lv0) {
 return $this->env->langConverterEnabled(); 
}
private function a145($lv0, $ff) {

			// if flags contains 'R', then don't treat ; or : specially inside.
			if ( isset( $ff['flags'] ) ) {
				$ff['raw'] = isset( $ff['flags']['R'] ) || isset( $ff['flags']['N'] );
			} elseif ( isset( $ff['variants'] ) ) {
				$ff['raw'] = true;
			}
			return $ff;
		
}
private function a146($lv0) {
 return !$this->env->langConverterEnabled(); 
}
private function a147($lv0) {

			// if language converter not enabled, don't try to parse inside.
			return [ 'raw' => true ];
		
}
private function a148($lv0, $f) {
 return $f['raw']; 
}
private function a149($lv0, $f, $lv) {
 return [ [ 'text' => $lv ] ]; 
}
private function a150($lv0, $f) {
 return !$f['raw']; 
}
private function a151($lv0, $f, $lv) {
 return $lv; 
}
private function a152($lv0, $f, $ts) {
 return $this->endOffset(); 
}
private function a153($lv0, $f, $ts, $lv1) {

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
				$attribs[] = new KV( $name, $t[$fld]['tokens'], $t[$fld]['srcOffsets']->expandTsrV() );
				$t[$fld] = $name;
			}
		}
		unset( $t );

		$flags = isset( $f['flags'] ) ? array_keys( $f['flags'] ) : [];
		sort( $flags );
		$variants = isset( $f['variants'] ) ? array_keys( $f['variants'] ) : [];
		sort( $variants );

		$dp = new DataParsoid;
		$dp->tsr = new SourceRange( $lv0, $lv1 );
		$dp->src = $lvsrc;
		$dp->flags = $flags;
		$dp->variants = $variants;
		$dp->original = $f['original'];
		$dp->flagSp = $f['sp'];
		$dp->texts = $ts;

		return [
			new SelfclosingTagTk(
				'language-variant',
				$attribs,
				$dp
			)
		];
	
}
private function a154($r, &$preproc) {

		$preproc = null;
		return $r;
	
}
private function a155($t, $wr) {
 return $wr; 
}
private function a156($p) {
 return $this->endOffset(); 
}
private function a157($p, $startPos, $lt) {

			$tsr = new SourceRange( $startPos, $this->endOffset() );
			$maybeContent = new KV( 'mw:maybeContent', $lt ?? [], $tsr->expandTsrV() );
			$maybeContent->vsrc = substr( $this->input, $startPos, $this->endOffset() - $startPos );
			return [$p, $maybeContent];
		
}
private function a158($end, $name) {
 return [ $end, $name ]; 
}
private function a159($p, $dashes) {
 $this->unreachable(); 
}
private function a160($p, $dashes, $a) {
 return $this->endOffset(); 
}
private function a161($p, $dashes, $a, $tagEndPos, $s2) {

		$coms = TokenizerUtils::popComments( $a );
		if ( $coms ) {
			$tagEndPos = $coms['commentStartPos'];
		}

		$da = new DataParsoid;
		$da->tsr = new SourceRange( $this->startOffset(), $tagEndPos );
		$da->startTagSrc = $p . $dashes;

		// We rely on our tree builder to close the row as needed. This is
		// needed to support building tables from fragment templates with
		// individual cells or rows.
		$trToken = new TagTk( 'tr', $a, $da );

		return array_merge( [ $trToken ], $coms ? $coms['buf'] : [], $s2 );
	
}
private function a162($p, $td, $tds) {

		// Avoid modifying a cached result
		$td[0] = clone $td[0];
		$da = $td[0]->dataParsoid = clone $td[0]->dataParsoid;
		$da->tsr = clone $da->tsr;
		$da->tsr->start -= strlen( $p ); // include "|"
		if ( $p !== '|' ) {
			// Variation from default
			$da->startTagSrc = $p;
		}
		return array_merge( $td, $tds );
	
}
private function a163($p, $args) {
 return $this->endOffset(); 
}
private function a164($p, $args, $tagEndPos, $c) {

		$tsr = new SourceRange( $this->startOffset(), $tagEndPos );
		return TokenizerUtils::buildTableTokens(
			$this->input, 'caption', '|+', $args, $tsr, $this->endOffset(), $c, true
		);
	
}
private function a165($ff) {
 return $ff; 
}
private function a166($f) {

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
private function a167($tokens) {

		return [
			'tokens' => TokenizerUtils::flattenStringlist( $tokens ),
			'srcOffsets' => $this->tsrOffsets(),
		];
	
}
private function a168($o, $oo) {
 return $oo; 
}
private function a169($o, $rest, $tr) {

		array_unshift( $rest, $o );
		// if the last bogus option is just spaces, keep them; otherwise
		// drop all this bogus stuff on the ground
		if ( count($tr) > 0 ) {
			$last = $tr[count($tr)-1];
			if (preg_match('/^\s*$/Du', $last[1])) {
				$rest[] = [ 'semi' => true, 'sp' => $last[1] ];
			}
		}
		return $rest;
	
}
private function a170($lvtext) {
 return [ [ 'text' => $lvtext ] ]; 
}
private function a171($thTag, $thTags) {

		// Avoid modifying a cached result
		$thTag[0] = clone $thTag[0];
		$da = $thTag[0]->dataParsoid = clone $thTag[0]->dataParsoid;
		$da->tsr = clone $da->tsr;
		$da->tsr->start--; // include "!"
		array_unshift( $thTags, $thTag );
		return $thTags;
	
}
private function a172($arg) {
 return $this->endOffset(); 
}
private function a173($arg, $tagEndPos, $td) {

		$tagStart = $this->startOffset();
		$tsr = new SourceRange( $tagStart, $tagEndPos );
		return TokenizerUtils::buildTableTokens(
			$this->input, 'td', '|', $arg, $tsr, $this->endOffset(), $td
		);
	
}
private function a174($pp, $tdt) {

			// Avoid modifying cached dataParsoid object
			$tdt[0] = clone $tdt[0];
			$da = $tdt[0]->dataParsoid = clone $tdt[0]->dataParsoid;
			$da->tsr = clone $da->tsr;
			$da->stx = 'row';
			$da->setTempFlag( TempData::NON_MERGEABLE_TABLE_CELL );
			$da->tsr->start -= strlen( $pp ); // include "||"
			if ( $pp !== '||' || ( isset( $da->startTagSrc ) && $da->startTagSrc !== $pp ) ) {
				// Variation from default
				$da->startTagSrc = $pp . ( isset( $da->startTagSrc ) ? substr( $da->startTagSrc, 1 ) : '' );
			}
			return $tdt;
		
}
private function a175($b) {

		return $b;
	
}
private function a176($sp1, $f, $sp2, $more) {

		$r = ( $more && $more[1] ) ? $more[1] : [ 'sp' => [], 'flags' => [] ];
		// Note that sp and flags are in reverse order, since we're using
		// right recursion and want to push instead of unshift.
		$r['sp'][] = $sp2;
		$r['sp'][] = $sp1;
		$r['flags'][] = $f;
		return $r;
	
}
private function a177($sp) {

		return [ 'sp' => [ $sp ], 'flags' => [] ];
	
}
private function a178($sp1, $lang, $sp2, $sp3, $lvtext) {

		return [
			'twoway' => true,
			'lang' => $lang,
			'text' => $lvtext,
			'sp' => [ $sp1, $sp2, $sp3 ]
		];
	
}
private function a179($sp1, $from, $sp2, $lang, $sp3, $sp4, $to) {

		return [
			'oneway' => true,
			'from' => $from,
			'lang' => $lang,
			'to' => $to,
			'sp' => [ $sp1, $sp2, $sp3, $sp4 ]
		];
	
}
private function a180($arg, $tagEndPos, &$th, $d) {

			// Ignore newlines found in transclusions!
			// This is not perfect (since {{..}} may not always tokenize to transclusions).
			if ( $th !== false && strpos( preg_replace( "/{{[\s\S]+?}}/", "", $this->text() ), "\n" ) !== false ) {
				// There's been a newline. Remove the break and continue
				// tokenizing nested_block_in_tables.
				$th = false;
			}
			return $d;
		
}
private function a181($arg, $tagEndPos, $c) {

		$tagStart = $this->startOffset();
		$tsr = new SourceRange( $tagStart, $tagEndPos );
		return TokenizerUtils::buildTableTokens(
			$this->input, 'th', '!', $arg, $tsr, $this->endOffset(), $c
		);
	
}
private function a182($pp, $tht) {

			// Avoid modifying cached dataParsoid object
			$tht[0] = clone $tht[0];
			$da = $tht[0]->dataParsoid = clone $tht[0]->dataParsoid;
			$da->tsr = clone $da->tsr;
			$da->stx = 'row';
			$da->setTempFlag( TempData::NON_MERGEABLE_TABLE_CELL );
			$da->tsr->start -= strlen( $pp ); // include "!!" or "||"
			if ( $pp !== '!!' || ( isset( $da->startTagSrc ) && $da->startTagSrc !== $pp ) ) {
				// Variation from default
				$da->startTagSrc = $pp . ( isset( $da->startTagSrc ) ? substr( $da->startTagSrc, 1 ) : '' );
			}
			return $tht;
		
}
private function a183($f) {
 return [ 'flag' => $f ]; 
}
private function a184($v) {
 return [ 'variant' => $v ]; 
}
private function a185($b) {
 return [ 'bogus' => $b ]; /* bad flag */
}
private function a186($n, $sp) {

		$tsr = $this->tsrOffsets();
		$tsr->end -= strlen( $sp );
		return [
			'tokens' => [ $n ],
			'srcOffsets' => $tsr,
		];
	
}
private function a187($r) {

		return $r;
	
}
private function a188($ext) {
 return $ext; 
}
private function a189($extToken) {

		$txt = Utils::extractExtBody( $extToken );
		return Utils::decodeWtEntities( $txt );
	
}
private function a190($start) {

		list(,$name) = $start;
		return ( mb_strtolower( $name ) === 'nowiki' );
	
}

	// generated
	private function streamstart_async($silence, &$param_th, &$param_preproc) {
  for (;;) {
    $p2 = $this->currPos;
    // start seq_1
    $p3 = $this->currPos;
    $r4 = $param_th;
    $r5 = $param_preproc;
    $this->savedPos = $this->currPos;
    $r6 = $this->a0();
    if ($r6) {
      $r6 = false;
    } else {
      $r6 = self::$FAILED;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsetlb($silence, $param_th, $param_preproc);
    // t <- $r7
    if ($r7===self::$FAILED) {
      $this->currPos = $p3;
      $param_th = $r4;
      $param_preproc = $r5;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r8 = $this->a1($r7);
    if ($r8) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p3;
      $param_th = $r4;
      $param_preproc = $r5;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $r1 = true;
    seq_1:
    if ($r1!==self::$FAILED) {
      $this->savedPos = $p2;
      $r1 = $this->a2($r7);
      yield $r1;
    } else {
      if ($this->currPos < $this->inputLength) {
        if (!$silence) { $this->fail(0); }
        throw $this->buildParseException();
      }
      break;
    }
    // free $r6,$r8
    // free $p3,$r4,$r5
    // free $p2
  }
}
private function parsestart($silence, &$param_th, &$param_preproc) {
  $key = json_encode([294, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start seq_1
  $r5 = [];
  for (;;) {
    $r6 = $this->parsetlb(true, $param_th, $param_preproc);
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // t <- $r5
  // free $r6
  $r6 = [];
  for (;;) {
    $r7 = $this->parsenewlineToken(true);
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // n <- $r6
  // free $r7
  $r4 = true;
  seq_1:
  $this->savedPos = $p1;
  $r4 = $this->a3($r5, $r6);
  // free $p1,$r2,$r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_start_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([498, $boolParams & 0x1fef, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  // b <- $r5
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r5 = "{";
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsepipe(true);
  // p <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $r7 = $this->parsetable_attributes(true, $boolParams & ~0x10, $param_tagType, $param_preproc, $param_th);
  if ($r7!==self::$FAILED) {
    goto choice_1;
  }
  $this->savedPos = $this->currPos;
  $r7 = $this->a4($r5, $r6);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
  }
  choice_1:
  // ta <- $r7
  $p9 = $this->currPos;
  $r8 = true;
  // tsEndPos <- $r8
  $this->savedPos = $p9;
  $r8 = $this->a5($r5, $r6, $r7);
  // free $p9
  $r10 = strspn($this->input, " \x09", $this->currPos);
  // s2 <- $r10
  $this->currPos += $r10;
  $r10 = substr($this->input, $this->currPos - $r10, $r10);
  $r10 = mb_str_split($r10, 1, "utf-8");
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a6($r5, $r6, $r7, $r8, $r10);
  } else {
    if (!$silence) { $this->fail(2); }
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseurl($silence, &$param_preproc, &$param_th) {
  $key = json_encode([354, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parseurl_protocol($silence);
  // proto <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $r6 = $this->parseipv6urladdr($silence);
  if ($r6!==self::$FAILED) {
    goto choice_1;
  }
  $r6 = '';
  choice_1:
  // addr <- $r6
  $r7 = [];
  for (;;) {
    $p9 = $this->currPos;
    // start seq_2
    $p10 = $this->currPos;
    $r11 = $param_preproc;
    $r12 = $param_th;
    $r13 = $this->discardinline_breaks(0x0, "", $param_preproc, $param_th);
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    // start choice_2
    if (preg_match("/[^ \\]\\[\\x0d\\x0a\"'<>\\x00- \\x7f&\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}{]/Au", $this->input, $r14, 0, $this->currPos)) {
      $r14 = $r14[0];
      $this->currPos += strlen($r14);
      goto choice_2;
    } else {
      $r14 = self::$FAILED;
      if (!$silence) { $this->fail(3); }
    }
    $r14 = $this->parsecomment($silence);
    if ($r14!==self::$FAILED) {
      goto choice_2;
    }
    $r14 = $this->parsetplarg_or_template($silence, 0x0, "", $param_th, $param_preproc);
    if ($r14!==self::$FAILED) {
      goto choice_2;
    }
    $r14 = $this->input[$this->currPos] ?? '';
    if ($r14 === "'" || $r14 === "{") {
      $this->currPos++;
      goto choice_2;
    } else {
      $r14 = self::$FAILED;
      if (!$silence) { $this->fail(4); }
    }
    $p15 = $this->currPos;
    // start seq_3
    $p16 = $this->currPos;
    $r17 = $param_preproc;
    $r18 = $param_th;
    // start seq_4
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r20 = true;
    } else {
      $r20 = self::$FAILED;
      $r19 = self::$FAILED;
      goto seq_4;
    }
    // start choice_3
    // start seq_5
    $p22 = $this->currPos;
    $r23 = $param_preproc;
    $r24 = $param_th;
    $r25 = $this->input[$this->currPos] ?? '';
    if ($r25 === "l" || $r25 === "L") {
      $this->currPos++;
    } else {
      $r25 = self::$FAILED;
      $r21 = self::$FAILED;
      goto seq_5;
    }
    $r26 = $this->input[$this->currPos] ?? '';
    if ($r26 === "t" || $r26 === "T") {
      $this->currPos++;
    } else {
      $r26 = self::$FAILED;
      $this->currPos = $p22;
      $param_preproc = $r23;
      $param_th = $r24;
      $r21 = self::$FAILED;
      goto seq_5;
    }
    $r21 = true;
    seq_5:
    if ($r21!==self::$FAILED) {
      goto choice_3;
    }
    // free $r25,$r26
    // free $p22,$r23,$r24
    // start seq_6
    $p22 = $this->currPos;
    $r24 = $param_preproc;
    $r23 = $param_th;
    $r26 = $this->input[$this->currPos] ?? '';
    if ($r26 === "g" || $r26 === "G") {
      $this->currPos++;
    } else {
      $r26 = self::$FAILED;
      $r21 = self::$FAILED;
      goto seq_6;
    }
    $r25 = $this->input[$this->currPos] ?? '';
    if ($r25 === "t" || $r25 === "T") {
      $this->currPos++;
    } else {
      $r25 = self::$FAILED;
      $this->currPos = $p22;
      $param_preproc = $r24;
      $param_th = $r23;
      $r21 = self::$FAILED;
      goto seq_6;
    }
    $r21 = true;
    seq_6:
    // free $r26,$r25
    // free $p22,$r24,$r23
    choice_3:
    if ($r21===self::$FAILED) {
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r19 = self::$FAILED;
      goto seq_4;
    }
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r23 = true;
    } else {
      $r23 = self::$FAILED;
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r19 = self::$FAILED;
      goto seq_4;
    }
    $r19 = true;
    seq_4:
    // free $r20,$r21,$r23
    if ($r19 === self::$FAILED) {
      $r19 = false;
    } else {
      $r19 = self::$FAILED;
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r14 = self::$FAILED;
      goto seq_3;
    }
    // start choice_4
    $p22 = $this->currPos;
    // start seq_7
    $p27 = $this->currPos;
    $r21 = $param_preproc;
    $r20 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r24 = true;
      $r24 = false;
      $this->currPos = $p27;
      $param_preproc = $r21;
      $param_th = $r20;
    } else {
      $r24 = self::$FAILED;
      $r23 = self::$FAILED;
      goto seq_7;
    }
    $r25 = $this->parsehtmlentity($silence);
    // he <- $r25
    if ($r25===self::$FAILED) {
      $this->currPos = $p27;
      $param_preproc = $r21;
      $param_th = $r20;
      $r23 = self::$FAILED;
      goto seq_7;
    }
    $r23 = true;
    seq_7:
    if ($r23!==self::$FAILED) {
      $this->savedPos = $p22;
      $r23 = $this->a7($r5, $r6, $r25);
      goto choice_4;
    }
    // free $r24
    // free $p27,$r21,$r20
    // free $p22
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r23 = "&";
    } else {
      if (!$silence) { $this->fail(5); }
      $r23 = self::$FAILED;
    }
    choice_4:
    // r <- $r23
    if ($r23===self::$FAILED) {
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r14 = self::$FAILED;
      goto seq_3;
    }
    $r14 = true;
    seq_3:
    if ($r14!==self::$FAILED) {
      $this->savedPos = $p15;
      $r14 = $this->a8($r5, $r6, $r23);
    }
    // free $r19
    // free $p16,$r17,$r18
    // free $p15
    choice_2:
    // c <- $r14
    if ($r14===self::$FAILED) {
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = true;
    seq_2:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a9($r5, $r6, $r14);
      $r7[] = $r8;
    } else {
      break;
    }
    // free $r13
    // free $p10,$r11,$r12
    // free $p9
  }
  // path <- $r7
  // free $r8
  $this->savedPos = $this->currPos;
  $r8 = $this->a10($r5, $r6, $r7);
  if ($r8) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a11($r5, $r6, $r7);
  }
  // free $r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parserow_syntax_table_args($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([520, $boolParams & 0x1fbf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parsetable_attributes($silence, $boolParams | 0x40, $param_tagType, $param_preproc, $param_th);
  // as <- $r5
  $p7 = $this->currPos;
  $r6 = strspn($this->input, " \x09", $this->currPos);
  // s <- $r6
  $this->currPos += $r6;
  $r6 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  $r8 = $this->parsepipe($silence);
  // p <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r9 = $this->discardpipe();
  if ($r9 === self::$FAILED) {
    $r9 = false;
  } else {
    $r9 = self::$FAILED;
    $this->currPos = $p7;
    $param_preproc = $r10;
    $param_th = $r11;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r10,$r11
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a12($r5, $r6, $r8);
  }
  // free $r9
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_attributes($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([298, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = [];
  for (;;) {
    // start choice_1
    $r5 = $this->parsetable_attribute($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r5!==self::$FAILED) {
      goto choice_1;
    }
    $p6 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $r10 = strspn($this->input, " \x09", $this->currPos);
    $this->currPos += $r10;
    $r11 = $this->parsebroken_table_attribute_name_char();
    // b <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $r5 = true;
    seq_1:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a13($r11);
    }
    // free $r10
    // free $p7,$r8,$r9
    // free $p6
    choice_1:
    if ($r5!==self::$FAILED) {
      $r4[] = $r5;
    } else {
      break;
    }
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsegeneric_newline_attributes($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([296, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = [];
  for (;;) {
    $r5 = $this->parsegeneric_newline_attribute($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r5!==self::$FAILED) {
      $r4[] = $r5;
    } else {
      break;
    }
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetplarg_or_template_or_bust($silence, &$param_th, &$param_preproc) {
  $key = json_encode([362, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->parsetplarg_or_template($silence, 0x0, "", $param_th, $param_preproc);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    if ($this->currPos < $this->inputLength) {
      $r6 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r6 = self::$FAILED;
      if (!$silence) { $this->fail(9); }
    }
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a14($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseextlink($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([342, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (!(/*extlink*/($boolParams & 0x4) !== 0)) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r11 = true;
  } else {
    $r11 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $p13 = $this->currPos;
  $r12 = true;
  // p0 <- $r12
  $this->savedPos = $p13;
  $r12 = $this->a15();
  // free $p13
  $p13 = $this->currPos;
  // start seq_3
  // start choice_1
  // start seq_4
  $p16 = $this->currPos;
  $r17 = $param_preproc;
  $r18 = $param_th;
  $r19 = $this->parseurl_protocol(true);
  if ($r19===self::$FAILED) {
    $r15 = self::$FAILED;
    goto seq_4;
  }
  $r20 = $this->parseipv6urladdr(true);
  if ($r20===self::$FAILED) {
    $this->currPos = $p16;
    $param_preproc = $r17;
    $param_th = $r18;
    $r15 = self::$FAILED;
    goto seq_4;
  }
  $r15 = [$r19,$r20];
  seq_4:
  if ($r15!==self::$FAILED) {
    goto choice_1;
  }
  // free $r19,$r20
  // free $p16,$r17,$r18
  $r15 = '';
  choice_1:
  // addr <- $r15
  // start choice_2
  $r18 = $this->parseextlink_nonipv6url($boolParams | 0x4, $param_tagType, $param_preproc, $param_th);
  if ($r18!==self::$FAILED) {
    goto choice_2;
  }
  $r18 = '';
  choice_2:
  // target <- $r18
  $r14 = true;
  seq_3:
  // flat <- $r14
  $this->savedPos = $p13;
  $r14 = $this->a16($r12, $r15, $r18);
  // free $p13
  $this->savedPos = $this->currPos;
  $r17 = $this->a17($r12, $r14);
  if ($r17) {
    $r17 = false;
  } else {
    $r17 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $p13 = $this->currPos;
  $r20 = true;
  // p1 <- $r20
  $this->savedPos = $p13;
  $r20 = $this->a18($r12, $r14);
  // free $p13
  $p13 = $this->currPos;
  for (;;) {
    // start choice_3
    $r21 = $this->input[$this->currPos] ?? '';
    if ($r21 === " " || $r21 === "\x09") {
      $this->currPos++;
      goto choice_3;
    } else {
      $r21 = self::$FAILED;
    }
    if (preg_match("/[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r21, 0, $this->currPos)) {
      $r21 = $r21[0];
      $this->currPos += strlen($r21);
    } else {
      $r21 = self::$FAILED;
    }
    choice_3:
    if ($r21===self::$FAILED) {
      break;
    }
  }
  // free $r21
  $r19 = true;
  // sp <- $r19
  if ($r19!==self::$FAILED) {
    $r19 = substr($this->input, $p13, $this->currPos - $p13);
  } else {
    $r19 = self::$FAILED;
  }
  // free $p13
  $p13 = $this->currPos;
  $r21 = true;
  // p2 <- $r21
  $this->savedPos = $p13;
  $r21 = $this->a19($r12, $r14, $r20, $r19);
  // free $p13
  $r22 = $this->parseinlineline(true, $boolParams | 0x4, $param_tagType, $param_preproc, $param_th);
  if ($r22===self::$FAILED) {
    $r22 = null;
  }
  // content <- $r22
  $p13 = $this->currPos;
  $r23 = true;
  // p3 <- $r23
  $this->savedPos = $p13;
  $r23 = $this->a20($r12, $r14, $r20, $r19, $r21, $r22);
  // free $p13
  if (($this->input[$this->currPos] ?? null) === "]") {
    $this->currPos++;
    $r24 = true;
  } else {
    $r24 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  // r <- $r6
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a21($r12, $r14, $r20, $r19, $r21, $r22, $r23);
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r11,$r17,$r24
  // free $p8,$r9,$r10
  // free $p7
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r6);
  } else {
    if (!$silence) { $this->fail(10); }
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselist_item($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([476, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parsedtdd($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsehacky_dl_uses($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parseli($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetlb($silence, &$param_th, &$param_preproc) {
  $key = json_encode([302, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start seq_1
  $r5 = $this->discardeof();
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseblock(true, 0x0, "", $param_th, $param_preproc);
  // b <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a23($r6);
  } else {
    if (!$silence) { $this->fail(11); }
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsenewlineToken($silence) {
  $key = 562;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $this->discardnewline();
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a24();
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsepipe($silence) {
  $key = 552;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $this->currPos++;
    $r2 = "|";
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(12); }
    $r2 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r2 = "{{!}}";
    $this->currPos += 5;
  } else {
    if (!$silence) { $this->fail(13); }
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseurl_protocol($silence) {
  $key = 352;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $p4 = $this->currPos;
  // start choice_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
    $r3 = true;
    $this->currPos += 2;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(14); }
    $r3 = self::$FAILED;
  }
  // start seq_2
  $r5 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[A-Za-z]/A", $r5)) {
    $this->currPos++;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(15); }
    $r3 = self::$FAILED;
    goto seq_2;
  }
  $r6 = null;
  if (preg_match("/[\\-A-Za-z0-9+.]*/A", $this->input, $r6, 0, $this->currPos)) {
    $this->currPos += strlen($r6[0]);
    $r6 = true;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(16); }
  }
  if (($this->input[$this->currPos] ?? null) === ":") {
    $this->currPos++;
    $r7 = true;
  } else {
    if (!$silence) { $this->fail(17); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_2;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
    $r8 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(14); }
    $r8 = self::$FAILED;
    $r8 = null;
  }
  $r3 = true;
  seq_2:
  // free $r5,$r6,$r7,$r8
  choice_1:
  // p <- $r3
  if ($r3!==self::$FAILED) {
    $r3 = substr($this->input, $p4, $this->currPos - $p4);
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p4
  $this->savedPos = $this->currPos;
  $r8 = $this->a25($r3);
  if ($r8) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a26($r3);
  }
  // free $r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseipv6urladdr($silence) {
  $key = 358;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p2 = $this->currPos;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r4 = true;
  } else {
    if (!$silence) { $this->fail(18); }
    $r4 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r5 = null;
  if (preg_match("/[0-9A-Fa-f:.]+/A", $this->input, $r5, 0, $this->currPos)) {
    $this->currPos += strlen($r5[0]);
    $r5 = true;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(19); }
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "]") {
    $this->currPos++;
    $r6 = true;
  } else {
    if (!$silence) { $this->fail(20); }
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $r3 = substr($this->input, $p2, $this->currPos - $p2);
  } else {
    $r3 = self::$FAILED;
  }
  // free $r4,$r5,$r6
  // free $p2
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function discardinline_breaks($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([325, $boolParams & 0x7fe, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (strspn($this->input, "=|!{}:;\x0d\x0a[]-", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $this->savedPos = $this->currPos;
  $r10 = $this->a27($param_tagType, /*h*/($boolParams & 0x2) !== 0, /*extlink*/($boolParams & 0x4) !== 0, $param_preproc, /*equal*/($boolParams & 0x8) !== 0, /*table*/($boolParams & 0x10) !== 0, /*templateArg*/($boolParams & 0x20) !== 0, /*tableCellArg*/($boolParams & 0x40) !== 0, /*semicolon*/($boolParams & 0x80) !== 0, /*arrow*/($boolParams & 0x100) !== 0, /*linkdesc*/($boolParams & 0x200) !== 0, /*colon*/($boolParams & 0x400) !== 0, $param_th);
  if ($r10) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r10
  // free $p7,$r8,$r9
  $r4 = true;
  seq_1:
  // free $r5,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsecomment($silence) {
  $key = 566;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "<!--", $this->currPos, 4, false) === 0) {
    $r3 = true;
    $this->currPos += 4;
  } else {
    if (!$silence) { $this->fail(21); }
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $p5 = $this->currPos;
  for (;;) {
    // start seq_2
    $p7 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r8 = true;
      $this->currPos += 3;
    } else {
      $r8 = self::$FAILED;
    }
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    if ($this->currPos < $this->inputLength) {
      self::advanceChar($this->input, $this->currPos);;
      $r9 = true;
    } else {
      $r9 = self::$FAILED;
      if (!$silence) { $this->fail(9); }
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6===self::$FAILED) {
      break;
    }
    // free $r8,$r9
    // free $p7
  }
  // free $r6
  $r4 = true;
  // c <- $r4
  if ($r4!==self::$FAILED) {
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r4 = self::$FAILED;
  }
  // free $p5
  $p5 = $this->currPos;
  // start choice_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
    $r6 = true;
    $this->currPos += 3;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(22); }
    $r6 = self::$FAILED;
  }
  $r6 = $this->discardeof();
  choice_1:
  // cEnd <- $r6
  if ($r6!==self::$FAILED) {
    $r6 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a28($r4, $r6);
  }
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetplarg_or_template($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([360, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
    $r5 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_th;
  $r10 = $param_preproc;
  // start seq_3
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $this->currPos += 2;
  } else {
    $r12 = self::$FAILED;
    $r11 = self::$FAILED;
    goto seq_3;
  }
  $p14 = $this->currPos;
  $r15 = $param_th;
  $r16 = $param_preproc;
  // start seq_4
  $r17 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r18 = true;
      $this->currPos += 3;
      $r17 = true;
    } else {
      $r18 = self::$FAILED;
      break;
    }
  }
  if ($r17===self::$FAILED) {
    $r13 = self::$FAILED;
    goto seq_4;
  }
  // free $r18
  $p19 = $this->currPos;
  $r20 = $param_th;
  $r21 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r18 = true;
  } else {
    $r18 = self::$FAILED;
  }
  if ($r18 === self::$FAILED) {
    $r18 = false;
  } else {
    $r18 = self::$FAILED;
    $this->currPos = $p19;
    $param_th = $r20;
    $param_preproc = $r21;
    $this->currPos = $p14;
    $param_th = $r15;
    $param_preproc = $r16;
    $r13 = self::$FAILED;
    goto seq_4;
  }
  // free $p19,$r20,$r21
  $r13 = true;
  seq_4:
  if ($r13!==self::$FAILED) {
    $r13 = false;
    $this->currPos = $p14;
    $param_th = $r15;
    $param_preproc = $r16;
  } else {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $r11 = self::$FAILED;
    goto seq_3;
  }
  // free $r17,$r18
  // free $p14,$r15,$r16
  $r16 = $this->discardtplarg($boolParams, $param_tagType, $param_th);
  if ($r16===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $r11 = self::$FAILED;
    goto seq_3;
  }
  $r11 = true;
  seq_3:
  if ($r11!==self::$FAILED) {
    $r11 = false;
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
  } else {
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // free $r12,$r13,$r16
  // start choice_2
  $r16 = $this->parsetemplate($silence, $boolParams, $param_tagType, $param_th);
  if ($r16!==self::$FAILED) {
    goto choice_2;
  }
  $r16 = $this->parsebroken_template($silence, $param_preproc);
  choice_2:
  // a <- $r16
  if ($r16===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a29($r16);
    goto choice_1;
  }
  // free $r11
  // free $p8,$r9,$r10
  // free $p7
  $p7 = $this->currPos;
  // start seq_5
  $p8 = $this->currPos;
  $r10 = $param_th;
  $r9 = $param_preproc;
  $p14 = $this->currPos;
  // start seq_6
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r13 = true;
  } else {
    if (!$silence) { $this->fail(23); }
    $r13 = self::$FAILED;
    $r11 = self::$FAILED;
    goto seq_6;
  }
  $p19 = $this->currPos;
  $r15 = $param_th;
  $r18 = $param_preproc;
  // start seq_7
  $r17 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r21 = true;
      $this->currPos += 3;
      $r17 = true;
    } else {
      $r21 = self::$FAILED;
      break;
    }
  }
  if ($r17===self::$FAILED) {
    $r12 = self::$FAILED;
    goto seq_7;
  }
  // free $r21
  $p22 = $this->currPos;
  $r20 = $param_th;
  $r23 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r21 = true;
  } else {
    $r21 = self::$FAILED;
  }
  if ($r21 === self::$FAILED) {
    $r21 = false;
  } else {
    $r21 = self::$FAILED;
    $this->currPos = $p22;
    $param_th = $r20;
    $param_preproc = $r23;
    $this->currPos = $p19;
    $param_th = $r15;
    $param_preproc = $r18;
    $r12 = self::$FAILED;
    goto seq_7;
  }
  // free $p22,$r20,$r23
  $r12 = true;
  seq_7:
  if ($r12!==self::$FAILED) {
    $r12 = false;
    $this->currPos = $p19;
    $param_th = $r15;
    $param_preproc = $r18;
  } else {
    $this->currPos = $p8;
    $param_th = $r10;
    $param_preproc = $r9;
    $r11 = self::$FAILED;
    goto seq_6;
  }
  // free $r17,$r21
  // free $p19,$r15,$r18
  $r11 = true;
  seq_6:
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // free $r13,$r12
  // a <- $r11
  $r11 = substr($this->input, $p14, $this->currPos - $p14);
  // free $p14
  $r12 = $this->parsetplarg($silence, $boolParams, $param_tagType, $param_th);
  // b <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r10;
    $param_preproc = $r9;
    $r6 = self::$FAILED;
    goto seq_5;
  }
  $r6 = true;
  seq_5:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a30($r11, $r12);
    goto choice_1;
  }
  // free $p8,$r10,$r9
  // free $p7
  $p7 = $this->currPos;
  // start seq_8
  $p8 = $this->currPos;
  $r9 = $param_th;
  $r10 = $param_preproc;
  $p14 = $this->currPos;
  // start seq_9
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r18 = true;
  } else {
    if (!$silence) { $this->fail(23); }
    $r18 = self::$FAILED;
    $r13 = self::$FAILED;
    goto seq_9;
  }
  $p19 = $this->currPos;
  $r21 = $param_th;
  $r17 = $param_preproc;
  // start seq_10
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r23 = true;
    $this->currPos += 2;
  } else {
    $r23 = self::$FAILED;
    $r15 = self::$FAILED;
    goto seq_10;
  }
  $p22 = $this->currPos;
  $r24 = $param_th;
  $r25 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r20 = true;
  } else {
    $r20 = self::$FAILED;
  }
  if ($r20 === self::$FAILED) {
    $r20 = false;
  } else {
    $r20 = self::$FAILED;
    $this->currPos = $p22;
    $param_th = $r24;
    $param_preproc = $r25;
    $this->currPos = $p19;
    $param_th = $r21;
    $param_preproc = $r17;
    $r15 = self::$FAILED;
    goto seq_10;
  }
  // free $p22,$r24,$r25
  $r15 = true;
  seq_10:
  if ($r15!==self::$FAILED) {
    $r15 = false;
    $this->currPos = $p19;
    $param_th = $r21;
    $param_preproc = $r17;
  } else {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $r13 = self::$FAILED;
    goto seq_9;
  }
  // free $r23,$r20
  // free $p19,$r21,$r17
  $r13 = true;
  seq_9:
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  // free $r18,$r15
  // a <- $r13
  $r13 = substr($this->input, $p14, $this->currPos - $p14);
  // free $p14
  $r15 = $this->parsetemplate($silence, $boolParams, $param_tagType, $param_th);
  // b <- $r15
  if ($r15===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $r6 = self::$FAILED;
    goto seq_8;
  }
  $r6 = true;
  seq_8:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a30($r13, $r15);
    goto choice_1;
  }
  // free $p8,$r9,$r10
  // free $p7
  $r6 = $this->parsebroken_template($silence, $param_preproc);
  choice_1:
  // t <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a2($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsehtmlentity($silence) {
  $key = 526;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $r3 = $this->parseraw_htmlentity($silence);
  // cc <- $r3
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a31($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardpipe() {
  $key = 553;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $this->currPos++;
    $r2 = true;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r2 = true;
    $this->currPos += 5;
  } else {
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_attribute($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([458, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r5;
  $p7 = $this->currPos;
  $r6 = true;
  // namePos0 <- $r6
  $this->savedPos = $p7;
  $r6 = $this->a15();
  // free $p7
  $r8 = $this->parsetable_attribute_name($boolParams, $param_tagType, $param_preproc, $param_th);
  // name <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r9 = true;
  // namePos1 <- $r9
  $this->savedPos = $p7;
  $r9 = $this->a32($r6, $r8);
  // free $p7
  $p7 = $this->currPos;
  // start seq_2
  $p11 = $this->currPos;
  $r12 = $param_preproc;
  $r13 = $param_th;
  $r14 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r14;
  if (($this->input[$this->currPos] ?? null) === "=") {
    $this->currPos++;
    $r15 = true;
  } else {
    $r15 = self::$FAILED;
    $this->currPos = $p11;
    $param_preproc = $r12;
    $param_th = $r13;
    $r10 = self::$FAILED;
    goto seq_2;
  }
  $r16 = $this->parsetable_att_value($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r16===self::$FAILED) {
    $r16 = null;
  }
  // v <- $r16
  $r10 = true;
  seq_2:
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p7;
    $r10 = $this->a33($r6, $r8, $r9, $r16);
  } else {
    $r10 = null;
  }
  // free $r14,$r15
  // free $p11,$r12,$r13
  // free $p7
  // vd <- $r10
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a34($r6, $r8, $r9, $r10);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsebroken_table_attribute_name_char() {
  $key = 466;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // c <- $r3
  if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
    $r3 = $this->input[$this->currPos++];
  } else {
    $r3 = self::$FAILED;
  }
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a35($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsegeneric_newline_attribute($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([456, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  for (;;) {
    $r6 = $this->discardspace_or_newline_or_solidus();
    if ($r6===self::$FAILED) {
      break;
    }
  }
  // free $r6
  $r5 = true;
  // free $r5
  $p7 = $this->currPos;
  $r5 = true;
  // namePos0 <- $r5
  $this->savedPos = $p7;
  $r5 = $this->a15();
  // free $p7
  $r6 = $this->parsegeneric_attribute_name($boolParams, $param_tagType, $param_preproc, $param_th);
  // name <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r8 = true;
  // namePos1 <- $r8
  $this->savedPos = $p7;
  $r8 = $this->a32($r5, $r6);
  // free $p7
  $p7 = $this->currPos;
  // start seq_2
  $p10 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  $this->currPos += $r13;
  if (($this->input[$this->currPos] ?? null) === "=") {
    $this->currPos++;
    $r14 = true;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $r9 = self::$FAILED;
    goto seq_2;
  }
  $r15 = $this->parsegeneric_att_value($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r15===self::$FAILED) {
    $r15 = null;
  }
  // v <- $r15
  $r9 = true;
  seq_2:
  if ($r9!==self::$FAILED) {
    $this->savedPos = $p7;
    $r9 = $this->a33($r5, $r6, $r8, $r15);
  } else {
    $r9 = null;
  }
  // free $r13,$r14
  // free $p10,$r11,$r12
  // free $p7
  // vd <- $r9
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a36($r5, $r6, $r8, $r9);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseextlink_nonipv6url($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([536, $boolParams & 0x1dff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->parseextlink_nonipv6url_parameterized($boolParams & ~0x200, $param_tagType, $param_preproc, $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseinlineline($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([326, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->parseurltext($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r12 = $this->parseinline_element($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12!==self::$FAILED) {
      goto choice_2;
    }
    $p13 = $this->currPos;
    // start seq_2
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $this->discardnewline();
    if ($r17 === self::$FAILED) {
      $r17 = false;
    } else {
      $r17 = self::$FAILED;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $r12 = self::$FAILED;
      goto seq_2;
    }
    // s <- $r18
    if ($this->currPos < $this->inputLength) {
      $r18 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r18 = self::$FAILED;
      if (!$silence) { $this->fail(9); }
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $r12 = self::$FAILED;
      goto seq_2;
    }
    $r12 = true;
    seq_2:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p13;
      $r12 = $this->a37($r18);
    }
    // free $r17
    // free $p14,$r15,$r16
    // free $p13
    choice_2:
    // r <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a22($r12);
    }
    // free $r11
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // c <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a38($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsedtdd($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([484, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = [];
  for (;;) {
    $p7 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    // start seq_3
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r12 = true;
    } else {
      $r12 = self::$FAILED;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    if (strspn($this->input, "*#:;", $this->currPos, 1) !== 0) {
      $this->currPos++;
      $r13 = true;
    } else {
      $r13 = self::$FAILED;
    }
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    // free $p14,$r15,$r16
    $r11 = true;
    seq_3:
    // free $r12,$r13
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // lc <- $r13
    if (strspn($this->input, "*#:;", $this->currPos, 1) !== 0) {
      $r13 = $this->input[$this->currPos++];
    } else {
      $r13 = self::$FAILED;
      if (!$silence) { $this->fail(24); }
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a39($r13);
      $r5[] = $r6;
    } else {
      break;
    }
    // free $r11
    // free $p8,$r9,$r10
    // free $p7
  }
  // bullets <- $r5
  // free $r6
  if (($this->input[$this->currPos] ?? null) === ";") {
    $this->currPos++;
    $r6 = true;
  } else {
    if (!$silence) { $this->fail(25); }
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r10 = [];
  for (;;) {
    $r9 = $this->parsedtdd_colon($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      $r10[] = $r9;
    } else {
      break;
    }
  }
  // colons <- $r10
  // free $r9
  $r9 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r9===self::$FAILED) {
    $r9 = null;
  }
  // d <- $r9
  $p7 = $this->currPos;
  $r12 = $param_preproc;
  $r16 = $param_th;
  $r11 = $this->discardeolf();
  if ($r11!==self::$FAILED) {
    $r11 = false;
    $this->currPos = $p7;
    $param_preproc = $r12;
    $param_th = $r16;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r12,$r16
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a40($r5, $r10, $r9);
  }
  // free $r6,$r11
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsehacky_dl_uses($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([480, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = [];
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === ":") {
      $this->currPos++;
      $r6 = ":";
      $r5[] = $r6;
    } else {
      if (!$silence) { $this->fail(17); }
      $r6 = self::$FAILED;
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // bullets <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r6
  $r6 = [];
  for (;;) {
    $r7 = $this->parsespace_or_comment($silence);
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // sc <- $r6
  // free $r7
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r7 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7 === self::$FAILED) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10
  $r10 = $this->parsetable_start_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // tbl <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a41($r5, $r6, $r10);
  }
  // free $r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseli($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([478, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = strspn($this->input, "*#:;", $this->currPos);
  // bullets <- $r5
  if ($r5 > 0) {
    $this->currPos += $r5;
    $r5 = substr($this->input, $this->currPos - $r5, $r5);
    $r5 = str_split($r5);
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(24); }
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6===self::$FAILED) {
    $r6 = null;
  }
  // c <- $r6
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  // start choice_1
  $r7 = $this->discardeolf();
  if ($r7!==self::$FAILED) {
    goto choice_1;
  }
  $r7 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  if ($r7!==self::$FAILED) {
    $r7 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a42($r5, $r6);
  }
  // free $r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardeof() {
  $key = 559;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r2 = $this->a43();
  if ($r2) {
    $r2 = false;
  } else {
    $r2 = self::$FAILED;
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseblock($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([308, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start choice_1
  // start seq_1
  $r5 = $this->discardsof();
  if ($r5!==self::$FAILED) {
    $r5 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
  } else {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseredirect($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // r <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    $r8 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r8!==self::$FAILED) {
      $r7[] = $r8;
    } else {
      break;
    }
  }
  // cil <- $r7
  // free $r8
  $r8 = $this->parseblock_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // bl <- $r8
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a44($r6, $r7, $r8);
    goto choice_1;
  }
  // free $r5
  $r4 = $this->parseblock_lines($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  // start choice_2
  if (/*tableCaption*/($boolParams & 0x1000) !== 0) {
    $r5 = false;
    goto choice_2;
  } else {
    $r5 = self::$FAILED;
  }
  if (/*fullTable*/($boolParams & 0x800) !== 0) {
    $r5 = false;
    goto choice_2;
  } else {
    $r5 = self::$FAILED;
  }
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
  }
  choice_2:
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r9 = $this->parsesol($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // s <- $r9
  if ($r9===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $p11 = $this->currPos;
  $r12 = $param_th;
  $r13 = $param_preproc;
  $r10 = $this->discardsof();
  if ($r10 === self::$FAILED) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p11;
    $param_th = $r12;
    $param_preproc = $r13;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  // free $p11,$r12,$r13
  $p11 = $this->currPos;
  $r12 = $param_th;
  $r14 = $param_preproc;
  $r13 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r13 === self::$FAILED) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $this->currPos = $p11;
    $param_th = $r12;
    $param_preproc = $r14;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  // free $p11,$r12,$r14
  $r4 = true;
  seq_2:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a37($r9);
  }
  // free $r5,$r10,$r13
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardnewline() {
  $key = 561;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $this->currPos++;
    $r2 = true;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r2 = true;
    $this->currPos += 2;
  } else {
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardtplarg($boolParams, $param_tagType, &$param_th) {
  $key = json_encode([373, $boolParams & 0x1fff, $param_tagType, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $this->discardtplarg_preproc($boolParams, $param_tagType, self::newRef("}}"), $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r3;
}
private function parsetemplate($silence, $boolParams, $param_tagType, &$param_th) {
  $key = json_encode([364, $boolParams & 0x1fff, $param_tagType, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $this->parsetemplate_preproc($silence, $boolParams, $param_tagType, self::newRef("}}"), $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r3;
}
private function parsebroken_template($silence, &$param_preproc) {
  $key = json_encode([366, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  // start seq_1
  // t <- $r4
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r4 = "{{";
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(26); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $this->savedPos = $p1;
    $r3 = $this->a45($param_preproc, $r4);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsetplarg($silence, $boolParams, $param_tagType, &$param_th) {
  $key = json_encode([372, $boolParams & 0x1fff, $param_tagType, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $this->parsetplarg_preproc($silence, $boolParams, $param_tagType, self::newRef("}}"), $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r3;
}
private function parseraw_htmlentity($silence) {
  $key = 524;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p4 = $this->currPos;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "&") {
    $this->currPos++;
    $r5 = true;
  } else {
    if (!$silence) { $this->fail(5); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r6 = null;
  if (preg_match("/[#0-9a-zA-Z\\x{5e8}\\x{5dc}\\x{5de}\\x{631}\\x{644}\\x{645}]+/Au", $this->input, $r6, 0, $this->currPos)) {
    $this->currPos += strlen($r6[0]);
    $r6 = true;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(27); }
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === ";") {
    $this->currPos++;
    $r7 = true;
  } else {
    if (!$silence) { $this->fail(25); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
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
  // free $r5,$r6,$r7
  // free $p4
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a46($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_attribute_name($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([468, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  // start choice_1
  $p6 = $this->currPos;
  if (strspn($this->input, "\"'=", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r5 = true;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
    goto choice_1;
  } else {
    $r5 = self::$FAILED;
    $r5 = self::$FAILED;
  }
  // free $p6
  $r5 = $this->parsetable_attribute_name_piece($boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  // first <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    $r8 = $this->parsetable_attribute_name_piece($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r8!==self::$FAILED) {
      $r7[] = $r8;
    } else {
      break;
    }
  }
  // rest <- $r7
  // free $r8
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a47($r5, $r7);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_att_value($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([474, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  $p6 = $this->currPos;
  // start seq_2
  $r7 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r7;
  if (($this->input[$this->currPos] ?? null) === "'") {
    $this->currPos++;
    $r8 = true;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = true;
  seq_2:
  // s <- $r5
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r7,$r8
  // free $p6
  $r8 = $this->parsetable_attribute_preprocessor_text_single($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // t <- $r8
  $p6 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "'") {
    $this->currPos++;
    $r7 = true;
    goto choice_2;
  } else {
    $r7 = self::$FAILED;
  }
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  // start choice_3
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
    $r7 = true;
    $this->currPos += 2;
    goto choice_3;
  } else {
    $r7 = self::$FAILED;
  }
  if (strspn($this->input, "|\x0d\x0a", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r7 = true;
  } else {
    $r7 = self::$FAILED;
  }
  choice_3:
  if ($r7!==self::$FAILED) {
    $r7 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
  }
  // free $p9,$r10,$r11
  choice_2:
  // q <- $r7
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p6
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a48($r5, $r8, $r7);
    goto choice_1;
  }
  // start seq_3
  $p6 = $this->currPos;
  // start seq_4
  $r10 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r10;
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $this->currPos++;
    $r12 = true;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r11 = self::$FAILED;
    goto seq_4;
  }
  $r11 = true;
  seq_4:
  // s <- $r11
  if ($r11!==self::$FAILED) {
    $r11 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r11 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_3;
  }
  // free $r10,$r12
  // free $p6
  $r12 = $this->parsetable_attribute_preprocessor_text_double($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r12===self::$FAILED) {
    $r12 = null;
  }
  // t <- $r12
  $p6 = $this->currPos;
  // start choice_4
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $this->currPos++;
    $r10 = true;
    goto choice_4;
  } else {
    $r10 = self::$FAILED;
  }
  $p9 = $this->currPos;
  $r13 = $param_preproc;
  $r14 = $param_th;
  // start choice_5
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
    $r10 = true;
    $this->currPos += 2;
    goto choice_5;
  } else {
    $r10 = self::$FAILED;
  }
  if (strspn($this->input, "|\x0d\x0a", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r10 = true;
  } else {
    $r10 = self::$FAILED;
  }
  choice_5:
  if ($r10!==self::$FAILED) {
    $r10 = false;
    $this->currPos = $p9;
    $param_preproc = $r13;
    $param_th = $r14;
  }
  // free $p9,$r13,$r14
  choice_4:
  // q <- $r10
  if ($r10!==self::$FAILED) {
    $r10 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_3;
  }
  // free $p6
  $r4 = true;
  seq_3:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a48($r11, $r12, $r10);
    goto choice_1;
  }
  // start seq_5
  $p6 = $this->currPos;
  $r14 = strspn($this->input, " \x09", $this->currPos);
  // s <- $r14
  $this->currPos += $r14;
  $r14 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  $r13 = $this->parsetable_attribute_preprocessor_text($boolParams, $param_tagType, $param_preproc, $param_th);
  // t <- $r13
  if ($r13===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_5;
  }
  $p6 = $this->currPos;
  $r16 = $param_preproc;
  $r17 = $param_th;
  // start choice_6
  if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r15 = true;
    goto choice_6;
  } else {
    $r15 = self::$FAILED;
  }
  $r15 = $this->discardeof();
  if ($r15!==self::$FAILED) {
    goto choice_6;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
    $r15 = true;
    $this->currPos += 2;
    goto choice_6;
  } else {
    $r15 = self::$FAILED;
  }
  if (($this->input[$this->currPos] ?? null) === "|") {
    $this->currPos++;
    $r15 = true;
  } else {
    $r15 = self::$FAILED;
  }
  choice_6:
  if ($r15!==self::$FAILED) {
    $r15 = false;
    $this->currPos = $p6;
    $param_preproc = $r16;
    $param_th = $r17;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_5;
  }
  // free $p6,$r16,$r17
  $r4 = true;
  seq_5:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a49($r14, $r13);
  }
  // free $r15
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardspace_or_newline_or_solidus() {
  $key = 451;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r2 = true;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
  }
  // start seq_1
  // s <- $r3
  if (($this->input[$this->currPos] ?? null) === "/") {
    $this->currPos++;
    $r3 = "/";
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $p5 = $this->currPos;
  if (($this->input[$this->currPos] ?? null) === ">") {
    $this->currPos++;
    $r4 = true;
  } else {
    $r4 = self::$FAILED;
  }
  if ($r4 === self::$FAILED) {
    $r4 = false;
  } else {
    $r4 = self::$FAILED;
    $this->currPos = $p5;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a37($r3);
  }
  // free $r4
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsegeneric_attribute_name($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([462, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  // start choice_1
  $p6 = $this->currPos;
  if (strspn($this->input, "\"'=", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r5 = true;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
    goto choice_1;
  } else {
    $r5 = self::$FAILED;
    $r5 = self::$FAILED;
  }
  // free $p6
  $r5 = $this->parsegeneric_attribute_name_piece($boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  // first <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    $r8 = $this->parsegeneric_attribute_name_piece($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r8!==self::$FAILED) {
      $r7[] = $r8;
    } else {
      break;
    }
  }
  // rest <- $r7
  // free $r8
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a47($r5, $r7);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsegeneric_att_value($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([472, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  $p6 = $this->currPos;
  // start seq_2
  $r7 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  $this->currPos += $r7;
  if (($this->input[$this->currPos] ?? null) === "'") {
    $this->currPos++;
    $r8 = true;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = true;
  seq_2:
  // s <- $r5
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r7,$r8
  // free $p6
  $r8 = $this->parseattribute_preprocessor_text_single($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // t <- $r8
  $p6 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "'") {
    $this->currPos++;
    $r7 = true;
    goto choice_2;
  } else {
    $r7 = self::$FAILED;
  }
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  // start seq_3
  if (($this->input[$this->currPos] ?? null) === "/") {
    $this->currPos++;
    $r12 = true;
  } else {
    $r12 = self::$FAILED;
    $r12 = null;
  }
  if (($this->input[$this->currPos] ?? null) === ">") {
    $this->currPos++;
    $r13 = true;
  } else {
    $r13 = self::$FAILED;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $r7 = self::$FAILED;
    goto seq_3;
  }
  $r7 = true;
  seq_3:
  if ($r7!==self::$FAILED) {
    $r7 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
  }
  // free $r12,$r13
  // free $p9,$r10,$r11
  choice_2:
  // q <- $r7
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p6
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a48($r5, $r8, $r7);
    goto choice_1;
  }
  // start seq_4
  $p6 = $this->currPos;
  // start seq_5
  $r10 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  $this->currPos += $r10;
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $this->currPos++;
    $r13 = true;
  } else {
    $r13 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r11 = self::$FAILED;
    goto seq_5;
  }
  $r11 = true;
  seq_5:
  // s <- $r11
  if ($r11!==self::$FAILED) {
    $r11 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r11 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_4;
  }
  // free $r10,$r13
  // free $p6
  $r13 = $this->parseattribute_preprocessor_text_double($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  // t <- $r13
  $p6 = $this->currPos;
  // start choice_3
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $this->currPos++;
    $r10 = true;
    goto choice_3;
  } else {
    $r10 = self::$FAILED;
  }
  $p9 = $this->currPos;
  $r12 = $param_preproc;
  $r14 = $param_th;
  // start seq_6
  if (($this->input[$this->currPos] ?? null) === "/") {
    $this->currPos++;
    $r15 = true;
  } else {
    $r15 = self::$FAILED;
    $r15 = null;
  }
  if (($this->input[$this->currPos] ?? null) === ">") {
    $this->currPos++;
    $r16 = true;
  } else {
    $r16 = self::$FAILED;
    $this->currPos = $p9;
    $param_preproc = $r12;
    $param_th = $r14;
    $r10 = self::$FAILED;
    goto seq_6;
  }
  $r10 = true;
  seq_6:
  if ($r10!==self::$FAILED) {
    $r10 = false;
    $this->currPos = $p9;
    $param_preproc = $r12;
    $param_th = $r14;
  }
  // free $r15,$r16
  // free $p9,$r12,$r14
  choice_3:
  // q <- $r10
  if ($r10!==self::$FAILED) {
    $r10 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_4;
  }
  // free $p6
  $r4 = true;
  seq_4:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a48($r11, $r13, $r10);
    goto choice_1;
  }
  // start seq_7
  $p6 = $this->currPos;
  $r14 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // s <- $r14
  $this->currPos += $r14;
  $r14 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  $r12 = $this->parseattribute_preprocessor_text($boolParams, $param_tagType, $param_preproc, $param_th);
  // t <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_7;
  }
  $p6 = $this->currPos;
  $r15 = $param_preproc;
  $r17 = $param_th;
  // start choice_4
  if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r16 = true;
    goto choice_4;
  } else {
    $r16 = self::$FAILED;
  }
  $r16 = $this->discardeof();
  if ($r16!==self::$FAILED) {
    goto choice_4;
  }
  // start seq_8
  if (($this->input[$this->currPos] ?? null) === "/") {
    $this->currPos++;
    $r18 = true;
  } else {
    $r18 = self::$FAILED;
    $r18 = null;
  }
  if (($this->input[$this->currPos] ?? null) === ">") {
    $this->currPos++;
    $r19 = true;
  } else {
    $r19 = self::$FAILED;
    $this->currPos = $p6;
    $param_preproc = $r15;
    $param_th = $r17;
    $r16 = self::$FAILED;
    goto seq_8;
  }
  $r16 = true;
  seq_8:
  // free $r18,$r19
  choice_4:
  if ($r16!==self::$FAILED) {
    $r16 = false;
    $this->currPos = $p6;
    $param_preproc = $r15;
    $param_th = $r17;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_7;
  }
  // free $p6,$r15,$r17
  $r4 = true;
  seq_7:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a49($r14, $r12);
  }
  // free $r16
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseextlink_nonipv6url_parameterized($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([538, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = null;
    if (preg_match("/[^<\\[{\\x0a\\x0d|!\\]}\\-\\x09&=\"' \\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]+/Au", $this->input, $r6, 0, $this->currPos)) {
      $this->currPos += strlen($r6[0]);
      $r6 = true;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r12 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "&|{-!}=", $this->currPos, 1) !== 0) {
      $r12 = $this->input[$this->currPos++];
    } else {
      $r12 = self::$FAILED;
    }
    choice_2:
    // s <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r12);
      goto choice_1;
    }
    // free $r11
    // free $p8,$r9,$r10
    // free $p7
    $p7 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    $r10 = $param_preproc;
    $r9 = $param_th;
    $r11 = $this->input[$this->currPos] ?? '';
    if ($r11 === "'") {
      $this->currPos++;
    } else {
      $r11 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "'") {
      $this->currPos++;
    } else {
      $r13 = self::$FAILED;
    }
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $this->currPos = $p8;
      $param_preproc = $r10;
      $param_th = $r9;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $p14,$r15,$r16
    $r6 = true;
    seq_2:
    if ($r6!==self::$FAILED) {
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
    } else {
      $r6 = self::$FAILED;
    }
    // free $r11,$r13
    // free $p8,$r10,$r9
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a50($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseurltext($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([522, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = [];
  for (;;) {
    // start choice_1
    $p6 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $this->savedPos = $this->currPos;
    $r10 = $this->a51();
    if ($r10) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $r5 = true;
    seq_1:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a52();
      goto choice_1;
    }
    // free $r10
    // free $p7,$r8,$r9
    // free $p6
    $p6 = $this->currPos;
    // start seq_2
    $p7 = $this->currPos;
    $r9 = $param_preproc;
    $r8 = $param_th;
    $this->savedPos = $this->currPos;
    $r10 = $this->a53();
    if ($r10) {
      $r10 = false;
    } else {
      $r10 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r11 = $this->parseautolink($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    // al <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r9;
      $param_th = $r8;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = true;
    seq_2:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a54($r11);
      goto choice_1;
    }
    // free $r10
    // free $p7,$r9,$r8
    // free $p6
    $p6 = $this->currPos;
    // start seq_3
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r10 = true;
      $r10 = false;
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
    } else {
      $r10 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_3;
    }
    $r12 = $this->parsehtmlentity($silence);
    // he <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $r5 = self::$FAILED;
      goto seq_3;
    }
    $r5 = true;
    seq_3:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a55($r12);
      goto choice_1;
    }
    // free $r10
    // free $p7,$r8,$r9
    // free $p6
    $p6 = $this->currPos;
    // start seq_4
    $p7 = $this->currPos;
    $r9 = $param_preproc;
    $r8 = $param_th;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r10 = true;
      $this->currPos += 2;
      $r10 = false;
      $this->currPos = $p7;
      $param_preproc = $r9;
      $param_th = $r8;
    } else {
      $r10 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_4;
    }
    $r13 = $this->parsebehavior_switch($silence);
    // bs <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r9;
      $param_th = $r8;
      $r5 = self::$FAILED;
      goto seq_4;
    }
    $r5 = true;
    seq_4:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a56($r13);
      goto choice_1;
    }
    // free $r10
    // free $p7,$r9,$r8
    // free $p6
    if (strcspn($this->input, "-'<[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
      $r5 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r5 = self::$FAILED;
      if (!$silence) { $this->fail(28); }
    }
    choice_1:
    if ($r5!==self::$FAILED) {
      $r4[] = $r5;
    } else {
      break;
    }
  }
  if (count($r4) === 0) {
    $r4 = self::$FAILED;
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseinline_element($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([332, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "<") {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseangle_bracket_markup($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // r <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r6);
    goto choice_1;
  }
  // free $r5
  // start seq_2
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // r <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r4 = true;
  seq_2:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r7);
    goto choice_1;
  }
  // free $r5
  // start seq_3
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_3;
  }
  $r8 = $this->parselang_variant_or_tpl($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // r <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_3;
  }
  $r4 = true;
  seq_3:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r8);
    goto choice_1;
  }
  // free $r5
  $p9 = $this->currPos;
  $r4 = self::$FAILED;
  for (;;) {
    // start seq_4
    $p10 = $this->currPos;
    $r11 = $param_preproc;
    $r12 = $param_th;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r13 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(29); }
      $r13 = self::$FAILED;
      $r5 = self::$FAILED;
      goto seq_4;
    }
    $p15 = $this->currPos;
    $r16 = $param_preproc;
    $r17 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r14 = true;
      $r14 = false;
      $this->currPos = $p15;
      $param_preproc = $r16;
      $param_th = $r17;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r5 = self::$FAILED;
      goto seq_4;
    }
    // free $p15,$r16,$r17
    $r5 = true;
    seq_4:
    if ($r5!==self::$FAILED) {
      $r4 = true;
    } else {
      break;
    }
    // free $r13,$r14
    // free $p10,$r11,$r12
  }
  if ($r4!==self::$FAILED) {
    $r4 = substr($this->input, $p9, $this->currPos - $p9);
    goto choice_1;
  } else {
    $r4 = self::$FAILED;
  }
  // free $r5
  // free $p9
  // start seq_5
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_5;
  }
  // start choice_2
  $r12 = $this->parsewikilink($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  if ($r12!==self::$FAILED) {
    goto choice_2;
  }
  $r12 = $this->parseextlink($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_2:
  // r <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_5;
  }
  $r4 = true;
  seq_5:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r12);
    goto choice_1;
  }
  // free $r5
  // start seq_6
  if (($this->input[$this->currPos] ?? null) === "'") {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_6;
  }
  $r11 = $this->parsequote($silence);
  // r <- $r11
  if ($r11===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_6;
  }
  $r4 = true;
  seq_6:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r11);
  }
  // free $r5
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsedtdd_colon($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([482, $boolParams & 0x1bff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parseinlineline_break_on_colon($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r5===self::$FAILED) {
    $r5 = null;
  }
  // c <- $r5
  $p7 = $this->currPos;
  // cpos <- $r6
  if (($this->input[$this->currPos] ?? null) === ":") {
    $this->currPos++;
    $r6 = true;
    $this->savedPos = $p7;
    $r6 = $this->a57($r5);
  } else {
    if (!$silence) { $this->fail(17); }
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a58($r5, $r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardeolf() {
  $key = 565;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->discardnewline();
  if ($r2!==self::$FAILED) {
    goto choice_1;
  }
  $r2 = $this->discardeof();
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsespace_or_comment($silence) {
  $key = 568;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->input[$this->currPos] ?? '';
  if ($r2 === " " || $r2 === "\x09") {
    $this->currPos++;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
    if (!$silence) { $this->fail(6); }
  }
  $r2 = $this->parsecomment($silence);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardsof() {
  $key = 557;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r2 = $this->a59();
  if ($r2) {
    $r2 = false;
  } else {
    $r2 = self::$FAILED;
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseredirect($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([304, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start seq_1
  $r5 = $this->parseredirect_word($silence);
  // rw <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r6 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp <- $r6
  $this->currPos += $r6;
  $r6 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  $p7 = $this->currPos;
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_th;
  $r11 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === ":") {
    $this->currPos++;
    $r12 = true;
  } else {
    if (!$silence) { $this->fail(17); }
    $r12 = self::$FAILED;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r13 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  $this->currPos += $r13;
  $r8 = true;
  seq_2:
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // free $r12,$r13
  // free $p9,$r10,$r11
  // c <- $r8
  $r8 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  $r11 = $this->parsewikilink($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // wl <- $r11
  if ($r11===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r10 = $this->a60($r5, $r6, $r8, $r11);
  if ($r10) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a61($r5, $r6, $r8, $r11);
  }
  // free $r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsesol_transparent($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([580, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parsecomment($silence);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parseinclude_limits($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parseannotation_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsebehavior_switch($silence);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseblock_line($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([320, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parseheading($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parselist_item($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsehr($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_1
  if (strspn($this->input, " \x09<{}|!", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsetable_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // tl <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a62($r6);
  }
  // free $r5
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseblock_lines($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([316, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parsesol($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // s <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $this->parseoptionalSpaceToken($silence);
  // os <- $r11
  $r12 = $this->parsesol($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // so <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a63($r5, $r11, $r12);
  } else {
    $r6 = null;
  }
  // free $p8,$r9,$r10
  // free $p7
  // s2 <- $r6
  $r10 = $this->parseblock_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // bl <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a64($r5, $r6, $r10);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsesol($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([582, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r5 = $this->a65();
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsesol_prefix($silence);
  // sp <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parseempty_lines_with_comments($silence);
  if ($r7===self::$FAILED) {
    $r7 = null;
  }
  // elc <- $r7
  $r8 = [];
  for (;;) {
    $r9 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      $r8[] = $r9;
    } else {
      break;
    }
  }
  // st <- $r8
  // free $r9
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a66($r6, $r7, $r8);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardtplarg_preproc($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([375, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
    $r5 = true;
    $this->currPos += 3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    $r7 = $this->discardnl_comment_space();
    if ($r7===self::$FAILED) {
      break;
    }
  }
  // free $r7
  $r6 = true;
  // free $r6
  $p8 = $this->currPos;
  $r6 = true;
  // p <- $r6
  $this->savedPos = $p8;
  $r6 = $this->a15();
  // free $p8
  $r7 = $this->parseinlineline_in_tpls(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7===self::$FAILED) {
    $r7 = null;
  }
  // target <- $r7
  $r9 = [];
  for (;;) {
    $p8 = $this->currPos;
    // start seq_2
    $p11 = $this->currPos;
    $r12 = $param_preproc;
    $r13 = $param_th;
    for (;;) {
      $r15 = $this->discardnl_comment_space();
      if ($r15===self::$FAILED) {
        break;
      }
    }
    // free $r15
    $r14 = true;
    // free $r14
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r14 = true;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $p16 = $this->currPos;
    // start seq_3
    $p17 = $this->currPos;
    $r18 = $param_preproc;
    $r19 = $param_th;
    $r20 = true;
    // p0 <- $r20
    $this->savedPos = $p17;
    $r20 = $this->a67($r6, $r7);
    $r21 = [];
    for (;;) {
      $r22 = $this->parsenl_comment_space(true);
      if ($r22!==self::$FAILED) {
        $r21[] = $r22;
      } else {
        break;
      }
    }
    // v <- $r21
    // free $r22
    $p23 = $this->currPos;
    $r22 = true;
    // p1 <- $r22
    $this->savedPos = $p23;
    $r22 = $this->a68($r6, $r7, $r20, $r21);
    // free $p23
    $p23 = $this->currPos;
    $r25 = $param_preproc;
    $r26 = $param_th;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r24 = true;
      goto choice_2;
    } else {
      $r24 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r24 = true;
      $this->currPos += 3;
    } else {
      $r24 = self::$FAILED;
    }
    choice_2:
    if ($r24!==self::$FAILED) {
      $r24 = false;
      $this->currPos = $p23;
      $param_preproc = $r25;
      $param_th = $r26;
    } else {
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $r15 = self::$FAILED;
      goto seq_3;
    }
    // free $p23,$r25,$r26
    $r15 = true;
    seq_3:
    if ($r15!==self::$FAILED) {
      $this->savedPos = $p16;
      $r15 = $this->a69($r6, $r7, $r20, $r21, $r22);
      goto choice_1;
    }
    // free $r24
    // free $p17,$r18,$r19
    // free $p16
    $r15 = $this->parsetemplate_param_value(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    choice_1:
    // r <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    $r10 = true;
    seq_2:
    if ($r10!==self::$FAILED) {
      $this->savedPos = $p8;
      $r10 = $this->a70($r6, $r7, $r15);
      $r9[] = $r10;
    } else {
      break;
    }
    // free $r14
    // free $p11,$r12,$r13
    // free $p8
  }
  // params <- $r9
  // free $r10
  for (;;) {
    $r13 = $this->discardnl_comment_space();
    if ($r13===self::$FAILED) {
      break;
    }
  }
  // free $r13
  $r10 = true;
  // free $r10
  $r10 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
    $r13 = true;
    $this->currPos += 3;
  } else {
    $r13 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a71($r6, $r7, $r9);
  }
  // free $r5,$r10,$r13
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetemplate_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([368, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(26); }
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    $r7 = $this->discardnl_comment_space();
    if ($r7===self::$FAILED) {
      break;
    }
  }
  // free $r7
  $r6 = true;
  // free $r6
  // start choice_2
  $r6 = $this->parseinlineline_in_tpls($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6!==self::$FAILED) {
    goto choice_2;
  }
  $r6 = $this->parseparsoid_fragment_marker($silence);
  choice_2:
  // target <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    $p9 = $this->currPos;
    // start seq_2
    $p10 = $this->currPos;
    $r11 = $param_preproc;
    $r12 = $param_th;
    for (;;) {
      $r14 = $this->discardnl_comment_space();
      if ($r14===self::$FAILED) {
        break;
      }
    }
    // free $r14
    $r13 = true;
    // free $r13
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r13 = true;
    } else {
      if (!$silence) { $this->fail(12); }
      $r13 = self::$FAILED;
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    // start choice_3
    $p15 = $this->currPos;
    // start seq_3
    $p16 = $this->currPos;
    $r17 = $param_preproc;
    $r18 = $param_th;
    $r19 = true;
    // p0 <- $r19
    $this->savedPos = $p16;
    $r19 = $this->a72($r6);
    $r20 = [];
    for (;;) {
      $r21 = $this->parsenl_comment_space($silence);
      if ($r21!==self::$FAILED) {
        $r20[] = $r21;
      } else {
        break;
      }
    }
    // v <- $r20
    // free $r21
    $p22 = $this->currPos;
    $r21 = true;
    // p1 <- $r21
    $this->savedPos = $p22;
    $r21 = $this->a73($r6, $r19, $r20);
    // free $p22
    $p22 = $this->currPos;
    $r24 = $param_preproc;
    $r25 = $param_th;
    // start choice_4
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r23 = true;
      goto choice_4;
    } else {
      $r23 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
      $r23 = true;
      $this->currPos += 2;
    } else {
      $r23 = self::$FAILED;
    }
    choice_4:
    if ($r23!==self::$FAILED) {
      $r23 = false;
      $this->currPos = $p22;
      $param_preproc = $r24;
      $param_th = $r25;
    } else {
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r14 = self::$FAILED;
      goto seq_3;
    }
    // free $p22,$r24,$r25
    $r14 = true;
    seq_3:
    if ($r14!==self::$FAILED) {
      $this->savedPos = $p15;
      $r14 = $this->a74($r6, $r19, $r20, $r21);
      goto choice_3;
    }
    // free $r23
    // free $p16,$r17,$r18
    // free $p15
    $r14 = $this->parsetemplate_param($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    choice_3:
    // r <- $r14
    if ($r14===self::$FAILED) {
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = true;
    seq_2:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a75($r6, $r14);
      $r7[] = $r8;
    } else {
      break;
    }
    // free $r13
    // free $p10,$r11,$r12
    // free $p9
  }
  // params <- $r7
  // free $r8
  for (;;) {
    $r12 = $this->discardnl_comment_space();
    if ($r12===self::$FAILED) {
      break;
    }
  }
  // free $r12
  $r8 = true;
  // free $r8
  $r8 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(31); }
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a76($r6, $r7);
    goto choice_1;
  }
  // free $r5,$r8,$r12
  $p9 = $this->currPos;
  // start seq_4
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(26); }
    $r12 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_4;
  }
  $r8 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  $this->currPos += $r8;
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(31); }
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_4;
  }
  $r4 = true;
  seq_4:
  if ($r4!==self::$FAILED) {
    $r4 = substr($this->input, $p9, $this->currPos - $p9);
  } else {
    $r4 = self::$FAILED;
  }
  // free $r12,$r8,$r5
  // free $p9
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetplarg_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([374, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
    $r5 = true;
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(32); }
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    $r7 = $this->discardnl_comment_space();
    if ($r7===self::$FAILED) {
      break;
    }
  }
  // free $r7
  $r6 = true;
  // free $r6
  $p8 = $this->currPos;
  $r6 = true;
  // p <- $r6
  $this->savedPos = $p8;
  $r6 = $this->a15();
  // free $p8
  $r7 = $this->parseinlineline_in_tpls($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7===self::$FAILED) {
    $r7 = null;
  }
  // target <- $r7
  $r9 = [];
  for (;;) {
    $p8 = $this->currPos;
    // start seq_2
    $p11 = $this->currPos;
    $r12 = $param_preproc;
    $r13 = $param_th;
    for (;;) {
      $r15 = $this->discardnl_comment_space();
      if ($r15===self::$FAILED) {
        break;
      }
    }
    // free $r15
    $r14 = true;
    // free $r14
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r14 = true;
    } else {
      if (!$silence) { $this->fail(12); }
      $r14 = self::$FAILED;
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    // start choice_1
    $p16 = $this->currPos;
    // start seq_3
    $p17 = $this->currPos;
    $r18 = $param_preproc;
    $r19 = $param_th;
    $r20 = true;
    // p0 <- $r20
    $this->savedPos = $p17;
    $r20 = $this->a67($r6, $r7);
    $r21 = [];
    for (;;) {
      $r22 = $this->parsenl_comment_space($silence);
      if ($r22!==self::$FAILED) {
        $r21[] = $r22;
      } else {
        break;
      }
    }
    // v <- $r21
    // free $r22
    $p23 = $this->currPos;
    $r22 = true;
    // p1 <- $r22
    $this->savedPos = $p23;
    $r22 = $this->a68($r6, $r7, $r20, $r21);
    // free $p23
    $p23 = $this->currPos;
    $r25 = $param_preproc;
    $r26 = $param_th;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r24 = true;
      goto choice_2;
    } else {
      $r24 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r24 = true;
      $this->currPos += 3;
    } else {
      $r24 = self::$FAILED;
    }
    choice_2:
    if ($r24!==self::$FAILED) {
      $r24 = false;
      $this->currPos = $p23;
      $param_preproc = $r25;
      $param_th = $r26;
    } else {
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $r15 = self::$FAILED;
      goto seq_3;
    }
    // free $p23,$r25,$r26
    $r15 = true;
    seq_3:
    if ($r15!==self::$FAILED) {
      $this->savedPos = $p16;
      $r15 = $this->a69($r6, $r7, $r20, $r21, $r22);
      goto choice_1;
    }
    // free $r24
    // free $p17,$r18,$r19
    // free $p16
    $r15 = $this->parsetemplate_param_value($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    choice_1:
    // r <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    $r10 = true;
    seq_2:
    if ($r10!==self::$FAILED) {
      $this->savedPos = $p8;
      $r10 = $this->a70($r6, $r7, $r15);
      $r9[] = $r10;
    } else {
      break;
    }
    // free $r14
    // free $p11,$r12,$r13
    // free $p8
  }
  // params <- $r9
  // free $r10
  for (;;) {
    $r13 = $this->discardnl_comment_space();
    if ($r13===self::$FAILED) {
      break;
    }
  }
  // free $r13
  $r10 = true;
  // free $r10
  $r10 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
    $r13 = true;
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(33); }
    $r13 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a71($r6, $r7, $r9);
  }
  // free $r5,$r10,$r13
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_attribute_name_piece($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([470, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $p5 = $this->currPos;
  $r4 = strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|[", $this->currPos);
  if ($r4 > 0) {
    $this->currPos += $r4;
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
    goto choice_1;
  } else {
    $r4 = self::$FAILED;
    $r4 = self::$FAILED;
  }
  // free $p5
  // start seq_1
  $r6 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_2
  $p5 = $this->currPos;
  $r7 = $this->discardwikilink($boolParams, $param_tagType, $param_th, $param_preproc);
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p5, $this->currPos - $p5);
    goto choice_2;
  } else {
    $r7 = self::$FAILED;
  }
  // free $p5
  $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7!==self::$FAILED) {
    goto choice_2;
  }
  $p5 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  if (($this->input[$this->currPos] ?? null) === "<") {
    $this->currPos++;
    $r11 = true;
    $r11 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
  } else {
    $r11 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r12 = $this->parsehtml_tag(true, $boolParams, $param_preproc, $param_th);
  // x <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r13 = $this->parseinlineline(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  // ill <- $r13
  $r7 = true;
  seq_2:
  if ($r7!==self::$FAILED) {
    $this->savedPos = $p5;
    $r7 = $this->a77($r12, $r13);
    goto choice_2;
  }
  // free $r11
  // free $p8,$r9,$r10
  // free $p5
  $p5 = $this->currPos;
  // start seq_3
  $p8 = $this->currPos;
  $r10 = $param_preproc;
  $r9 = $param_th;
  // start choice_3
  if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r11 = true;
    goto choice_3;
  } else {
    $r11 = self::$FAILED;
  }
  if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r11 = true;
  } else {
    $r11 = self::$FAILED;
  }
  choice_3:
  if ($r11 === self::$FAILED) {
    $r11 = false;
  } else {
    $r11 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r10;
    $param_th = $r9;
    $r7 = self::$FAILED;
    goto seq_3;
  }
  if ($this->currPos < $this->inputLength) {
    self::advanceChar($this->input, $this->currPos);;
    $r14 = true;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r10;
    $param_th = $r9;
    $r7 = self::$FAILED;
    goto seq_3;
  }
  $r7 = true;
  seq_3:
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r7 = self::$FAILED;
  }
  // free $r11,$r14
  // free $p8,$r10,$r9
  // free $p5
  choice_2:
  // t <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a2($r7);
  }
  // free $r6
  choice_1:
  // r <- $r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_attribute_preprocessor_text_single($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([548, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = strcspn($this->input, "{}&<-!['\x0d\x0a|", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r12 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
      $r12 = $this->input[$this->currPos++];
    } else {
      $r12 = self::$FAILED;
    }
    choice_2:
    // s <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r12);
    }
    // free $r11
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a50($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_attribute_preprocessor_text_double($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([550, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = strcspn($this->input, "{}&<-![\"\x0d\x0a|", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r12 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
      $r12 = $this->input[$this->currPos++];
    } else {
      $r12 = self::$FAILED;
    }
    choice_2:
    // s <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r12);
    }
    // free $r11
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a50($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_attribute_preprocessor_text($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([546, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = strcspn($this->input, "{}&<-![ \x09\x0a\x0d\x0c|", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r12 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&<-![", $this->currPos, 1) !== 0) {
      $r12 = $this->input[$this->currPos++];
    } else {
      $r12 = self::$FAILED;
    }
    choice_2:
    // s <- $r12
    if ($r12===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r12);
    }
    // free $r11
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a50($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsegeneric_attribute_name_piece($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([464, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $p5 = $this->currPos;
  $r4 = strcspn($this->input, " \x09\x0d\x0a\x00/=><&{}-!|", $this->currPos);
  if ($r4 > 0) {
    $this->currPos += $r4;
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
    goto choice_1;
  } else {
    $r4 = self::$FAILED;
    $r4 = self::$FAILED;
  }
  // free $p5
  // start seq_1
  $r6 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_2
  $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7!==self::$FAILED) {
    goto choice_2;
  }
  $r7 = $this->parseless_than($param_tagType);
  if ($r7!==self::$FAILED) {
    goto choice_2;
  }
  $p5 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  // start choice_3
  if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r11 = true;
    goto choice_3;
  } else {
    $r11 = self::$FAILED;
  }
  if (strspn($this->input, "\x00/=><", $this->currPos, 1) !== 0) {
    $this->currPos++;
    $r11 = true;
  } else {
    $r11 = self::$FAILED;
  }
  choice_3:
  if ($r11 === self::$FAILED) {
    $r11 = false;
  } else {
    $r11 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  if ($this->currPos < $this->inputLength) {
    self::advanceChar($this->input, $this->currPos);;
    $r12 = true;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = true;
  seq_2:
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r7 = self::$FAILED;
  }
  // free $r11,$r12
  // free $p8,$r9,$r10
  // free $p5
  choice_2:
  // t <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a2($r7);
  }
  // free $r6
  choice_1:
  // r <- $r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseattribute_preprocessor_text_single($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([542, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = strcspn($this->input, "{}&<-|/'>", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
      $r12 = true;
      $this->currPos += 2;
    } else {
      $r12 = self::$FAILED;
    }
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // free $p13,$r14,$r15
    // start choice_2
    $r15 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    $r15 = $this->parseless_than($param_tagType);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
      $r15 = $this->input[$this->currPos++];
    } else {
      $r15 = self::$FAILED;
    }
    choice_2:
    // s <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r15);
    }
    // free $r11,$r12
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a50($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseattribute_preprocessor_text_double($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([544, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = strcspn($this->input, "{}&<-|/\">", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
      $r12 = true;
      $this->currPos += 2;
    } else {
      $r12 = self::$FAILED;
    }
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // free $p13,$r14,$r15
    // start choice_2
    $r15 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    $r15 = $this->parseless_than($param_tagType);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
      $r15 = $this->input[$this->currPos++];
    } else {
      $r15 = self::$FAILED;
    }
    choice_2:
    // s <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r15);
    }
    // free $r11,$r12
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a50($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseattribute_preprocessor_text($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([540, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    $r6 = strcspn($this->input, "{}&<-|/ \x09\x0a\x0d\x0c>", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      $r6 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      $r6 = self::$FAILED;
    }
    // free $p7
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
      $r12 = true;
      $this->currPos += 2;
    } else {
      $r12 = self::$FAILED;
    }
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // free $p13,$r14,$r15
    // start choice_2
    $r15 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    $r15 = $this->parseless_than($param_tagType);
    if ($r15!==self::$FAILED) {
      goto choice_2;
    }
    if (strspn($this->input, "{}&-|/", $this->currPos, 1) !== 0) {
      $r15 = $this->input[$this->currPos++];
    } else {
      $r15 = self::$FAILED;
    }
    choice_2:
    // s <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a37($r15);
    }
    // free $r11,$r12
    // free $p8,$r9,$r10
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a50($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsedirective($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([532, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parsecomment($silence);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parseannotation_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsewellformed_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parselang_variant_or_tpl($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // v <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a78($r6);
    goto choice_1;
  }
  // free $r5
  // start seq_2
  if (($this->input[$this->currPos] ?? null) === "&") {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parsehtmlentity($silence);
  // e <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r4 = true;
  seq_2:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a79($r7);
    goto choice_1;
  }
  // free $r5
  $r4 = $this->parseinclude_limits($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseautolink($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([340, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (!(/*extlink*/($boolParams & 0x4) !== 0)) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a80();
  if (!$r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $r7 = $this->parseautourl($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7!==self::$FAILED) {
    goto choice_1;
  }
  $r7 = $this->parseautoref($silence);
  if ($r7!==self::$FAILED) {
    goto choice_1;
  }
  $r7 = $this->parseisbn($silence);
  choice_1:
  // r <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r7);
  }
  // free $r5,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsebehavior_switch($silence) {
  $key = 336;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p4 = $this->currPos;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(34); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->discardbehavior_text();
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
    $r7 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(34); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
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
  // free $r5,$r6,$r7
  // free $p4
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a81($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseangle_bracket_markup($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([330, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parseannotation_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsemaybe_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parseinclude_limits($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsehtml_tag($silence, $boolParams, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsecomment($silence);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_or_tpl($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([386, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start choice_1
  // start seq_1
  // start seq_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $this->currPos += 2;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $p8 = $this->currPos;
  $r9 = $param_th;
  $r10 = $param_preproc;
  // start seq_3
  $r11 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r12 = true;
      $this->currPos += 3;
      $r11 = true;
    } else {
      $r12 = self::$FAILED;
      break;
    }
  }
  if ($r11===self::$FAILED) {
    $r7 = self::$FAILED;
    goto seq_3;
  }
  // free $r12
  $p13 = $this->currPos;
  $r14 = $param_th;
  $r15 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r12 = true;
  } else {
    $r12 = self::$FAILED;
  }
  if ($r12 === self::$FAILED) {
    $r12 = false;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p13;
    $param_th = $r14;
    $param_preproc = $r15;
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $r7 = self::$FAILED;
    goto seq_3;
  }
  // free $p13,$r14,$r15
  $r7 = true;
  seq_3:
  if ($r7!==self::$FAILED) {
    $r7 = false;
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  // free $r11,$r12
  // free $p8,$r9,$r10
  $r10 = $this->discardtplarg($boolParams, $param_tagType, $param_th);
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = true;
  seq_2:
  if ($r5!==self::$FAILED) {
    $r5 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
  } else {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r6,$r7,$r10
  $r10 = $this->parselang_variant($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // a <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a29($r10);
    goto choice_1;
  }
  // free $r5
  // start seq_4
  $p8 = $this->currPos;
  // start seq_5
  if (($this->input[$this->currPos] ?? null) === "-") {
    $this->currPos++;
    $r7 = true;
  } else {
    if (!$silence) { $this->fail(35); }
    $r7 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  $p13 = $this->currPos;
  $r9 = $param_th;
  $r12 = $param_preproc;
  // start seq_6
  $r11 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r15 = true;
      $this->currPos += 3;
      $r11 = true;
    } else {
      $r15 = self::$FAILED;
      break;
    }
  }
  if ($r11===self::$FAILED) {
    $r6 = self::$FAILED;
    goto seq_6;
  }
  // free $r15
  $p16 = $this->currPos;
  $r14 = $param_th;
  $r17 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r15 = true;
  } else {
    $r15 = self::$FAILED;
  }
  if ($r15 === self::$FAILED) {
    $r15 = false;
  } else {
    $r15 = self::$FAILED;
    $this->currPos = $p16;
    $param_th = $r14;
    $param_preproc = $r17;
    $this->currPos = $p13;
    $param_th = $r9;
    $param_preproc = $r12;
    $r6 = self::$FAILED;
    goto seq_6;
  }
  // free $p16,$r14,$r17
  $r6 = true;
  seq_6:
  if ($r6!==self::$FAILED) {
    $r6 = false;
    $this->currPos = $p13;
    $param_th = $r9;
    $param_preproc = $r12;
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // free $r11,$r15
  // free $p13,$r9,$r12
  $r5 = true;
  seq_5:
  // a <- $r5
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p8, $this->currPos - $p8);
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_4;
  }
  // free $r7,$r6
  // free $p8
  $r6 = $this->parsetplarg($silence, $boolParams, $param_tagType, $param_th);
  // b <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_4;
  }
  $r4 = true;
  seq_4:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a30($r5, $r6);
    goto choice_1;
  }
  // start seq_7
  $p8 = $this->currPos;
  // start seq_8
  if (($this->input[$this->currPos] ?? null) === "-") {
    $this->currPos++;
    $r12 = true;
  } else {
    if (!$silence) { $this->fail(35); }
    $r12 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_8;
  }
  $p13 = $this->currPos;
  $r15 = $param_th;
  $r11 = $param_preproc;
  // start seq_9
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r17 = true;
    $this->currPos += 2;
  } else {
    $r17 = self::$FAILED;
    $r9 = self::$FAILED;
    goto seq_9;
  }
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r18 = true;
      $this->currPos += 3;
    } else {
      $r18 = self::$FAILED;
      break;
    }
  }
  // free $r18
  $r14 = true;
  // free $r14
  $p16 = $this->currPos;
  $r18 = $param_th;
  $r19 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $this->currPos++;
    $r14 = true;
  } else {
    $r14 = self::$FAILED;
  }
  if ($r14 === self::$FAILED) {
    $r14 = false;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p16;
    $param_th = $r18;
    $param_preproc = $r19;
    $this->currPos = $p13;
    $param_th = $r15;
    $param_preproc = $r11;
    $r9 = self::$FAILED;
    goto seq_9;
  }
  // free $p16,$r18,$r19
  $r9 = true;
  seq_9:
  if ($r9!==self::$FAILED) {
    $r9 = false;
    $this->currPos = $p13;
    $param_th = $r15;
    $param_preproc = $r11;
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r7 = self::$FAILED;
    goto seq_8;
  }
  // free $r17,$r14
  // free $p13,$r15,$r11
  $r7 = true;
  seq_8:
  // a <- $r7
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p8, $this->currPos - $p8);
  } else {
    $r7 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_7;
  }
  // free $r12,$r9
  // free $p8
  $r9 = $this->parsetemplate($silence, $boolParams, $param_tagType, $param_th);
  // b <- $r9
  if ($r9===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_7;
  }
  $r4 = true;
  seq_7:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a30($r7, $r9);
    goto choice_1;
  }
  // start seq_10
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $this->currPos += 2;
    $r12 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
  } else {
    $r12 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_10;
  }
  $r11 = $this->parselang_variant($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // a <- $r11
  if ($r11===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $r4 = self::$FAILED;
    goto seq_10;
  }
  $r4 = true;
  seq_10:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a29($r11);
  }
  // free $r12
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsewikilink($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([418, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start choice_1
  $r4 = $this->parsewikilink_preproc($silence, $boolParams, $param_tagType, self::newRef("]]"), $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsebroken_wikilink($silence, $boolParams, $param_preproc, $param_tagType, $param_th);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsequote($silence) {
  $key = 428;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p4 = $this->currPos;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "''", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(36); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r7 = true;
    } else {
      if (!$silence) { $this->fail(37); }
      $r7 = self::$FAILED;
      break;
    }
  }
  // free $r7
  $r6 = true;
  // free $r6
  $r3 = true;
  seq_1:
  // quotes <- $r3
  if ($r3!==self::$FAILED) {
    $r3 = substr($this->input, $p4, $this->currPos - $p4);
  } else {
    $r3 = self::$FAILED;
  }
  // free $r5
  // free $p4
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a82($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseinlineline_break_on_colon($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([486, $boolParams & 0x1bff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->parseinlineline($silence, $boolParams | 0x400, $param_tagType, $param_preproc, $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseredirect_word($silence) {
  $key = 306;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p2 = $this->currPos;
  // start seq_1
  $r4 = strspn($this->input, " \x09\x0a\x0d\x00\x0b", $this->currPos);
  $this->currPos += $r4;
  $p6 = $this->currPos;
  $r5 = strcspn($this->input, " \x09\x0a\x0d\x0c:[", $this->currPos);
  // rw <- $r5
  if ($r5 > 0) {
    $this->currPos += $r5;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(39); }
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  // free $p6
  $this->savedPos = $this->currPos;
  $r7 = $this->a83($r5);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $r3 = substr($this->input, $p2, $this->currPos - $p2);
  } else {
    $r3 = self::$FAILED;
  }
  // free $r4,$r7
  // free $p2
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parseinclude_limits($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([530, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardinclude_check($param_tagType);
  if ($r5!==self::$FAILED) {
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsexmlish_tag($silence, $boolParams, "inc", $param_preproc, $param_th);
  // t <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a84($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseannotation_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([434, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r5 = $this->a85();
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $r6 = $this->parsetvar_old_syntax_closing_HACK($silence, $param_tagType);
  if ($r6!==self::$FAILED) {
    goto choice_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $this->discardannotation_check($param_tagType);
  if ($r11!==self::$FAILED) {
    $r11 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
  } else {
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r12 = $this->parsexmlish_tag($silence, $boolParams, "anno", $param_preproc, $param_th);
  // t <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a86($r12);
  }
  // free $r11
  // free $p8,$r9,$r10
  // free $p7
  choice_1:
  // tag <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a87($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseheading($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([334, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "=") {
    $this->currPos++;
    $r5 = true;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $p12 = $this->currPos;
  $r11 = self::$FAILED;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r13 = true;
      $r11 = true;
    } else {
      if (!$silence) { $this->fail(40); }
      $r13 = self::$FAILED;
      break;
    }
  }
  // s <- $r11
  if ($r11!==self::$FAILED) {
    $r11 = substr($this->input, $p12, $this->currPos - $p12);
  } else {
    $r11 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // free $r13
  // free $p12
  // start seq_3
  $p12 = $this->currPos;
  $r14 = $param_preproc;
  $r15 = $param_th;
  $r17 = $this->parseinlineline($silence, $boolParams | 0x2, $param_tagType, $param_preproc, $param_th);
  if ($r17===self::$FAILED) {
    $r17 = null;
  }
  // ill <- $r17
  $r16 = $r17;
  $this->savedPos = $p12;
  $r16 = $this->a88($r11, $r17);
  $p18 = $this->currPos;
  $r19 = self::$FAILED;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "=") {
      $this->currPos++;
      $r20 = true;
      $r19 = true;
    } else {
      if (!$silence) { $this->fail(40); }
      $r20 = self::$FAILED;
      break;
    }
  }
  if ($r19!==self::$FAILED) {
    $r19 = substr($this->input, $p18, $this->currPos - $p18);
  } else {
    $r19 = self::$FAILED;
    $this->currPos = $p12;
    $param_preproc = $r14;
    $param_th = $r15;
    $r13 = self::$FAILED;
    goto seq_3;
  }
  // free $r20
  // free $p18
  $r13 = [$r16,$r19];
  seq_3:
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  // free $r16,$r19
  // free $p12,$r14,$r15
  // ce <- $r13
  $this->savedPos = $this->currPos;
  $r15 = $this->a89($r11, $r13);
  if ($r15) {
    $r15 = false;
  } else {
    $r15 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $p12 = $this->currPos;
  $r14 = true;
  // endTPos <- $r14
  $this->savedPos = $p12;
  $r14 = $this->a90($r11, $r13);
  // free $p12
  $r19 = [];
  for (;;) {
    // start choice_1
    $r16 = $this->input[$this->currPos] ?? '';
    if ($r16 === " " || $r16 === "\x09") {
      $this->currPos++;
      goto choice_1;
    } else {
      $r16 = self::$FAILED;
      if (!$silence) { $this->fail(6); }
    }
    $r16 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    choice_1:
    if ($r16!==self::$FAILED) {
      $r19[] = $r16;
    } else {
      break;
    }
  }
  // spc <- $r19
  // free $r16
  $p12 = $this->currPos;
  $r20 = $param_preproc;
  $r21 = $param_th;
  $r16 = $this->discardeolf();
  if ($r16!==self::$FAILED) {
    $r16 = false;
    $this->currPos = $p12;
    $param_preproc = $r20;
    $param_th = $r21;
  } else {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // free $p12,$r20,$r21
  $r6 = true;
  seq_2:
  // r <- $r6
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a91($r11, $r13, $r14, $r19);
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r15,$r16
  // free $p8,$r9,$r10
  // free $p7
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a22($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsehr($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([318, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "----", $this->currPos, 4, false) === 0) {
    $r5 = true;
    $this->currPos += 4;
  } else {
    if (!$silence) { $this->fail(41); }
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r8 = true;
    } else {
      if (!$silence) { $this->fail(35); }
      $r8 = self::$FAILED;
      break;
    }
  }
  // free $r8
  $r6 = true;
  // d <- $r6
  if ($r6!==self::$FAILED) {
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r6 = self::$FAILED;
  }
  // free $p7
  // start choice_1
  $p7 = $this->currPos;
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $this->discardsol($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r12!==self::$FAILED) {
    $r12 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
  } else {
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = true;
  seq_2:
  if ($r8!==self::$FAILED) {
    $this->savedPos = $p7;
    $r8 = $this->a92($r6);
    goto choice_1;
  }
  // free $r12
  // free $p9,$r10,$r11
  // free $p7
  $p7 = $this->currPos;
  $r8 = true;
  $this->savedPos = $p7;
  $r8 = $this->a93($r6);
  // free $p7
  choice_1:
  // lineContent <- $r8
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a94($r6, $r8);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_line($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([494, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = [];
  for (;;) {
    $r6 = $this->parsespace_or_comment($silence);
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // sc <- $r5
  // free $r6
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $r6 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r8,$r9
  // start choice_1
  $r9 = $this->parsetable_start_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r9!==self::$FAILED) {
    goto choice_1;
  }
  $r9 = $this->parsetable_content_line($silence, $boolParams | 0x10, $param_tagType, $param_preproc, $param_th);
  if ($r9!==self::$FAILED) {
    goto choice_1;
  }
  $r9 = $this->parsetable_end_tag($silence);
  choice_1:
  // tl <- $r9
  if ($r9===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a95($r5, $r9);
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseoptionalSpaceToken($silence) {
  $key = 572;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p4 = $this->currPos;
  $r3 = strspn($this->input, " \x09", $this->currPos);
  // s <- $r3
  $this->currPos += $r3;
  $r3 = substr($this->input, $p4, $this->currPos - $p4);
  // free $p4
  $r2 = $r3;
  $this->savedPos = $p1;
  $r2 = $this->a96($r3);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsesol_prefix($silence) {
  $key = 584;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->parsenewlineToken($silence);
  if ($r2!==self::$FAILED) {
    goto choice_1;
  }
  $this->savedPos = $this->currPos;
  $r2 = $this->a97();
  if ($r2) {
    $r2 = false;
    $this->savedPos = $p1;
    $r2 = $this->a98();
  } else {
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseempty_lines_with_comments($silence) {
  $key = 586;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = true;
  // p <- $r3
  $this->savedPos = $p1;
  $r3 = $this->a15();
  $r4 = [];
  for (;;) {
    // start seq_2
    $p6 = $this->currPos;
    $r7 = strspn($this->input, " \x09", $this->currPos);
    $this->currPos += $r7;
    $r7 = substr($this->input, $this->currPos - $r7, $r7);
    $r7 = mb_str_split($r7, 1, "utf-8");
    $r8 = $this->parsecomment($silence);
    if ($r8===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r9 = [];
    for (;;) {
      $r10 = $this->parsespace_or_comment($silence);
      if ($r10!==self::$FAILED) {
        $r9[] = $r10;
      } else {
        break;
      }
    }
    // free $r10
    $r10 = $this->parsenewline($silence);
    if ($r10===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = [$r7,$r8,$r9,$r10];
    seq_2:
    if ($r5!==self::$FAILED) {
      $r4[] = $r5;
    } else {
      break;
    }
    // free $r7,$r8,$r9,$r10
    // free $p6
  }
  if (count($r4) === 0) {
    $r4 = self::$FAILED;
  }
  // c <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r5
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a99($r3, $r4);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardnl_comment_space() {
  $key = 571;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->discardnewlineToken();
  if ($r2!==self::$FAILED) {
    goto choice_1;
  }
  $r2 = $this->discardspace_or_comment();
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseinlineline_in_tpls($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([384, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->parsenested_inlineline($silence, ($boolParams & ~0x5c) | 0x20, $param_tagType, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    $r6 = $this->parsenewlineToken($silence);
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // il <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a100($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsenl_comment_space($silence) {
  $key = 570;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->parsenewlineToken($silence);
  if ($r2!==self::$FAILED) {
    goto choice_1;
  }
  $r2 = $this->parsespace_or_comment($silence);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetemplate_param_value($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([380, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = $this->parsetemplate_param_text($silence, $boolParams & ~0x8, $param_tagType, $param_preproc, $param_th);
  // tpt <- $r5
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a101($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseparsoid_fragment_marker($silence) {
  $key = 370;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p2 = $this->currPos;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "#parsoid\x00fragment:", $this->currPos, 18, false) === 0) {
    $r4 = true;
    $this->currPos += 18;
  } else {
    if (!$silence) { $this->fail(42); }
    $r4 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r5 = null;
  if (preg_match("/[0-9]+/A", $this->input, $r5, 0, $this->currPos)) {
    $this->currPos += strlen($r5[0]);
    $r5 = true;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(43); }
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $r3 = substr($this->input, $p2, $this->currPos - $p2);
  } else {
    $r3 = self::$FAILED;
  }
  // free $r4,$r5
  // free $p2
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsetemplate_param($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([376, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  $r5 = $this->parsetemplate_param_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // name <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = true;
  // kEndPos <- $r11
  $this->savedPos = $p8;
  $r11 = $this->a102($r5);
  if (($this->input[$this->currPos] ?? null) === "=") {
    $this->currPos++;
    $r12 = true;
  } else {
    if (!$silence) { $this->fail(40); }
    $r12 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $p14 = $this->currPos;
  $r13 = true;
  // vStartPos <- $r13
  $this->savedPos = $p14;
  $r13 = $this->a103($r5, $r11);
  // free $p14
  $r15 = $this->parseoptionalSpaceToken($silence);
  // optSp <- $r15
  $r16 = $this->parsetemplate_param_value($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r16===self::$FAILED) {
    $r16 = null;
  }
  // tpv <- $r16
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a104($r5, $r11, $r13, $r15, $r16);
  } else {
    $r6 = null;
  }
  // free $r12
  // free $p8,$r9,$r10
  // free $p7
  // val <- $r6
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a105($r5, $r6);
    goto choice_1;
  }
  $r4 = $this->input[$this->currPos] ?? '';
  if ($r4 === "|" || $r4 === "}") {
    $this->currPos++;
    $r4 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $this->savedPos = $p1;
    $r4 = $this->a106();
  } else {
    $r4 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardwikilink($boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([419, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start choice_1
  $r4 = $this->discardwikilink_preproc($boolParams, $param_tagType, self::newRef("]]"), $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->discardbroken_wikilink($boolParams, $param_preproc, $param_tagType, $param_th);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsehtml_tag($silence, $boolParams, &$param_preproc, &$param_th) {
  $key = json_encode([328, $boolParams & 0x1faf, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->parsexmlish_tag($silence, $boolParams, "html", $param_preproc, $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseless_than($param_tagType) {
  $key = json_encode([460, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p2 = $this->currPos;
  // start seq_1
  $r4 = $this->discardhtml_or_empty($param_tagType);
  if ($r4 === self::$FAILED) {
    $r4 = false;
  } else {
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "<") {
    $this->currPos++;
    $r5 = true;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $r3 = substr($this->input, $p2, $this->currPos - $p2);
  } else {
    $r3 = self::$FAILED;
  }
  // free $r4,$r5
  // free $p2
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsewellformed_extension_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([442, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parsemaybe_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // extToken <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a107($r5);
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a108($r5);
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseautourl($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([356, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    $r5 = self::$FAILED;
  }
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $this->parseurl_protocol($silence);
  // proto <- $r11
  if ($r11===self::$FAILED) {
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  $r12 = $this->parseipv6urladdr($silence);
  if ($r12!==self::$FAILED) {
    goto choice_1;
  }
  $r12 = '';
  choice_1:
  // addr <- $r12
  $r13 = [];
  for (;;) {
    $p15 = $this->currPos;
    // start seq_3
    $p16 = $this->currPos;
    $r17 = $param_preproc;
    $r18 = $param_th;
    $r19 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r19 === self::$FAILED) {
      $r19 = false;
    } else {
      $r19 = self::$FAILED;
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r14 = self::$FAILED;
      goto seq_3;
    }
    // start choice_2
    if (preg_match("/[^ \\]\\[\\x0d\\x0a\"'<>\\x00- \\x7f&\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}{]/Au", $this->input, $r20, 0, $this->currPos)) {
      $r20 = $r20[0];
      $this->currPos += strlen($r20);
      goto choice_2;
    } else {
      $r20 = self::$FAILED;
      if (!$silence) { $this->fail(3); }
    }
    $r20 = $this->parsecomment($silence);
    if ($r20!==self::$FAILED) {
      goto choice_2;
    }
    $r20 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
    if ($r20!==self::$FAILED) {
      goto choice_2;
    }
    $p21 = $this->currPos;
    // start seq_4
    $p22 = $this->currPos;
    $r23 = $param_preproc;
    $r24 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r25 = true;
    } else {
      if (!$silence) { $this->fail(37); }
      $r25 = self::$FAILED;
      $r20 = self::$FAILED;
      goto seq_4;
    }
    $p27 = $this->currPos;
    $r28 = $param_preproc;
    $r29 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "'") {
      $this->currPos++;
      $r26 = true;
    } else {
      $r26 = self::$FAILED;
    }
    if ($r26 === self::$FAILED) {
      $r26 = false;
    } else {
      $r26 = self::$FAILED;
      $this->currPos = $p27;
      $param_preproc = $r28;
      $param_th = $r29;
      $this->currPos = $p22;
      $param_preproc = $r23;
      $param_th = $r24;
      $r20 = self::$FAILED;
      goto seq_4;
    }
    // free $p27,$r28,$r29
    $r20 = true;
    seq_4:
    if ($r20!==self::$FAILED) {
      $r20 = substr($this->input, $p21, $this->currPos - $p21);
      goto choice_2;
    } else {
      $r20 = self::$FAILED;
    }
    // free $r25,$r26
    // free $p22,$r23,$r24
    // free $p21
    if (($this->input[$this->currPos] ?? null) === "{") {
      $this->currPos++;
      $r20 = "{";
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(23); }
      $r20 = self::$FAILED;
    }
    $p21 = $this->currPos;
    // start seq_5
    $p22 = $this->currPos;
    $r24 = $param_preproc;
    $r23 = $param_th;
    // start seq_6
    $r25 = $this->parseraw_htmlentity(true);
    // rhe <- $r25
    if ($r25===self::$FAILED) {
      $r26 = self::$FAILED;
      goto seq_6;
    }
    $this->savedPos = $this->currPos;
    $r29 = $this->a109($r11, $r12, $r25);
    if ($r29) {
      $r29 = false;
    } else {
      $r29 = self::$FAILED;
      $this->currPos = $p22;
      $param_preproc = $r24;
      $param_th = $r23;
      $r26 = self::$FAILED;
      goto seq_6;
    }
    $r26 = true;
    seq_6:
    // free $r29
    if ($r26 === self::$FAILED) {
      $r26 = false;
    } else {
      $r26 = self::$FAILED;
      $this->currPos = $p22;
      $param_preproc = $r24;
      $param_th = $r23;
      $r20 = self::$FAILED;
      goto seq_5;
    }
    // start choice_3
    $p27 = $this->currPos;
    // start seq_7
    $p30 = $this->currPos;
    $r28 = $param_preproc;
    $r31 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r32 = true;
      $r32 = false;
      $this->currPos = $p30;
      $param_preproc = $r28;
      $param_th = $r31;
    } else {
      $r32 = self::$FAILED;
      $r29 = self::$FAILED;
      goto seq_7;
    }
    $r33 = $this->parsehtmlentity($silence);
    // he <- $r33
    if ($r33===self::$FAILED) {
      $this->currPos = $p30;
      $param_preproc = $r28;
      $param_th = $r31;
      $r29 = self::$FAILED;
      goto seq_7;
    }
    $r29 = true;
    seq_7:
    if ($r29!==self::$FAILED) {
      $this->savedPos = $p27;
      $r29 = $this->a7($r11, $r12, $r33);
      goto choice_3;
    }
    // free $r32
    // free $p30,$r28,$r31
    // free $p27
    if (($this->input[$this->currPos] ?? null) === "&") {
      $this->currPos++;
      $r29 = "&";
    } else {
      if (!$silence) { $this->fail(5); }
      $r29 = self::$FAILED;
    }
    choice_3:
    // r <- $r29
    if ($r29===self::$FAILED) {
      $this->currPos = $p22;
      $param_preproc = $r24;
      $param_th = $r23;
      $r20 = self::$FAILED;
      goto seq_5;
    }
    $r20 = true;
    seq_5:
    if ($r20!==self::$FAILED) {
      $this->savedPos = $p21;
      $r20 = $this->a8($r11, $r12, $r29);
    }
    // free $r26
    // free $p22,$r24,$r23
    // free $p21
    choice_2:
    // c <- $r20
    if ($r20===self::$FAILED) {
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r18;
      $r14 = self::$FAILED;
      goto seq_3;
    }
    $r14 = true;
    seq_3:
    if ($r14!==self::$FAILED) {
      $this->savedPos = $p15;
      $r14 = $this->a9($r11, $r12, $r20);
      $r13[] = $r14;
    } else {
      break;
    }
    // free $r19
    // free $p16,$r17,$r18
    // free $p15
  }
  // path <- $r13
  // free $r14
  $r6 = true;
  seq_2:
  // r <- $r6
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a110($r11, $r12, $r13);
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10
  // free $p7
  $this->savedPos = $this->currPos;
  $r10 = $this->a111($r6);
  if ($r10) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a112($r6);
  }
  // free $r5,$r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseautoref($silence) {
  $key = 348;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  // start choice_1
  $r3 = $this->parseRFC($silence);
  if ($r3!==self::$FAILED) {
    goto choice_1;
  }
  $r3 = $this->parsePMID($silence);
  choice_1:
  // ref <- $r3
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r4 = [];
  for (;;) {
    $r5 = $this->parsespace_or_nbsp($silence);
    if ($r5!==self::$FAILED) {
      $r4[] = $r5;
    } else {
      break;
    }
  }
  if (count($r4) === 0) {
    $r4 = self::$FAILED;
  }
  // sp <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r5
  $p6 = $this->currPos;
  $r5 = null;
  // identifier <- $r5
  if (preg_match("/[0-9]+/A", $this->input, $r5, 0, $this->currPos)) {
    $this->currPos += strlen($r5[0]);
    $r5 = true;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(43); }
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p6
  $r7 = $this->discardend_of_word();
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a113($r3, $r4, $r5);
  }
  // free $r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseisbn($silence) {
  $key = 350;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a114();
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "ISBN", $this->currPos, 4, false) === 0) {
    $r4 = true;
    $this->currPos += 4;
  } else {
    if (!$silence) { $this->fail(44); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r5 = [];
  for (;;) {
    $r6 = $this->parsespace_or_nbsp($silence);
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // sp <- $r5
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r6
  // start seq_2
  $p7 = $this->currPos;
  $r8 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[0-9]/A", $r8)) {
    $this->currPos++;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(43); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r9 = [];
  for (;;) {
    // start seq_3
    $p11 = $this->currPos;
    // start choice_1
    $r12 = $this->parsespace_or_nbsp_or_dash($silence);
    if ($r12!==self::$FAILED) {
      goto choice_1;
    }
    $r12 = '';
    choice_1:
    $r13 = $this->input[$this->currPos] ?? '';
    if (preg_match("/[0-9]/A", $r13)) {
      $this->currPos++;
    } else {
      $r13 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $this->currPos = $p11;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $r10 = [$r12,$r13];
    seq_3:
    if ($r10!==self::$FAILED) {
      $r9[] = $r10;
    } else {
      break;
    }
    // free $r12,$r13
    // free $p11
  }
  if (count($r9) === 0) {
    $r9 = self::$FAILED;
  }
  if ($r9===self::$FAILED) {
    $this->currPos = $p7;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // free $r10
  // start choice_2
  // start seq_4
  $p11 = $this->currPos;
  // start choice_3
  $r13 = $this->parsespace_or_nbsp_or_dash($silence);
  if ($r13!==self::$FAILED) {
    goto choice_3;
  }
  $r13 = '';
  choice_3:
  $r12 = $this->input[$this->currPos] ?? '';
  if ($r12 === "x" || $r12 === "X") {
    $this->currPos++;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(45); }
    $this->currPos = $p11;
    $r10 = self::$FAILED;
    goto seq_4;
  }
  $r10 = [$r13,$r12];
  seq_4:
  if ($r10!==self::$FAILED) {
    goto choice_2;
  }
  // free $r13,$r12
  // free $p11
  $r10 = '';
  choice_2:
  $r6 = [$r8,$r9,$r10];
  seq_2:
  // isbn <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r8,$r9,$r10
  // free $p7
  $p7 = $this->currPos;
  $r10 = $this->discardend_of_word();
  // isbncode <- $r10
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p7;
    $r10 = $this->a115($r5, $r6);
  } else {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  $this->savedPos = $this->currPos;
  $r9 = $this->a116($r5, $r6, $r10);
  if ($r9) {
    $r9 = false;
  } else {
    $r9 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a117($r5, $r6, $r10);
  }
  // free $r3,$r4,$r9
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardbehavior_text() {
  $key = 339;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = self::$FAILED;
  for (;;) {
    // start seq_1
    $p4 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r5 = true;
      $this->currPos += 2;
    } else {
      $r5 = self::$FAILED;
    }
    if ($r5 === self::$FAILED) {
      $r5 = false;
    } else {
      $r5 = self::$FAILED;
      $this->currPos = $p4;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    // start choice_1
    if (strcspn($this->input, "-'<[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
      self::advanceChar($this->input, $this->currPos);
      $r6 = true;
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
    }
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r6 = true;
    } else {
      $r6 = self::$FAILED;
    }
    choice_1:
    if ($r6===self::$FAILED) {
      $this->currPos = $p4;
      $r3 = self::$FAILED;
      goto seq_1;
    }
    $r3 = true;
    seq_1:
    if ($r3!==self::$FAILED) {
      $r2 = true;
    } else {
      break;
    }
    // free $r5,$r6
    // free $p4
  }
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsemaybe_extension_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([440, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardextension_check($param_tagType);
  if ($r5!==self::$FAILED) {
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsexmlish_tag($silence, $boolParams, "ext", $param_preproc, $param_th);
  // t <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a118($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc) {
  $key = json_encode([390, $boolParams & 0x1ffb, $param_tagType, $param_th, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  // start choice_1
  $r4 = $this->parselang_variant_preproc($silence, $boolParams & ~0x4, $param_tagType, self::newRef("}-"), $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsebroken_lang_variant($silence, $param_preproc);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsewikilink_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([422, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(29); }
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r6 = true;
  // spos <- $r6
  $this->savedPos = $p7;
  $r6 = $this->a15();
  // free $p7
  $r8 = $this->parsewikilink_preprocessor_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // target <- $r8
  $p7 = $this->currPos;
  $r9 = true;
  // tpos <- $r9
  $this->savedPos = $p7;
  $r9 = $this->a119($r6, $r8);
  // free $p7
  // start choice_1
  $p7 = $this->currPos;
  // start seq_2
  $p11 = $this->currPos;
  $r12 = $param_preproc;
  $r13 = $param_th;
  $r14 = $this->parsewikilink_content($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // l <- $r14
  $r15 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r15===self::$FAILED) {
    $this->currPos = $p11;
    $param_preproc = $r12;
    $param_th = $r13;
    $r10 = self::$FAILED;
    goto seq_2;
  }
  $r10 = true;
  seq_2:
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p7;
    $r10 = $this->a120($r6, $r8, $r9, $r14);
    goto choice_1;
  }
  // free $r15
  // free $p11,$r12,$r13
  // free $p7
  $p7 = $this->currPos;
  $r13 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // l <- $r13
  $r10 = $r13;
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p7;
    $r10 = $this->a121($r6, $r8, $r9, $r13);
  }
  // free $p7
  choice_1:
  // lcs <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(46); }
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a122($r6, $r8, $r9, $r10);
  }
  // free $r5,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsebroken_wikilink($silence, $boolParams, &$param_preproc, $param_tagType, &$param_th) {
  $key = json_encode([420, $boolParams & 0x1fff, $param_preproc, $param_tagType, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a123($param_preproc);
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r11 = "[";
  } else {
    if (!$silence) { $this->fail(18); }
    $r11 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  $r12 = $this->parseextlink($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r12!==self::$FAILED) {
    goto choice_1;
  }
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r12 = "[";
  } else {
    if (!$silence) { $this->fail(18); }
    $r12 = self::$FAILED;
  }
  choice_1:
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = [$r11,$r12];
  seq_2:
  // a <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r11,$r12
  // free $p8,$r9,$r10
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a124($param_preproc, $r7);
  }
  // free $r5,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardinclude_check($param_tagType) {
  $key = json_encode([529, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = $this->discardhtml_or_empty($param_tagType);
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsexmlish_start(true);
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a125($r4);
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsexmlish_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([454, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parsexmlish_start($silence);
  // start <- $r5
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a126($param_tagType, $r5);
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parsegeneric_newline_attributes($silence, $boolParams & ~0x50, $param_tagType, $param_preproc, $param_th);
  // attribs <- $r7
  for (;;) {
    $r9 = $this->discardspace_or_newline_or_solidus();
    if ($r9===self::$FAILED) {
      break;
    }
  }
  // free $r9
  $r8 = true;
  // free $r8
  if (($this->input[$this->currPos] ?? null) === "/") {
    $this->currPos++;
    $r8 = "/";
  } else {
    if (!$silence) { $this->fail(47); }
    $r8 = self::$FAILED;
    $r8 = null;
  }
  // selfclose <- $r8
  $r9 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r9;
  if (($this->input[$this->currPos] ?? null) === ">") {
    $this->currPos++;
    $r10 = true;
  } else {
    if (!$silence) { $this->fail(48); }
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a127($param_tagType, $r5, $r7, $r8);
  }
  // free $r6,$r9,$r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetvar_old_syntax_closing_HACK($silence, $param_tagType) {
  $key = json_encode([430, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a128($param_tagType);
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "</>", $this->currPos, 3, false) === 0) {
    $r4 = true;
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(49); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a129($param_tagType);
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a130($param_tagType);
  }
  // free $r3,$r4,$r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardannotation_check($param_tagType) {
  $key = json_encode([433, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a128($param_tagType);
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsexmlish_start(true);
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a131($param_tagType, $r4);
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardsol($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([583, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r5 = $this->a65();
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsesol_prefix(true);
  // sp <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parseempty_lines_with_comments(true);
  if ($r7===self::$FAILED) {
    $r7 = null;
  }
  // elc <- $r7
  $r8 = [];
  for (;;) {
    $r9 = $this->parsesol_transparent(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r9!==self::$FAILED) {
      $r8[] = $r9;
    } else {
      break;
    }
  }
  // st <- $r8
  // free $r9
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a66($r6, $r7, $r8);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_content_line($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([496, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parsetable_heading_tags($silence, $boolParams, $param_tagType, $param_preproc);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsetable_row_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsetable_data_tags($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  $r4 = $this->parsetable_caption_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_end_tag($silence) {
  $key = 518;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = $this->parsepipe($silence);
  // p <- $r3
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // b <- $r4
  if (($this->input[$this->currPos] ?? null) === "}") {
    $this->currPos++;
    $r4 = "}";
  } else {
    if (!$silence) { $this->fail(50); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a132($r3, $r4);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsenewline($silence) {
  $key = 560;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $this->currPos++;
    $r2 = "\x0a";
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(51); }
    $r2 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r2 = "\x0d\x0a";
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(52); }
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardnewlineToken() {
  $key = 563;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $this->discardnewline();
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a24();
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardspace_or_comment() {
  $key = 569;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->input[$this->currPos] ?? '';
  if ($r2 === " " || $r2 === "\x09") {
    $this->currPos++;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
  }
  $r2 = $this->discardcomment();
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsenested_inlineline($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([314, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // i <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a133($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetemplate_param_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([382, $boolParams & 0x1f8b, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->parsenested_block($silence, ($boolParams & ~0x54) | 0x20, $param_tagType, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    $r6 = $this->parsenewlineToken($silence);
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // il <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a134($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetemplate_param_name($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([378, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r4 = $this->parsetemplate_param_text($silence, $boolParams | 0x8, $param_tagType, $param_preproc, $param_th);
  if ($r4!==self::$FAILED) {
    goto choice_1;
  }
  if (($this->input[$this->currPos] ?? null) === "=") {
    $this->currPos++;
    $r4 = true;
    $r4 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $this->savedPos = $p1;
    $r4 = $this->a135();
  } else {
    $r4 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardwikilink_preproc($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([423, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r6 = true;
  // spos <- $r6
  $this->savedPos = $p7;
  $r6 = $this->a15();
  // free $p7
  $r8 = $this->parsewikilink_preprocessor_text(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // target <- $r8
  $p7 = $this->currPos;
  $r9 = true;
  // tpos <- $r9
  $this->savedPos = $p7;
  $r9 = $this->a119($r6, $r8);
  // free $p7
  // start choice_1
  $p7 = $this->currPos;
  // start seq_2
  $p11 = $this->currPos;
  $r12 = $param_preproc;
  $r13 = $param_th;
  $r14 = $this->parsewikilink_content(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  // l <- $r14
  $r15 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r15===self::$FAILED) {
    $this->currPos = $p11;
    $param_preproc = $r12;
    $param_th = $r13;
    $r10 = self::$FAILED;
    goto seq_2;
  }
  $r10 = true;
  seq_2:
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p7;
    $r10 = $this->a120($r6, $r8, $r9, $r14);
    goto choice_1;
  }
  // free $r15
  // free $p11,$r12,$r13
  // free $p7
  $p7 = $this->currPos;
  $r13 = $this->parseinlineline(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  // l <- $r13
  $r10 = $r13;
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p7;
    $r10 = $this->a121($r6, $r8, $r9, $r13);
  }
  // free $p7
  choice_1:
  // lcs <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $this->currPos += 2;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a122($r6, $r8, $r9, $r10);
  }
  // free $r5,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardbroken_wikilink($boolParams, &$param_preproc, $param_tagType, &$param_th) {
  $key = json_encode([421, $boolParams & 0x1fff, $param_preproc, $param_tagType, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a123($param_preproc);
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r11 = "[";
  } else {
    $r11 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  $r12 = $this->parseextlink(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r12!==self::$FAILED) {
    goto choice_1;
  }
  if (($this->input[$this->currPos] ?? null) === "[") {
    $this->currPos++;
    $r12 = "[";
  } else {
    $r12 = self::$FAILED;
  }
  choice_1:
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = [$r11,$r12];
  seq_2:
  // a <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r11,$r12
  // free $p8,$r9,$r10
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a124($param_preproc, $r7);
  }
  // free $r5,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardhtml_or_empty($param_tagType) {
  $key = json_encode([437, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a136($param_tagType);
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseRFC($silence) {
  $key = 344;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a137();
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "RFC", $this->currPos, 3, false) === 0) {
    $r4 = true;
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(53); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a138();
  }
  // free $r3,$r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsePMID($silence) {
  $key = 346;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a139();
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "PMID", $this->currPos, 4, false) === 0) {
    $r4 = true;
    $this->currPos += 4;
  } else {
    if (!$silence) { $this->fail(54); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a140();
  }
  // free $r3,$r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsespace_or_nbsp($silence) {
  $key = 576;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->input[$this->currPos] ?? '';
  if ($r2 === " " || $r2 === "\x09") {
    $this->currPos++;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
    if (!$silence) { $this->fail(6); }
  }
  if (preg_match("/[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r2, 0, $this->currPos)) {
    $r2 = $r2[0];
    $this->currPos += strlen($r2);
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
    if (!$silence) { $this->fail(55); }
  }
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "&") {
    $this->currPos++;
    $r3 = true;
    $r3 = false;
    $this->currPos = $p1;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsehtmlentity($silence);
  // he <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a141($r4);
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a55($r4);
  }
  // free $r3,$r5
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardend_of_word() {
  $key = 575;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->discardeof();
  if ($r2!==self::$FAILED) {
    goto choice_1;
  }
  $r2 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[A-Za-z0-9_]/A", $r2)) {
    $this->currPos++;
  } else {
    $r2 = self::$FAILED;
  }
  if ($r2 === self::$FAILED) {
    $r2 = false;
  } else {
    $r2 = self::$FAILED;
    $this->currPos = $p1;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsespace_or_nbsp_or_dash($silence) {
  $key = 578;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  $r2 = $this->parsespace_or_nbsp($silence);
  if ($r2!==self::$FAILED) {
    goto choice_1;
  }
  if (($this->input[$this->currPos] ?? null) === "-") {
    $this->currPos++;
    $r2 = "-";
  } else {
    if (!$silence) { $this->fail(35); }
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardextension_check($param_tagType) {
  $key = json_encode([439, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = $this->discardhtml_or_empty($param_tagType);
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsexmlish_start(true);
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a142($r4);
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parselang_variant_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([392, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  // lv0 <- $r5
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r5 = true;
    $this->currPos += 2;
    $this->savedPos = $p1;
    $r5 = $this->a143();
  } else {
    if (!$silence) { $this->fail(56); }
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $this->savedPos = $this->currPos;
  $r11 = $this->a144($r5);
  if ($r11) {
    $r11 = false;
  } else {
    $r11 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r12 = $this->parseopt_lang_variant_flags($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // ff <- $r12
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a145($r5, $r12);
    goto choice_1;
  }
  // free $r11
  // free $p8,$r9,$r10
  // free $p7
  $p7 = $this->currPos;
  // start seq_3
  $p8 = $this->currPos;
  $r10 = $param_preproc;
  $r9 = $param_th;
  $this->savedPos = $this->currPos;
  $r11 = $this->a146($r5);
  if ($r11) {
    $r11 = false;
  } else {
    $r11 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_3;
  }
  $r6 = true;
  seq_3:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p7;
    $r6 = $this->a147($r5);
  }
  // free $r11
  // free $p8,$r10,$r9
  // free $p7
  choice_1:
  // f <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // start choice_2
  $p7 = $this->currPos;
  // start seq_4
  $p8 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $this->savedPos = $this->currPos;
  $r13 = $this->a148($r5, $r6);
  if ($r13) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $r9 = self::$FAILED;
    goto seq_4;
  }
  $r14 = $this->parselang_variant_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // lv <- $r14
  $r9 = true;
  seq_4:
  if ($r9!==self::$FAILED) {
    $this->savedPos = $p7;
    $r9 = $this->a149($r5, $r6, $r14);
    goto choice_2;
  }
  // free $r13
  // free $p8,$r10,$r11
  // free $p7
  $p7 = $this->currPos;
  // start seq_5
  $p8 = $this->currPos;
  $r11 = $param_preproc;
  $r10 = $param_th;
  $this->savedPos = $this->currPos;
  $r13 = $this->a150($r5, $r6);
  if ($r13) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $r9 = self::$FAILED;
    goto seq_5;
  }
  $r15 = $this->parselang_variant_option_list($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // lv <- $r15
  $r9 = true;
  seq_5:
  if ($r9!==self::$FAILED) {
    $this->savedPos = $p7;
    $r9 = $this->a151($r5, $r6, $r15);
  }
  // free $r13
  // free $p8,$r11,$r10
  // free $p7
  choice_2:
  // ts <- $r9
  if ($r9===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r10 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // lv1 <- $r11
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}-", $this->currPos, 2, false) === 0) {
    $r11 = true;
    $this->currPos += 2;
    $this->savedPos = $p7;
    $r11 = $this->a152($r5, $r6, $r9);
  } else {
    if (!$silence) { $this->fail(57); }
    $r11 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a153($r5, $r6, $r9, $r11);
  }
  // free $r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsebroken_lang_variant($silence, &$param_preproc) {
  $key = json_encode([388, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  // start seq_1
  // r <- $r4
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r4 = "-{";
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(56); }
    $r4 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $this->savedPos = $p1;
    $r3 = $this->a154($r4, $param_preproc);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsewikilink_preprocessor_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([534, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "<[{\x0a\x0d\x09|!]}{ &-", $this->currPos);
    // t <- $r7
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(58); }
      $r7 = self::$FAILED;
    }
    // free $p8
    $r6 = $r7;
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    $p8 = $this->currPos;
    // start seq_1
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r13 = $this->discardpipe();
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // free $p14,$r15,$r16
    // start choice_2
    $r16 = $this->parsedirective($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r16!==self::$FAILED) {
      goto choice_2;
    }
    $p14 = $this->currPos;
    // start seq_2
    $p17 = $this->currPos;
    $r15 = $param_preproc;
    $r18 = $param_th;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r19 = true;
      $this->currPos += 2;
    } else {
      $r19 = self::$FAILED;
    }
    if ($r19 === self::$FAILED) {
      $r19 = false;
    } else {
      $r19 = self::$FAILED;
      $this->currPos = $p17;
      $param_preproc = $r15;
      $param_th = $r18;
      $r16 = self::$FAILED;
      goto seq_2;
    }
    // start choice_3
    if (strcspn($this->input, "-'<[{\x0a\x0d:;]}|!=", $this->currPos, 1) !== 0) {
      self::advanceChar($this->input, $this->currPos);
      $r20 = true;
      goto choice_3;
    } else {
      $r20 = self::$FAILED;
      if (!$silence) { $this->fail(28); }
    }
    if (strspn($this->input, "!<-}]\x0a\x0d", $this->currPos, 1) !== 0) {
      $this->currPos++;
      $r20 = true;
    } else {
      $r20 = self::$FAILED;
      if (!$silence) { $this->fail(59); }
    }
    choice_3:
    if ($r20===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r15;
      $param_th = $r18;
      $r16 = self::$FAILED;
      goto seq_2;
    }
    $r16 = true;
    seq_2:
    if ($r16!==self::$FAILED) {
      $r16 = substr($this->input, $p14, $this->currPos - $p14);
    } else {
      $r16 = self::$FAILED;
    }
    // free $r19,$r20
    // free $p17,$r15,$r18
    // free $p14
    choice_2:
    // wr <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p8;
      $r6 = $this->a155($r7, $r16);
    }
    // free $r12,$r13
    // free $p9,$r10,$r11
    // free $p8
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // r <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a50($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsewikilink_content($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([416, $boolParams & 0x1df7, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = [];
  for (;;) {
    $p6 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $r10 = $this->parsepipe($silence);
    // p <- $r10
    if ($r10===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $p12 = $this->currPos;
    $r11 = true;
    // startPos <- $r11
    $this->savedPos = $p12;
    $r11 = $this->a156($r10);
    // free $p12
    $r13 = $this->parselink_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r13===self::$FAILED) {
      $r13 = null;
    }
    // lt <- $r13
    $r5 = true;
    seq_1:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a157($r10, $r11, $r13);
      $r4[] = $r5;
    } else {
      break;
    }
    // free $p7,$r8,$r9
    // free $p6
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsexmlish_start($silence) {
  $key = 452;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "<") {
    $this->currPos++;
    $r3 = true;
  } else {
    if (!$silence) { $this->fail(60); }
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "/") {
    $this->currPos++;
    $r4 = "/";
  } else {
    if (!$silence) { $this->fail(47); }
    $r4 = self::$FAILED;
    $r4 = null;
  }
  // end <- $r4
  $p6 = $this->currPos;
  $r5 = strcspn($this->input, "\x09\x0a\x0b />\x00", $this->currPos);
  // name <- $r5
  if ($r5 > 0) {
    $this->currPos += $r5;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(61); }
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p6
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a158($r4, $r5);
  }
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_heading_tags($silence, $boolParams, $param_tagType, &$param_preproc) {
  $key = json_encode([504, $boolParams & 0x1fff, $param_tagType, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $this->parsetable_heading_tags_parameterized($silence, $boolParams, $param_tagType, $param_preproc, self::newRef(true));
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsetable_row_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([502, $boolParams & 0x1fef, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsepipe($silence);
  // p <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  $r7 = self::$FAILED;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "-") {
      $this->currPos++;
      $r9 = true;
      $r7 = true;
    } else {
      if (!$silence) { $this->fail(35); }
      $r9 = self::$FAILED;
      break;
    }
  }
  // dashes <- $r7
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p8, $this->currPos - $p8);
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r9
  // free $p8
  // start choice_1
  $r9 = $this->parsetable_attributes($silence, $boolParams & ~0x10, $param_tagType, $param_preproc, $param_th);
  if ($r9!==self::$FAILED) {
    goto choice_1;
  }
  $this->savedPos = $this->currPos;
  $r9 = $this->a159($r6, $r7);
  if ($r9) {
    $r9 = false;
  } else {
    $r9 = self::$FAILED;
  }
  choice_1:
  // a <- $r9
  $p8 = $this->currPos;
  $r10 = true;
  // tagEndPos <- $r10
  $this->savedPos = $p8;
  $r10 = $this->a160($r6, $r7, $r9);
  // free $p8
  $r11 = strspn($this->input, " \x09", $this->currPos);
  // s2 <- $r11
  $this->currPos += $r11;
  $r11 = substr($this->input, $this->currPos - $r11, $r11);
  $r11 = mb_str_split($r11, 1, "utf-8");
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a161($r6, $r7, $r9, $r10, $r11);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_data_tags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([512, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsepipe($silence);
  // p <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
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
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10
  $r10 = $this->parsetable_data_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // td <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r9 = $this->parsetds($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // tds <- $r9
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a162($r6, $r10, $r9);
  }
  // free $r5,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_caption_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([500, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsepipe($silence);
  // p <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "+") {
    $this->currPos++;
    $r7 = true;
  } else {
    if (!$silence) { $this->fail(62); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r8 = $this->parserow_syntax_table_args($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // args <- $r8
  $p10 = $this->currPos;
  $r9 = true;
  // tagEndPos <- $r9
  $this->savedPos = $p10;
  $r9 = $this->a163($r6, $r8);
  // free $p10
  $r11 = [];
  for (;;) {
    $r12 = $this->parsenested_block_in_table($silence, $boolParams | 0x1000, $param_tagType, $param_preproc, $param_th);
    if ($r12!==self::$FAILED) {
      $r11[] = $r12;
    } else {
      break;
    }
  }
  // c <- $r11
  // free $r12
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a164($r6, $r8, $r9, $r11);
  }
  // free $r5,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardcomment() {
  $key = 567;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "<!--", $this->currPos, 4, false) === 0) {
    $r3 = true;
    $this->currPos += 4;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $p5 = $this->currPos;
  for (;;) {
    // start seq_2
    $p7 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r8 = true;
      $this->currPos += 3;
    } else {
      $r8 = self::$FAILED;
    }
    if ($r8 === self::$FAILED) {
      $r8 = false;
    } else {
      $r8 = self::$FAILED;
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    if ($this->currPos < $this->inputLength) {
      self::advanceChar($this->input, $this->currPos);;
      $r9 = true;
    } else {
      $r9 = self::$FAILED;
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6===self::$FAILED) {
      break;
    }
    // free $r8,$r9
    // free $p7
  }
  // free $r6
  $r4 = true;
  // c <- $r4
  if ($r4!==self::$FAILED) {
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r4 = self::$FAILED;
  }
  // free $p5
  $p5 = $this->currPos;
  // start choice_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
    $r6 = true;
    $this->currPos += 3;
    goto choice_1;
  } else {
    $r6 = self::$FAILED;
  }
  $r6 = $this->discardeof();
  choice_1:
  // cEnd <- $r6
  if ($r6!==self::$FAILED) {
    $r6 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a28($r4, $r6);
  }
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsenested_block($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([310, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseblock($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
  // b <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a13($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseopt_lang_variant_flags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([394, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r6 = $this->parselang_variant_flags($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // ff <- $r6
  if (($this->input[$this->currPos] ?? null) === "|") {
    $this->currPos++;
    $r7 = true;
  } else {
    if (!$silence) { $this->fail(12); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a165($r6);
  } else {
    $r5 = null;
  }
  // free $r7
  // f <- $r5
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a166($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([410, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r6 = "|";
    } else {
      if (!$silence) { $this->fail(12); }
      $r6 = self::$FAILED;
    }
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // tokens <- $r5
  // free $r6
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a167($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_option_list($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([402, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  $r5 = $this->parselang_variant_option($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // o <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = [];
  for (;;) {
    $p8 = $this->currPos;
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r12 = true;
    } else {
      if (!$silence) { $this->fail(25); }
      $r12 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r13 = $this->parselang_variant_option($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    // oo <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = true;
    seq_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a168($r5, $r13);
      $r6[] = $r7;
    } else {
      break;
    }
    // free $r12
    // free $p9,$r10,$r11
    // free $p8
  }
  // rest <- $r6
  // free $r7
  $r7 = [];
  for (;;) {
    // start seq_3
    $p8 = $this->currPos;
    $r10 = $param_preproc;
    $r12 = $param_th;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $this->currPos++;
      $r14 = ";";
    } else {
      if (!$silence) { $this->fail(25); }
      $r14 = self::$FAILED;
      $r11 = self::$FAILED;
      goto seq_3;
    }
    $p9 = $this->currPos;
    $r15 = $this->discardbogus_lang_variant_option($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r15!==self::$FAILED) {
      $r15 = substr($this->input, $p9, $this->currPos - $p9);
    } else {
      $r15 = self::$FAILED;
    }
    // free $p9
    $r11 = [$r14,$r15];
    seq_3:
    if ($r11!==self::$FAILED) {
      $r7[] = $r11;
    } else {
      break;
    }
    // free $r14,$r15
    // free $p8,$r10,$r12
  }
  // tr <- $r7
  // free $r11
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a169($r5, $r6, $r7);
    goto choice_1;
  }
  $r11 = $this->parselang_variant_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // lvtext <- $r11
  $r4 = $r11;
  $this->savedPos = $p1;
  $r4 = $this->a170($r11);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselink_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([424, $boolParams & 0x1df7, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->parselink_text_parameterized($silence, ($boolParams & ~0x8) | 0x200, $param_tagType, $param_preproc, $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_heading_tags_parameterized($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([506, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "!") {
    $this->currPos++;
    $r5 = true;
  } else {
    if (!$silence) { $this->fail(63); }
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsetable_heading_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // thTag <- $r6
  $r7 = $this->parseths($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // thTags <- $r7
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a171($r6, $r7);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_data_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([514, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "}") {
    $this->currPos++;
    $r5 = true;
  } else {
    $r5 = self::$FAILED;
  }
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parserow_syntax_table_args($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6===self::$FAILED) {
    $r6 = null;
  }
  // arg <- $r6
  $p8 = $this->currPos;
  $r7 = true;
  // tagEndPos <- $r7
  $this->savedPos = $p8;
  $r7 = $this->a172($r6);
  // free $p8
  $r9 = [];
  for (;;) {
    $r10 = $this->parsenested_block_in_table($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      $r9[] = $r10;
    } else {
      break;
    }
  }
  // td <- $r9
  // free $r10
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a173($r6, $r7, $r9);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetds($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([516, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = [];
  for (;;) {
    $p6 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $r10 = $this->parsepipe_pipe($silence);
    // pp <- $r10
    if ($r10===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $r11 = $this->parsetable_data_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    // tdt <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $r5 = true;
    seq_1:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a174($r10, $r11);
      $r4[] = $r5;
    } else {
      break;
    }
    // free $p7,$r8,$r9
    // free $p6
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsenested_block_in_table($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([312, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardinline_breaks($boolParams | 0x1, $param_tagType, $param_preproc, $param_th);
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  // start seq_2
  $r10 = $this->discardsol($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r10===self::$FAILED) {
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start seq_3
  $p12 = $this->currPos;
  $r13 = $param_preproc;
  $r14 = $param_th;
  $r15 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r15;
  $r16 = $this->discardsol($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r16===self::$FAILED) {
    $this->currPos = $p12;
    $param_preproc = $r13;
    $param_th = $r14;
    $r11 = self::$FAILED;
    goto seq_3;
  }
  $r11 = true;
  seq_3:
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // free $r15,$r16
  // free $p12,$r13,$r14
  $r14 = strspn($this->input, " \x09", $this->currPos);
  $this->currPos += $r14;
  // start choice_1
  $r13 = $this->discardpipe();
  if ($r13!==self::$FAILED) {
    goto choice_1;
  }
  if (($this->input[$this->currPos] ?? null) === "!") {
    $this->currPos++;
    $r13 = true;
  } else {
    $r13 = self::$FAILED;
  }
  choice_1:
  if ($r13===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  // free $r10,$r11,$r14,$r13
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r8,$r9
  $r9 = $this->parsenested_block($silence, $boolParams | 0x1, $param_tagType, $param_preproc, $param_th);
  // b <- $r9
  if ($r9===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a175($r9);
  }
  // free $r5,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_flags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([396, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  $p6 = $this->currPos;
  $r5 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp1 <- $r5
  $this->currPos += $r5;
  $r5 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  $r7 = $this->parselang_variant_flag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // f <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p6 = $this->currPos;
  $r8 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp2 <- $r8
  $this->currPos += $r8;
  $r8 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  // start seq_2
  $p6 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  if (($this->input[$this->currPos] ?? null) === ";") {
    $this->currPos++;
    $r12 = ";";
  } else {
    if (!$silence) { $this->fail(25); }
    $r12 = self::$FAILED;
    $r9 = self::$FAILED;
    goto seq_2;
  }
  $r13 = $this->parselang_variant_flags($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  $r9 = [$r12,$r13];
  seq_2:
  if ($r9===self::$FAILED) {
    $r9 = null;
  }
  // free $r12,$r13
  // free $p6,$r10,$r11
  // more <- $r9
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a176($r5, $r7, $r8, $r9);
    goto choice_1;
  }
  $p6 = $this->currPos;
  $r11 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp <- $r11
  $this->currPos += $r11;
  $r11 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  $r4 = $r11;
  $this->savedPos = $p1;
  $r4 = $this->a177($r11);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_option($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([406, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  // start seq_1
  $p6 = $this->currPos;
  $r5 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp1 <- $r5
  $this->currPos += $r5;
  $r5 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  $r7 = $this->parselang_variant_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // lang <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p6 = $this->currPos;
  $r8 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp2 <- $r8
  $this->currPos += $r8;
  $r8 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  if (($this->input[$this->currPos] ?? null) === ":") {
    $this->currPos++;
    $r9 = true;
  } else {
    if (!$silence) { $this->fail(17); }
    $r9 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p6 = $this->currPos;
  $r10 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp3 <- $r10
  $this->currPos += $r10;
  $r10 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  // start choice_2
  $r11 = $this->parselang_variant_nowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r11!==self::$FAILED) {
    goto choice_2;
  }
  $r11 = $this->parselang_variant_text_no_semi($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_2:
  // lvtext <- $r11
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a178($r5, $r7, $r8, $r10, $r11);
    goto choice_1;
  }
  // free $r9
  // start seq_2
  $p6 = $this->currPos;
  $r9 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp1 <- $r9
  $this->currPos += $r9;
  $r9 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  // start choice_3
  $r12 = $this->parselang_variant_nowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r12!==self::$FAILED) {
    goto choice_3;
  }
  $r12 = $this->parselang_variant_text_no_semi_or_arrow($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_3:
  // from <- $r12
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "=>", $this->currPos, 2, false) === 0) {
    $r13 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(64); }
    $r13 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $p6 = $this->currPos;
  $r14 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp2 <- $r14
  $this->currPos += $r14;
  $r14 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  $r15 = $this->parselang_variant_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // lang <- $r15
  if ($r15===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $p6 = $this->currPos;
  $r16 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp3 <- $r16
  $this->currPos += $r16;
  $r16 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  if (($this->input[$this->currPos] ?? null) === ":") {
    $this->currPos++;
    $r17 = true;
  } else {
    if (!$silence) { $this->fail(17); }
    $r17 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $p6 = $this->currPos;
  $r18 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp4 <- $r18
  $this->currPos += $r18;
  $r18 = substr($this->input, $p6, $this->currPos - $p6);
  // free $p6
  // start choice_4
  $r19 = $this->parselang_variant_nowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r19!==self::$FAILED) {
    goto choice_4;
  }
  $r19 = $this->parselang_variant_text_no_semi($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_4:
  // to <- $r19
  $r4 = true;
  seq_2:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a179($r9, $r12, $r14, $r15, $r16, $r18, $r19);
  }
  // free $r13,$r17
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardbogus_lang_variant_option($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([405, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->discardlang_variant_text($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r4===self::$FAILED) {
    $r4 = null;
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselink_text_parameterized($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([426, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $r10 = $this->parsesol($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r10===self::$FAILED) {
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    $r11 = $this->parseheading($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $r11 = $this->parsehr($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    $r11 = $this->parsefull_table_in_link_caption($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    choice_2:
    if ($r11===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = [$r10,$r11];
    seq_1:
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    // free $r10,$r11
    // free $p7,$r8,$r9
    $r6 = $this->parseurltext($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    $p7 = $this->currPos;
    // start seq_2
    $p12 = $this->currPos;
    $r9 = $param_preproc;
    $r8 = $param_th;
    $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r11 === self::$FAILED) {
      $r11 = false;
    } else {
      $r11 = self::$FAILED;
      $this->currPos = $p12;
      $param_preproc = $r9;
      $param_th = $r8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // start choice_3
    $r10 = $this->parseinline_element($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r10!==self::$FAILED) {
      goto choice_3;
    }
    // start seq_3
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $this->currPos++;
      $r16 = "[";
    } else {
      if (!$silence) { $this->fail(18); }
      $r16 = self::$FAILED;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $r17 = strcspn($this->input, "-'<[{\x0a\x0d:;]}|!=", $this->currPos);
    if ($r17 > 0) {
      $this->currPos += $r17;
      $r17 = substr($this->input, $this->currPos - $r17, $r17);
      $r17 = mb_str_split($r17, 1, "utf-8");
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(28); }
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    if (($this->input[$this->currPos] ?? null) === "]") {
      $this->currPos++;
      $r18 = "]";
    } else {
      if (!$silence) { $this->fail(20); }
      $r18 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $p19 = $this->currPos;
    $p21 = $this->currPos;
    $r22 = $param_preproc;
    $r23 = $param_th;
    // start choice_4
    if (($this->input[$this->currPos] ?? null) === "]") {
      $this->currPos++;
      $r20 = true;
    } else {
      $r20 = self::$FAILED;
    }
    if ($r20 === self::$FAILED) {
      $r20 = false;
      goto choice_4;
    } else {
      $r20 = self::$FAILED;
      $this->currPos = $p21;
      $param_preproc = $r22;
      $param_th = $r23;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r20 = true;
      $this->currPos += 2;
    } else {
      $r20 = self::$FAILED;
    }
    choice_4:
    if ($r20!==self::$FAILED) {
      $r20 = false;
      $this->currPos = $p21;
      $param_preproc = $r22;
      $param_th = $r23;
      $r20 = substr($this->input, $p19, $this->currPos - $p19);
    } else {
      $r20 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    // free $p21,$r22,$r23
    // free $p19
    $r10 = [$r16,$r17,$r18,$r20];
    seq_3:
    if ($r10!==self::$FAILED) {
      goto choice_3;
    }
    // free $r16,$r17,$r18,$r20
    // free $p13,$r14,$r15
    if ($this->currPos < $this->inputLength) {
      $r10 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r10 = self::$FAILED;
      if (!$silence) { $this->fail(9); }
    }
    choice_3:
    // r <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p12;
      $param_preproc = $r9;
      $param_th = $r8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a22($r10);
    }
    // free $r11
    // free $p12,$r9,$r8
    // free $p7
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  if (count($r5) === 0) {
    $r5 = self::$FAILED;
  }
  // c <- $r5
  // free $r6
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a38($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_heading_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([508, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parserow_syntax_table_args($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r5===self::$FAILED) {
    $r5 = null;
  }
  // arg <- $r5
  $p7 = $this->currPos;
  $r6 = true;
  // tagEndPos <- $r6
  $this->savedPos = $p7;
  $r6 = $this->a172($r5);
  // free $p7
  $r8 = [];
  for (;;) {
    $p7 = $this->currPos;
    // start seq_2
    $p10 = $this->currPos;
    $r11 = $param_preproc;
    $r12 = $param_th;
    $r13 = $this->parsenested_block_in_table($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    // d <- $r13
    if ($r13===self::$FAILED) {
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r9 = self::$FAILED;
      goto seq_2;
    }
    $r9 = true;
    seq_2:
    if ($r9!==self::$FAILED) {
      $this->savedPos = $p7;
      $r9 = $this->a180($r5, $r6, $param_th, $r13);
      $r8[] = $r9;
    } else {
      break;
    }
    // free $p10,$r11,$r12
    // free $p7
  }
  // c <- $r8
  // free $r9
  $r4 = true;
  seq_1:
  $this->savedPos = $p1;
  $r4 = $this->a181($r5, $r6, $r8);
  // free $p1,$r2,$r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseths($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([510, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = [];
  for (;;) {
    $p6 = $this->currPos;
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
      $r10 = "!!";
      $this->currPos += 2;
      goto choice_1;
    } else {
      if (!$silence) { $this->fail(65); }
      $r10 = self::$FAILED;
    }
    $r10 = $this->parsepipe_pipe($silence);
    choice_1:
    // pp <- $r10
    if ($r10===self::$FAILED) {
      $r5 = self::$FAILED;
      goto seq_1;
    }
    $r11 = $this->parsetable_heading_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
    // tht <- $r11
    $r5 = true;
    seq_1:
    if ($r5!==self::$FAILED) {
      $this->savedPos = $p6;
      $r5 = $this->a182($r10, $r11);
      $r4[] = $r5;
    } else {
      break;
    }
    // free $p7,$r8,$r9
    // free $p6
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsepipe_pipe($silence) {
  $key = 554;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "||", $this->currPos, 2, false) === 0) {
    $r2 = "||";
    $this->currPos += 2;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(66); }
    $r2 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}{{!}}", $this->currPos, 10, false) === 0) {
    $r2 = "{{!}}{{!}}";
    $this->currPos += 10;
  } else {
    if (!$silence) { $this->fail(67); }
    $r2 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parselang_variant_flag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([398, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $r5 = $this->input[$this->currPos] ?? '';
  // f <- $r5
  if (preg_match("/[\\-+A-Z]/A", $r5)) {
    $this->currPos++;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(68); }
  }
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a183($r5);
    goto choice_1;
  }
  $r6 = $this->parselang_variant_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // v <- $r6
  $r4 = $r6;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a184($r6);
    goto choice_1;
  }
  $p8 = $this->currPos;
  $r7 = self::$FAILED;
  for (;;) {
    // start seq_1
    $p10 = $this->currPos;
    $r11 = $param_preproc;
    $r12 = $param_th;
    if (strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos, 1) !== 0) {
      $this->currPos++;
      $r13 = true;
    } else {
      $r13 = self::$FAILED;
    }
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r9 = self::$FAILED;
      goto seq_1;
    }
    $p15 = $this->currPos;
    $r16 = $param_preproc;
    $r17 = $param_th;
    $r14 = $this->discardnowiki($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r14 === self::$FAILED) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p15;
      $param_preproc = $r16;
      $param_th = $r17;
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r9 = self::$FAILED;
      goto seq_1;
    }
    // free $p15,$r16,$r17
    if (strcspn($this->input, "{}|;", $this->currPos, 1) !== 0) {
      self::advanceChar($this->input, $this->currPos);
      $r17 = true;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(69); }
      $this->currPos = $p10;
      $param_preproc = $r11;
      $param_th = $r12;
      $r9 = self::$FAILED;
      goto seq_1;
    }
    $r9 = true;
    seq_1:
    if ($r9!==self::$FAILED) {
      $r7 = true;
    } else {
      break;
    }
    // free $r13,$r14,$r17
    // free $p10,$r11,$r12
  }
  // b <- $r7
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p8, $this->currPos - $p8);
  } else {
    $r7 = self::$FAILED;
  }
  // free $r9
  // free $p8
  $r4 = $r7;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a185($r7);
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_name($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([400, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start choice_1
  $p5 = $this->currPos;
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[a-z]/A", $r6)) {
    $this->currPos++;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(70); }
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = null;
  if (preg_match("/[\\-a-zA-Z]+/A", $this->input, $r7, 0, $this->currPos)) {
    $this->currPos += strlen($r7[0]);
    $r7 = true;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(71); }
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $r4 = substr($this->input, $p5, $this->currPos - $p5);
    goto choice_1;
  } else {
    $r4 = self::$FAILED;
  }
  // free $r6,$r7
  // free $p5
  $r4 = $this->parsenowiki_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_nowiki($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([408, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parsenowiki_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // n <- $r5
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r6 = strspn($this->input, " \x09\x0a\x0d\x0c", $this->currPos);
  // sp <- $r6
  $this->currPos += $r6;
  $r6 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a186($r5, $r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_text_no_semi($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([412, $boolParams & 0x1f7f, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->parselang_variant_text($silence, $boolParams | 0x80, $param_tagType, $param_preproc, $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parselang_variant_text_no_semi_or_arrow($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([414, $boolParams & 0x1e7f, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $this->parselang_variant_text_no_semi($silence, $boolParams | 0x100, $param_tagType, $param_preproc, $param_th);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardlang_variant_text($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([411, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->parseinlineline(true, $boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $this->currPos++;
      $r6 = "|";
    } else {
      $r6 = self::$FAILED;
    }
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // tokens <- $r5
  // free $r6
  $r4 = $r5;
  $this->savedPos = $p1;
  $r4 = $this->a167($r5);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsefull_table_in_link_caption($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([488, $boolParams & 0x17fe, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r5 === self::$FAILED) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parseembedded_full_table($silence, ($boolParams & ~0x201) | 0x810, $param_tagType, $param_preproc, $param_th);
  // r <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a187($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardnowiki($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([447, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardnowiki_check($param_tagType);
  if ($r5!==self::$FAILED) {
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsewellformed_extension_tag(true, $boolParams, $param_tagType, $param_preproc, $param_th);
  // ext <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a188($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsenowiki_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([448, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r5 = $this->parsenowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // extToken <- $r5
  $r4 = $r5;
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a189($r5);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseembedded_full_table($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([492, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = [];
  for (;;) {
    $r6 = $this->parsespace_or_comment($silence);
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // free $r6
  $r6 = $this->parsetable_start_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = [];
    for (;;) {
      // start seq_3
      $p14 = $this->currPos;
      $r15 = $param_preproc;
      $r16 = $param_th;
      $r17 = [];
      for (;;) {
        $r18 = $this->parseembedded_full_table_line_prefix($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
        if ($r18!==self::$FAILED) {
          $r17[] = $r18;
        } else {
          break;
        }
      }
      if (count($r17) === 0) {
        $r17 = self::$FAILED;
      }
      if ($r17===self::$FAILED) {
        $r13 = self::$FAILED;
        goto seq_3;
      }
      // free $r18
      // start choice_1
      $r18 = $this->parsetable_content_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
      if ($r18!==self::$FAILED) {
        goto choice_1;
      }
      $r18 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc);
      choice_1:
      if ($r18===self::$FAILED) {
        $this->currPos = $p14;
        $param_preproc = $r15;
        $param_th = $r16;
        $r13 = self::$FAILED;
        goto seq_3;
      }
      $r13 = [$r17,$r18];
      seq_3:
      if ($r13!==self::$FAILED) {
        $r12[] = $r13;
      } else {
        break;
      }
      // free $r17,$r18
      // free $p14,$r15,$r16
    }
    // free $r13
    $r13 = [];
    for (;;) {
      $r16 = $this->parseembedded_full_table_line_prefix($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
      if ($r16!==self::$FAILED) {
        $r13[] = $r16;
      } else {
        break;
      }
    }
    if (count($r13) === 0) {
      $r13 = self::$FAILED;
    }
    if ($r13===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    // free $r16
    $r16 = $this->parsetable_end_tag($silence);
    if ($r16===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = [$r12,$r13,$r16];
    seq_2:
    if ($r8!==self::$FAILED) {
      $r7[] = $r8;
    } else {
      break;
    }
    // free $r12,$r13,$r16
    // free $p9,$r10,$r11
  }
  if (count($r7) === 0) {
    $r7 = self::$FAILED;
  }
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  // free $r8
  $r4 = [$r5,$r6,$r7];
  seq_1:
  // free $r5,$r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function discardnowiki_check($param_tagType) {
  $key = json_encode([445, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = $this->discardhtml_or_empty($param_tagType);
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsexmlish_start(true);
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a190($r4);
  if ($r5) {
    $r5 = false;
  } else {
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsenowiki($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([446, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->discardnowiki_check($param_tagType);
  if ($r5!==self::$FAILED) {
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
  } else {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsewellformed_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  // ext <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = true;
  seq_1:
  if ($r4!==self::$FAILED) {
    $this->savedPos = $p1;
    $r4 = $this->a188($r6);
  }
  // free $r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseembedded_full_table_line_prefix($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th) {
  $key = json_encode([490, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  // start seq_1
  $r5 = $this->parsesol($silence, $boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r5===self::$FAILED) {
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r6 = [];
  for (;;) {
    $r7 = $this->parsespace_or_comment($silence);
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // free $r7
  $r4 = [$r5,$r6];
  seq_1:
  // free $r5,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}

	public function parse( $input, $options = [] ) {
		$this->initInternal( $input, $options );
		$startRule = $options['startRule'] ?? '(DEFAULT)';
		$result = null;

		if ( !empty( $options['stream'] ) ) {
			switch ( $startRule ) {
				case '(DEFAULT)':
case "start_async":
  return $this->streamstart_async(false, self::newRef(null), self::newRef(null));
  break;
			default:
				throw new \Wikimedia\WikiPEG\InternalError( "Can't stream rule $startRule." );
			}
		} else {
			switch ( $startRule ) {
				case '(DEFAULT)':
case "start":
  $result = $this->parsestart(false, self::newRef(null), self::newRef(null));
  break;

case "table_start_tag":
  $result = $this->parsetable_start_tag(false, 0, "", self::newRef(null), self::newRef(null));
  break;

case "url":
  $result = $this->parseurl(false, self::newRef(null), self::newRef(null));
  break;

case "row_syntax_table_args":
  $result = $this->parserow_syntax_table_args(false, 0, "", self::newRef(null), self::newRef(null));
  break;

case "table_attributes":
  $result = $this->parsetable_attributes(false, 0, "", self::newRef(null), self::newRef(null));
  break;

case "generic_newline_attributes":
  $result = $this->parsegeneric_newline_attributes(false, 0, "", self::newRef(null), self::newRef(null));
  break;

case "tplarg_or_template_or_bust":
  $result = $this->parsetplarg_or_template_or_bust(false, self::newRef(null), self::newRef(null));
  break;

case "extlink":
  $result = $this->parseextlink(false, 0, "", self::newRef(null), self::newRef(null));
  break;

case "list_item":
  $result = $this->parselist_item(false, 0, "", self::newRef(null), self::newRef(null));
  break;
			default:
				throw new \Wikimedia\WikiPEG\InternalError( "Can't start parsing from rule $startRule." );
			}
		}

		if ( $result !== self::$FAILED && $this->currPos === $this->inputLength ) {
			return $result;
		} else {
			if ( $result !== self::$FAILED && $this->currPos < $this->inputLength ) {
				$this->fail( 0 );
			}
			throw $this->buildParseException();
		}
	}
}
