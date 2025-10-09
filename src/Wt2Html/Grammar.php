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
	public $headingIndex;
	public $preproc;
	public $th;


	public function __construct( $nextPos, $result, $headingIndex, $preproc, $th ) {
		$this->nextPos = $nextPos;
		$this->result = $result;
		$this->headingIndex = $headingIndex;
		$this->preproc = $preproc;
		$this->th = $th;

	}
}


class Grammar extends \Wikimedia\WikiPEG\PEGParserBase {
	// initializer
	
	private Env $env;
	private SiteConfig $siteConfig;
	private Frame $frame;
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
		$this->frame = $tokenizer->getFrame();
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
	private $hasSOLTransparentAtStart = false;

	public function resetState() {
		$this->prevOffset = 0;
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
2 => ["type" => "literal", "value" => "|", "description" => "\"|\""],
3 => ["type" => "literal", "value" => "{{!}}", "description" => "\"{{!}}\""],
4 => ["type" => "literal", "value" => "-", "description" => "\"-\""],
5 => ["type" => "class", "value" => "[ \\t]", "description" => "[ \\t]"],
6 => ["type" => "other", "description" => "table_start_tag"],
7 => ["type" => "other", "description" => "url_protocol"],
8 => ["type" => "other", "description" => "ipv6urladdr"],
9 => ["type" => "class", "value" => "[^ \\]\\[\\r\\n\"'<>\\x00-\\x20\\x7f&\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000{]", "description" => "[^ \\]\\[\\r\\n\"'<>\\x00-\\x20\\x7f&\\u00A0\\u1680\\u180E\\u2000-\\u200A\\u202F\\u205F\\u3000{]"],
10 => ["type" => "other", "description" => "comment"],
11 => ["type" => "other", "description" => "tplarg_or_template"],
12 => ["type" => "class", "value" => "['{]", "description" => "['{]"],
13 => ["type" => "other", "description" => "htmlentity"],
14 => ["type" => "literal", "value" => "&", "description" => "\"&\""],
15 => ["type" => "other", "description" => "table_attributes"],
16 => ["type" => "other", "description" => "generic_newline_attributes"],
17 => ["type" => "any", "description" => "any character"],
18 => ["type" => "other", "description" => "extlink"],
19 => ["type" => "other", "description" => "dtdd"],
20 => ["type" => "other", "description" => "hacky_dl_uses"],
21 => ["type" => "other", "description" => "li"],
22 => ["type" => "other", "description" => "tlb"],
23 => ["type" => "literal", "value" => "//", "description" => "\"//\""],
24 => ["type" => "class", "value" => "[A-Za-z]", "description" => "[A-Za-z]"],
25 => ["type" => "class", "value" => "[-A-Za-z0-9+.]", "description" => "[-A-Za-z0-9+.]"],
26 => ["type" => "literal", "value" => ":", "description" => "\":\""],
27 => ["type" => "literal", "value" => "[", "description" => "\"[\""],
28 => ["type" => "class", "value" => "[0-9A-Fa-f:.]", "description" => "[0-9A-Fa-f:.]"],
29 => ["type" => "literal", "value" => "]", "description" => "\"]\""],
30 => ["type" => "literal", "value" => "<!--", "description" => "\"<!--\""],
31 => ["type" => "class", "value" => "[^-]", "description" => "[^-]"],
32 => ["type" => "literal", "value" => "-->", "description" => "\"-->\""],
33 => ["type" => "other", "description" => "parsoid_fragment_marker"],
34 => ["type" => "other", "description" => "template"],
35 => ["type" => "other", "description" => "broken_template"],
36 => ["type" => "literal", "value" => "{", "description" => "\"{\""],
37 => ["type" => "other", "description" => "tplarg"],
38 => ["type" => "other", "description" => "raw_htmlentity"],
39 => ["type" => "other", "description" => "inline_element"],
40 => ["type" => "class", "value" => "[*#:;]", "description" => "[*#:;]"],
41 => ["type" => "literal", "value" => ";", "description" => "\";\""],
42 => ["type" => "other", "description" => "redirect"],
43 => ["type" => "other", "description" => "sol_transparent"],
44 => ["type" => "other", "description" => "block_line"],
45 => ["type" => "other", "description" => "block_lines"],
46 => ["type" => "literal", "value" => "\x0a", "description" => "\"\\n\""],
47 => ["type" => "literal", "value" => "\x0d\x0a", "description" => "\"\\r\\n\""],
48 => ["type" => "other", "description" => "empty_lines_with_comments"],
49 => ["type" => "literal", "value" => "{{#parsoid\x00fragment:", "description" => "\"{{#parsoid\\u0000fragment:\""],
50 => ["type" => "class", "value" => "[0-9]", "description" => "[0-9]"],
51 => ["type" => "literal", "value" => "}}", "description" => "\"}}\""],
52 => ["type" => "other", "description" => "template_preproc"],
53 => ["type" => "literal", "value" => "{{", "description" => "\"{{\""],
54 => ["type" => "other", "description" => "tplarg_preproc"],
55 => ["type" => "class", "value" => "[#0-9a-zA-Z\u{5e8}\u{5dc}\u{5de}\u{631}\u{644}\u{645}]", "description" => "[#0-9a-zA-Z\u{5e8}\u{5dc}\u{5de}\u{631}\u{644}\u{645}]"],
56 => ["type" => "other", "description" => "autolink"],
57 => ["type" => "other", "description" => "behavior_switch"],
58 => ["type" => "class", "value" => "[^-'<[{\\n\\r:;\\]}|!=]", "description" => "[^-'<[{\\n\\r:;\\]}|!=]"],
59 => ["type" => "other", "description" => "angle_bracket_markup"],
60 => ["type" => "other", "description" => "lang_variant_or_tpl"],
61 => ["type" => "literal", "value" => "[[", "description" => "\"[[\""],
62 => ["type" => "other", "description" => "wikilink"],
63 => ["type" => "other", "description" => "quote"],
64 => ["type" => "other", "description" => "redirect_word"],
65 => ["type" => "class", "value" => "[ \\t\\n\\r\\x0c]", "description" => "[ \\t\\n\\r\\x0c]"],
66 => ["type" => "other", "description" => "include_limits"],
67 => ["type" => "other", "description" => "annotation_tag"],
68 => ["type" => "other", "description" => "heading"],
69 => ["type" => "other", "description" => "list_item"],
70 => ["type" => "other", "description" => "hr"],
71 => ["type" => "other", "description" => "table_line"],
72 => ["type" => "literal", "value" => "{{{", "description" => "\"{{{\""],
73 => ["type" => "literal", "value" => "}}}", "description" => "\"}}}\""],
74 => ["type" => "other", "description" => "wellformed_extension_tag"],
75 => ["type" => "other", "description" => "autourl"],
76 => ["type" => "other", "description" => "autoref"],
77 => ["type" => "other", "description" => "isbn"],
78 => ["type" => "literal", "value" => "__", "description" => "\"__\""],
79 => ["type" => "other", "description" => "behavior_text"],
80 => ["type" => "other", "description" => "maybe_extension_tag"],
81 => ["type" => "other", "description" => "html_tag"],
82 => ["type" => "other", "description" => "lang_variant"],
83 => ["type" => "other", "description" => "wikilink_preproc"],
84 => ["type" => "other", "description" => "broken_wikilink"],
85 => ["type" => "literal", "value" => "''", "description" => "\"''\""],
86 => ["type" => "literal", "value" => "'", "description" => "\"'\""],
87 => ["type" => "class", "value" => "[ \\t\\n\\r\\0\\x0b]", "description" => "[ \\t\\n\\r\\0\\x0b]"],
88 => ["type" => "class", "value" => "[^ \\t\\n\\r\\x0c:\\[]", "description" => "[^ \\t\\n\\r\\x0c:\\[]"],
89 => ["type" => "other", "description" => "xmlish_tag"],
90 => ["type" => "other", "description" => "tvar_old_syntax_closing_HACK"],
91 => ["type" => "literal", "value" => "=", "description" => "\"=\""],
92 => ["type" => "literal", "value" => "----", "description" => "\"----\""],
93 => ["type" => "other", "description" => "table_content_line"],
94 => ["type" => "other", "description" => "table_end_tag"],
95 => ["type" => "other", "description" => "RFC"],
96 => ["type" => "other", "description" => "PMID"],
97 => ["type" => "class", "value" => "[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]", "description" => "[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]"],
98 => ["type" => "literal", "value" => "ISBN", "description" => "\"ISBN\""],
99 => ["type" => "class", "value" => "[xX]", "description" => "[xX]"],
100 => ["type" => "other", "description" => "lang_variant_preproc"],
101 => ["type" => "other", "description" => "broken_lang_variant"],
102 => ["type" => "other", "description" => "wikilink_preproc_internal"],
103 => ["type" => "literal", "value" => "]]", "description" => "\"]]\""],
104 => ["type" => "other", "description" => "xmlish_start"],
105 => ["type" => "other", "description" => "space_or_newline_or_solidus"],
106 => ["type" => "literal", "value" => "/", "description" => "\"/\""],
107 => ["type" => "literal", "value" => ">", "description" => "\">\""],
108 => ["type" => "literal", "value" => "</>", "description" => "\"</>\""],
109 => ["type" => "other", "description" => "table_heading_tags"],
110 => ["type" => "other", "description" => "table_row_tag"],
111 => ["type" => "other", "description" => "table_data_tags"],
112 => ["type" => "other", "description" => "table_caption_tag"],
113 => ["type" => "literal", "value" => "}", "description" => "\"}\""],
114 => ["type" => "literal", "value" => "RFC", "description" => "\"RFC\""],
115 => ["type" => "literal", "value" => "PMID", "description" => "\"PMID\""],
116 => ["type" => "literal", "value" => "-{", "description" => "\"-{\""],
117 => ["type" => "literal", "value" => "}-", "description" => "\"}-\""],
118 => ["type" => "other", "description" => "wikilink_preprocessor_text"],
119 => ["type" => "literal", "value" => "<", "description" => "\"<\""],
120 => ["type" => "class", "value" => "[^\\t\\n\\v />\\0]", "description" => "[^\\t\\n\\v />\\0]"],
121 => ["type" => "other", "description" => "table_heading_tags_parameterized"],
122 => ["type" => "literal", "value" => "+", "description" => "\"+\""],
123 => ["type" => "other", "description" => "row_syntax_table_args"],
124 => ["type" => "class", "value" => "[^<[{\\n\\r\\t|!\\]}{ &\\-]", "description" => "[^<[{\\n\\r\\t|!\\]}{ &\\-]"],
125 => ["type" => "other", "description" => "directive"],
126 => ["type" => "class", "value" => "[^-'<[{\\n\\r:;\\]}|!=] or [!<\\-\\}\\]\\n\\r]", "description" => "[^-'<[{\\n\\r:;\\]}|!=] or [!<\\-\\}\\]\\n\\r]"],
127 => ["type" => "literal", "value" => "!", "description" => "\"!\""],
128 => ["type" => "other", "description" => "lang_variant_flag"],
129 => ["type" => "other", "description" => "lang_variant_name"],
130 => ["type" => "other", "description" => "lang_variant_nowiki"],
131 => ["type" => "literal", "value" => "=>", "description" => "\"=>\""],
132 => ["type" => "literal", "value" => "!!", "description" => "\"!!\""],
133 => ["type" => "class", "value" => "[-+A-Z]", "description" => "[-+A-Z]"],
134 => ["type" => "class", "value" => "[^{}|;]", "description" => "[^{}|;]"],
135 => ["type" => "class", "value" => "[a-z]", "description" => "[a-z]"],
136 => ["type" => "class", "value" => "[-a-zA-Z]", "description" => "[-a-zA-Z]"],
137 => ["type" => "other", "description" => "nowiki_text"],
138 => ["type" => "other", "description" => "full_table_in_link_caption"],
139 => ["type" => "other", "description" => "nowiki"],
140 => ["type" => "other", "description" => "embedded_full_table"],
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
private function a1() {

				if ( $this->env->profiling() ) {
					$profile = $this->env->getCurrentProfile();
					$profile->bumpTimeUse(
						'PEG', hrtime( true ) - $this->startTime, 'PEG' );
				}
				return true;
			
}
private function a2($p, $dashes, $attrStartPos, $a, $tagEndPos, $s2) {

		$coms = TokenizerUtils::popComments( $a );
		if ( $coms ) {
			$tagEndPos = $coms['commentStartPos'];
		}

		$da = new DataParsoid;
		$da->tsr = new SourceRange( $this->startOffset(), $tagEndPos );
		$da->startTagSrc = $p . $dashes;
		$da->getTemp()->attrSrc = substr(
			$this->input, $attrStartPos, $tagEndPos - $attrStartPos
		);

		// We rely on our tree builder to close the row as needed. This is
		// needed to support building tables from fragment templates with
		// individual cells or rows.
		$trToken = new TagTk( 'tr', $a, $da );

		return array_merge( [ $trToken ], $coms ? $coms['buf'] : [], $s2 );
	
}
private function a3($b, $p, $attrStartPos, $ta, $tsEndPos, $s2) {

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
		$dp->getTemp()->attrSrc = substr(
			$this->input, $attrStartPos, $tsEndPos - $attrStartPos
		);

		return array_merge(
			[ new TagTk( 'table', $ta, $dp ) ],
			$coms ? $coms['buf'] : [],
			$s2
		);
	
}
private function a4($proto, $addr, $path) {
 return $addr !== '' || count( $path ) > 0; 
}
private function a5($proto, $addr, $path) {

		return TokenizerUtils::flattenString( array_merge( [ $proto, $addr ], $path ) );
	
}
private function a6($as, $s, $p) {

		return [ $as, $s, $p ];
	
}
private function a7($r) {
 return TokenizerUtils::flattenIfArray( $r ); 
}
private function a8($p0, $addr, $target) {
 return TokenizerUtils::flattenString( [ $addr, $target ] ); 
}
private function a9($p0, $flat) {

			// Protocol must be valid and there ought to be at least one
			// post-protocol character.  So strip last char off target
			// before testing protocol.
			if ( is_array( $flat ) ) {
				// There are templates present, alas.
				return count( $flat ) > 0;
			}
			return Utils::isProtocolValid( substr( $flat, 0, -1 ), $this->env );
		
}
private function a10($p0, $flat, $p1, $sp, $p2, $content, $p3) {

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
private function a11() {
 return $this->endOffset() === $this->inputLength; 
}
private function a12($b) {

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
private function a13($t) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a14($t, $n) {

		if ( count( $t ) ) {
			$ret = TokenizerUtils::flattenIfArray( $t );
		} else {
			$ret = [];
		}
		if ( count( $n ) ) {
			PHPUtils::pushArray($ret, $n);
		}
		return $ret;
	
}
private function a15() {
 return $this->endOffset(); 
}
private function a16() {
 $this->unreachable(); 
}
private function a17($p) {
 return Utils::isProtocolValid( $p, $this->env ); 
}
private function a18($p) {
 return $p; 
}
private function a19($tagType, $h, $extlink, &$preproc, $equal, $table, $templateArg, $tableCellArg, $semicolon, $arrow, $linkdesc, $colon, &$th) {

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
private function a20($c) {
 return $this->endOffset() === $this->inputLength; 
}
private function a21($c, $cEnd) {

		$data = WTUtils::encodeComment( $c );
		$dp = new DataParsoid;
		$dp->tsr = $this->tsrOffsets();
		if ( $cEnd !== '-->' ) {
			$dp->unclosedComment = true;
		}
		return [ new CommentTk( $data, $dp ) ];
	
}
private function a22($cc) {

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
private function a23($namePos0, $name, $namePos1, $vd) {

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
private function a24($c) {
 return new KV( $c, '' ); 
}
private function a25($namePos0, $name, $namePos1, $vd) {

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
private function a26($c) {

		return TokenizerUtils::flattenStringlist( $c );
	
}
private function a27($bullets, $colons, $d) {
 return $this->endOffset() === $this->inputLength; 
}
private function a28($bullets, $colons, $d) {

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
private function a29($bullets, $sc, $tbl) {

	// Leave bullets as an array -- list handler expects this
	$tsr = $this->tsrOffsets( 'start' );
	$tsr->end += count( $bullets );
	$dp = new DataParsoid;
	$dp->tsr = $tsr;
	$li = new TagTk( 'listItem', [ new KV( 'bullets', $bullets, $tsr->expandTsrV() ) ], $dp );
	return array_merge( [ $li ], $sc, $tbl );

}
private function a30($bullets, $c) {
 return $this->endOffset() === $this->inputLength; 
}
private function a31($bullets, $c) {

		// Leave bullets as an array -- list handler expects this
		$tsr = $this->tsrOffsets( 'start' );
		$tsr->end += count( $bullets );
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$li = new TagTk( 'listItem', [ new KV( 'bullets', $bullets, $tsr->expandTsrV() ) ], $dp );
		return array_merge( [ $li ], $c ?: [] );
	
}
private function a32() {
 return $this->endOffset() === 0 && !$this->pipelineOffset; 
}
private function a33($r, $cil, $bl) {

		$this->hasSOLTransparentAtStart = true;
		return array_merge( [ $r ], $cil, $bl ?: [] );
	
}
private function a34() {
 return $this->endOffset() === 0 || strspn($this->input, "\r\n", $this->currPos, 1) > 0; 
}
private function a35() {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a36() {

		// Use the sol flag only at the start of the input
		return $this->endOffset() === 0 && $this->options['sol'];
	
}
private function a37() {

		return [];
	
}
private function a38($sp, $elc, $st) {

	$this->hasSOLTransparentAtStart = ( count( $st ) > 0 );
	return [ $sp, $elc ?? [], $st ];

}
private function a39($marker) {

	return TokenizerUtils::parsoidFragmentMarkerToTokens(
	  $this->env, $this->frame, $marker, $this->tsrOffsets()
	);

}
private function a40(&$preproc, $t) {

		$preproc = null;
		return $t;
	
}
private function a41($m) {

		return Utils::decodeWtEntities( $m );
	
}
private function a42($first, $rest) {

		array_unshift( $rest, $first );
		return TokenizerUtils::flattenString( $rest );
	
}
private function a43($s, $t, $q) {

		return TokenizerUtils::getAttrVal( $t, $this->startOffset() + strlen( $s ), $this->endOffset() - strlen( $q ) );
	
}
private function a44($s, $t) {
 return $this->endOffset() === $this->inputLength; 
}
private function a45($s, $t) {

		return TokenizerUtils::getAttrVal( $t, $this->startOffset() + strlen( $s ), $this->endOffset() );
	
}
private function a46($r) {

		return TokenizerUtils::flattenString( $r );
	
}
private function a47() {

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
private function a48() {

			$this->currPos += strlen( $this->urltextPlainSegment );
			return $this->urltextPlainSegment;
		
}
private function a49() {
 return $this->urltextFoundAutolink; 
}
private function a50($c, $cpos) {

	return [ $c, $cpos ];

}
private function a51($rw, $sp, $c, $wl) {

		return count( $wl ) === 1 && $wl[0] instanceof Token;
	
}
private function a52($rw, $sp, $c, $wl) {

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
private function a53($s) {

		if ( $s !== '' ) {
			return [ $s ];
		} else {
			return [];
		}
	
}
private function a54($s, $os) {
 return $this->endOffset() === 0 || strspn($this->input, "\r\n", $this->currPos, 1) > 0; 
}
private function a55($s, $os) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a56($s, $os) {

		// Use the sol flag only at the start of the input
		return $this->endOffset() === 0 && $this->options['sol'];
	
}
private function a57($s, $os) {

		return [];
	
}
private function a58($s, $os, $sp, $elc, $st) {

	$this->hasSOLTransparentAtStart = ( count( $st ) > 0 );
	return [ $sp, $elc ?? [], $st ];

}
private function a59($s, $os, $so) {
 return array_merge( $os, $so ); 
}
private function a60($s, $s2, $bl) {

		return array_merge( $s, $s2 ?: [], $bl );
	
}
private function a61($p, $c) {

		$dp = new DataParsoid;
		$dp->tsr = new SourceRange( $p, $this->endOffset() );
		return [ new EmptyLineTk( TokenizerUtils::flattenIfArray( $c ), $dp ) ];
	
}
private function a62($p, $target) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a63($p, $target, $p0) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a64($p, $target, $p0, $v, $p1) {

				// empty argument
				return [ 'tokens' => $v, 'srcOffsets' => new SourceRange( $p0, $p1 ) ];
			
}
private function a65($p, $target, $params) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a66($p, $target, $params) {

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
private function a67($target) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a68($target, $p0) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a69($target, $p0, $v, $p1) {

				// empty argument
				$tsr0 = new SourceRange( $p0, $p1 );
				return new KV( '', TokenizerUtils::flattenIfArray( $v ), $tsr0->expandTsrV() );
			
}
private function a70($target, $params) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a71($target, $params) {

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
private function a72($x, $ill) {
 return array_merge( [$x], $ill ?: [] ); 
}
private function a73() {
 return Utils::isUniWord(Utils::lastUniChar( $this->input, $this->endOffset() ) ); 
}
private function a74($bs) {

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
private function a76($rw) {

			return preg_match( $this->env->getSiteConfig()->getMagicWordMatcher( 'redirect' ), $rw );
		
}
private function a77($t) {

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
private function a78() {
 return $this->annotationsEnabledOnWiki; /* short-circuit! */ 
}
private function a79($t) {

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
private function a80($tag) {

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
private function a81($s, $ill) {
 return $ill ?: []; 
}
private function a82($s, $ce) {
 return $ce || strlen( $s ) > 2; 
}
private function a83($s, $ce, $endTPos, $spc) {
 return $this->endOffset() === $this->inputLength; 
}
private function a84($s, $ce, $endTPos, $spc, &$headingIndex) {

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
				$headingIndex++;
				$tagDP->getTemp()->headingIndex = $headingIndex;
			}

			$res = [ new TagTk( 'h' . $level, [], $tagDP ) ];
			PHPUtils::pushArray( $res, $c );
			$endTagDP = new DataParsoid;
			$endTagDP->tsr = new SourceRange( $endTPos - $level, $endTPos );
			$res[] = new EndTagTk( 'h' . $level, [], $endTagDP );
			PHPUtils::pushArray( $res, $spc );
			return $res;
		
}
private function a85($d) {
 return $this->endOffset() === 0 || strspn($this->input, "\r\n", $this->currPos, 1) > 0; 
}
private function a86($d) {
 return [ new NlTk( $this->tsrOffsets() ) ]; 
}
private function a87($d) {

		// Use the sol flag only at the start of the input
		return $this->endOffset() === 0 && $this->options['sol'];
	
}
private function a88($d) {

		return [];
	
}
private function a89($d, $sp, $elc, $st) {

	$this->hasSOLTransparentAtStart = ( count( $st ) > 0 );
	return [ $sp, $elc ?? [], $st ];

}
private function a90($d) {
 return null; 
}
private function a91($d) {
 return true; 
}
private function a92($d, $lineContent) {

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
private function a93($sc, $tl) {

		return array_merge($sc, $tl);
	
}
private function a94($il) {

		// il is guaranteed to be an array -- so, tu.flattenIfArray will
		// always return an array
		$r = TokenizerUtils::flattenIfArray( $il );
		if ( count( $r ) === 1 && is_string( $r[0] ) ) {
			$r = $r[0];
		}
		return [ 'tokens' => $r, 'srcOffsets' => $this->tsrOffsets() ];
	
}
private function a95($tpt) {

		return [ 'tokens' => $tpt, 'srcOffsets' => $this->tsrOffsets() ];
	
}
private function a96($name, $kEndPos, $vStartPos, $s) {

		if ( $s !== '' ) {
			return [ $s ];
		} else {
			return [];
		}
	
}
private function a97($name, $kEndPos, $vStartPos, $optSp, $tpv) {

			return [
				'kEndPos' => $kEndPos,
				'vStartPos' => $vStartPos,
				'value' => ( $tpv === null ) ? '' :
					TokenizerUtils::flattenString( [ $optSp, $tpv['tokens'] ] ),
			];
		
}
private function a98($name, $val) {

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
private function a99() {

		$so = new SourceRange( $this->startOffset(), $this->endOffset() );
		return new KV( '', '', $so->expandTsrV() );
	
}
private function a100($extToken) {
 return $extToken->getName() === 'extension'; 
}
private function a101($extToken) {
 return $extToken; 
}
private function a102($tagType) {

		return ( $tagType === 'html' || $tagType === '' );
	
}
private function a103($proto, $addr, $rhe) {
 return $rhe === '<' || $rhe === '>' || $rhe === "\u{A0}"; 
}
private function a104($proto, $addr, $path) {

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
private function a105($r) {
 return $r !== null; 
}
private function a106($r) {

		$tsr = $this->tsrOffsets();
		$dp = new DataParsoid;
		$dp->tsr = $tsr;
		$res = [ new SelfclosingTagTk( 'urllink', [ new KV( 'href', $r, $tsr->expandTsrV() ) ], $dp ) ];
		return $res;
	
}
private function a107($ref, $he) {
 return is_array( $he ) && $he[ 1 ] === "\u{A0}"; 
}
private function a108($ref, $he) {
 return $he; 
}
private function a109($ref, $sp, $identifier) {
 return $this->endOffset() === $this->inputLength; 
}
private function a110($ref, $sp, $identifier) {

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
private function a111() {
 return $this->siteConfig->magicLinkEnabled("ISBN"); 
}
private function a112($he) {
 return is_array( $he ) && $he[ 1 ] === "\u{A0}"; 
}
private function a113($he) {
 return $he; 
}
private function a114($sp, $he) {
 return is_array( $he ) && $he[ 1 ] === "\u{A0}"; 
}
private function a115($sp, $he) {
 return $he; 
}
private function a116($sp, $isbn) {
 return $this->endOffset() === $this->inputLength; 
}
private function a117($sp, $isbn) {

			// Convert isbn token-and-entity array to stripped string.
			$stripped = '';
			foreach ( TokenizerUtils::flattenStringlist( $isbn ) as $part ) {
				if ( is_string( $part ) ) {
					$stripped .= $part;
				}
			}
			return strtoupper( preg_replace( '/[^\dX]/i', '', $stripped ) );
		
}
private function a118($sp, $isbn, $isbncode) {

		// ISBNs can only be 10 or 13 digits long (with a specific format)
		return strlen( $isbncode ) === 10
			|| ( strlen( $isbncode ) === 13 && preg_match( '/^97[89]/', $isbncode ) );
	
}
private function a119($sp, $isbn, $isbncode) {

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
private function a120($t) {

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
private function a121(&$preproc) {
 $preproc = null; return true; 
}
private function a122(&$preproc, $a) {

		return $a;
	
}
private function a123($start) {

		list(,$name) = $start;
		return WTUtils::isIncludeTag( mb_strtolower( $name ) );
	
}
private function a124($tagType, $start) {

		// Only enforce ascii alpha first char for non-extension tags.
		// See tag_name above for the details.
		list(,$name) = $start;
		return $tagType !== 'html' ||
			( preg_match( '/^[A-Za-z]/', $name ) && $this->isXMLTag( $name ) );
	
}
private function a125($tagType, $start, $attribs, $selfclose) {

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
private function a126($tagType) {

		return $tagType !== 'anno';
	
}
private function a127($tagType) {
 return $this->env->hasAnnotations && $this->siteConfig->isAnnotationTag( 'tvar' ); 
}
private function a128($tagType) {

		$metaAttrs = [ new KV( 'typeof', 'mw:Annotation/tvar/End' ) ];
		$dp = new DataParsoid();
		$dp->tsr = $this->tsrOffsets();
		return new SelfclosingTagTk ( 'meta', $metaAttrs, $dp );
	
}
private function a129($tagType, $start) {

		list(,$name) = $start;
		return WTUtils::isAnnotationTag( $this->env, $name );
	
}
private function a130($p, $b) {

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
private function a131($il) {

		// il is guaranteed to be an array -- so, tu.flattenIfArray will
		// always return an array
		$r = TokenizerUtils::flattenIfArray( $il );
		if ( count( $r ) === 1 && is_string( $r[0] ) ) {
			$r = $r[0];
		}
		return $r;
	
}
private function a132() {
 return $this->siteConfig->magicLinkEnabled("RFC"); 
}
private function a133() {
 return $this->siteConfig->magicLinkEnabled("PMID"); 
}
private function a134($start) {

		list(,$name) = $start;
		return isset( $this->extTags[mb_strtolower( $name )] ) &&
			// NOTE: This check is redundant with the precedence of the current
			// rules ( annotation_tag / *_extension_tag ) but kept as a precaution
			// since annotation tags are in extTags and we want them handled
			// elsewhere.
			!WTUtils::isAnnotationTag( $this->env, $name );
	
}
private function a135() {
 return $this->startOffset(); 
}
private function a136($lv0) {
 return $this->env->langConverterEnabled(); 
}
private function a137($lv0, $ff) {

			// if flags contains 'R', then don't treat ; or : specially inside.
			if ( isset( $ff['flags'] ) ) {
				$ff['raw'] = isset( $ff['flags']['R'] ) || isset( $ff['flags']['N'] );
			} elseif ( isset( $ff['variants'] ) ) {
				$ff['raw'] = true;
			}
			return $ff;
		
}
private function a138($lv0) {
 return !$this->env->langConverterEnabled(); 
}
private function a139($lv0) {

			// if language converter not enabled, don't try to parse inside.
			return [ 'raw' => true ];
		
}
private function a140($lv0, $f) {
 return $f['raw']; 
}
private function a141($lv0, $f, $lv) {
 return [ [ 'text' => $lv ] ]; 
}
private function a142($lv0, $f) {
 return !$f['raw']; 
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
private function a144($r, &$preproc) {

		$preproc = null;
		return $r;
	
}
private function a145($spos, $target, $tpos, $lcs) {

		$pipeTrick = count( $lcs ) === 1 && count( $lcs[0][1]->v ) === 0;
		if ( $target === null || $pipeTrick ) {
			$textTokens = [];
			$textTokens[] = '[[';
			if ( $target ) {
				// FIXME: $target should really be retokenized
				$textTokens[] = $target;
			}
			foreach ( $lcs as $a ) {
				// $a[0] is a pipe
				// FIXME: Account for variation, emit a template tag
				$textTokens[] = '|';
				// $a[1] is a mw:maybeContent attribute
				if ( count( $a[1]->v ) > 0 ) {
					$textTokens[] = $a[1]->v;
				}
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
private function a146($p, $td, $tds) {

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
private function a147($p, $args, $tagEndPos, $c) {

		$tsr = new SourceRange( $this->startOffset(), $tagEndPos );
		return TokenizerUtils::buildTableTokens(
			$this->input, 'caption', '|+', $args, $tsr, $this->endOffset(), $c, true
		);
	
}
private function a148($f) {

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
private function a149($tokens) {

		return [
			'tokens' => TokenizerUtils::flattenStringlist( $tokens ),
			'srcOffsets' => $this->tsrOffsets(),
		];
	
}
private function a150($o, $rest, $tr) {

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
private function a151($lvtext) {
 return [ [ 'text' => $lvtext ] ]; 
}
private function a152($p, $startPos, $lt) {

			$tsr = new SourceRange( $startPos, $this->endOffset() );
			$maybeContent = new KV( 'mw:maybeContent', $lt ?? [], $tsr->expandTsrV() );
			$maybeContent->vsrc = substr( $this->input, $startPos, $this->endOffset() - $startPos );
			return [$p, $maybeContent];
		
}
private function a153($thTag, $thTags) {

		// Avoid modifying a cached result
		$thTag[0] = clone $thTag[0];
		$da = $thTag[0]->dataParsoid = clone $thTag[0]->dataParsoid;
		$da->tsr = clone $da->tsr;
		$da->tsr->start--; // include "!"
		array_unshift( $thTags, $thTag );
		return $thTags;
	
}
private function a154($arg, $tagEndPos, $td) {

		$tagStart = $this->startOffset();
		$tsr = new SourceRange( $tagStart, $tagEndPos );
		return TokenizerUtils::buildTableTokens(
			$this->input, 'td', '|', $arg, $tsr, $this->endOffset(), $td
		);
	
}
private function a155($pp, $tdt) {

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
private function a156($b) {

		return $b;
	
}
private function a157($sp1, $f, $sp2, $more) {

		$r = ( $more && $more[1] ) ? $more[1] : [ 'sp' => [], 'flags' => [] ];
		// Note that sp and flags are in reverse order, since we're using
		// right recursion and want to push instead of unshift.
		$r['sp'][] = $sp2;
		$r['sp'][] = $sp1;
		$r['flags'][] = $f;
		return $r;
	
}
private function a158($sp) {

		return [ 'sp' => [ $sp ], 'flags' => [] ];
	
}
private function a159($sp1, $lang, $sp2, $sp3, $lvtext) {

		return [
			'twoway' => true,
			'lang' => $lang,
			'text' => $lvtext,
			'sp' => [ $sp1, $sp2, $sp3 ]
		];
	
}
private function a160($sp1, $from, $sp2, $lang, $sp3, $sp4, $to) {

		return [
			'oneway' => true,
			'from' => $from,
			'lang' => $lang,
			'to' => $to,
			'sp' => [ $sp1, $sp2, $sp3, $sp4 ]
		];
	
}
private function a161($arg, $tagEndPos, &$th, $d) {

			// Ignore newlines found in transclusions!
			// This is not perfect (since {{..}} may not always tokenize to transclusions).
			if ( $th !== false && str_contains( preg_replace( "/{{[\s\S]+?}}/", "", $this->text() ), "\n" ) ) {
				// There's been a newline. Remove the break and continue
				// tokenizing nested_block_in_tables.
				$th = false;
			}
			return $d;
		
}
private function a162($arg, $tagEndPos, $c) {

		$tagStart = $this->startOffset();
		$tsr = new SourceRange( $tagStart, $tagEndPos );
		return TokenizerUtils::buildTableTokens(
			$this->input, 'th', '!', $arg, $tsr, $this->endOffset(), $c
		);
	
}
private function a163($pp, $tht) {

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
private function a164($f) {
 return [ 'flag' => $f ]; 
}
private function a165($v) {
 return [ 'variant' => $v ]; 
}
private function a166($b) {
 return [ 'bogus' => $b ]; /* bad flag */
}
private function a167($n, $sp) {

		$tsr = $this->tsrOffsets();
		$tsr->end -= strlen( $sp );
		return [
			'tokens' => [ $n ],
			'srcOffsets' => $tsr,
		];
	
}
private function a168($extToken) {

		$txt = Utils::extractExtBody( $extToken );
		return Utils::decodeWtEntities( $txt );
	
}
private function a169($r) {

		return $r;
	
}
private function a170($start) {

		list(,$name) = $start;
		return ( mb_strtolower( $name ) === 'nowiki' );
	
}

	// generated
	private function streamstart_async($silence, &$param_th, &$param_headingIndex, &$param_preproc) {
  for (;;) {
    // start seq_1
    $p2 = $this->currPos;
    $r3 = $param_th;
    $r4 = $param_headingIndex;
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
    $r1 = $this->parsetlb($silence, $param_th, $param_headingIndex, $param_preproc);
    if ($r1===self::$FAILED) {
      $this->currPos = $p2;
      $param_th = $r3;
      $param_headingIndex = $r4;
      $param_preproc = $r5;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    $this->savedPos = $this->currPos;
    $r7 = $this->a1();
    if ($r7) {
      $r7 = false;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p2;
      $param_th = $r3;
      $param_headingIndex = $r4;
      $param_preproc = $r5;
      $r1 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    if ($r1!==self::$FAILED) {
      yield $r1;
    } else {
      if ($this->currPos < $this->inputLength) {
        if (!$silence) { $this->fail(0); }
        throw $this->buildParseException();
      }
      break;
    }
    // free $p2,$r3,$r4,$r5
  }
}
private function parsestart($silence, &$param_th, &$param_preproc) {
  $key = json_encode([272, $param_th, $param_preproc]);
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
  $r4 = $this->parsestart_with_headingIndex($param_th, self::newRef(0), $param_preproc);
  if ($r4===self::$FAILED) {
    if (!$silence) { $this->fail(1); }
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    self::$UNDEFINED,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_row_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([484, $boolParams & 0x1fef, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r7 = "|";
    $this->currPos++;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(2); }
    $r7 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r7 = "{{!}}";
    $this->currPos += 5;
  } else {
    if (!$silence) { $this->fail(3); }
    $r7 = self::$FAILED;
  }
  choice_1:
  // p <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p9 = $this->currPos;
  $r8 = self::$FAILED;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "-") {
      $r10 = true;
      $this->currPos++;
      $r8 = true;
    } else {
      if (!$silence) { $this->fail(4); }
      $r10 = self::$FAILED;
      break;
    }
  }
  // dashes <- $r8
  if ($r8!==self::$FAILED) {
    $r8 = substr($this->input, $p9, $this->currPos - $p9);
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r10
  // free $p9
  $r10 = $this->parsePOSITION($silence);
  // attrStartPos <- $r10
  // start choice_2
  $r11 = $this->parsetable_attributes($silence, $boolParams & ~0x10, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r11!==self::$FAILED) {
    goto choice_2;
  }
  $r11 = $this->parseunreachable($silence);
  choice_2:
  // a <- $r11
  $r12 = $this->parsePOSITION($silence);
  // tagEndPos <- $r12
  $r13 = strspn($this->input, "\x09 ", $this->currPos);
  // s2 <- $r13
  $this->currPos += $r13;
  $r13 = substr($this->input, $this->currPos - $r13, $r13);
  $r13 = mb_str_split($r13, 1, "utf-8");
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a2($r7, $r8, $r10, $r11, $r12, $r13);
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_start_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([478, $boolParams & 0x1fef, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // b <- $r6
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r6 = "{";
    $this->currPos++;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r7 = "|";
    $this->currPos++;
    goto choice_1;
  } else {
    $r7 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r7 = "{{!}}";
    $this->currPos += 5;
  } else {
    $r7 = self::$FAILED;
  }
  choice_1:
  // p <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r8 = $this->parsePOSITION(true);
  // attrStartPos <- $r8
  // start choice_2
  $r9 = $this->parsetable_attributes(true, $boolParams & ~0x10, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r9!==self::$FAILED) {
    goto choice_2;
  }
  $r9 = $this->parseunreachable(true);
  choice_2:
  // ta <- $r9
  $r10 = $this->parsePOSITION(true);
  // tsEndPos <- $r10
  $r11 = strspn($this->input, "\x09 ", $this->currPos);
  // s2 <- $r11
  $this->currPos += $r11;
  $r11 = substr($this->input, $this->currPos - $r11, $r11);
  $r11 = mb_str_split($r11, 1, "utf-8");
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a3($r6, $r7, $r8, $r9, $r10, $r11);
  } else {
    if (!$silence) { $this->fail(6); }
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseurl($silence, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([334, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[\\/A-Za-z]/A", $r7)) {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(7); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parseurl_protocol($silence);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // proto <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  // start seq_3
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "[") {
    $r13 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(8); }
    $r8 = self::$FAILED;
    goto seq_3;
  }
  $r8 = $this->parseipv6urladdr($silence);
  if ($r8===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r8!==self::$FAILED) {
    goto choice_1;
  }
  // free $p9,$r10,$r11,$r12
  $r8 = '';
  choice_1:
  // addr <- $r8
  $r12 = [];
  for (;;) {
    // start seq_4
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r14 = $param_th;
    $r15 = $param_headingIndex;
    $r16 = $this->discardinline_breaks(0x0, "", $param_preproc, $param_th);
    if ($r16 === self::$FAILED) {
      $r16 = false;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r14;
      $param_headingIndex = $r15;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    // start choice_2
    if (preg_match("/[^\\x00- \"&-'<>\\[\\]{\\x7f\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r11, 0, $this->currPos)) {
      $r11 = $r11[0];
      $this->currPos += strlen($r11);
      goto choice_2;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) { $this->fail(9); }
    }
    // start seq_5
    $p17 = $this->currPos;
    $r18 = $param_preproc;
    $r19 = $param_th;
    $r20 = $param_headingIndex;
    $r21 = $this->input[$this->currPos] ?? '';
    if ($r21 === "<") {
      $r21 = false;
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
    } else {
      $r21 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r11 = self::$FAILED;
      goto seq_5;
    }
    $r11 = $this->parsecomment($silence);
    if ($r11===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $r11 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    // free $p17,$r18,$r19,$r20
    // start seq_6
    $p17 = $this->currPos;
    $r20 = $param_preproc;
    $r19 = $param_th;
    $r18 = $param_headingIndex;
    $r22 = $this->input[$this->currPos] ?? '';
    if ($r22 === "{") {
      $r22 = false;
      $this->currPos = $p17;
      $param_preproc = $r20;
      $param_th = $r19;
      $param_headingIndex = $r18;
    } else {
      $r22 = self::$FAILED;
      if (!$silence) { $this->fail(11); }
      $r11 = self::$FAILED;
      goto seq_6;
    }
    $r11 = $this->parsetplarg_or_template($silence, 0x0, "", $param_th, $param_preproc, $param_headingIndex);
    if ($r11===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r20;
      $param_th = $r19;
      $param_headingIndex = $r18;
      $r11 = self::$FAILED;
      goto seq_6;
    }
    seq_6:
    if ($r11!==self::$FAILED) {
      goto choice_2;
    }
    // free $p17,$r20,$r19,$r18
    $r11 = $this->input[$this->currPos] ?? '';
    if ($r11 === "'" || $r11 === "{") {
      $this->currPos++;
      goto choice_2;
    } else {
      $r11 = self::$FAILED;
      if (!$silence) { $this->fail(12); }
    }
    // start seq_7
    $p17 = $this->currPos;
    $r18 = $param_preproc;
    $r19 = $param_th;
    $r20 = $param_headingIndex;
    // start seq_8
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r24 = true;
      $this->currPos++;
    } else {
      $r24 = self::$FAILED;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    // start choice_3
    // start seq_9
    $p26 = $this->currPos;
    $r27 = $param_preproc;
    $r28 = $param_th;
    $r29 = $param_headingIndex;
    $r30 = $this->input[$this->currPos] ?? '';
    if ($r30 === "L" || $r30 === "l") {
      $this->currPos++;
    } else {
      $r30 = self::$FAILED;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    $r31 = $this->input[$this->currPos] ?? '';
    if ($r31 === "T" || $r31 === "t") {
      $this->currPos++;
    } else {
      $r31 = self::$FAILED;
      $this->currPos = $p26;
      $param_preproc = $r27;
      $param_th = $r28;
      $param_headingIndex = $r29;
      $r25 = self::$FAILED;
      goto seq_9;
    }
    $r25 = true;
    seq_9:
    if ($r25!==self::$FAILED) {
      goto choice_3;
    }
    // free $r30,$r31
    // free $p26,$r27,$r28,$r29
    // start seq_10
    $p26 = $this->currPos;
    $r29 = $param_preproc;
    $r28 = $param_th;
    $r27 = $param_headingIndex;
    $r31 = $this->input[$this->currPos] ?? '';
    if ($r31 === "G" || $r31 === "g") {
      $this->currPos++;
    } else {
      $r31 = self::$FAILED;
      $r25 = self::$FAILED;
      goto seq_10;
    }
    $r30 = $this->input[$this->currPos] ?? '';
    if ($r30 === "T" || $r30 === "t") {
      $this->currPos++;
    } else {
      $r30 = self::$FAILED;
      $this->currPos = $p26;
      $param_preproc = $r29;
      $param_th = $r28;
      $param_headingIndex = $r27;
      $r25 = self::$FAILED;
      goto seq_10;
    }
    $r25 = true;
    seq_10:
    // free $r31,$r30
    // free $p26,$r29,$r28,$r27
    choice_3:
    if ($r25===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    if (($this->input[$this->currPos] ?? null) === ";") {
      $r27 = true;
    } else {
      $r27 = self::$FAILED;
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $r23 = self::$FAILED;
      goto seq_8;
    }
    $r23 = true;
    seq_8:
    // free $r24,$r25,$r27
    if ($r23 === self::$FAILED) {
      $r23 = false;
    } else {
      $r23 = self::$FAILED;
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $r11 = self::$FAILED;
      goto seq_7;
    }
    // start choice_4
    // start seq_11
    $p26 = $this->currPos;
    $r27 = $param_preproc;
    $r25 = $param_th;
    $r24 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r28 = true;
      $r28 = false;
      $this->currPos = $p26;
      $param_preproc = $r27;
      $param_th = $r25;
      $param_headingIndex = $r24;
    } else {
      $r28 = self::$FAILED;
      $r11 = self::$FAILED;
      goto seq_11;
    }
    // start seq_12
    $p32 = $this->currPos;
    $r29 = $param_preproc;
    $r30 = $param_th;
    $r31 = $param_headingIndex;
    $r33 = $this->input[$this->currPos] ?? '';
    if ($r33 === "&") {
      $r33 = false;
      $this->currPos = $p32;
      $param_preproc = $r29;
      $param_th = $r30;
      $param_headingIndex = $r31;
    } else {
      $r33 = self::$FAILED;
      if (!$silence) { $this->fail(13); }
      $r11 = self::$FAILED;
      goto seq_12;
    }
    $r11 = $this->parsehtmlentity($silence);
    if ($r11===self::$FAILED) {
      $this->currPos = $p32;
      $param_preproc = $r29;
      $param_th = $r30;
      $param_headingIndex = $r31;
      $r11 = self::$FAILED;
      goto seq_12;
    }
    seq_12:
    if ($r11===self::$FAILED) {
      $this->currPos = $p26;
      $param_preproc = $r27;
      $param_th = $r25;
      $param_headingIndex = $r24;
      $r11 = self::$FAILED;
      goto seq_11;
    }
    // free $p32,$r29,$r30,$r31
    seq_11:
    if ($r11!==self::$FAILED) {
      goto choice_4;
    }
    // free $r33
    // free $p26,$r27,$r25,$r24
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r11 = "&";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(14); }
      $r11 = self::$FAILED;
    }
    choice_4:
    if ($r11===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $r11 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    // free $r28
    // free $p17,$r18,$r19,$r20
    choice_2:
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r14;
      $param_headingIndex = $r15;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    seq_4:
    if ($r11!==self::$FAILED) {
      $r12[] = $r11;
    } else {
      break;
    }
    // free $r21,$r22,$r23
    // free $p9,$r10,$r14,$r15
  }
  // path <- $r12
  // free $r11
  // free $r16
  $this->savedPos = $this->currPos;
  $r16 = $this->a4($r6, $r8, $r12);
  if ($r16) {
    $r16 = false;
  } else {
    $r16 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a5($r6, $r8, $r12);
  }
  // free $r7,$r13,$r16
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parserow_syntax_table_args($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([502, $boolParams & 0x1fbf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->parsetable_attributes($silence, $boolParams | 0x40, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // as <- $r6
  $p8 = $this->currPos;
  $r7 = strspn($this->input, "\x09 ", $this->currPos);
  // s <- $r7
  $this->currPos += $r7;
  $r7 = substr($this->input, $p8, $this->currPos - $p8);
  // free $p8
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r9 = "|";
    $this->currPos++;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(2); }
    $r9 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r9 = "{{!}}";
    $this->currPos += 5;
  } else {
    if (!$silence) { $this->fail(3); }
    $r9 = self::$FAILED;
  }
  choice_1:
  // p <- $r9
  if ($r9===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r10 = true;
    goto choice_2;
  } else {
    $r10 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r10 = true;
  } else {
    $r10 = self::$FAILED;
  }
  choice_2:
  if ($r10 === self::$FAILED) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r11,$r12,$r13
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a6($r6, $r7, $r9);
  }
  // free $r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_attributes($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([278, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = [];
  for (;;) {
    // start choice_1
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $r10 = $param_headingIndex;
    if (strcspn($this->input, "\x00\x0a\x0d/>", $this->currPos, 1) !== 0) {
      $r11 = true;
      $r11 = false;
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $param_headingIndex = $r10;
    } else {
      $r11 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsetable_attribute($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r6===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $param_headingIndex = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    // free $p7,$r8,$r9,$r10
    // start seq_2
    $p7 = $this->currPos;
    $r10 = $param_preproc;
    $r9 = $param_th;
    $r8 = $param_headingIndex;
    $r12 = strspn($this->input, "\x09 ", $this->currPos);
    $this->currPos += $r12;
    // start seq_3
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_3;
    }
    $r6 = $this->parsebroken_table_attribute_name_char();
    if ($r6===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r6 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r6===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r10;
      $param_th = $r9;
      $param_headingIndex = $r8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $p13,$r14,$r15,$r16
    seq_2:
    // free $r17
    // free $p7,$r10,$r9,$r8
    choice_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
  }
  // free $r6
  // free $r11,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsegeneric_newline_attributes($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([276, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = [];
  for (;;) {
    // start seq_1
    $p7 = $this->currPos;
    $r8 = $param_preproc;
    $r9 = $param_th;
    $r10 = $param_headingIndex;
    $r11 = self::charAt($this->input, $this->currPos);
    if ($r11 !== '' && !($r11 === "\x00" || $r11 === ">")) {
      $r11 = false;
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $param_headingIndex = $r10;
    } else {
      $r11 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = $this->parsegeneric_newline_attribute($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r6===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r8;
      $param_th = $r9;
      $param_headingIndex = $r10;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    if ($r6!==self::$FAILED) {
      $r5[] = $r6;
    } else {
      break;
    }
    // free $p7,$r8,$r9,$r10
  }
  // free $r6
  // free $r11
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetplarg_or_template_or_bust($silence, &$param_th, &$param_preproc, &$param_headingIndex) {
  $key = json_encode([342, $param_th, $param_preproc, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_th;
    $r10 = $param_preproc;
    $r11 = $param_headingIndex;
    $r12 = $this->input[$this->currPos] ?? '';
    if ($r12 === "{") {
      $r12 = false;
      $this->currPos = $p8;
      $param_th = $r9;
      $param_preproc = $r10;
      $param_headingIndex = $r11;
    } else {
      $r12 = self::$FAILED;
      if (!$silence) { $this->fail(11); }
      $r7 = self::$FAILED;
      goto seq_1;
    }
    $r7 = $this->parsetplarg_or_template($silence, 0x0, "", $param_th, $param_preproc, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_th = $r9;
      $param_preproc = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // free $p8,$r9,$r10,$r11
    if ($this->currPos < $this->inputLength) {
      $r7 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(17); }
    }
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // r <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a7($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseextlink($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([322, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (!(/*extlink*/($boolParams & 0x4) !== 0)) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "[") {
    $r12 = true;
    $this->currPos++;
  } else {
    $r12 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r13 = $this->parsePOSITION(true);
  // p0 <- $r13
  $p15 = $this->currPos;
  // start seq_3
  // start choice_1
  // start seq_4
  $p17 = $this->currPos;
  $r18 = $param_preproc;
  $r19 = $param_th;
  $r20 = $param_headingIndex;
  // start seq_5
  $r22 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[\\/A-Za-z]/A", $r22)) {
    $r22 = false;
    $this->currPos = $p17;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
  } else {
    $r22 = self::$FAILED;
    $r21 = self::$FAILED;
    goto seq_5;
  }
  $r21 = $this->parseurl_protocol(true);
  if ($r21===self::$FAILED) {
    $this->currPos = $p17;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
    $r21 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  if ($r21===self::$FAILED) {
    $r16 = self::$FAILED;
    goto seq_4;
  }
  // start seq_6
  $p24 = $this->currPos;
  $r25 = $param_preproc;
  $r26 = $param_th;
  $r27 = $param_headingIndex;
  $r28 = $this->input[$this->currPos] ?? '';
  if ($r28 === "[") {
    $r28 = false;
    $this->currPos = $p24;
    $param_preproc = $r25;
    $param_th = $r26;
    $param_headingIndex = $r27;
  } else {
    $r28 = self::$FAILED;
    $r23 = self::$FAILED;
    goto seq_6;
  }
  $r23 = $this->parseipv6urladdr(true);
  if ($r23===self::$FAILED) {
    $this->currPos = $p24;
    $param_preproc = $r25;
    $param_th = $r26;
    $param_headingIndex = $r27;
    $r23 = self::$FAILED;
    goto seq_6;
  }
  seq_6:
  if ($r23===self::$FAILED) {
    $this->currPos = $p17;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
    $r16 = self::$FAILED;
    goto seq_4;
  }
  // free $p24,$r25,$r26,$r27
  $r16 = [$r21,$r23];
  seq_4:
  if ($r16!==self::$FAILED) {
    goto choice_1;
  }
  // free $r21,$r22,$r23,$r28
  // free $p17,$r18,$r19,$r20
  $r16 = '';
  choice_1:
  // addr <- $r16
  // start choice_2
  // start seq_7
  $p17 = $this->currPos;
  $r19 = $param_preproc;
  $r18 = $param_th;
  $r28 = $param_headingIndex;
  if (preg_match("/[^\\x09-\\x0a\\x0d \"\\[\\]\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r23, 0, $this->currPos)) {
    $r23 = $r23[0];
    $r23 = false;
    $this->currPos = $p17;
    $param_preproc = $r19;
    $param_th = $r18;
    $param_headingIndex = $r28;
  } else {
    $r23 = self::$FAILED;
    $r20 = self::$FAILED;
    goto seq_7;
  }
  $r20 = $this->parseextlink_nonipv6url($boolParams | 0x4, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r20===self::$FAILED) {
    $this->currPos = $p17;
    $param_preproc = $r19;
    $param_th = $r18;
    $param_headingIndex = $r28;
    $r20 = self::$FAILED;
    goto seq_7;
  }
  seq_7:
  if ($r20!==self::$FAILED) {
    goto choice_2;
  }
  // free $p17,$r19,$r18,$r28
  $r20 = '';
  choice_2:
  // target <- $r20
  $r14 = true;
  seq_3:
  // flat <- $r14
  $this->savedPos = $p15;
  $r14 = $this->a8($r13, $r16, $r20);
  // free $r23
  // free $p15
  $this->savedPos = $this->currPos;
  $r23 = $this->a9($r13, $r14);
  if ($r23) {
    $r23 = false;
  } else {
    $r23 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r28 = $this->parsePOSITION(true);
  // p1 <- $r28
  $p15 = $this->currPos;
  $r18 = null;
  // sp <- $r18
  if (preg_match("/[\\x09 \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]*/Au", $this->input, $r18, 0, $this->currPos)) {
    $this->currPos += strlen($r18[0]);
    $r18 = true;
    $r18 = substr($this->input, $p15, $this->currPos - $p15);
  } else {
    $r18 = self::$FAILED;
    $r18 = self::$FAILED;
  }
  // free $p15
  $r19 = $this->parsePOSITION(true);
  // p2 <- $r19
  $r22 = $this->parseinlineline(true, $boolParams | 0x4, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r22===self::$FAILED) {
    $r22 = null;
  }
  // content <- $r22
  $r21 = $this->parsePOSITION(true);
  // p3 <- $r21
  if (($this->input[$this->currPos] ?? null) === "]") {
    $r27 = true;
    $this->currPos++;
  } else {
    $r27 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = true;
  seq_2:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p7;
    $r5 = $this->a10($r13, $r14, $r28, $r18, $r19, $r22, $r21);
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r12,$r23,$r27
  // free $p8,$r9,$r10,$r11
  // free $p7
  seq_1:
  if ($r5===self::$FAILED) {
    if (!$silence) { $this->fail(18); }
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselist_item($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([456, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  if (strspn($this->input, "#*:;", $this->currPos, 1) !== 0) {
    $r6 = true;
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(19); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsedtdd($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === ":") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(20); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parsehacky_dl_uses($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  if (strspn($this->input, "#*:;", $this->currPos, 1) !== 0) {
    $r8 = true;
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(21); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parseli($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetlb($silence, &$param_th, &$param_headingIndex, &$param_preproc) {
  $key = json_encode([282, $param_th, $param_headingIndex, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  $r4 = $param_preproc;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r6 = $this->a11();
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
  }
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parseblock(true, 0x0, "", $param_th, $param_headingIndex, $param_preproc);
  // b <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a12($r7);
  } else {
    if (!$silence) { $this->fail(22); }
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r4 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsestart_with_headingIndex(&$param_th, &$param_headingIndex, &$param_preproc) {
  $key = json_encode([274, $param_th, $param_headingIndex, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  $r4 = $param_preproc;
  // start seq_1
  $r6 = [];
  for (;;) {
    $r7 = $this->parsetlb(true, $param_th, $param_headingIndex, $param_preproc);
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // t <- $r6
  // free $r7
  $r7 = [];
  for (;;) {
    $p9 = $this->currPos;
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r8 = true;
      $this->currPos++;
      goto choice_1;
    } else {
      $r8 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r8 = true;
      $this->currPos += 2;
    } else {
      $r8 = self::$FAILED;
    }
    choice_1:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a13($r6);
      $r7[] = $r8;
    } else {
      break;
    }
    // free $p9
  }
  // n <- $r7
  // free $r8
  $r5 = true;
  seq_1:
  $this->savedPos = $p1;
  $r5 = $this->a14($r6, $r7);
  // free $p1,$r2,$r3,$r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r4 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsePOSITION($silence) {
  $p2 = $this->currPos;
  $r1 = true;
  $this->savedPos = $p2;
  $r1 = $this->a15();
  // free $p2
  return $r1;
}
private function parseunreachable($silence) {
  $key = 480;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a16();
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = [$r3,''];
  seq_1:
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseurl_protocol($silence) {
  $key = 332;
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
    if (!$silence) { $this->fail(23); }
    $r3 = self::$FAILED;
  }
  // start seq_2
  $r5 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[A-Za-z]/A", $r5)) {
    $this->currPos++;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(24); }
    $r3 = self::$FAILED;
    goto seq_2;
  }
  $r6 = null;
  if (preg_match("/[+\\--.0-9A-Za-z]*/A", $this->input, $r6, 0, $this->currPos)) {
    $this->currPos += strlen($r6[0]);
    $r6 = true;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(25); }
  }
  if (($this->input[$this->currPos] ?? null) === ":") {
    $r7 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(26); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_2;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
    $r8 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(23); }
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
  $r8 = $this->a17($r3);
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
    $r2 = $this->a18($r3);
  }
  // free $r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseipv6urladdr($silence) {
  $key = 338;
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
    $r4 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(27); }
    $r4 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r5 = null;
  if (preg_match("/[.0-:A-Fa-f]+/A", $this->input, $r5, 0, $this->currPos)) {
    $this->currPos += strlen($r5[0]);
    $r5 = true;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(28); }
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "]") {
    $r6 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(29); }
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
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function discardinline_breaks($boolParams, $param_tagType, &$param_preproc, &$param_th) {
  // start seq_1
  $p2 = $this->currPos;
  $r3 = $param_preproc;
  $r4 = $param_th;
  if (strspn($this->input, "\x0a\x0d!-:;=[]{|}", $this->currPos, 1) !== 0) {
    $r5 = true;
    $r5 = false;
    $this->currPos = $p2;
    $param_preproc = $r3;
    $param_th = $r4;
  } else {
    $r5 = self::$FAILED;
    $r1 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $this->savedPos = $this->currPos;
  $r10 = $this->a19($param_tagType, /*h*/($boolParams & 0x2) !== 0, /*extlink*/($boolParams & 0x4) !== 0, $param_preproc, /*equal*/($boolParams & 0x8) !== 0, /*table*/($boolParams & 0x10) !== 0, /*templateArg*/($boolParams & 0x20) !== 0, /*tableCellArg*/($boolParams & 0x40) !== 0, /*semicolon*/($boolParams & 0x80) !== 0, /*arrow*/($boolParams & 0x100) !== 0, /*linkdesc*/($boolParams & 0x200) !== 0, /*colon*/($boolParams & 0x400) !== 0, $param_th);
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
    $this->currPos = $p2;
    $param_preproc = $r3;
    $param_th = $r4;
    $r1 = self::$FAILED;
    goto seq_1;
  }
  // free $r10
  // free $p7,$r8,$r9
  $r1 = true;
  seq_1:
  // free $r5,$r6
  // free $p2,$r3,$r4
  return $r1;
}
private function parsecomment($silence) {
  $key = 538;
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
    if (!$silence) { $this->fail(30); }
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $p5 = $this->currPos;
  for (;;) {
    // start choice_1
    $r6 = strcspn($this->input, "-", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      if (!$silence) { $this->fail(31); }
    }
    // start seq_2
    $p7 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r8 = true;
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
      if (!$silence) { $this->fail(17); }
      $this->currPos = $p7;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    // free $r8,$r9
    // free $p7
    choice_1:
    if ($r6===self::$FAILED) {
      break;
    }
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
  // start choice_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
    $r6 = true;
    $this->currPos += 3;
    goto choice_2;
  } else {
    if (!$silence) { $this->fail(32); }
    $r6 = self::$FAILED;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a20($r4);
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
  }
  choice_2:
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
    $r2 = $this->a21($r4, $r6);
  }
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetplarg_or_template($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc, &$param_headingIndex) {
  $key = json_encode([340, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "{") {
    $r6 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(33); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parseparsoid_fragment_marker($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r7 = true;
    $r7 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  // start choice_2
  // start seq_3
  $p8 = $this->currPos;
  $r9 = $param_th;
  $r10 = $param_preproc;
  $r11 = $param_headingIndex;
  // start seq_4
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r13 = true;
    $this->currPos += 2;
  } else {
    $r13 = self::$FAILED;
    $r12 = self::$FAILED;
    goto seq_4;
  }
  $p15 = $this->currPos;
  $r16 = $param_th;
  $r17 = $param_preproc;
  $r18 = $param_headingIndex;
  // start seq_5
  $r19 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r20 = true;
      $this->currPos += 3;
      $r19 = true;
    } else {
      $r20 = self::$FAILED;
      break;
    }
  }
  if ($r19===self::$FAILED) {
    $r14 = self::$FAILED;
    goto seq_5;
  }
  // free $r20
  $p21 = $this->currPos;
  $r22 = $param_th;
  $r23 = $param_preproc;
  $r24 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r20 = true;
  } else {
    $r20 = self::$FAILED;
  }
  if ($r20 === self::$FAILED) {
    $r20 = false;
  } else {
    $r20 = self::$FAILED;
    $this->currPos = $p21;
    $param_th = $r22;
    $param_preproc = $r23;
    $param_headingIndex = $r24;
    $this->currPos = $p15;
    $param_th = $r16;
    $param_preproc = $r17;
    $param_headingIndex = $r18;
    $r14 = self::$FAILED;
    goto seq_5;
  }
  // free $p21,$r22,$r23,$r24
  $r14 = true;
  seq_5:
  if ($r14!==self::$FAILED) {
    $r14 = false;
    $this->currPos = $p15;
    $param_th = $r16;
    $param_preproc = $r17;
    $param_headingIndex = $r18;
  } else {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $param_headingIndex = $r11;
    $r12 = self::$FAILED;
    goto seq_4;
  }
  // free $r19,$r20
  // free $p15,$r16,$r17,$r18
  // start seq_6
  $p15 = $this->currPos;
  $r17 = $param_th;
  $r16 = $param_preproc;
  $r20 = $param_headingIndex;
  $r19 = $this->input[$this->currPos] ?? '';
  if ($r19 === "{") {
    $r19 = false;
    $this->currPos = $p15;
    $param_th = $r17;
    $param_preproc = $r16;
    $param_headingIndex = $r20;
  } else {
    $r19 = self::$FAILED;
    $r18 = self::$FAILED;
    goto seq_6;
  }
  $r18 = $this->discardtplarg($boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r18===self::$FAILED) {
    $this->currPos = $p15;
    $param_th = $r17;
    $param_preproc = $r16;
    $param_headingIndex = $r20;
    $r18 = self::$FAILED;
    goto seq_6;
  }
  seq_6:
  if ($r18===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $param_headingIndex = $r11;
    $r12 = self::$FAILED;
    goto seq_4;
  }
  // free $p15,$r17,$r16,$r20
  $r12 = true;
  seq_4:
  if ($r12!==self::$FAILED) {
    $r12 = false;
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $param_headingIndex = $r11;
  } else {
    $r5 = self::$FAILED;
    goto seq_3;
  }
  // free $r13,$r14,$r18,$r19
  // start choice_3
  // start seq_7
  $p15 = $this->currPos;
  $r19 = $param_th;
  $r18 = $param_preproc;
  $r14 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "{") {
    $r13 = false;
    $this->currPos = $p15;
    $param_th = $r19;
    $param_preproc = $r18;
    $param_headingIndex = $r14;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(34); }
    $r5 = self::$FAILED;
    goto seq_7;
  }
  $r5 = $this->parsetemplate($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p15;
    $param_th = $r19;
    $param_preproc = $r18;
    $param_headingIndex = $r14;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  seq_7:
  if ($r5!==self::$FAILED) {
    goto choice_3;
  }
  // free $p15,$r19,$r18,$r14
  // start seq_8
  $p15 = $this->currPos;
  $r14 = $param_th;
  $r18 = $param_preproc;
  $r19 = $param_headingIndex;
  $r20 = $this->input[$this->currPos] ?? '';
  if ($r20 === "{") {
    $r20 = false;
    $this->currPos = $p15;
    $param_th = $r14;
    $param_preproc = $r18;
    $param_headingIndex = $r19;
  } else {
    $r20 = self::$FAILED;
    if (!$silence) { $this->fail(35); }
    $r5 = self::$FAILED;
    goto seq_8;
  }
  $r5 = $this->parsebroken_template($silence, $param_preproc);
  if ($r5===self::$FAILED) {
    $this->currPos = $p15;
    $param_th = $r14;
    $param_preproc = $r18;
    $param_headingIndex = $r19;
    $r5 = self::$FAILED;
    goto seq_8;
  }
  seq_8:
  // free $p15,$r14,$r18,$r19
  choice_3:
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_2;
  }
  // free $r13,$r20
  // free $p8,$r9,$r10,$r11
  // start seq_9
  $p8 = $this->currPos;
  $r11 = $param_th;
  $r10 = $param_preproc;
  $r9 = $param_headingIndex;
  $p15 = $this->currPos;
  // start seq_10
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r13 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(36); }
    $r13 = self::$FAILED;
    $r20 = self::$FAILED;
    goto seq_10;
  }
  $p21 = $this->currPos;
  $r18 = $param_th;
  $r14 = $param_preproc;
  $r16 = $param_headingIndex;
  // start seq_11
  $r17 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r24 = true;
      $this->currPos += 3;
      $r17 = true;
    } else {
      $r24 = self::$FAILED;
      break;
    }
  }
  if ($r17===self::$FAILED) {
    $r19 = self::$FAILED;
    goto seq_11;
  }
  // free $r24
  $p25 = $this->currPos;
  $r23 = $param_th;
  $r22 = $param_preproc;
  $r26 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r24 = true;
  } else {
    $r24 = self::$FAILED;
  }
  if ($r24 === self::$FAILED) {
    $r24 = false;
  } else {
    $r24 = self::$FAILED;
    $this->currPos = $p25;
    $param_th = $r23;
    $param_preproc = $r22;
    $param_headingIndex = $r26;
    $this->currPos = $p21;
    $param_th = $r18;
    $param_preproc = $r14;
    $param_headingIndex = $r16;
    $r19 = self::$FAILED;
    goto seq_11;
  }
  // free $p25,$r23,$r22,$r26
  $r19 = true;
  seq_11:
  if ($r19!==self::$FAILED) {
    $r19 = false;
    $this->currPos = $p21;
    $param_th = $r18;
    $param_preproc = $r14;
    $param_headingIndex = $r16;
  } else {
    $this->currPos = $p8;
    $param_th = $r11;
    $param_preproc = $r10;
    $param_headingIndex = $r9;
    $r20 = self::$FAILED;
    goto seq_10;
  }
  // free $r17,$r24
  // free $p21,$r18,$r14,$r16
  $r20 = true;
  seq_10:
  if ($r20===self::$FAILED) {
    $r20 = null;
  }
  // free $r13,$r19
  $r20 = substr($this->input, $p15, $this->currPos - $p15);
  // free $p15
  // start seq_12
  $p15 = $this->currPos;
  $r13 = $param_th;
  $r16 = $param_preproc;
  $r14 = $param_headingIndex;
  $r18 = $this->input[$this->currPos] ?? '';
  if ($r18 === "{") {
    $r18 = false;
    $this->currPos = $p15;
    $param_th = $r13;
    $param_preproc = $r16;
    $param_headingIndex = $r14;
  } else {
    $r18 = self::$FAILED;
    if (!$silence) { $this->fail(37); }
    $r19 = self::$FAILED;
    goto seq_12;
  }
  $r19 = $this->parsetplarg($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r19===self::$FAILED) {
    $this->currPos = $p15;
    $param_th = $r13;
    $param_preproc = $r16;
    $param_headingIndex = $r14;
    $r19 = self::$FAILED;
    goto seq_12;
  }
  seq_12:
  if ($r19===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r11;
    $param_preproc = $r10;
    $param_headingIndex = $r9;
    $r5 = self::$FAILED;
    goto seq_9;
  }
  // free $p15,$r13,$r16,$r14
  $r5 = [$r20,$r19];
  seq_9:
  if ($r5!==self::$FAILED) {
    goto choice_2;
  }
  // free $r20,$r19,$r18
  // free $p8,$r11,$r10,$r9
  // start seq_13
  $p8 = $this->currPos;
  $r9 = $param_th;
  $r10 = $param_preproc;
  $r11 = $param_headingIndex;
  $p15 = $this->currPos;
  // start seq_14
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r19 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(36); }
    $r19 = self::$FAILED;
    $r18 = self::$FAILED;
    goto seq_14;
  }
  $p21 = $this->currPos;
  $r14 = $param_th;
  $r16 = $param_preproc;
  $r13 = $param_headingIndex;
  // start seq_15
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r24 = true;
    $this->currPos += 2;
  } else {
    $r24 = self::$FAILED;
    $r20 = self::$FAILED;
    goto seq_15;
  }
  $p25 = $this->currPos;
  $r26 = $param_th;
  $r22 = $param_preproc;
  $r23 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r17 = true;
  } else {
    $r17 = self::$FAILED;
  }
  if ($r17 === self::$FAILED) {
    $r17 = false;
  } else {
    $r17 = self::$FAILED;
    $this->currPos = $p25;
    $param_th = $r26;
    $param_preproc = $r22;
    $param_headingIndex = $r23;
    $this->currPos = $p21;
    $param_th = $r14;
    $param_preproc = $r16;
    $param_headingIndex = $r13;
    $r20 = self::$FAILED;
    goto seq_15;
  }
  // free $p25,$r26,$r22,$r23
  $r20 = true;
  seq_15:
  if ($r20!==self::$FAILED) {
    $r20 = false;
    $this->currPos = $p21;
    $param_th = $r14;
    $param_preproc = $r16;
    $param_headingIndex = $r13;
  } else {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $param_headingIndex = $r11;
    $r18 = self::$FAILED;
    goto seq_14;
  }
  // free $r24,$r17
  // free $p21,$r14,$r16,$r13
  $r18 = true;
  seq_14:
  if ($r18===self::$FAILED) {
    $r18 = null;
  }
  // free $r19,$r20
  $r18 = substr($this->input, $p15, $this->currPos - $p15);
  // free $p15
  // start seq_16
  $p15 = $this->currPos;
  $r19 = $param_th;
  $r13 = $param_preproc;
  $r16 = $param_headingIndex;
  $r14 = $this->input[$this->currPos] ?? '';
  if ($r14 === "{") {
    $r14 = false;
    $this->currPos = $p15;
    $param_th = $r19;
    $param_preproc = $r13;
    $param_headingIndex = $r16;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(34); }
    $r20 = self::$FAILED;
    goto seq_16;
  }
  $r20 = $this->parsetemplate($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r20===self::$FAILED) {
    $this->currPos = $p15;
    $param_th = $r19;
    $param_preproc = $r13;
    $param_headingIndex = $r16;
    $r20 = self::$FAILED;
    goto seq_16;
  }
  seq_16:
  if ($r20===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_preproc = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_13;
  }
  // free $p15,$r19,$r13,$r16
  $r5 = [$r18,$r20];
  seq_13:
  if ($r5!==self::$FAILED) {
    goto choice_2;
  }
  // free $r18,$r20,$r14
  // free $p8,$r9,$r10,$r11
  // start seq_17
  $p8 = $this->currPos;
  $r11 = $param_th;
  $r10 = $param_preproc;
  $r9 = $param_headingIndex;
  $r14 = $this->input[$this->currPos] ?? '';
  if ($r14 === "{") {
    $r14 = false;
    $this->currPos = $p8;
    $param_th = $r11;
    $param_preproc = $r10;
    $param_headingIndex = $r9;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(35); }
    $r5 = self::$FAILED;
    goto seq_17;
  }
  $r5 = $this->parsebroken_template($silence, $param_preproc);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r11;
    $param_preproc = $r10;
    $param_headingIndex = $r9;
    $r5 = self::$FAILED;
    goto seq_17;
  }
  seq_17:
  // free $p8,$r11,$r10,$r9
  choice_2:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // free $r12,$r14
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsehtmlentity($silence) {
  $key = 510;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r4 = $this->input[$this->currPos] ?? '';
  if ($r4 === "&") {
    $r4 = false;
    $this->currPos = $p1;
  } else {
    $r4 = self::$FAILED;
    if (!$silence) { $this->fail(38); }
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = $this->parseraw_htmlentity($silence);
  if ($r3===self::$FAILED) {
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  // cc <- $r3
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a22($r3);
  }
  // free $r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_attribute($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([440, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r6;
  $r7 = $this->parsePOSITION(true);
  // namePos0 <- $r7
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  if (strcspn($this->input, "\x00\x09\x0a\x0d />", $this->currPos, 1) !== 0) {
    $r13 = true;
    $r13 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r13 = self::$FAILED;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->parsetable_attribute_name($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // name <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r10,$r11,$r12
  $r12 = $this->parsePOSITION(true);
  // namePos1 <- $r12
  // start seq_3
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r14 = $param_th;
  $r15 = $param_headingIndex;
  $r16 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r16;
  if (($this->input[$this->currPos] ?? null) === "=") {
    $r17 = true;
    $this->currPos++;
  } else {
    $r17 = self::$FAILED;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r14;
    $param_headingIndex = $r15;
    $r11 = self::$FAILED;
    goto seq_3;
  }
  // start seq_4
  $p18 = $this->currPos;
  $r19 = $param_preproc;
  $r20 = $param_th;
  $r21 = $param_headingIndex;
  if (strcspn($this->input, "\x0a\x0c\x0d|", $this->currPos, 1) !== 0) {
    $r22 = true;
    $r22 = false;
    $this->currPos = $p18;
    $param_preproc = $r19;
    $param_th = $r20;
    $param_headingIndex = $r21;
  } else {
    $r22 = self::$FAILED;
    $r11 = self::$FAILED;
    goto seq_4;
  }
  $r11 = $this->parsetable_att_value($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r11===self::$FAILED) {
    $this->currPos = $p18;
    $param_preproc = $r19;
    $param_th = $r20;
    $param_headingIndex = $r21;
    $r11 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // free $p18,$r19,$r20,$r21
  seq_3:
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // free $r22
  // free $p9,$r10,$r14,$r15
  // vd <- $r11
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a23($r7, $r8, $r12, $r11);
  }
  // free $r6,$r13,$r16,$r17
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsebroken_table_attribute_name_char() {
  $key = 446;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // c <- $r3
  if (strspn($this->input, "\x00/=>", $this->currPos, 1) !== 0) {
    $r3 = $this->input[$this->currPos];
    $this->currPos++;
  } else {
    $r3 = self::$FAILED;
  }
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a24($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsegeneric_newline_attribute($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([438, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  for (;;) {
    // start seq_2
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    if (strspn($this->input, "\x09\x0a\x0c\x0d /", $this->currPos, 1) !== 0) {
      $r12 = true;
      $r12 = false;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
    } else {
      $r12 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->discardspace_or_newline_or_solidus();
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7===self::$FAILED) {
      break;
    }
    // free $p8,$r9,$r10,$r11
  }
  // free $r7
  // free $r12
  $r6 = true;
  // free $r6
  $r6 = $this->parsePOSITION(true);
  // namePos0 <- $r6
  // start seq_3
  $p8 = $this->currPos;
  $r7 = $param_preproc;
  $r11 = $param_th;
  $r10 = $param_headingIndex;
  if (strcspn($this->input, "\x00\x09\x0a\x0d />", $this->currPos, 1) !== 0) {
    $r9 = true;
    $r9 = false;
    $this->currPos = $p8;
    $param_preproc = $r7;
    $param_th = $r11;
    $param_headingIndex = $r10;
  } else {
    $r9 = self::$FAILED;
    $r12 = self::$FAILED;
    goto seq_3;
  }
  $r12 = $this->parsegeneric_attribute_name($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r7;
    $param_th = $r11;
    $param_headingIndex = $r10;
    $r12 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  // name <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r7,$r11,$r10
  $r10 = $this->parsePOSITION(true);
  // namePos1 <- $r10
  $r11 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  $this->currPos += $r11;
  $p8 = $this->currPos;
  $r13 = $param_preproc;
  $r14 = $param_th;
  $r15 = $param_headingIndex;
  $r7 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7 === self::$FAILED) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r13;
    $param_th = $r14;
    $param_headingIndex = $r15;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r13,$r14,$r15
  // start seq_4
  $p8 = $this->currPos;
  $r14 = $param_preproc;
  $r13 = $param_th;
  $r16 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "=") {
    $r17 = true;
    $this->currPos++;
  } else {
    $r17 = self::$FAILED;
    $r15 = self::$FAILED;
    goto seq_4;
  }
  // start seq_5
  $p18 = $this->currPos;
  $r19 = $param_preproc;
  $r20 = $param_th;
  $r21 = $param_headingIndex;
  $r22 = self::charAt($this->input, $this->currPos);
  if ($r22 !== '' && !($r22 === ">")) {
    $r22 = false;
    $this->currPos = $p18;
    $param_preproc = $r19;
    $param_th = $r20;
    $param_headingIndex = $r21;
  } else {
    $r22 = self::$FAILED;
    $r15 = self::$FAILED;
    goto seq_5;
  }
  $r15 = $this->parsegeneric_att_value($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r15===self::$FAILED) {
    $this->currPos = $p18;
    $param_preproc = $r19;
    $param_th = $r20;
    $param_headingIndex = $r21;
    $r15 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  if ($r15===self::$FAILED) {
    $r15 = null;
  }
  // free $p18,$r19,$r20,$r21
  seq_4:
  if ($r15===self::$FAILED) {
    $r15 = null;
  }
  // free $r22
  // free $p8,$r14,$r13,$r16
  // vd <- $r15
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a25($r6, $r12, $r10, $r15);
  }
  // free $r9,$r11,$r7,$r17
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseextlink_nonipv6url($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([520, $boolParams & 0x1dff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (preg_match("/[^\\x09-\\x0a\\x0d \"\\[\\]\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r6, 0, $this->currPos)) {
    $r6 = $r6[0];
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parseextlink_nonipv6url_parameterized($boolParams & ~0x200, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseinlineline($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([306, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->parseurltext($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "'-<[{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(39); }
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parseinline_element($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p13,$r14,$r15,$r16
    // start seq_3
    $p13 = $this->currPos;
    $r16 = $param_preproc;
    $r15 = $param_th;
    $r14 = $param_headingIndex;
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r18 = true;
      goto choice_3;
    } else {
      $r18 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r18 = true;
    } else {
      $r18 = self::$FAILED;
    }
    choice_3:
    if ($r18 === self::$FAILED) {
      $r18 = false;
    } else {
      $r18 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r16;
      $param_th = $r15;
      $param_headingIndex = $r14;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    if ($this->currPos < $this->inputLength) {
      $r7 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(17); }
      $this->currPos = $p13;
      $param_preproc = $r16;
      $param_th = $r15;
      $param_headingIndex = $r14;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    // free $p13,$r16,$r15,$r14
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r17,$r18
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // c <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a26($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsedtdd($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([464, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = [];
  for (;;) {
    // start seq_2
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    // start seq_3
    if (($this->input[$this->currPos] ?? null) === ";") {
      $r13 = true;
      $this->currPos++;
    } else {
      $r13 = self::$FAILED;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    $p15 = $this->currPos;
    $r16 = $param_preproc;
    $r17 = $param_th;
    $r18 = $param_headingIndex;
    if (strspn($this->input, "#*:;", $this->currPos, 1) !== 0) {
      $r14 = true;
    } else {
      $r14 = self::$FAILED;
    }
    if ($r14 === self::$FAILED) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p15;
      $param_preproc = $r16;
      $param_th = $r17;
      $param_headingIndex = $r18;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    // free $p15,$r16,$r17,$r18
    $r12 = true;
    seq_3:
    // free $r13,$r14
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    if (strspn($this->input, "#*:;", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(40); }
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
    // free $p8,$r9,$r10,$r11
  }
  // bullets <- $r6
  // free $r7
  // free $r12
  if (($this->input[$this->currPos] ?? null) === ";") {
    $r12 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(41); }
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    $r11 = $this->parsedtdd_colon($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r11!==self::$FAILED) {
      $r7[] = $r11;
    } else {
      break;
    }
  }
  // colons <- $r7
  // free $r11
  $r11 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // d <- $r11
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r14 = $param_th;
  $r13 = $param_headingIndex;
  // start choice_1
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r10 = true;
    goto choice_2;
  } else {
    $r10 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r10 = true;
  } else {
    $r10 = self::$FAILED;
  }
  choice_2:
  if ($r10!==self::$FAILED) {
    goto choice_1;
  }
  $this->savedPos = $this->currPos;
  $r10 = $this->a27($r6, $r7, $r11);
  if ($r10) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
  }
  choice_1:
  if ($r10!==self::$FAILED) {
    $r10 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r14;
    $param_headingIndex = $r13;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r14,$r13
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a28($r6, $r7, $r11);
  }
  // free $r12,$r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsehacky_dl_uses($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([460, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = [];
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === ":") {
      $r7 = ":";
      $this->currPos++;
      $r6[] = $r7;
    } else {
      if (!$silence) { $this->fail(26); }
      $r7 = self::$FAILED;
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // bullets <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r7
  $r7 = [];
  for (;;) {
    // start choice_1
    $r8 = $this->input[$this->currPos] ?? '';
    if ($r8 === "\x09" || $r8 === " ") {
      $this->currPos++;
      goto choice_1;
    } else {
      $r8 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "<") {
      $r13 = false;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
    } else {
      $r13 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = $this->parsecomment($silence);
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    // free $p9,$r10,$r11,$r12
    choice_1:
    if ($r8!==self::$FAILED) {
      $r7[] = $r8;
    } else {
      break;
    }
  }
  // sc <- $r7
  // free $r8
  // free $r13
  $p9 = $this->currPos;
  $r8 = $param_preproc;
  $r12 = $param_th;
  $r11 = $param_headingIndex;
  $r13 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r13 === self::$FAILED) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $this->currPos = $p9;
    $param_preproc = $r8;
    $param_th = $r12;
    $param_headingIndex = $r11;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r8,$r12,$r11
  // start seq_3
  $p9 = $this->currPos;
  $r12 = $param_preproc;
  $r8 = $param_th;
  $r10 = $param_headingIndex;
  $r14 = $this->input[$this->currPos] ?? '';
  if ($r14 === "{") {
    $r14 = false;
    $this->currPos = $p9;
    $param_preproc = $r12;
    $param_th = $r8;
    $param_headingIndex = $r10;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(6); }
    $r11 = self::$FAILED;
    goto seq_3;
  }
  $r11 = $this->parsetable_start_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r11===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r12;
    $param_th = $r8;
    $param_headingIndex = $r10;
    $r11 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  // tbl <- $r11
  if ($r11===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r12,$r8,$r10
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a29($r6, $r7, $r11);
  }
  // free $r13,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseli($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([458, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = strspn($this->input, "#*:;", $this->currPos);
  // bullets <- $r6
  if ($r6 > 0) {
    $this->currPos += $r6;
    $r6 = substr($this->input, $this->currPos - $r6, $r6);
    $r6 = str_split($r6);
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(40); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r7===self::$FAILED) {
    $r7 = null;
  }
  // c <- $r7
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  // start choice_1
  // start choice_2
  // start choice_3
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r8 = true;
    goto choice_3;
  } else {
    $r8 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r8 = true;
  } else {
    $r8 = self::$FAILED;
  }
  choice_3:
  if ($r8!==self::$FAILED) {
    goto choice_2;
  }
  $this->savedPos = $this->currPos;
  $r8 = $this->a30($r6, $r7);
  if ($r8) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
  }
  choice_2:
  if ($r8!==self::$FAILED) {
    goto choice_1;
  }
  $r8 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  choice_1:
  if ($r8!==self::$FAILED) {
    $r8 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r10,$r11,$r12
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a31($r6, $r7);
  }
  // free $r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseblock($silence, $boolParams, $param_tagType, &$param_th, &$param_headingIndex, &$param_preproc) {
  $key = json_encode([288, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  $r4 = $param_preproc;
  // start choice_1
  // start seq_1
  $this->savedPos = $this->currPos;
  $r6 = $this->a32();
  if ($r6) {
    $r6 = false;
    $r6 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_th;
  $r10 = $param_headingIndex;
  $r11 = $param_preproc;
  if (strcspn($this->input, "\x0c:[", $this->currPos, 1) !== 0) {
    $r12 = true;
    $r12 = false;
    $this->currPos = $p8;
    $param_th = $r9;
    $param_headingIndex = $r10;
    $param_preproc = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(42); }
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parseredirect($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex, $param_preproc);
  if ($r7===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r9;
    $param_headingIndex = $r10;
    $param_preproc = $r11;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // r <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10,$r11
  $r11 = [];
  for (;;) {
    // start seq_3
    $p8 = $this->currPos;
    $r9 = $param_th;
    $r13 = $param_headingIndex;
    $r14 = $param_preproc;
    $r15 = $this->input[$this->currPos] ?? '';
    if ($r15 === "<" || $r15 === "_") {
      $r15 = false;
      $this->currPos = $p8;
      $param_th = $r9;
      $param_headingIndex = $r13;
      $param_preproc = $r14;
    } else {
      $r15 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $r10 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r10===self::$FAILED) {
      $this->currPos = $p8;
      $param_th = $r9;
      $param_headingIndex = $r13;
      $param_preproc = $r14;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r10!==self::$FAILED) {
      $r11[] = $r10;
    } else {
      break;
    }
    // free $p8,$r9,$r13,$r14
  }
  // cil <- $r11
  // free $r10
  // free $r15
  // start seq_4
  $p8 = $this->currPos;
  $r10 = $param_th;
  $r14 = $param_headingIndex;
  $r13 = $param_preproc;
  if (strspn($this->input, "\x09 !#*-:;<={|", $this->currPos, 1) !== 0) {
    $r9 = true;
    $r9 = false;
    $this->currPos = $p8;
    $param_th = $r10;
    $param_headingIndex = $r14;
    $param_preproc = $r13;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(44); }
    $r15 = self::$FAILED;
    goto seq_4;
  }
  $r15 = $this->parseblock_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r15===self::$FAILED) {
    $this->currPos = $p8;
    $param_th = $r10;
    $param_headingIndex = $r14;
    $param_preproc = $r13;
    $r15 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r15===self::$FAILED) {
    $r15 = null;
  }
  // free $p8,$r10,$r14,$r13
  // bl <- $r15
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a33($r7, $r11, $r15);
    goto choice_1;
  }
  // free $r6,$r12,$r9
  // start seq_5
  if (strspn($this->input, "\x09\x0a\x0d !#*-:;<=_{|", $this->currPos, 1) !== 0) {
    $r9 = true;
    $r9 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(45); }
    $r5 = self::$FAILED;
    goto seq_5;
  }
  $r5 = $this->parseblock_lines($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  $r5 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_6
  // start choice_2
  if (/*tableCaption*/($boolParams & 0x1000) !== 0) {
    $r12 = false;
    goto choice_2;
  } else {
    $r12 = self::$FAILED;
  }
  if (/*fullTable*/($boolParams & 0x800) !== 0) {
    $r12 = false;
    goto choice_2;
  } else {
    $r12 = self::$FAILED;
  }
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r12 = false;
  } else {
    $r12 = self::$FAILED;
  }
  choice_2:
  if ($r12===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_6;
  }
  $p8 = $this->currPos;
  // start seq_7
  $p16 = $this->currPos;
  $r6 = $param_th;
  $r13 = $param_headingIndex;
  $r14 = $param_preproc;
  $this->savedPos = $this->currPos;
  $r10 = $this->a34();
  if ($r10) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  // start choice_3
  $p18 = $this->currPos;
  // start choice_4
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r17 = true;
    $this->currPos++;
    goto choice_4;
  } else {
    if (!$silence) { $this->fail(46); }
    $r17 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r17 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(47); }
    $r17 = self::$FAILED;
  }
  choice_4:
  if ($r17!==self::$FAILED) {
    $this->savedPos = $p18;
    $r17 = $this->a35();
    goto choice_3;
  }
  // free $p18
  $p18 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r17 = $this->a36();
  if ($r17) {
    $r17 = false;
    $this->savedPos = $p18;
    $r17 = $this->a37();
  } else {
    $r17 = self::$FAILED;
  }
  // free $p18
  choice_3:
  // sp <- $r17
  if ($r17===self::$FAILED) {
    $this->currPos = $p16;
    $param_th = $r6;
    $param_headingIndex = $r13;
    $param_preproc = $r14;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  // start seq_8
  $p18 = $this->currPos;
  $r20 = $param_th;
  $r21 = $param_headingIndex;
  $r22 = $param_preproc;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r23 = true;
    $r23 = false;
    $this->currPos = $p18;
    $param_th = $r20;
    $param_headingIndex = $r21;
    $param_preproc = $r22;
  } else {
    $r23 = self::$FAILED;
    if (!$silence) { $this->fail(48); }
    $r19 = self::$FAILED;
    goto seq_8;
  }
  $r19 = $this->parseempty_lines_with_comments($silence);
  if ($r19===self::$FAILED) {
    $this->currPos = $p18;
    $param_th = $r20;
    $param_headingIndex = $r21;
    $param_preproc = $r22;
    $r19 = self::$FAILED;
    goto seq_8;
  }
  seq_8:
  if ($r19===self::$FAILED) {
    $r19 = null;
  }
  // free $p18,$r20,$r21,$r22
  // elc <- $r19
  $r22 = [];
  for (;;) {
    // start seq_9
    $p18 = $this->currPos;
    $r20 = $param_th;
    $r24 = $param_headingIndex;
    $r25 = $param_preproc;
    $r26 = $this->input[$this->currPos] ?? '';
    if ($r26 === "<" || $r26 === "_") {
      $r26 = false;
      $this->currPos = $p18;
      $param_th = $r20;
      $param_headingIndex = $r24;
      $param_preproc = $r25;
    } else {
      $r26 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $r21 = self::$FAILED;
      goto seq_9;
    }
    $r21 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r21===self::$FAILED) {
      $this->currPos = $p18;
      $param_th = $r20;
      $param_headingIndex = $r24;
      $param_preproc = $r25;
      $r21 = self::$FAILED;
      goto seq_9;
    }
    seq_9:
    if ($r21!==self::$FAILED) {
      $r22[] = $r21;
    } else {
      break;
    }
    // free $p18,$r20,$r24,$r25
  }
  // st <- $r22
  // free $r21
  // free $r26
  $r5 = true;
  seq_7:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p8;
    $r5 = $this->a38($r17, $r19, $r22);
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  // free $r10,$r23
  // free $p16,$r6,$r13,$r14
  // free $p8
  $p8 = $this->currPos;
  $r13 = $param_th;
  $r6 = $param_headingIndex;
  $r23 = $param_preproc;
  $this->savedPos = $this->currPos;
  $r14 = $this->a32();
  if ($r14) {
    $r14 = false;
  } else {
    $r14 = self::$FAILED;
  }
  if ($r14 === self::$FAILED) {
    $r14 = false;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p8;
    $param_th = $r13;
    $param_headingIndex = $r6;
    $param_preproc = $r23;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  // free $p8,$r13,$r6,$r23
  $p8 = $this->currPos;
  $r6 = $param_th;
  $r13 = $param_headingIndex;
  $r10 = $param_preproc;
  $r23 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r23 === self::$FAILED) {
    $r23 = false;
  } else {
    $r23 = self::$FAILED;
    $this->currPos = $p8;
    $param_th = $r6;
    $param_headingIndex = $r13;
    $param_preproc = $r10;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  // free $p8,$r6,$r13,$r10
  $this->discardnotempty();
  seq_6:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r4 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseparsoid_fragment_marker($silence) {
  $key = 350;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p4 = $this->currPos;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{#parsoid\x00fragment:", $this->currPos, 20, false) === 0) {
    $r5 = true;
    $this->currPos += 20;
  } else {
    if (!$silence) { $this->fail(49); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r6 = strspn($this->input, "0123456789", $this->currPos);
  if ($r6 > 0) {
    $this->currPos += $r6;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(50); }
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
    $r7 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(51); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  // marker <- $r3
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
    $r2 = $this->a39($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardtplarg($boolParams, $param_tagType, &$param_th, &$param_headingIndex) {
  $key = json_encode([353, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  // start seq_1
  $r5 = $this->input[$this->currPos] ?? '';
  if ($r5 === "{") {
    $r5 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
  } else {
    $r5 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->discardtplarg_preproc($boolParams, $param_tagType, self::newRef("}}"), $param_th, $param_headingIndex);
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsetemplate($silence, $boolParams, $param_tagType, &$param_th, &$param_headingIndex) {
  $key = json_encode([344, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  // start seq_1
  $r5 = $this->input[$this->currPos] ?? '';
  if ($r5 === "{") {
    $r5 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(52); }
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsetemplate_preproc($silence, $boolParams, $param_tagType, self::newRef("}}"), $param_th, $param_headingIndex);
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parsebroken_template($silence, &$param_preproc) {
  $key = json_encode([346, $param_preproc]);
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
    if (!$silence) { $this->fail(53); }
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
    $r3 = $this->a40($param_preproc, $r4);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsetplarg($silence, $boolParams, $param_tagType, &$param_th, &$param_headingIndex) {
  $key = json_encode([352, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  // start seq_1
  $r5 = $this->input[$this->currPos] ?? '';
  if ($r5 === "{") {
    $r5 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(54); }
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsetplarg_preproc($silence, $boolParams, $param_tagType, self::newRef("}}"), $param_th, $param_headingIndex);
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r4;
}
private function parseraw_htmlentity($silence) {
  $key = 508;
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
    $r5 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(14); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r6 = null;
  if (preg_match("/[#0-9A-Za-z\\x{5dc}\\x{5de}\\x{5e8}\\x{631}\\x{644}-\\x{645}]+/Au", $this->input, $r6, 0, $this->currPos)) {
    $this->currPos += strlen($r6[0]);
    $r6 = true;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(55); }
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === ";") {
    $r7 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(41); }
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
    $r2 = $this->a41($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_attribute_name($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([448, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start choice_1
  $p7 = $this->currPos;
  if (strspn($this->input, "\"'=", $this->currPos, 1) !== 0) {
    $r6 = true;
    $this->currPos++;
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
    goto choice_1;
  } else {
    $r6 = self::$FAILED;
    $r6 = self::$FAILED;
  }
  // free $p7
  // start seq_2
  if (strcspn($this->input, "\x00\x09\x0a\x0d /=>", $this->currPos, 1) !== 0) {
    $r8 = true;
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parsetable_attribute_name_piece($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  choice_1:
  // first <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r9 = [];
  for (;;) {
    // start seq_3
    $p7 = $this->currPos;
    $r11 = $param_preproc;
    $r12 = $param_th;
    $r13 = $param_headingIndex;
    if (strcspn($this->input, "\x00\x09\x0a\x0d /=>", $this->currPos, 1) !== 0) {
      $r14 = true;
      $r14 = false;
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r12;
      $param_headingIndex = $r13;
    } else {
      $r14 = self::$FAILED;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $r10 = $this->parsetable_attribute_name_piece($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r10===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r12;
      $param_headingIndex = $r13;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r10!==self::$FAILED) {
      $r9[] = $r10;
    } else {
      break;
    }
    // free $p7,$r11,$r12,$r13
  }
  // rest <- $r9
  // free $r10
  // free $r14
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a42($r6, $r9);
  }
  // free $r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_att_value($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([454, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $p7 = $this->currPos;
  // start seq_2
  $r8 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r8;
  if (($this->input[$this->currPos] ?? null) === "'") {
    $r9 = true;
    $this->currPos++;
  } else {
    $r9 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  // s <- $r6
  if ($r6!==self::$FAILED) {
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r8,$r9
  // free $p7
  $r9 = $this->parsetable_attribute_preprocessor_text_single($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r9===self::$FAILED) {
    $r9 = null;
  }
  // t <- $r9
  $p7 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "'") {
    $r8 = true;
    $this->currPos++;
    goto choice_2;
  } else {
    $r8 = self::$FAILED;
  }
  $p10 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  // start choice_3
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
    $r8 = true;
    goto choice_3;
  } else {
    $r8 = self::$FAILED;
  }
  if (strspn($this->input, "\x0a\x0d|", $this->currPos, 1) !== 0) {
    $r8 = true;
  } else {
    $r8 = self::$FAILED;
  }
  choice_3:
  if ($r8!==self::$FAILED) {
    $r8 = false;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  }
  // free $p10,$r11,$r12,$r13
  choice_2:
  // q <- $r8
  if ($r8!==self::$FAILED) {
    $r8 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a43($r6, $r9, $r8);
    goto choice_1;
  }
  // start seq_3
  $p7 = $this->currPos;
  // start seq_4
  $r12 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r12;
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $r11 = true;
    $this->currPos++;
  } else {
    $r11 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r13 = self::$FAILED;
    goto seq_4;
  }
  $r13 = true;
  seq_4:
  // s <- $r13
  if ($r13!==self::$FAILED) {
    $r13 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r13 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  // free $r12,$r11
  // free $p7
  $r11 = $this->parsetable_attribute_preprocessor_text_double($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // t <- $r11
  $p7 = $this->currPos;
  // start choice_4
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $r12 = true;
    $this->currPos++;
    goto choice_4;
  } else {
    $r12 = self::$FAILED;
  }
  $p10 = $this->currPos;
  $r14 = $param_preproc;
  $r15 = $param_th;
  $r16 = $param_headingIndex;
  // start choice_5
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
    $r12 = true;
    goto choice_5;
  } else {
    $r12 = self::$FAILED;
  }
  if (strspn($this->input, "\x0a\x0d|", $this->currPos, 1) !== 0) {
    $r12 = true;
  } else {
    $r12 = self::$FAILED;
  }
  choice_5:
  if ($r12!==self::$FAILED) {
    $r12 = false;
    $this->currPos = $p10;
    $param_preproc = $r14;
    $param_th = $r15;
    $param_headingIndex = $r16;
  }
  // free $p10,$r14,$r15,$r16
  choice_4:
  // q <- $r12
  if ($r12!==self::$FAILED) {
    $r12 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  // free $p7
  $r5 = true;
  seq_3:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a43($r13, $r11, $r12);
    goto choice_1;
  }
  // start seq_5
  $p7 = $this->currPos;
  $r16 = strspn($this->input, "\x09 ", $this->currPos);
  // s <- $r16
  $this->currPos += $r16;
  $r16 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start seq_6
  $p7 = $this->currPos;
  $r14 = $param_preproc;
  $r17 = $param_th;
  $r18 = $param_headingIndex;
  if (strcspn($this->input, "\x09\x0a\x0c\x0d |", $this->currPos, 1) !== 0) {
    $r19 = true;
    $r19 = false;
    $this->currPos = $p7;
    $param_preproc = $r14;
    $param_th = $r17;
    $param_headingIndex = $r18;
  } else {
    $r19 = self::$FAILED;
    $r15 = self::$FAILED;
    goto seq_6;
  }
  $r15 = $this->parsetable_attribute_preprocessor_text($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r15===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r14;
    $param_th = $r17;
    $param_headingIndex = $r18;
    $r15 = self::$FAILED;
    goto seq_6;
  }
  seq_6:
  // t <- $r15
  if ($r15===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // free $p7,$r14,$r17,$r18
  $p7 = $this->currPos;
  $r17 = $param_preproc;
  $r14 = $param_th;
  $r20 = $param_headingIndex;
  // start choice_6
  if (strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos, 1) !== 0) {
    $r18 = true;
    goto choice_6;
  } else {
    $r18 = self::$FAILED;
  }
  $this->savedPos = $this->currPos;
  $r18 = $this->a44($r16, $r15);
  if ($r18) {
    $r18 = false;
    goto choice_6;
  } else {
    $r18 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
    $r18 = true;
    goto choice_6;
  } else {
    $r18 = self::$FAILED;
  }
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r18 = true;
  } else {
    $r18 = self::$FAILED;
  }
  choice_6:
  if ($r18!==self::$FAILED) {
    $r18 = false;
    $this->currPos = $p7;
    $param_preproc = $r17;
    $param_th = $r14;
    $param_headingIndex = $r20;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // free $p7,$r17,$r14,$r20
  $r5 = true;
  seq_5:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a45($r16, $r15);
  }
  // free $r19,$r18
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardspace_or_newline_or_solidus() {
  $key = 433;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start choice_1
  if (strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos, 1) !== 0) {
    $r2 = true;
    $this->currPos++;
    goto choice_1;
  } else {
    $r2 = self::$FAILED;
  }
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "/") {
    $r2 = true;
    $this->currPos++;
  } else {
    $r2 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $p4 = $this->currPos;
  if (($this->input[$this->currPos] ?? null) === ">") {
    $r3 = true;
  } else {
    $r3 = self::$FAILED;
  }
  if ($r3 === self::$FAILED) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $this->currPos = $p4;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p4
  seq_1:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsegeneric_attribute_name($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([444, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start choice_1
  $p7 = $this->currPos;
  if (strspn($this->input, "\"'=", $this->currPos, 1) !== 0) {
    $r6 = true;
    $this->currPos++;
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
    goto choice_1;
  } else {
    $r6 = self::$FAILED;
    $r6 = self::$FAILED;
  }
  // free $p7
  // start choice_2
  $p7 = $this->currPos;
  $r6 = strcspn($this->input, "\x00\x09\x0a\x0d !&-/<=>{|}", $this->currPos);
  if ($r6 > 0) {
    $this->currPos += $r6;
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
    goto choice_2;
  } else {
    $r6 = self::$FAILED;
    $r6 = self::$FAILED;
  }
  // free $p7
  // start seq_2
  $r8 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r8 === self::$FAILED) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start choice_3
  // start seq_3
  $p7 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
    $r12 = true;
    $r12 = false;
    $this->currPos = $p7;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_3;
  }
  $r6 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r6 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r6!==self::$FAILED) {
    goto choice_3;
  }
  // free $p7,$r9,$r10,$r11
  // start seq_4
  $p7 = $this->currPos;
  $r11 = $param_preproc;
  $r10 = $param_th;
  $r9 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "<") {
    $r13 = false;
    $this->currPos = $p7;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
  } else {
    $r13 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_4;
  }
  $r6 = $this->parseless_than($param_tagType);
  if ($r6===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
    $r6 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r6!==self::$FAILED) {
    goto choice_3;
  }
  // free $p7,$r11,$r10,$r9
  $p7 = $this->currPos;
  // start seq_5
  $p14 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r15 = true;
  if ($r15!==self::$FAILED) {
    $r15 = false;
    $this->currPos = $p14;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  }
  if (strcspn($this->input, "\x00\x09\x0a\x0c\x0d /<=>", $this->currPos, 1) !== 0) {
    $r16 = true;
    self::advanceChar($this->input, $this->currPos);
  } else {
    $r16 = self::$FAILED;
    $this->currPos = $p14;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r6 = self::$FAILED;
    goto seq_5;
  }
  $r6 = true;
  seq_5:
  if ($r6!==self::$FAILED) {
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r6 = self::$FAILED;
  }
  // free $r15,$r16
  // free $p14,$r9,$r10,$r11
  // free $p7
  choice_3:
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // free $r12,$r13
  choice_2:
  choice_1:
  // first <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r13 = [];
  for (;;) {
    // start choice_4
    $p7 = $this->currPos;
    $r12 = strcspn($this->input, "\x00\x09\x0a\x0d !&-/<=>{|}", $this->currPos);
    if ($r12 > 0) {
      $this->currPos += $r12;
      $r12 = substr($this->input, $p7, $this->currPos - $p7);
      goto choice_4;
    } else {
      $r12 = self::$FAILED;
      $r12 = self::$FAILED;
    }
    // free $p7
    // start seq_6
    $p7 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r9 = $param_headingIndex;
    $r16 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r16 === self::$FAILED) {
      $r16 = false;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r12 = self::$FAILED;
      goto seq_6;
    }
    // start choice_5
    // start seq_7
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r17 = $param_th;
    $r18 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r19 = true;
      $r19 = false;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r17;
      $param_headingIndex = $r18;
    } else {
      $r19 = self::$FAILED;
      $r12 = self::$FAILED;
      goto seq_7;
    }
    $r12 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r12===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r17;
      $param_headingIndex = $r18;
      $r12 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    if ($r12!==self::$FAILED) {
      goto choice_5;
    }
    // free $p14,$r15,$r17,$r18
    // start seq_8
    $p14 = $this->currPos;
    $r18 = $param_preproc;
    $r17 = $param_th;
    $r15 = $param_headingIndex;
    $r20 = $this->input[$this->currPos] ?? '';
    if ($r20 === "<") {
      $r20 = false;
      $this->currPos = $p14;
      $param_preproc = $r18;
      $param_th = $r17;
      $param_headingIndex = $r15;
    } else {
      $r20 = self::$FAILED;
      $r12 = self::$FAILED;
      goto seq_8;
    }
    $r12 = $this->parseless_than($param_tagType);
    if ($r12===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r18;
      $param_th = $r17;
      $param_headingIndex = $r15;
      $r12 = self::$FAILED;
      goto seq_8;
    }
    seq_8:
    if ($r12!==self::$FAILED) {
      goto choice_5;
    }
    // free $p14,$r18,$r17,$r15
    $p14 = $this->currPos;
    // start seq_9
    $p21 = $this->currPos;
    $r15 = $param_preproc;
    $r17 = $param_th;
    $r18 = $param_headingIndex;
    $r22 = true;
    if ($r22!==self::$FAILED) {
      $r22 = false;
      $this->currPos = $p21;
      $param_preproc = $r15;
      $param_th = $r17;
      $param_headingIndex = $r18;
    }
    if (strcspn($this->input, "\x00\x09\x0a\x0c\x0d /<=>", $this->currPos, 1) !== 0) {
      $r23 = true;
      self::advanceChar($this->input, $this->currPos);
    } else {
      $r23 = self::$FAILED;
      $this->currPos = $p21;
      $param_preproc = $r15;
      $param_th = $r17;
      $param_headingIndex = $r18;
      $r12 = self::$FAILED;
      goto seq_9;
    }
    $r12 = true;
    seq_9:
    if ($r12!==self::$FAILED) {
      $r12 = substr($this->input, $p14, $this->currPos - $p14);
    } else {
      $r12 = self::$FAILED;
    }
    // free $r22,$r23
    // free $p21,$r15,$r17,$r18
    // free $p14
    choice_5:
    if ($r12===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r12 = self::$FAILED;
      goto seq_6;
    }
    seq_6:
    // free $r19,$r20
    // free $p7,$r11,$r10,$r9
    choice_4:
    if ($r12!==self::$FAILED) {
      $r13[] = $r12;
    } else {
      break;
    }
  }
  // rest <- $r13
  // free $r12
  // free $r16
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a42($r6, $r13);
  }
  // free $r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsegeneric_att_value($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([452, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $p7 = $this->currPos;
  // start seq_2
  $r8 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  $this->currPos += $r8;
  if (($this->input[$this->currPos] ?? null) === "'") {
    $r9 = true;
    $this->currPos++;
  } else {
    $r9 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = true;
  seq_2:
  // s <- $r6
  if ($r6!==self::$FAILED) {
    $r6 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r8,$r9
  // free $p7
  $r9 = $this->parseattribute_preprocessor_text_single($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r9===self::$FAILED) {
    $r9 = null;
  }
  // t <- $r9
  $p7 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "'") {
    $r8 = true;
    $this->currPos++;
    goto choice_2;
  } else {
    $r8 = self::$FAILED;
  }
  $p10 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  // start seq_3
  if (($this->input[$this->currPos] ?? null) === "/") {
    $r14 = true;
    $this->currPos++;
  } else {
    $r14 = self::$FAILED;
    $r14 = null;
  }
  if (($this->input[$this->currPos] ?? null) === ">") {
    $r15 = true;
  } else {
    $r15 = self::$FAILED;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $r8 = self::$FAILED;
    goto seq_3;
  }
  $r8 = true;
  seq_3:
  if ($r8!==self::$FAILED) {
    $r8 = false;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  }
  // free $r14,$r15
  // free $p10,$r11,$r12,$r13
  choice_2:
  // q <- $r8
  if ($r8!==self::$FAILED) {
    $r8 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a43($r6, $r9, $r8);
    goto choice_1;
  }
  // start seq_4
  $p7 = $this->currPos;
  // start seq_5
  $r12 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  $this->currPos += $r12;
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $r11 = true;
    $this->currPos++;
  } else {
    $r11 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r13 = self::$FAILED;
    goto seq_5;
  }
  $r13 = true;
  seq_5:
  // s <- $r13
  if ($r13!==self::$FAILED) {
    $r13 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r13 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // free $r12,$r11
  // free $p7
  $r11 = $this->parseattribute_preprocessor_text_double($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r11===self::$FAILED) {
    $r11 = null;
  }
  // t <- $r11
  $p7 = $this->currPos;
  // start choice_3
  if (($this->input[$this->currPos] ?? null) === "\"") {
    $r12 = true;
    $this->currPos++;
    goto choice_3;
  } else {
    $r12 = self::$FAILED;
  }
  $p10 = $this->currPos;
  $r15 = $param_preproc;
  $r14 = $param_th;
  $r16 = $param_headingIndex;
  // start seq_6
  if (($this->input[$this->currPos] ?? null) === "/") {
    $r17 = true;
    $this->currPos++;
  } else {
    $r17 = self::$FAILED;
    $r17 = null;
  }
  if (($this->input[$this->currPos] ?? null) === ">") {
    $r18 = true;
  } else {
    $r18 = self::$FAILED;
    $this->currPos = $p10;
    $param_preproc = $r15;
    $param_th = $r14;
    $param_headingIndex = $r16;
    $r12 = self::$FAILED;
    goto seq_6;
  }
  $r12 = true;
  seq_6:
  if ($r12!==self::$FAILED) {
    $r12 = false;
    $this->currPos = $p10;
    $param_preproc = $r15;
    $param_th = $r14;
    $param_headingIndex = $r16;
  }
  // free $r17,$r18
  // free $p10,$r15,$r14,$r16
  choice_3:
  // q <- $r12
  if ($r12!==self::$FAILED) {
    $r12 = substr($this->input, $p7, $this->currPos - $p7);
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // free $p7
  $r5 = true;
  seq_4:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a43($r13, $r11, $r12);
    goto choice_1;
  }
  // start seq_7
  $p7 = $this->currPos;
  $r16 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // s <- $r16
  $this->currPos += $r16;
  $r16 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start seq_8
  $p7 = $this->currPos;
  $r15 = $param_preproc;
  $r18 = $param_th;
  $r17 = $param_headingIndex;
  if (strcspn($this->input, "\x09\x0a\x0c\x0d >", $this->currPos, 1) !== 0) {
    $r19 = true;
    $r19 = false;
    $this->currPos = $p7;
    $param_preproc = $r15;
    $param_th = $r18;
    $param_headingIndex = $r17;
  } else {
    $r19 = self::$FAILED;
    $r14 = self::$FAILED;
    goto seq_8;
  }
  $r14 = $this->parseattribute_preprocessor_text($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r14===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r15;
    $param_th = $r18;
    $param_headingIndex = $r17;
    $r14 = self::$FAILED;
    goto seq_8;
  }
  seq_8:
  // t <- $r14
  if ($r14===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  // free $p7,$r15,$r18,$r17
  $p7 = $this->currPos;
  $r18 = $param_preproc;
  $r15 = $param_th;
  $r20 = $param_headingIndex;
  // start choice_4
  if (strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos, 1) !== 0) {
    $r17 = true;
    goto choice_4;
  } else {
    $r17 = self::$FAILED;
  }
  $this->savedPos = $this->currPos;
  $r17 = $this->a44($r16, $r14);
  if ($r17) {
    $r17 = false;
    goto choice_4;
  } else {
    $r17 = self::$FAILED;
  }
  // start seq_9
  if (($this->input[$this->currPos] ?? null) === "/") {
    $r21 = true;
    $this->currPos++;
  } else {
    $r21 = self::$FAILED;
    $r21 = null;
  }
  if (($this->input[$this->currPos] ?? null) === ">") {
    $r22 = true;
  } else {
    $r22 = self::$FAILED;
    $this->currPos = $p7;
    $param_preproc = $r18;
    $param_th = $r15;
    $param_headingIndex = $r20;
    $r17 = self::$FAILED;
    goto seq_9;
  }
  $r17 = true;
  seq_9:
  // free $r21,$r22
  choice_4:
  if ($r17!==self::$FAILED) {
    $r17 = false;
    $this->currPos = $p7;
    $param_preproc = $r18;
    $param_th = $r15;
    $param_headingIndex = $r20;
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  // free $p7,$r18,$r15,$r20
  $r5 = true;
  seq_7:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a45($r16, $r14);
  }
  // free $r19,$r17
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseextlink_nonipv6url_parameterized($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([522, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = null;
    if (preg_match("/[^\\x09-\\x0a\\x0d -\"&-'\\-<-=\\[\\]{-}\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]+/Au", $this->input, $r7, 0, $this->currPos)) {
      $this->currPos += strlen($r7[0]);
      $r7 = true;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p13,$r14,$r15,$r16
    if (strspn($this->input, "!&-={|}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // free $r17
    // free $p8,$r9,$r10,$r11
    $p8 = $this->currPos;
    // start seq_3
    $p13 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r9 = $param_headingIndex;
    $r17 = $this->input[$this->currPos] ?? '';
    if ($r17 === "'") {
      $this->currPos++;
    } else {
      $r17 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    $p18 = $this->currPos;
    $r15 = $param_preproc;
    $r14 = $param_th;
    $r19 = $param_headingIndex;
    $r16 = $this->input[$this->currPos] ?? '';
    if (!($r16 === "'")) {
      $r16 = self::$FAILED;
    }
    if ($r16 === self::$FAILED) {
      $r16 = false;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p18;
      $param_preproc = $r15;
      $param_th = $r14;
      $param_headingIndex = $r19;
      $this->currPos = $p13;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    // free $p18,$r15,$r14,$r19
    $r7 = true;
    seq_3:
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
    } else {
      $r7 = self::$FAILED;
    }
    // free $r17,$r16
    // free $p13,$r11,$r10,$r9
    // free $p8
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // r <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a46($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseurltext($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([504, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = [];
  for (;;) {
    // start choice_1
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $this->savedPos = $this->currPos;
    $r12 = $this->a47();
    if ($r12) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $this->discardnotempty();
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a48();
      goto choice_1;
    }
    // free $r12
    // free $p8,$r9,$r10,$r11
    // free $p7
    // start seq_2
    $p7 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r9 = $param_headingIndex;
    $this->savedPos = $this->currPos;
    $r12 = $this->a49();
    if ($r12) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // start seq_3
    $p8 = $this->currPos;
    $r13 = $param_preproc;
    $r14 = $param_th;
    $r15 = $param_headingIndex;
    $r16 = $this->input[$this->currPos] ?? '';
    if (preg_match("/[\\/A-Za-z]/A", $r16)) {
      $r16 = false;
      $this->currPos = $p8;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
    } else {
      $r16 = self::$FAILED;
      if (!$silence) { $this->fail(56); }
      $r6 = self::$FAILED;
      goto seq_3;
    }
    $r6 = $this->parseautolink($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r6===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
      $r6 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r6===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $p8,$r13,$r14,$r15
    seq_2:
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    // free $r16
    // free $p7,$r11,$r10,$r9
    // start seq_4
    $p7 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r16 = true;
      $r16 = false;
      $this->currPos = $p7;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
    } else {
      $r16 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_4;
    }
    // start seq_5
    $p8 = $this->currPos;
    $r15 = $param_preproc;
    $r14 = $param_th;
    $r13 = $param_headingIndex;
    $r17 = $this->input[$this->currPos] ?? '';
    if ($r17 === "&") {
      $r17 = false;
      $this->currPos = $p8;
      $param_preproc = $r15;
      $param_th = $r14;
      $param_headingIndex = $r13;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(13); }
      $r6 = self::$FAILED;
      goto seq_5;
    }
    $r6 = $this->parsehtmlentity($silence);
    if ($r6===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r15;
      $param_th = $r14;
      $param_headingIndex = $r13;
      $r6 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    if ($r6===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r6 = self::$FAILED;
      goto seq_4;
    }
    // free $p8,$r15,$r14,$r13
    seq_4:
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    // free $r17
    // free $p7,$r9,$r10,$r11
    // start seq_6
    $p7 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r9 = $param_headingIndex;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
    } else {
      $r17 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_6;
    }
    // start seq_7
    $p8 = $this->currPos;
    $r13 = $param_preproc;
    $r14 = $param_th;
    $r15 = $param_headingIndex;
    $r18 = $this->input[$this->currPos] ?? '';
    if ($r18 === "_") {
      $r18 = false;
      $this->currPos = $p8;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
    } else {
      $r18 = self::$FAILED;
      if (!$silence) { $this->fail(57); }
      $r6 = self::$FAILED;
      goto seq_7;
    }
    $r6 = $this->parsebehavior_switch($silence);
    if ($r6===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
      $r6 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    if ($r6===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r6 = self::$FAILED;
      goto seq_6;
    }
    // free $p8,$r13,$r14,$r15
    seq_6:
    if ($r6!==self::$FAILED) {
      goto choice_1;
    }
    // free $r18
    // free $p7,$r11,$r10,$r9
    if (strcspn($this->input, "\x0a\x0d!'-:;<=[]{|}", $this->currPos, 1) !== 0) {
      $r6 = self::consumeChar($this->input, $this->currPos);
    } else {
      $r6 = self::$FAILED;
      if (!$silence) { $this->fail(58); }
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
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseinline_element($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([312, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "<") {
    $r6 = true;
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $r10 = $param_headingIndex;
  $r11 = $this->input[$this->currPos] ?? '';
  if ($r11 === "<") {
    $r11 = false;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
  } else {
    $r11 = self::$FAILED;
    if (!$silence) { $this->fail(59); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parseangle_bracket_markup($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r8,$r9,$r10
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r11
  // start seq_3
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r11 = true;
    $r11 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r11 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  // start seq_4
  $p7 = $this->currPos;
  $r10 = $param_preproc;
  $r9 = $param_th;
  $r8 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if ($r12 === "{") {
    $r12 = false;
    $this->currPos = $p7;
    $param_preproc = $r10;
    $param_th = $r9;
    $param_headingIndex = $r8;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(11); }
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $r5 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r10;
    $param_th = $r9;
    $param_headingIndex = $r8;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  // free $p7,$r10,$r9,$r8
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r12
  // start seq_5
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r12 = true;
    $r12 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r12 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // start seq_6
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $r10 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "-") {
    $r13 = false;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(60); }
    $r5 = self::$FAILED;
    goto seq_6;
  }
  $r5 = $this->parselang_variant_or_tpl($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  seq_6:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // free $p7,$r8,$r9,$r10
  seq_5:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r13
  $p7 = $this->currPos;
  $r5 = self::$FAILED;
  for (;;) {
    // start seq_7
    $p14 = $this->currPos;
    $r10 = $param_preproc;
    $r9 = $param_th;
    $r8 = $param_headingIndex;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
      $r15 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(61); }
      $r15 = self::$FAILED;
      $r13 = self::$FAILED;
      goto seq_7;
    }
    $p17 = $this->currPos;
    $r18 = $param_preproc;
    $r19 = $param_th;
    $r20 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $r16 = true;
      $r16 = false;
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p14;
      $param_preproc = $r10;
      $param_th = $r9;
      $param_headingIndex = $r8;
      $r13 = self::$FAILED;
      goto seq_7;
    }
    // free $p17,$r18,$r19,$r20
    $r13 = true;
    seq_7:
    if ($r13!==self::$FAILED) {
      $r5 = true;
    } else {
      break;
    }
    // free $r15,$r16
    // free $p14,$r10,$r9,$r8
  }
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p7, $this->currPos - $p7);
    goto choice_1;
  } else {
    $r5 = self::$FAILED;
  }
  // free $r13
  // free $p7
  // start seq_8
  if (($this->input[$this->currPos] ?? null) === "[") {
    $r13 = true;
    $r13 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r13 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_8;
  }
  // start choice_2
  // start seq_9
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $r10 = $param_headingIndex;
  $r16 = $this->input[$this->currPos] ?? '';
  if ($r16 === "[") {
    $r16 = false;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
  } else {
    $r16 = self::$FAILED;
    if (!$silence) { $this->fail(62); }
    $r5 = self::$FAILED;
    goto seq_9;
  }
  $r5 = $this->parsewikilink($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex, $param_preproc);
  if ($r5===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
    $r5 = self::$FAILED;
    goto seq_9;
  }
  seq_9:
  if ($r5!==self::$FAILED) {
    goto choice_2;
  }
  // free $p7,$r8,$r9,$r10
  // start seq_10
  $p7 = $this->currPos;
  $r10 = $param_preproc;
  $r9 = $param_th;
  $r8 = $param_headingIndex;
  $r15 = $this->input[$this->currPos] ?? '';
  if ($r15 === "[") {
    $r15 = false;
    $this->currPos = $p7;
    $param_preproc = $r10;
    $param_th = $r9;
    $param_headingIndex = $r8;
  } else {
    $r15 = self::$FAILED;
    if (!$silence) { $this->fail(18); }
    $r5 = self::$FAILED;
    goto seq_10;
  }
  $r5 = $this->parseextlink($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r10;
    $param_th = $r9;
    $param_headingIndex = $r8;
    $r5 = self::$FAILED;
    goto seq_10;
  }
  seq_10:
  // free $p7,$r10,$r9,$r8
  choice_2:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_8;
  }
  seq_8:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r16,$r15
  // start seq_11
  if (($this->input[$this->currPos] ?? null) === "'") {
    $r15 = true;
    $r15 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r15 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_11;
  }
  // start seq_12
  $p7 = $this->currPos;
  $r16 = $param_preproc;
  $r8 = $param_th;
  $r9 = $param_headingIndex;
  $r10 = $this->input[$this->currPos] ?? '';
  if ($r10 === "'") {
    $r10 = false;
    $this->currPos = $p7;
    $param_preproc = $r16;
    $param_th = $r8;
    $param_headingIndex = $r9;
  } else {
    $r10 = self::$FAILED;
    if (!$silence) { $this->fail(63); }
    $r5 = self::$FAILED;
    goto seq_12;
  }
  $r5 = $this->parsequote($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r16;
    $param_th = $r8;
    $param_headingIndex = $r9;
    $r5 = self::$FAILED;
    goto seq_12;
  }
  seq_12:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_11;
  }
  // free $p7,$r16,$r8,$r9
  seq_11:
  // free $r10
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsedtdd_colon($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([462, $boolParams & 0x1bff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->parseinlineline_break_on_colon($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $r6 = null;
  }
  // c <- $r6
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === ":") {
    $r12 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(26); }
    $r12 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parsePOSITION($silence);
  seq_2:
  // cpos <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10,$r11
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a50($r6, $r7);
  }
  // free $r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseredirect($silence, $boolParams, $param_tagType, &$param_th, &$param_headingIndex, &$param_preproc) {
  $key = json_encode([284, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  $r4 = $param_preproc;
  // start seq_1
  // start seq_2
  if (strcspn($this->input, "\x0c:[", $this->currPos, 1) !== 0) {
    $r7 = true;
    $r7 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(64); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parseredirect_word($silence);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // rw <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p9 = $this->currPos;
  $r8 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp <- $r8
  $this->currPos += $r8;
  $r8 = substr($this->input, $p9, $this->currPos - $p9);
  // free $p9
  $p9 = $this->currPos;
  // start seq_3
  $p11 = $this->currPos;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  $r14 = $param_preproc;
  if (($this->input[$this->currPos] ?? null) === ":") {
    $r15 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(26); }
    $r15 = self::$FAILED;
    $r10 = self::$FAILED;
    goto seq_3;
  }
  $r16 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  $this->currPos += $r16;
  $r10 = true;
  seq_3:
  if ($r10===self::$FAILED) {
    $r10 = null;
  }
  // free $r15,$r16
  // free $p11,$r12,$r13,$r14
  // c <- $r10
  $r10 = substr($this->input, $p9, $this->currPos - $p9);
  // free $p9
  // start seq_4
  $p9 = $this->currPos;
  $r13 = $param_th;
  $r12 = $param_headingIndex;
  $r16 = $param_preproc;
  $r15 = $this->input[$this->currPos] ?? '';
  if ($r15 === "[") {
    $r15 = false;
    $this->currPos = $p9;
    $param_th = $r13;
    $param_headingIndex = $r12;
    $param_preproc = $r16;
  } else {
    $r15 = self::$FAILED;
    if (!$silence) { $this->fail(62); }
    $r14 = self::$FAILED;
    goto seq_4;
  }
  $r14 = $this->parsewikilink($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex, $param_preproc);
  if ($r14===self::$FAILED) {
    $this->currPos = $p9;
    $param_th = $r13;
    $param_headingIndex = $r12;
    $param_preproc = $r16;
    $r14 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  // wl <- $r14
  if ($r14===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r13,$r12,$r16
  $this->savedPos = $this->currPos;
  $r16 = $this->a51($r6, $r8, $r10, $r14);
  if ($r16) {
    $r16 = false;
  } else {
    $r16 = self::$FAILED;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a52($r6, $r8, $r10, $r14);
  }
  // free $r7,$r15,$r16
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r4 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsesol_transparent($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([540, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(10); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsecomment($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(66); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parseinclude_limits($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "<") {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(67); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parseannotation_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_4
  $r9 = $this->input[$this->currPos] ?? '';
  if ($r9 === "_") {
    $r9 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(57); }
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $r5 = $this->parsebehavior_switch($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseblock_line($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([300, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "=") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(68); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parseheading($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  if (strspn($this->input, "#*:;", $this->currPos, 1) !== 0) {
    $r7 = true;
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(69); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parselist_item($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "-") {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(70); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parsehr($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_4
  if (strspn($this->input, "\x09 !<{|}", $this->currPos, 1) !== 0) {
    $r9 = true;
    $r9 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r9 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // start seq_5
  $p10 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  if (strspn($this->input, "\x09 !<{|", $this->currPos, 1) !== 0) {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(71); }
    $r5 = self::$FAILED;
    goto seq_5;
  }
  $r5 = $this->parsetable_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // free $p10,$r11,$r12,$r13
  seq_4:
  // free $r14
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseblock_lines($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([296, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $this->savedPos = $this->currPos;
  $r7 = $this->a34();
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  $p9 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r8 = true;
    $this->currPos++;
    goto choice_2;
  } else {
    if (!$silence) { $this->fail(46); }
    $r8 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r8 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(47); }
    $r8 = self::$FAILED;
  }
  choice_2:
  if ($r8!==self::$FAILED) {
    $this->savedPos = $p9;
    $r8 = $this->a35();
    goto choice_1;
  }
  // free $p9
  $p9 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r8 = $this->a36();
  if ($r8) {
    $r8 = false;
    $this->savedPos = $p9;
    $r8 = $this->a37();
  } else {
    $r8 = self::$FAILED;
  }
  // free $p9
  choice_1:
  // sp <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start seq_3
  $p9 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p9;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(48); }
    $r10 = self::$FAILED;
    goto seq_3;
  }
  $r10 = $this->parseempty_lines_with_comments($silence);
  if ($r10===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $r10 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r10===self::$FAILED) {
    $r10 = null;
  }
  // free $p9,$r11,$r12,$r13
  // elc <- $r10
  $r13 = [];
  for (;;) {
    // start seq_4
    $p9 = $this->currPos;
    $r11 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    $r17 = $this->input[$this->currPos] ?? '';
    if ($r17 === "<" || $r17 === "_") {
      $r17 = false;
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $r12 = self::$FAILED;
      goto seq_4;
    }
    $r12 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r12 = self::$FAILED;
      goto seq_4;
    }
    seq_4:
    if ($r12!==self::$FAILED) {
      $r13[] = $r12;
    } else {
      break;
    }
    // free $p9,$r11,$r15,$r16
  }
  // st <- $r13
  // free $r12
  // free $r17
  $r6 = true;
  seq_2:
  // s <- $r6
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p1;
    $r6 = $this->a38($r8, $r10, $r13);
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r7,$r14
  $p9 = $this->currPos;
  // start seq_5
  $p18 = $this->currPos;
  $r7 = $param_preproc;
  $r17 = $param_th;
  $r12 = $param_headingIndex;
  $p19 = $this->currPos;
  $r15 = strspn($this->input, "\x09 ", $this->currPos);
  // s <- $r15
  $this->currPos += $r15;
  $r15 = substr($this->input, $p19, $this->currPos - $p19);
  // free $p19
  $r16 = $r15;
  // os <- $r16
  $this->savedPos = $p18;
  $r16 = $this->a53($r15);
  $p19 = $this->currPos;
  // start seq_6
  $p20 = $this->currPos;
  $r21 = $param_preproc;
  $r22 = $param_th;
  $r23 = $param_headingIndex;
  $this->savedPos = $this->currPos;
  $r24 = $this->a54($r6, $r16);
  if ($r24) {
    $r24 = false;
  } else {
    $r24 = self::$FAILED;
    $r11 = self::$FAILED;
    goto seq_6;
  }
  // start choice_3
  $p26 = $this->currPos;
  // start choice_4
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r25 = true;
    $this->currPos++;
    goto choice_4;
  } else {
    if (!$silence) { $this->fail(46); }
    $r25 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r25 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(47); }
    $r25 = self::$FAILED;
  }
  choice_4:
  if ($r25!==self::$FAILED) {
    $this->savedPos = $p26;
    $r25 = $this->a55($r6, $r16);
    goto choice_3;
  }
  // free $p26
  $p26 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r25 = $this->a56($r6, $r16);
  if ($r25) {
    $r25 = false;
    $this->savedPos = $p26;
    $r25 = $this->a57($r6, $r16);
  } else {
    $r25 = self::$FAILED;
  }
  // free $p26
  choice_3:
  // sp <- $r25
  if ($r25===self::$FAILED) {
    $this->currPos = $p20;
    $param_preproc = $r21;
    $param_th = $r22;
    $param_headingIndex = $r23;
    $r11 = self::$FAILED;
    goto seq_6;
  }
  // start seq_7
  $p26 = $this->currPos;
  $r28 = $param_preproc;
  $r29 = $param_th;
  $r30 = $param_headingIndex;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r31 = true;
    $r31 = false;
    $this->currPos = $p26;
    $param_preproc = $r28;
    $param_th = $r29;
    $param_headingIndex = $r30;
  } else {
    $r31 = self::$FAILED;
    if (!$silence) { $this->fail(48); }
    $r27 = self::$FAILED;
    goto seq_7;
  }
  $r27 = $this->parseempty_lines_with_comments($silence);
  if ($r27===self::$FAILED) {
    $this->currPos = $p26;
    $param_preproc = $r28;
    $param_th = $r29;
    $param_headingIndex = $r30;
    $r27 = self::$FAILED;
    goto seq_7;
  }
  seq_7:
  if ($r27===self::$FAILED) {
    $r27 = null;
  }
  // free $p26,$r28,$r29,$r30
  // elc <- $r27
  $r30 = [];
  for (;;) {
    // start seq_8
    $p26 = $this->currPos;
    $r28 = $param_preproc;
    $r32 = $param_th;
    $r33 = $param_headingIndex;
    $r34 = $this->input[$this->currPos] ?? '';
    if ($r34 === "<" || $r34 === "_") {
      $r34 = false;
      $this->currPos = $p26;
      $param_preproc = $r28;
      $param_th = $r32;
      $param_headingIndex = $r33;
    } else {
      $r34 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $r29 = self::$FAILED;
      goto seq_8;
    }
    $r29 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r29===self::$FAILED) {
      $this->currPos = $p26;
      $param_preproc = $r28;
      $param_th = $r32;
      $param_headingIndex = $r33;
      $r29 = self::$FAILED;
      goto seq_8;
    }
    seq_8:
    if ($r29!==self::$FAILED) {
      $r30[] = $r29;
    } else {
      break;
    }
    // free $p26,$r28,$r32,$r33
  }
  // st <- $r30
  // free $r29
  // free $r34
  $r11 = true;
  seq_6:
  // so <- $r11
  if ($r11!==self::$FAILED) {
    $this->savedPos = $p19;
    $r11 = $this->a58($r6, $r16, $r25, $r27, $r30);
  } else {
    $this->currPos = $p18;
    $param_preproc = $r7;
    $param_th = $r17;
    $param_headingIndex = $r12;
    $r14 = self::$FAILED;
    goto seq_5;
  }
  // free $r24,$r31
  // free $p20,$r21,$r22,$r23
  // free $p19
  $r14 = true;
  seq_5:
  if ($r14!==self::$FAILED) {
    $this->savedPos = $p9;
    $r14 = $this->a59($r6, $r16, $r11);
  } else {
    $r14 = null;
  }
  // free $p18,$r7,$r17,$r12
  // free $p9
  // s2 <- $r14
  // start seq_9
  $p9 = $this->currPos;
  $r17 = $param_preproc;
  $r7 = $param_th;
  $r23 = $param_headingIndex;
  if (strspn($this->input, "\x09 !#*-:;<={|", $this->currPos, 1) !== 0) {
    $r22 = true;
    $r22 = false;
    $this->currPos = $p9;
    $param_preproc = $r17;
    $param_th = $r7;
    $param_headingIndex = $r23;
  } else {
    $r22 = self::$FAILED;
    if (!$silence) { $this->fail(44); }
    $r12 = self::$FAILED;
    goto seq_9;
  }
  $r12 = $this->parseblock_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r12===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r17;
    $param_th = $r7;
    $param_headingIndex = $r23;
    $r12 = self::$FAILED;
    goto seq_9;
  }
  seq_9:
  // bl <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r17,$r7,$r23
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a60($r6, $r14, $r12);
  }
  // free $r22
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseempty_lines_with_comments($silence) {
  $key = 542;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = $this->parsePOSITION($silence);
  // p <- $r3
  $r4 = [];
  for (;;) {
    // start seq_2
    $p6 = $this->currPos;
    $r7 = strspn($this->input, "\x09 ", $this->currPos);
    $this->currPos += $r7;
    $r7 = substr($this->input, $this->currPos - $r7, $r7);
    $r7 = mb_str_split($r7, 1, "utf-8");
    // start seq_3
    $p9 = $this->currPos;
    $r10 = $this->input[$this->currPos] ?? '';
    if ($r10 === "<") {
      $r10 = false;
      $this->currPos = $p9;
    } else {
      $r10 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r8 = self::$FAILED;
      goto seq_3;
    }
    $r8 = $this->parsecomment($silence);
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $r8 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r8===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    // free $p9
    $r11 = [];
    for (;;) {
      // start choice_1
      $r12 = $this->input[$this->currPos] ?? '';
      if ($r12 === "\x09" || $r12 === " ") {
        $this->currPos++;
        goto choice_1;
      } else {
        $r12 = self::$FAILED;
        if (!$silence) { $this->fail(5); }
      }
      // start seq_4
      $p9 = $this->currPos;
      $r13 = $this->input[$this->currPos] ?? '';
      if ($r13 === "<") {
        $r13 = false;
        $this->currPos = $p9;
      } else {
        $r13 = self::$FAILED;
        if (!$silence) { $this->fail(10); }
        $r12 = self::$FAILED;
        goto seq_4;
      }
      $r12 = $this->parsecomment($silence);
      if ($r12===self::$FAILED) {
        $this->currPos = $p9;
        $r12 = self::$FAILED;
        goto seq_4;
      }
      seq_4:
      // free $p9
      choice_1:
      if ($r12!==self::$FAILED) {
        $r11[] = $r12;
      } else {
        break;
      }
    }
    // free $r12
    // free $r13
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r13 = "\x0a";
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(46); }
      $r13 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r13 = "\x0d\x0a";
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r13 = self::$FAILED;
    }
    choice_2:
    if ($r13===self::$FAILED) {
      $this->currPos = $p6;
      $r5 = self::$FAILED;
      goto seq_2;
    }
    $r5 = [$r7,$r8,$r11,$r13];
    seq_2:
    if ($r5!==self::$FAILED) {
      $r4[] = $r5;
    } else {
      break;
    }
    // free $r7,$r8,$r10,$r11,$r13
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
    $r2 = $this->a61($r3, $r4);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardnotempty() {

  return true;
}
private function discardtplarg_preproc($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([355, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
    $r6 = true;
    $this->currPos += 3;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    // start choice_1
    $p9 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r8 = true;
      $this->currPos++;
      goto choice_2;
    } else {
      $r8 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r8 = true;
      $this->currPos += 2;
    } else {
      $r8 = self::$FAILED;
    }
    choice_2:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a35();
      goto choice_1;
    }
    // free $p9
    // start choice_3
    $r8 = $this->input[$this->currPos] ?? '';
    if ($r8 === "\x09" || $r8 === " ") {
      $this->currPos++;
      goto choice_3;
    } else {
      $r8 = self::$FAILED;
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "<") {
      $r13 = false;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
    } else {
      $r13 = self::$FAILED;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = $this->discardcomment();
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    // free $p9,$r10,$r11,$r12
    choice_3:
    choice_1:
    if ($r8===self::$FAILED) {
      break;
    }
  }
  // free $r8
  // free $r13
  $r7 = true;
  // free $r7
  $r7 = $this->parsePOSITION(true);
  // p <- $r7
  $r13 = $this->parseinlineline_in_tpls(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  // target <- $r13
  $r8 = [];
  for (;;) {
    // start seq_3
    $p9 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r14 = $param_headingIndex;
    for (;;) {
      // start choice_4
      $p17 = $this->currPos;
      // start choice_5
      if (($this->input[$this->currPos] ?? null) === "\x0a") {
        $r16 = true;
        $this->currPos++;
        goto choice_5;
      } else {
        $r16 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
        $r16 = true;
        $this->currPos += 2;
      } else {
        $r16 = self::$FAILED;
      }
      choice_5:
      if ($r16!==self::$FAILED) {
        $this->savedPos = $p17;
        $r16 = $this->a62($r7, $r13);
        goto choice_4;
      }
      // free $p17
      // start choice_6
      $r16 = $this->input[$this->currPos] ?? '';
      if ($r16 === "\x09" || $r16 === " ") {
        $this->currPos++;
        goto choice_6;
      } else {
        $r16 = self::$FAILED;
      }
      // start seq_4
      $p17 = $this->currPos;
      $r18 = $param_preproc;
      $r19 = $param_th;
      $r20 = $param_headingIndex;
      $r21 = $this->input[$this->currPos] ?? '';
      if ($r21 === "<") {
        $r21 = false;
        $this->currPos = $p17;
        $param_preproc = $r18;
        $param_th = $r19;
        $param_headingIndex = $r20;
      } else {
        $r21 = self::$FAILED;
        $r16 = self::$FAILED;
        goto seq_4;
      }
      $r16 = $this->discardcomment();
      if ($r16===self::$FAILED) {
        $this->currPos = $p17;
        $param_preproc = $r18;
        $param_th = $r19;
        $param_headingIndex = $r20;
        $r16 = self::$FAILED;
        goto seq_4;
      }
      seq_4:
      // free $p17,$r18,$r19,$r20
      choice_6:
      choice_4:
      if ($r16===self::$FAILED) {
        break;
      }
    }
    // free $r16
    // free $r21
    $r15 = true;
    // free $r15
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r15 = true;
      $this->currPos++;
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r14;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    // start choice_7
    $p17 = $this->currPos;
    // start seq_5
    $p22 = $this->currPos;
    $r21 = $param_preproc;
    $r16 = $param_th;
    $r20 = $param_headingIndex;
    $r19 = $this->parsePOSITION(true);
    // p0 <- $r19
    $r18 = [];
    for (;;) {
      // start choice_8
      $p24 = $this->currPos;
      // start choice_9
      if (($this->input[$this->currPos] ?? null) === "\x0a") {
        $r23 = true;
        $this->currPos++;
        goto choice_9;
      } else {
        $r23 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
        $r23 = true;
        $this->currPos += 2;
      } else {
        $r23 = self::$FAILED;
      }
      choice_9:
      if ($r23!==self::$FAILED) {
        $this->savedPos = $p24;
        $r23 = $this->a63($r7, $r13, $r19);
        goto choice_8;
      }
      // free $p24
      // start choice_10
      $r23 = $this->input[$this->currPos] ?? '';
      if ($r23 === "\x09" || $r23 === " ") {
        $this->currPos++;
        goto choice_10;
      } else {
        $r23 = self::$FAILED;
      }
      // start seq_6
      $p24 = $this->currPos;
      $r25 = $param_preproc;
      $r26 = $param_th;
      $r27 = $param_headingIndex;
      $r28 = $this->input[$this->currPos] ?? '';
      if ($r28 === "<") {
        $r28 = false;
        $this->currPos = $p24;
        $param_preproc = $r25;
        $param_th = $r26;
        $param_headingIndex = $r27;
      } else {
        $r28 = self::$FAILED;
        $r23 = self::$FAILED;
        goto seq_6;
      }
      $r23 = $this->parsecomment(true);
      if ($r23===self::$FAILED) {
        $this->currPos = $p24;
        $param_preproc = $r25;
        $param_th = $r26;
        $param_headingIndex = $r27;
        $r23 = self::$FAILED;
        goto seq_6;
      }
      seq_6:
      // free $p24,$r25,$r26,$r27
      choice_10:
      choice_8:
      if ($r23!==self::$FAILED) {
        $r18[] = $r23;
      } else {
        break;
      }
    }
    // v <- $r18
    // free $r23
    // free $r28
    $r28 = $this->parsePOSITION(true);
    // p1 <- $r28
    $p24 = $this->currPos;
    $r27 = $param_preproc;
    $r26 = $param_th;
    $r25 = $param_headingIndex;
    // start choice_11
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r23 = true;
      goto choice_11;
    } else {
      $r23 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r23 = true;
    } else {
      $r23 = self::$FAILED;
    }
    choice_11:
    if ($r23!==self::$FAILED) {
      $r23 = false;
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
    } else {
      $this->currPos = $p22;
      $param_preproc = $r21;
      $param_th = $r16;
      $param_headingIndex = $r20;
      $r12 = self::$FAILED;
      goto seq_5;
    }
    // free $p24,$r27,$r26,$r25
    $r12 = true;
    seq_5:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p17;
      $r12 = $this->a64($r7, $r13, $r19, $r18, $r28);
      goto choice_7;
    }
    // free $r23
    // free $p22,$r21,$r16,$r20
    // free $p17
    $r12 = $this->parsetemplate_param_value(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    choice_7:
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r14;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r12!==self::$FAILED) {
      $r8[] = $r12;
    } else {
      break;
    }
    // free $p9,$r11,$r10,$r14
  }
  // params <- $r8
  // free $r12
  // free $r15
  for (;;) {
    // start choice_12
    $p9 = $this->currPos;
    // start choice_13
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r12 = true;
      $this->currPos++;
      goto choice_13;
    } else {
      $r12 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r12 = true;
      $this->currPos += 2;
    } else {
      $r12 = self::$FAILED;
    }
    choice_13:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p9;
      $r12 = $this->a65($r7, $r13, $r8);
      goto choice_12;
    }
    // free $p9
    // start choice_14
    $r12 = $this->input[$this->currPos] ?? '';
    if ($r12 === "\x09" || $r12 === " ") {
      $this->currPos++;
      goto choice_14;
    } else {
      $r12 = self::$FAILED;
    }
    // start seq_7
    $p9 = $this->currPos;
    $r14 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r20 = $this->input[$this->currPos] ?? '';
    if ($r20 === "<") {
      $r20 = false;
      $this->currPos = $p9;
      $param_preproc = $r14;
      $param_th = $r10;
      $param_headingIndex = $r11;
    } else {
      $r20 = self::$FAILED;
      $r12 = self::$FAILED;
      goto seq_7;
    }
    $r12 = $this->discardcomment();
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r14;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r12 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    // free $p9,$r14,$r10,$r11
    choice_14:
    choice_12:
    if ($r12===self::$FAILED) {
      break;
    }
  }
  // free $r12
  // free $r20
  $r15 = true;
  // free $r15
  $r15 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r15===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
    $r20 = true;
    $this->currPos += 3;
  } else {
    $r20 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a66($r7, $r13, $r8);
  }
  // free $r6,$r15,$r20
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetemplate_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([348, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(53); }
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    // start choice_2
    $p9 = $this->currPos;
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r8 = true;
      $this->currPos++;
      goto choice_3;
    } else {
      if (!$silence) { $this->fail(46); }
      $r8 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r8 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r8 = self::$FAILED;
    }
    choice_3:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a35();
      goto choice_2;
    }
    // free $p9
    // start choice_4
    $r8 = $this->input[$this->currPos] ?? '';
    if ($r8 === "\x09" || $r8 === " ") {
      $this->currPos++;
      goto choice_4;
    } else {
      $r8 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "<") {
      $r13 = false;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
    } else {
      $r13 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = $this->discardcomment();
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    // free $p9,$r10,$r11,$r12
    choice_4:
    choice_2:
    if ($r8===self::$FAILED) {
      break;
    }
  }
  // free $r8
  // free $r13
  $r7 = true;
  // free $r7
  $r7 = $this->parseinlineline_in_tpls($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // target <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r13 = [];
  for (;;) {
    // start seq_3
    $p9 = $this->currPos;
    $r12 = $param_preproc;
    $r11 = $param_th;
    $r10 = $param_headingIndex;
    for (;;) {
      // start choice_5
      $p16 = $this->currPos;
      // start choice_6
      if (($this->input[$this->currPos] ?? null) === "\x0a") {
        $r15 = true;
        $this->currPos++;
        goto choice_6;
      } else {
        if (!$silence) { $this->fail(46); }
        $r15 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
        $r15 = true;
        $this->currPos += 2;
      } else {
        if (!$silence) { $this->fail(47); }
        $r15 = self::$FAILED;
      }
      choice_6:
      if ($r15!==self::$FAILED) {
        $this->savedPos = $p16;
        $r15 = $this->a67($r7);
        goto choice_5;
      }
      // free $p16
      // start choice_7
      $r15 = $this->input[$this->currPos] ?? '';
      if ($r15 === "\x09" || $r15 === " ") {
        $this->currPos++;
        goto choice_7;
      } else {
        $r15 = self::$FAILED;
        if (!$silence) { $this->fail(5); }
      }
      // start seq_4
      $p16 = $this->currPos;
      $r17 = $param_preproc;
      $r18 = $param_th;
      $r19 = $param_headingIndex;
      $r20 = $this->input[$this->currPos] ?? '';
      if ($r20 === "<") {
        $r20 = false;
        $this->currPos = $p16;
        $param_preproc = $r17;
        $param_th = $r18;
        $param_headingIndex = $r19;
      } else {
        $r20 = self::$FAILED;
        if (!$silence) { $this->fail(10); }
        $r15 = self::$FAILED;
        goto seq_4;
      }
      $r15 = $this->discardcomment();
      if ($r15===self::$FAILED) {
        $this->currPos = $p16;
        $param_preproc = $r17;
        $param_th = $r18;
        $param_headingIndex = $r19;
        $r15 = self::$FAILED;
        goto seq_4;
      }
      seq_4:
      // free $p16,$r17,$r18,$r19
      choice_7:
      choice_5:
      if ($r15===self::$FAILED) {
        break;
      }
    }
    // free $r15
    // free $r20
    $r14 = true;
    // free $r14
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r14 = true;
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(2); }
      $r14 = self::$FAILED;
      $this->currPos = $p9;
      $param_preproc = $r12;
      $param_th = $r11;
      $param_headingIndex = $r10;
      $r8 = self::$FAILED;
      goto seq_3;
    }
    // start choice_8
    $p16 = $this->currPos;
    // start seq_5
    $p21 = $this->currPos;
    $r20 = $param_preproc;
    $r15 = $param_th;
    $r19 = $param_headingIndex;
    $r18 = $this->parsePOSITION($silence);
    // p0 <- $r18
    $r17 = [];
    for (;;) {
      // start choice_9
      $p23 = $this->currPos;
      // start choice_10
      if (($this->input[$this->currPos] ?? null) === "\x0a") {
        $r22 = true;
        $this->currPos++;
        goto choice_10;
      } else {
        if (!$silence) { $this->fail(46); }
        $r22 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
        $r22 = true;
        $this->currPos += 2;
      } else {
        if (!$silence) { $this->fail(47); }
        $r22 = self::$FAILED;
      }
      choice_10:
      if ($r22!==self::$FAILED) {
        $this->savedPos = $p23;
        $r22 = $this->a68($r7, $r18);
        goto choice_9;
      }
      // free $p23
      // start choice_11
      $r22 = $this->input[$this->currPos] ?? '';
      if ($r22 === "\x09" || $r22 === " ") {
        $this->currPos++;
        goto choice_11;
      } else {
        $r22 = self::$FAILED;
        if (!$silence) { $this->fail(5); }
      }
      // start seq_6
      $p23 = $this->currPos;
      $r24 = $param_preproc;
      $r25 = $param_th;
      $r26 = $param_headingIndex;
      $r27 = $this->input[$this->currPos] ?? '';
      if ($r27 === "<") {
        $r27 = false;
        $this->currPos = $p23;
        $param_preproc = $r24;
        $param_th = $r25;
        $param_headingIndex = $r26;
      } else {
        $r27 = self::$FAILED;
        if (!$silence) { $this->fail(10); }
        $r22 = self::$FAILED;
        goto seq_6;
      }
      $r22 = $this->parsecomment($silence);
      if ($r22===self::$FAILED) {
        $this->currPos = $p23;
        $param_preproc = $r24;
        $param_th = $r25;
        $param_headingIndex = $r26;
        $r22 = self::$FAILED;
        goto seq_6;
      }
      seq_6:
      // free $p23,$r24,$r25,$r26
      choice_11:
      choice_9:
      if ($r22!==self::$FAILED) {
        $r17[] = $r22;
      } else {
        break;
      }
    }
    // v <- $r17
    // free $r22
    // free $r27
    $r27 = $this->parsePOSITION($silence);
    // p1 <- $r27
    $p23 = $this->currPos;
    $r26 = $param_preproc;
    $r25 = $param_th;
    $r24 = $param_headingIndex;
    // start choice_12
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r22 = true;
      goto choice_12;
    } else {
      $r22 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
      $r22 = true;
    } else {
      $r22 = self::$FAILED;
    }
    choice_12:
    if ($r22!==self::$FAILED) {
      $r22 = false;
      $this->currPos = $p23;
      $param_preproc = $r26;
      $param_th = $r25;
      $param_headingIndex = $r24;
    } else {
      $this->currPos = $p21;
      $param_preproc = $r20;
      $param_th = $r15;
      $param_headingIndex = $r19;
      $r8 = self::$FAILED;
      goto seq_5;
    }
    // free $p23,$r26,$r25,$r24
    $r8 = true;
    seq_5:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p16;
      $r8 = $this->a69($r7, $r18, $r17, $r27);
      goto choice_8;
    }
    // free $r22
    // free $p21,$r20,$r15,$r19
    // free $p16
    $r8 = $this->parsetemplate_param($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    choice_8:
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r12;
      $param_th = $r11;
      $param_headingIndex = $r10;
      $r8 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r8!==self::$FAILED) {
      $r13[] = $r8;
    } else {
      break;
    }
    // free $p9,$r12,$r11,$r10
  }
  // params <- $r13
  // free $r8
  // free $r14
  for (;;) {
    // start choice_13
    $p9 = $this->currPos;
    // start choice_14
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r8 = true;
      $this->currPos++;
      goto choice_14;
    } else {
      if (!$silence) { $this->fail(46); }
      $r8 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r8 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r8 = self::$FAILED;
    }
    choice_14:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a70($r7, $r13);
      goto choice_13;
    }
    // free $p9
    // start choice_15
    $r8 = $this->input[$this->currPos] ?? '';
    if ($r8 === "\x09" || $r8 === " ") {
      $this->currPos++;
      goto choice_15;
    } else {
      $r8 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_7
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    $r19 = $this->input[$this->currPos] ?? '';
    if ($r19 === "<") {
      $r19 = false;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
    } else {
      $r19 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r8 = self::$FAILED;
      goto seq_7;
    }
    $r8 = $this->discardcomment();
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r8 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    // free $p9,$r10,$r11,$r12
    choice_15:
    choice_13:
    if ($r8===self::$FAILED) {
      break;
    }
  }
  // free $r8
  // free $r19
  $r14 = true;
  // free $r14
  $r14 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r14===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
    $r19 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(51); }
    $r19 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a71($r7, $r13);
    goto choice_1;
  }
  // free $r6,$r14,$r19
  $p9 = $this->currPos;
  // start seq_8
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r19 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(53); }
    $r19 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_8;
  }
  $r14 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  $this->currPos += $r14;
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(51); }
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_8;
  }
  $r5 = true;
  seq_8:
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p9, $this->currPos - $p9);
  } else {
    $r5 = self::$FAILED;
  }
  // free $r19,$r14,$r6
  // free $p9
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetplarg_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([354, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
    $r6 = true;
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(72); }
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    // start choice_1
    $p9 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r8 = true;
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(46); }
      $r8 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r8 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r8 = self::$FAILED;
    }
    choice_2:
    if ($r8!==self::$FAILED) {
      $this->savedPos = $p9;
      $r8 = $this->a35();
      goto choice_1;
    }
    // free $p9
    // start choice_3
    $r8 = $this->input[$this->currPos] ?? '';
    if ($r8 === "\x09" || $r8 === " ") {
      $this->currPos++;
      goto choice_3;
    } else {
      $r8 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "<") {
      $r13 = false;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
    } else {
      $r13 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = $this->discardcomment();
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    // free $p9,$r10,$r11,$r12
    choice_3:
    choice_1:
    if ($r8===self::$FAILED) {
      break;
    }
  }
  // free $r8
  // free $r13
  $r7 = true;
  // free $r7
  $r7 = $this->parsePOSITION($silence);
  // p <- $r7
  $r13 = $this->parseinlineline_in_tpls($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r13===self::$FAILED) {
    $r13 = null;
  }
  // target <- $r13
  $r8 = [];
  for (;;) {
    // start seq_3
    $p9 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r14 = $param_headingIndex;
    for (;;) {
      // start choice_4
      $p17 = $this->currPos;
      // start choice_5
      if (($this->input[$this->currPos] ?? null) === "\x0a") {
        $r16 = true;
        $this->currPos++;
        goto choice_5;
      } else {
        if (!$silence) { $this->fail(46); }
        $r16 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
        $r16 = true;
        $this->currPos += 2;
      } else {
        if (!$silence) { $this->fail(47); }
        $r16 = self::$FAILED;
      }
      choice_5:
      if ($r16!==self::$FAILED) {
        $this->savedPos = $p17;
        $r16 = $this->a62($r7, $r13);
        goto choice_4;
      }
      // free $p17
      // start choice_6
      $r16 = $this->input[$this->currPos] ?? '';
      if ($r16 === "\x09" || $r16 === " ") {
        $this->currPos++;
        goto choice_6;
      } else {
        $r16 = self::$FAILED;
        if (!$silence) { $this->fail(5); }
      }
      // start seq_4
      $p17 = $this->currPos;
      $r18 = $param_preproc;
      $r19 = $param_th;
      $r20 = $param_headingIndex;
      $r21 = $this->input[$this->currPos] ?? '';
      if ($r21 === "<") {
        $r21 = false;
        $this->currPos = $p17;
        $param_preproc = $r18;
        $param_th = $r19;
        $param_headingIndex = $r20;
      } else {
        $r21 = self::$FAILED;
        if (!$silence) { $this->fail(10); }
        $r16 = self::$FAILED;
        goto seq_4;
      }
      $r16 = $this->discardcomment();
      if ($r16===self::$FAILED) {
        $this->currPos = $p17;
        $param_preproc = $r18;
        $param_th = $r19;
        $param_headingIndex = $r20;
        $r16 = self::$FAILED;
        goto seq_4;
      }
      seq_4:
      // free $p17,$r18,$r19,$r20
      choice_6:
      choice_4:
      if ($r16===self::$FAILED) {
        break;
      }
    }
    // free $r16
    // free $r21
    $r15 = true;
    // free $r15
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r15 = true;
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(2); }
      $r15 = self::$FAILED;
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r14;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    // start choice_7
    $p17 = $this->currPos;
    // start seq_5
    $p22 = $this->currPos;
    $r21 = $param_preproc;
    $r16 = $param_th;
    $r20 = $param_headingIndex;
    $r19 = $this->parsePOSITION($silence);
    // p0 <- $r19
    $r18 = [];
    for (;;) {
      // start choice_8
      $p24 = $this->currPos;
      // start choice_9
      if (($this->input[$this->currPos] ?? null) === "\x0a") {
        $r23 = true;
        $this->currPos++;
        goto choice_9;
      } else {
        if (!$silence) { $this->fail(46); }
        $r23 = self::$FAILED;
      }
      if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
        $r23 = true;
        $this->currPos += 2;
      } else {
        if (!$silence) { $this->fail(47); }
        $r23 = self::$FAILED;
      }
      choice_9:
      if ($r23!==self::$FAILED) {
        $this->savedPos = $p24;
        $r23 = $this->a63($r7, $r13, $r19);
        goto choice_8;
      }
      // free $p24
      // start choice_10
      $r23 = $this->input[$this->currPos] ?? '';
      if ($r23 === "\x09" || $r23 === " ") {
        $this->currPos++;
        goto choice_10;
      } else {
        $r23 = self::$FAILED;
        if (!$silence) { $this->fail(5); }
      }
      // start seq_6
      $p24 = $this->currPos;
      $r25 = $param_preproc;
      $r26 = $param_th;
      $r27 = $param_headingIndex;
      $r28 = $this->input[$this->currPos] ?? '';
      if ($r28 === "<") {
        $r28 = false;
        $this->currPos = $p24;
        $param_preproc = $r25;
        $param_th = $r26;
        $param_headingIndex = $r27;
      } else {
        $r28 = self::$FAILED;
        if (!$silence) { $this->fail(10); }
        $r23 = self::$FAILED;
        goto seq_6;
      }
      $r23 = $this->parsecomment($silence);
      if ($r23===self::$FAILED) {
        $this->currPos = $p24;
        $param_preproc = $r25;
        $param_th = $r26;
        $param_headingIndex = $r27;
        $r23 = self::$FAILED;
        goto seq_6;
      }
      seq_6:
      // free $p24,$r25,$r26,$r27
      choice_10:
      choice_8:
      if ($r23!==self::$FAILED) {
        $r18[] = $r23;
      } else {
        break;
      }
    }
    // v <- $r18
    // free $r23
    // free $r28
    $r28 = $this->parsePOSITION($silence);
    // p1 <- $r28
    $p24 = $this->currPos;
    $r27 = $param_preproc;
    $r26 = $param_th;
    $r25 = $param_headingIndex;
    // start choice_11
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r23 = true;
      goto choice_11;
    } else {
      $r23 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
      $r23 = true;
    } else {
      $r23 = self::$FAILED;
    }
    choice_11:
    if ($r23!==self::$FAILED) {
      $r23 = false;
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
    } else {
      $this->currPos = $p22;
      $param_preproc = $r21;
      $param_th = $r16;
      $param_headingIndex = $r20;
      $r12 = self::$FAILED;
      goto seq_5;
    }
    // free $p24,$r27,$r26,$r25
    $r12 = true;
    seq_5:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p17;
      $r12 = $this->a64($r7, $r13, $r19, $r18, $r28);
      goto choice_7;
    }
    // free $r23
    // free $p22,$r21,$r16,$r20
    // free $p17
    $r12 = $this->parsetemplate_param_value($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    choice_7:
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r14;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r12!==self::$FAILED) {
      $r8[] = $r12;
    } else {
      break;
    }
    // free $p9,$r11,$r10,$r14
  }
  // params <- $r8
  // free $r12
  // free $r15
  for (;;) {
    // start choice_12
    $p9 = $this->currPos;
    // start choice_13
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r12 = true;
      $this->currPos++;
      goto choice_13;
    } else {
      if (!$silence) { $this->fail(46); }
      $r12 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r12 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r12 = self::$FAILED;
    }
    choice_13:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p9;
      $r12 = $this->a65($r7, $r13, $r8);
      goto choice_12;
    }
    // free $p9
    // start choice_14
    $r12 = $this->input[$this->currPos] ?? '';
    if ($r12 === "\x09" || $r12 === " ") {
      $this->currPos++;
      goto choice_14;
    } else {
      $r12 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_7
    $p9 = $this->currPos;
    $r14 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r20 = $this->input[$this->currPos] ?? '';
    if ($r20 === "<") {
      $r20 = false;
      $this->currPos = $p9;
      $param_preproc = $r14;
      $param_th = $r10;
      $param_headingIndex = $r11;
    } else {
      $r20 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r12 = self::$FAILED;
      goto seq_7;
    }
    $r12 = $this->discardcomment();
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r14;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r12 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    // free $p9,$r14,$r10,$r11
    choice_14:
    choice_12:
    if ($r12===self::$FAILED) {
      break;
    }
  }
  // free $r12
  // free $r20
  $r15 = true;
  // free $r15
  $r15 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r15===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}}}", $this->currPos, 3, false) === 0) {
    $r20 = true;
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(73); }
    $r20 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a66($r7, $r13, $r8);
  }
  // free $r6,$r15,$r20
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_attribute_name_piece($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([450, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  $p6 = $this->currPos;
  $r5 = strcspn($this->input, "\x00\x09\x0a\x0d !&-/<=>[{|}", $this->currPos);
  if ($r5 > 0) {
    $this->currPos += $r5;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
    goto choice_1;
  } else {
    $r5 = self::$FAILED;
    $r5 = self::$FAILED;
  }
  // free $p6
  // start seq_1
  $r7 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r7 === self::$FAILED) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_2
  $p6 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if ($r12 === "[") {
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->discardwikilink($boolParams, $param_tagType, $param_th, $param_headingIndex, $param_preproc);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
    goto choice_2;
  } else {
    $r5 = self::$FAILED;
  }
  // free $p8,$r9,$r10,$r11
  // free $p6
  // start seq_3
  $p6 = $this->currPos;
  $r11 = $param_preproc;
  $r10 = $param_th;
  $r9 = $param_headingIndex;
  if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
    $r13 = true;
    $r13 = false;
    $this->currPos = $p6;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
  } else {
    $r13 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p6;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_2;
  }
  // free $p6,$r11,$r10,$r9
  $p6 = $this->currPos;
  // start seq_4
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "<") {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r14 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // start seq_5
  $p16 = $this->currPos;
  $r17 = $param_preproc;
  $r18 = $param_th;
  $r19 = $param_headingIndex;
  $r20 = $this->input[$this->currPos] ?? '';
  if ($r20 === "<") {
    $r20 = false;
    $this->currPos = $p16;
    $param_preproc = $r17;
    $param_th = $r18;
    $param_headingIndex = $r19;
  } else {
    $r20 = self::$FAILED;
    $r15 = self::$FAILED;
    goto seq_5;
  }
  $r15 = $this->parsehtml_tag(true, $boolParams, $param_preproc, $param_th, $param_headingIndex);
  if ($r15===self::$FAILED) {
    $this->currPos = $p16;
    $param_preproc = $r17;
    $param_th = $r18;
    $param_headingIndex = $r19;
    $r15 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  // x <- $r15
  if ($r15===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // free $p16,$r17,$r18,$r19
  $r19 = $this->parseinlineline(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r19===self::$FAILED) {
    $r19 = null;
  }
  // ill <- $r19
  $r5 = true;
  seq_4:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p6;
    $r5 = $this->a72($r15, $r19);
    goto choice_2;
  }
  // free $r14,$r20
  // free $p8,$r9,$r10,$r11
  // free $p6
  $p6 = $this->currPos;
  // start seq_6
  $p8 = $this->currPos;
  $r11 = $param_preproc;
  $r10 = $param_th;
  $r9 = $param_headingIndex;
  $r20 = true;
  if ($r20!==self::$FAILED) {
    $r20 = false;
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
  }
  if (strcspn($this->input, "\x00\x09\x0a\x0c\x0d /=>", $this->currPos, 1) !== 0) {
    $r14 = true;
    self::advanceChar($this->input, $this->currPos);
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  $r5 = true;
  seq_6:
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
  }
  // free $r20,$r14
  // free $p8,$r11,$r10,$r9
  // free $p6
  choice_2:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  // free $r12,$r13
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_attribute_preprocessor_text_single($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([532, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "\x0a\x0d!&'-<[{|}", $this->currPos);
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p13,$r14,$r15,$r16
    if (strspn($this->input, "!&-<[{}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r17
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // r <- $r6
  // free $r7
  // free $r12
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a46($r6);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_attribute_preprocessor_text_double($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([534, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "\x0a\x0d!\"&-<[{|}", $this->currPos);
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p13,$r14,$r15,$r16
    if (strspn($this->input, "!&-<[{}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r17
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // r <- $r6
  // free $r7
  // free $r12
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a46($r6);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_attribute_preprocessor_text($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([530, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "\x09\x0a\x0c\x0d !&-<[{|}", $this->currPos);
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p13,$r14,$r15,$r16
    if (strspn($this->input, "!&-<[{}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r17
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // r <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a46($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsedirective($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([516, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(10); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsecomment($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(67); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parseannotation_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "<") {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(74); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parsewellformed_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_4
  $r9 = $this->input[$this->currPos] ?? '';
  if ($r9 === "{") {
    $r9 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(11); }
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $r5 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_5
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r10 = true;
    $r10 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r10 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // start seq_6
  $p11 = $this->currPos;
  $r12 = $param_preproc;
  $r13 = $param_th;
  $r14 = $param_headingIndex;
  $r15 = $this->input[$this->currPos] ?? '';
  if ($r15 === "-") {
    $r15 = false;
    $this->currPos = $p11;
    $param_preproc = $r12;
    $param_th = $r13;
    $param_headingIndex = $r14;
  } else {
    $r15 = self::$FAILED;
    if (!$silence) { $this->fail(60); }
    $r5 = self::$FAILED;
    goto seq_6;
  }
  $r5 = $this->parselang_variant_or_tpl($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p11;
    $param_preproc = $r12;
    $param_th = $r13;
    $param_headingIndex = $r14;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  seq_6:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  // free $p11,$r12,$r13,$r14
  seq_5:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r15
  // start seq_7
  if (($this->input[$this->currPos] ?? null) === "&") {
    $r15 = true;
    $r15 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r15 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  // start seq_8
  $p11 = $this->currPos;
  $r14 = $param_preproc;
  $r13 = $param_th;
  $r12 = $param_headingIndex;
  $r16 = $this->input[$this->currPos] ?? '';
  if ($r16 === "&") {
    $r16 = false;
    $this->currPos = $p11;
    $param_preproc = $r14;
    $param_th = $r13;
    $param_headingIndex = $r12;
  } else {
    $r16 = self::$FAILED;
    if (!$silence) { $this->fail(13); }
    $r5 = self::$FAILED;
    goto seq_8;
  }
  $r5 = $this->parsehtmlentity($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p11;
    $param_preproc = $r14;
    $param_th = $r13;
    $param_headingIndex = $r12;
    $r5 = self::$FAILED;
    goto seq_8;
  }
  seq_8:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_7;
  }
  // free $p11,$r14,$r13,$r12
  seq_7:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r16
  // start seq_9
  $r16 = $this->input[$this->currPos] ?? '';
  if ($r16 === "<") {
    $r16 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r16 = self::$FAILED;
    if (!$silence) { $this->fail(66); }
    $r5 = self::$FAILED;
    goto seq_9;
  }
  $r5 = $this->parseinclude_limits($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_9;
  }
  seq_9:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseless_than($param_tagType) {
  $key = json_encode([442, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $r3 = $this->discardhtml_or_empty($param_tagType);
  if ($r3 === self::$FAILED) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "<") {
    $r2 = "<";
    $this->currPos++;
  } else {
    $r2 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseattribute_preprocessor_text_single($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([526, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "&'-/<>{|}", $this->currPos);
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $param_headingIndex;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
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
      $param_headingIndex = $r17;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // free $p14,$r15,$r16,$r17
    // start choice_2
    // start seq_2
    $p14 = $this->currPos;
    $r17 = $param_preproc;
    $r16 = $param_th;
    $r15 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r18 = true;
      $r18 = false;
      $this->currPos = $p14;
      $param_preproc = $r17;
      $param_th = $r16;
      $param_headingIndex = $r15;
    } else {
      $r18 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r17;
      $param_th = $r16;
      $param_headingIndex = $r15;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p14,$r17,$r16,$r15
    // start seq_3
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $param_headingIndex;
    $r19 = $this->input[$this->currPos] ?? '';
    if ($r19 === "<") {
      $r19 = false;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $param_headingIndex = $r17;
    } else {
      $r19 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    $r7 = $this->parseless_than($param_tagType);
    if ($r7===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $param_headingIndex = $r17;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p14,$r15,$r16,$r17
    if (strspn($this->input, "&-/{|}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r18,$r19
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // r <- $r6
  // free $r7
  // free $r12,$r13
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a46($r6);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseattribute_preprocessor_text_double($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([528, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "\"&-/<>{|}", $this->currPos);
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $param_headingIndex;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
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
      $param_headingIndex = $r17;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // free $p14,$r15,$r16,$r17
    // start choice_2
    // start seq_2
    $p14 = $this->currPos;
    $r17 = $param_preproc;
    $r16 = $param_th;
    $r15 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r18 = true;
      $r18 = false;
      $this->currPos = $p14;
      $param_preproc = $r17;
      $param_th = $r16;
      $param_headingIndex = $r15;
    } else {
      $r18 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r17;
      $param_th = $r16;
      $param_headingIndex = $r15;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p14,$r17,$r16,$r15
    // start seq_3
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $param_headingIndex;
    $r19 = $this->input[$this->currPos] ?? '';
    if ($r19 === "<") {
      $r19 = false;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $param_headingIndex = $r17;
    } else {
      $r19 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    $r7 = $this->parseless_than($param_tagType);
    if ($r7===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $param_headingIndex = $r17;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p14,$r15,$r16,$r17
    if (strspn($this->input, "&-/{|}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r18,$r19
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // r <- $r6
  // free $r7
  // free $r12,$r13
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a46($r6);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseattribute_preprocessor_text($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([524, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p8 = $this->currPos;
    $r7 = strcspn($this->input, "\x09\x0a\x0c\x0d &-/<>{|}", $this->currPos);
    if ($r7 > 0) {
      $this->currPos += $r7;
      $r7 = substr($this->input, $p8, $this->currPos - $p8);
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      $r7 = self::$FAILED;
    }
    // free $p8
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $param_headingIndex;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "/>", $this->currPos, 2, false) === 0) {
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
      $param_headingIndex = $r17;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // free $p14,$r15,$r16,$r17
    // start choice_2
    // start seq_2
    $p14 = $this->currPos;
    $r17 = $param_preproc;
    $r16 = $param_th;
    $r15 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r18 = true;
      $r18 = false;
      $this->currPos = $p14;
      $param_preproc = $r17;
      $param_th = $r16;
      $param_headingIndex = $r15;
    } else {
      $r18 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r17;
      $param_th = $r16;
      $param_headingIndex = $r15;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p14,$r17,$r16,$r15
    // start seq_3
    $p14 = $this->currPos;
    $r15 = $param_preproc;
    $r16 = $param_th;
    $r17 = $param_headingIndex;
    $r19 = $this->input[$this->currPos] ?? '';
    if ($r19 === "<") {
      $r19 = false;
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $param_headingIndex = $r17;
    } else {
      $r19 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    $r7 = $this->parseless_than($param_tagType);
    if ($r7===self::$FAILED) {
      $this->currPos = $p14;
      $param_preproc = $r15;
      $param_th = $r16;
      $param_headingIndex = $r17;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p14,$r15,$r16,$r17
    if (strspn($this->input, "&-/{|}", $this->currPos, 1) !== 0) {
      $r7 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r18,$r19
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // r <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a46($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseautolink($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([320, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (!(/*extlink*/($boolParams & 0x4) !== 0)) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r7 = $this->a73();
  if (!$r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[\\/A-Za-z]/A", $r12)) {
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(75); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parseautourl($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $p8,$r9,$r10,$r11
  // start seq_3
  $p8 = $this->currPos;
  $r11 = $param_preproc;
  $r10 = $param_th;
  $r9 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "P" || $r13 === "R") {
    $r13 = false;
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(76); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parseautoref($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $p8,$r11,$r10,$r9
  // start seq_4
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r14 = $this->input[$this->currPos] ?? '';
  if ($r14 === "I") {
    $r14 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(77); }
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $r5 = $this->parseisbn($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  // free $p8,$r9,$r10,$r11
  choice_1:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  // free $r12,$r13,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsebehavior_switch($silence) {
  $key = 316;
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
    if (!$silence) { $this->fail(78); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p7 = $this->currPos;
  if (strcspn($this->input, "\x0a\x0d!':;<=[]{|}", $this->currPos, 1) !== 0) {
    $r8 = true;
    $r8 = false;
    $this->currPos = $p7;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(79); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->discardbehavior_text();
  if ($r6===self::$FAILED) {
    $this->currPos = $p7;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "__", $this->currPos, 2, false) === 0) {
    $r9 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(78); }
    $r9 = self::$FAILED;
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
  // free $r5,$r6,$r8,$r9
  // free $p4
  $r2 = $r3;
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a74($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseangle_bracket_markup($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([310, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(67); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parseannotation_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(80); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parsemaybe_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "<") {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(66); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parseinclude_limits($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_4
  $r9 = $this->input[$this->currPos] ?? '';
  if ($r9 === "<") {
    $r9 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(81); }
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $r5 = $this->parsehtml_tag($silence, $boolParams, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_5
  $r10 = $this->input[$this->currPos] ?? '';
  if ($r10 === "<") {
    $r10 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r10 = self::$FAILED;
    if (!$silence) { $this->fail(10); }
    $r5 = self::$FAILED;
    goto seq_5;
  }
  $r5 = $this->parsecomment($silence);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_or_tpl($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc, &$param_headingIndex) {
  $key = json_encode([366, $boolParams & 0x1fff, $param_tagType, $param_th, $param_preproc, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  // start seq_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r7 = true;
    $this->currPos += 2;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $p9 = $this->currPos;
  $r10 = $param_th;
  $r11 = $param_preproc;
  $r12 = $param_headingIndex;
  // start seq_3
  $r13 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r14 = true;
      $this->currPos += 3;
      $r13 = true;
    } else {
      $r14 = self::$FAILED;
      break;
    }
  }
  if ($r13===self::$FAILED) {
    $r8 = self::$FAILED;
    goto seq_3;
  }
  // free $r14
  $p15 = $this->currPos;
  $r16 = $param_th;
  $r17 = $param_preproc;
  $r18 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r14 = true;
  } else {
    $r14 = self::$FAILED;
  }
  if ($r14 === self::$FAILED) {
    $r14 = false;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p15;
    $param_th = $r16;
    $param_preproc = $r17;
    $param_headingIndex = $r18;
    $this->currPos = $p9;
    $param_th = $r10;
    $param_preproc = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_3;
  }
  // free $p15,$r16,$r17,$r18
  $r8 = true;
  seq_3:
  if ($r8!==self::$FAILED) {
    $r8 = false;
    $this->currPos = $p9;
    $param_th = $r10;
    $param_preproc = $r11;
    $param_headingIndex = $r12;
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // free $r13,$r14
  // free $p9,$r10,$r11,$r12
  // start seq_4
  $p9 = $this->currPos;
  $r11 = $param_th;
  $r10 = $param_preproc;
  $r14 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "{") {
    $r13 = false;
    $this->currPos = $p9;
    $param_th = $r11;
    $param_preproc = $r10;
    $param_headingIndex = $r14;
  } else {
    $r13 = self::$FAILED;
    $r12 = self::$FAILED;
    goto seq_4;
  }
  $r12 = $this->discardtplarg($boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r12===self::$FAILED) {
    $this->currPos = $p9;
    $param_th = $r11;
    $param_preproc = $r10;
    $param_headingIndex = $r14;
    $r12 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // free $p9,$r11,$r10,$r14
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $r6 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r7,$r8,$r12,$r13
  // start seq_5
  $p9 = $this->currPos;
  $r13 = $param_th;
  $r12 = $param_preproc;
  $r8 = $param_headingIndex;
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "-") {
    $r7 = false;
    $this->currPos = $p9;
    $param_th = $r13;
    $param_preproc = $r12;
    $param_headingIndex = $r8;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(82); }
    $r5 = self::$FAILED;
    goto seq_5;
  }
  $r5 = $this->parselang_variant($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p9;
    $param_th = $r13;
    $param_preproc = $r12;
    $param_headingIndex = $r8;
    $r5 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r13,$r12,$r8
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r7
  // start seq_6
  $p9 = $this->currPos;
  // start seq_7
  if (($this->input[$this->currPos] ?? null) === "-") {
    $r8 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(4); }
    $r8 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_7;
  }
  $p15 = $this->currPos;
  $r13 = $param_th;
  $r14 = $param_preproc;
  $r10 = $param_headingIndex;
  // start seq_8
  $r11 = self::$FAILED;
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r18 = true;
      $this->currPos += 3;
      $r11 = true;
    } else {
      $r18 = self::$FAILED;
      break;
    }
  }
  if ($r11===self::$FAILED) {
    $r12 = self::$FAILED;
    goto seq_8;
  }
  // free $r18
  $p19 = $this->currPos;
  $r17 = $param_th;
  $r16 = $param_preproc;
  $r20 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r18 = true;
  } else {
    $r18 = self::$FAILED;
  }
  if ($r18 === self::$FAILED) {
    $r18 = false;
  } else {
    $r18 = self::$FAILED;
    $this->currPos = $p19;
    $param_th = $r17;
    $param_preproc = $r16;
    $param_headingIndex = $r20;
    $this->currPos = $p15;
    $param_th = $r13;
    $param_preproc = $r14;
    $param_headingIndex = $r10;
    $r12 = self::$FAILED;
    goto seq_8;
  }
  // free $p19,$r17,$r16,$r20
  $r12 = true;
  seq_8:
  if ($r12!==self::$FAILED) {
    $r12 = false;
    $this->currPos = $p15;
    $param_th = $r13;
    $param_preproc = $r14;
    $param_headingIndex = $r10;
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r7 = self::$FAILED;
    goto seq_7;
  }
  // free $r11,$r18
  // free $p15,$r13,$r14,$r10
  $r7 = true;
  seq_7:
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p9, $this->currPos - $p9);
  } else {
    $r7 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  // free $r8,$r12
  // free $p9
  // start seq_9
  $p9 = $this->currPos;
  $r8 = $param_th;
  $r10 = $param_preproc;
  $r14 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "{") {
    $r13 = false;
    $this->currPos = $p9;
    $param_th = $r8;
    $param_preproc = $r10;
    $param_headingIndex = $r14;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(37); }
    $r12 = self::$FAILED;
    goto seq_9;
  }
  $r12 = $this->parsetplarg($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r12===self::$FAILED) {
    $this->currPos = $p9;
    $param_th = $r8;
    $param_preproc = $r10;
    $param_headingIndex = $r14;
    $r12 = self::$FAILED;
    goto seq_9;
  }
  seq_9:
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_6;
  }
  // free $p9,$r8,$r10,$r14
  $r5 = [$r7,$r12];
  seq_6:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r7,$r12,$r13
  // start seq_10
  $p9 = $this->currPos;
  // start seq_11
  if (($this->input[$this->currPos] ?? null) === "-") {
    $r12 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(4); }
    $r12 = self::$FAILED;
    $r13 = self::$FAILED;
    goto seq_11;
  }
  $p15 = $this->currPos;
  $r14 = $param_th;
  $r10 = $param_preproc;
  $r8 = $param_headingIndex;
  // start seq_12
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{", $this->currPos, 2, false) === 0) {
    $r18 = true;
    $this->currPos += 2;
  } else {
    $r18 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_12;
  }
  for (;;) {
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{{", $this->currPos, 3, false) === 0) {
      $r20 = true;
      $this->currPos += 3;
    } else {
      $r20 = self::$FAILED;
      break;
    }
  }
  // free $r20
  $r11 = true;
  // free $r11
  $p19 = $this->currPos;
  $r20 = $param_th;
  $r16 = $param_preproc;
  $r17 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "{") {
    $r11 = true;
  } else {
    $r11 = self::$FAILED;
  }
  if ($r11 === self::$FAILED) {
    $r11 = false;
  } else {
    $r11 = self::$FAILED;
    $this->currPos = $p19;
    $param_th = $r20;
    $param_preproc = $r16;
    $param_headingIndex = $r17;
    $this->currPos = $p15;
    $param_th = $r14;
    $param_preproc = $r10;
    $param_headingIndex = $r8;
    $r7 = self::$FAILED;
    goto seq_12;
  }
  // free $p19,$r20,$r16,$r17
  $r7 = true;
  seq_12:
  if ($r7!==self::$FAILED) {
    $r7 = false;
    $this->currPos = $p15;
    $param_th = $r14;
    $param_preproc = $r10;
    $param_headingIndex = $r8;
  } else {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r13 = self::$FAILED;
    goto seq_11;
  }
  // free $r18,$r11
  // free $p15,$r14,$r10,$r8
  $r13 = true;
  seq_11:
  if ($r13!==self::$FAILED) {
    $r13 = substr($this->input, $p9, $this->currPos - $p9);
  } else {
    $r13 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_10;
  }
  // free $r12,$r7
  // free $p9
  // start seq_13
  $p9 = $this->currPos;
  $r12 = $param_th;
  $r8 = $param_preproc;
  $r10 = $param_headingIndex;
  $r14 = $this->input[$this->currPos] ?? '';
  if ($r14 === "{") {
    $r14 = false;
    $this->currPos = $p9;
    $param_th = $r12;
    $param_preproc = $r8;
    $param_headingIndex = $r10;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(34); }
    $r7 = self::$FAILED;
    goto seq_13;
  }
  $r7 = $this->parsetemplate($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex);
  if ($r7===self::$FAILED) {
    $this->currPos = $p9;
    $param_th = $r12;
    $param_preproc = $r8;
    $param_headingIndex = $r10;
    $r7 = self::$FAILED;
    goto seq_13;
  }
  seq_13:
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_10;
  }
  // free $p9,$r12,$r8,$r10
  $r5 = [$r13,$r7];
  seq_10:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // free $r13,$r7,$r14
  // start seq_14
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
  } else {
    $r14 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_14;
  }
  // start seq_15
  $p9 = $this->currPos;
  $r7 = $param_th;
  $r13 = $param_preproc;
  $r10 = $param_headingIndex;
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "-") {
    $r8 = false;
    $this->currPos = $p9;
    $param_th = $r7;
    $param_preproc = $r13;
    $param_headingIndex = $r10;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(82); }
    $r5 = self::$FAILED;
    goto seq_15;
  }
  $r5 = $this->parselang_variant($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p9;
    $param_th = $r7;
    $param_preproc = $r13;
    $param_headingIndex = $r10;
    $r5 = self::$FAILED;
    goto seq_15;
  }
  seq_15:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_14;
  }
  // free $p9,$r7,$r13,$r10
  seq_14:
  // free $r8
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsewikilink($silence, $boolParams, $param_tagType, &$param_th, &$param_headingIndex, &$param_preproc) {
  $key = json_encode([398, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  $r4 = $param_preproc;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "[") {
    $r6 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(83); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsewikilink_preproc($silence, $boolParams, $param_tagType, self::newRef("]]"), $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "[") {
    $r7 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(84); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parsebroken_wikilink($silence, $boolParams, $param_preproc, $param_tagType, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r4 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsequote($silence) {
  $key = 410;
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
    if (!$silence) { $this->fail(85); }
    $r5 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "'") {
      $r7 = true;
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(86); }
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
    $r2 = $this->a75($r3);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseinlineline_break_on_colon($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([466, $boolParams & 0x1bff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = $this->parseinlineline($silence, $boolParams | 0x400, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseredirect_word($silence) {
  $key = 286;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  $p2 = $this->currPos;
  // start seq_1
  $r4 = strspn($this->input, "\x00\x09\x0a\x0b\x0d ", $this->currPos);
  $this->currPos += $r4;
  $p6 = $this->currPos;
  $r5 = strcspn($this->input, "\x09\x0a\x0c\x0d :[", $this->currPos);
  // rw <- $r5
  if ($r5 > 0) {
    $this->currPos += $r5;
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(88); }
    $r5 = self::$FAILED;
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  // free $p6
  $this->savedPos = $this->currPos;
  $r7 = $this->a76($r5);
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
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parseinclude_limits($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([514, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->discardinclude_check($param_tagType);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r6!==self::$FAILED) {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_3
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "<") {
    $r13 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(89); }
    $r8 = self::$FAILED;
    goto seq_3;
  }
  $r8 = $this->parsexmlish_tag($silence, $boolParams, "inc", $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  // t <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r10,$r11,$r12
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a77($r8);
  }
  // free $r6,$r7,$r13
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseannotation_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([416, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r6 = $this->a78();
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if ($r12 === "<") {
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(90); }
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parsetvar_old_syntax_closing_HACK($silence, $param_tagType);
  if ($r7===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r7!==self::$FAILED) {
    goto choice_1;
  }
  // free $p8,$r9,$r10,$r11
  $p8 = $this->currPos;
  // start seq_3
  $p13 = $this->currPos;
  $r11 = $param_preproc;
  $r10 = $param_th;
  $r9 = $param_headingIndex;
  // start seq_4
  $r15 = $this->input[$this->currPos] ?? '';
  if ($r15 === "<") {
    $r15 = false;
    $this->currPos = $p13;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
  } else {
    $r15 = self::$FAILED;
    $r14 = self::$FAILED;
    goto seq_4;
  }
  $r14 = $this->discardannotation_check($param_tagType);
  if ($r14===self::$FAILED) {
    $this->currPos = $p13;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
    $r14 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r14!==self::$FAILED) {
    $r14 = false;
    $this->currPos = $p13;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
  } else {
    $r7 = self::$FAILED;
    goto seq_3;
  }
  // start seq_5
  $p17 = $this->currPos;
  $r18 = $param_preproc;
  $r19 = $param_th;
  $r20 = $param_headingIndex;
  $r21 = $this->input[$this->currPos] ?? '';
  if ($r21 === "<") {
    $r21 = false;
    $this->currPos = $p17;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
  } else {
    $r21 = self::$FAILED;
    if (!$silence) { $this->fail(89); }
    $r16 = self::$FAILED;
    goto seq_5;
  }
  $r16 = $this->parsexmlish_tag($silence, $boolParams, "anno", $param_preproc, $param_th, $param_headingIndex);
  if ($r16===self::$FAILED) {
    $this->currPos = $p17;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
    $r16 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  // t <- $r16
  if ($r16===self::$FAILED) {
    $this->currPos = $p13;
    $param_preproc = $r11;
    $param_th = $r10;
    $param_headingIndex = $r9;
    $r7 = self::$FAILED;
    goto seq_3;
  }
  // free $p17,$r18,$r19,$r20
  $r7 = true;
  seq_3:
  if ($r7!==self::$FAILED) {
    $this->savedPos = $p8;
    $r7 = $this->a79($r16);
  }
  // free $r14,$r15,$r21
  // free $p13,$r11,$r10,$r9
  // free $p8
  choice_1:
  // tag <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a80($r7);
  }
  // free $r6,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseheading($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([314, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "=") {
    $r6 = true;
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $p13 = $this->currPos;
  $r12 = self::$FAILED;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "=") {
      $r14 = true;
      $this->currPos++;
      $r12 = true;
    } else {
      if (!$silence) { $this->fail(91); }
      $r14 = self::$FAILED;
      break;
    }
  }
  // s <- $r12
  if ($r12!==self::$FAILED) {
    $r12 = substr($this->input, $p13, $this->currPos - $p13);
  } else {
    $r12 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  // free $r14
  // free $p13
  // start seq_3
  $p13 = $this->currPos;
  $r15 = $param_preproc;
  $r16 = $param_th;
  $r17 = $param_headingIndex;
  $r19 = $this->parseinlineline($silence, $boolParams | 0x2, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r19===self::$FAILED) {
    $r19 = null;
  }
  // ill <- $r19
  $r18 = $r19;
  $this->savedPos = $p13;
  $r18 = $this->a81($r12, $r19);
  $p20 = $this->currPos;
  $r21 = self::$FAILED;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "=") {
      $r22 = true;
      $this->currPos++;
      $r21 = true;
    } else {
      if (!$silence) { $this->fail(91); }
      $r22 = self::$FAILED;
      break;
    }
  }
  if ($r21!==self::$FAILED) {
    $r21 = substr($this->input, $p20, $this->currPos - $p20);
  } else {
    $r21 = self::$FAILED;
    $this->currPos = $p13;
    $param_preproc = $r15;
    $param_th = $r16;
    $param_headingIndex = $r17;
    $r14 = self::$FAILED;
    goto seq_3;
  }
  // free $r22
  // free $p20
  $r14 = [$r18,$r21];
  seq_3:
  if ($r14===self::$FAILED) {
    $r14 = null;
  }
  // free $r18,$r21
  // free $p13,$r15,$r16,$r17
  // ce <- $r14
  $this->savedPos = $this->currPos;
  $r17 = $this->a82($r12, $r14);
  if ($r17) {
    $r17 = false;
  } else {
    $r17 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r16 = $this->parsePOSITION($silence);
  // endTPos <- $r16
  $r15 = [];
  for (;;) {
    // start choice_1
    $r21 = $this->input[$this->currPos] ?? '';
    if ($r21 === "\x09" || $r21 === " ") {
      $this->currPos++;
      goto choice_1;
    } else {
      $r21 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_4
    $p13 = $this->currPos;
    $r18 = $param_preproc;
    $r22 = $param_th;
    $r23 = $param_headingIndex;
    $r24 = $this->input[$this->currPos] ?? '';
    if ($r24 === "<" || $r24 === "_") {
      $r24 = false;
      $this->currPos = $p13;
      $param_preproc = $r18;
      $param_th = $r22;
      $param_headingIndex = $r23;
    } else {
      $r24 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $r21 = self::$FAILED;
      goto seq_4;
    }
    $r21 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r21===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r18;
      $param_th = $r22;
      $param_headingIndex = $r23;
      $r21 = self::$FAILED;
      goto seq_4;
    }
    seq_4:
    // free $p13,$r18,$r22,$r23
    choice_1:
    if ($r21!==self::$FAILED) {
      $r15[] = $r21;
    } else {
      break;
    }
  }
  // spc <- $r15
  // free $r21
  // free $r24
  $p13 = $this->currPos;
  $r21 = $param_preproc;
  $r23 = $param_th;
  $r22 = $param_headingIndex;
  // start choice_2
  // start choice_3
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r24 = true;
    goto choice_3;
  } else {
    $r24 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r24 = true;
  } else {
    $r24 = self::$FAILED;
  }
  choice_3:
  if ($r24!==self::$FAILED) {
    goto choice_2;
  }
  $this->savedPos = $this->currPos;
  $r24 = $this->a83($r12, $r14, $r16, $r15);
  if ($r24) {
    $r24 = false;
  } else {
    $r24 = self::$FAILED;
  }
  choice_2:
  if ($r24!==self::$FAILED) {
    $r24 = false;
    $this->currPos = $p13;
    $param_preproc = $r21;
    $param_th = $r23;
    $param_headingIndex = $r22;
  } else {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  // free $p13,$r21,$r23,$r22
  $r5 = true;
  seq_2:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p7;
    $r5 = $this->a84($r12, $r14, $r16, $r15, $param_headingIndex);
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r17,$r24
  // free $p8,$r9,$r10,$r11
  // free $p7
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsehr($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([298, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "----", $this->currPos, 4, false) === 0) {
    $r6 = true;
    $this->currPos += 4;
  } else {
    if (!$silence) { $this->fail(92); }
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  for (;;) {
    if (($this->input[$this->currPos] ?? null) === "-") {
      $r9 = true;
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(4); }
      $r9 = self::$FAILED;
      break;
    }
  }
  // free $r9
  $r7 = true;
  // d <- $r7
  if ($r7!==self::$FAILED) {
    $r7 = substr($this->input, $p8, $this->currPos - $p8);
  } else {
    $r7 = self::$FAILED;
  }
  // free $p8
  // start choice_1
  $p8 = $this->currPos;
  // start seq_2
  $p10 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  // start seq_3
  $this->savedPos = $this->currPos;
  $r15 = $this->a85($r7);
  if ($r15) {
    $r15 = false;
  } else {
    $r15 = self::$FAILED;
    $r14 = self::$FAILED;
    goto seq_3;
  }
  // start choice_2
  $p17 = $this->currPos;
  // start choice_3
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r16 = true;
    $this->currPos++;
    goto choice_3;
  } else {
    $r16 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r16 = true;
    $this->currPos += 2;
  } else {
    $r16 = self::$FAILED;
  }
  choice_3:
  if ($r16!==self::$FAILED) {
    $this->savedPos = $p17;
    $r16 = $this->a86($r7);
    goto choice_2;
  }
  // free $p17
  $p17 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r16 = $this->a87($r7);
  if ($r16) {
    $r16 = false;
    $this->savedPos = $p17;
    $r16 = $this->a88($r7);
  } else {
    $r16 = self::$FAILED;
  }
  // free $p17
  choice_2:
  // sp <- $r16
  if ($r16===self::$FAILED) {
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $r14 = self::$FAILED;
    goto seq_3;
  }
  // start seq_4
  $p17 = $this->currPos;
  $r19 = $param_preproc;
  $r20 = $param_th;
  $r21 = $param_headingIndex;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r22 = true;
    $r22 = false;
    $this->currPos = $p17;
    $param_preproc = $r19;
    $param_th = $r20;
    $param_headingIndex = $r21;
  } else {
    $r22 = self::$FAILED;
    $r18 = self::$FAILED;
    goto seq_4;
  }
  $r18 = $this->parseempty_lines_with_comments(true);
  if ($r18===self::$FAILED) {
    $this->currPos = $p17;
    $param_preproc = $r19;
    $param_th = $r20;
    $param_headingIndex = $r21;
    $r18 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r18===self::$FAILED) {
    $r18 = null;
  }
  // free $p17,$r19,$r20,$r21
  // elc <- $r18
  $r21 = [];
  for (;;) {
    // start seq_5
    $p17 = $this->currPos;
    $r19 = $param_preproc;
    $r23 = $param_th;
    $r24 = $param_headingIndex;
    $r25 = $this->input[$this->currPos] ?? '';
    if ($r25 === "<" || $r25 === "_") {
      $r25 = false;
      $this->currPos = $p17;
      $param_preproc = $r19;
      $param_th = $r23;
      $param_headingIndex = $r24;
    } else {
      $r25 = self::$FAILED;
      $r20 = self::$FAILED;
      goto seq_5;
    }
    $r20 = $this->parsesol_transparent(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r20===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r19;
      $param_th = $r23;
      $param_headingIndex = $r24;
      $r20 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    if ($r20!==self::$FAILED) {
      $r21[] = $r20;
    } else {
      break;
    }
    // free $p17,$r19,$r23,$r24
  }
  // st <- $r21
  // free $r20
  // free $r25
  $r14 = true;
  seq_3:
  if ($r14!==self::$FAILED) {
    $this->savedPos = $p10;
    $r14 = $this->a89($r7, $r16, $r18, $r21);
    $r14 = false;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  } else {
    $r9 = self::$FAILED;
    goto seq_2;
  }
  // free $r15,$r22
  $r9 = true;
  seq_2:
  if ($r9!==self::$FAILED) {
    $this->savedPos = $p8;
    $r9 = $this->a90($r7);
    goto choice_1;
  }
  // free $r14
  // free $p10,$r11,$r12,$r13
  // free $p8
  $p8 = $this->currPos;
  $r9 = true;
  $this->savedPos = $p8;
  $r9 = $this->a91($r7);
  // free $p8
  choice_1:
  // lineContent <- $r9
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a92($r7, $r9);
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_line($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([474, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->input[$this->currPos] ?? '';
    if ($r7 === "\x09" || $r7 === " ") {
      $this->currPos++;
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_2
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->input[$this->currPos] ?? '';
    if ($r12 === "<") {
      $r12 = false;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
    } else {
      $r12 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsecomment($silence);
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // sc <- $r6
  // free $r7
  // free $r12
  $p8 = $this->currPos;
  $r7 = $param_preproc;
  $r11 = $param_th;
  $r10 = $param_headingIndex;
  $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r12 === self::$FAILED) {
    $r12 = false;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r7;
    $param_th = $r11;
    $param_headingIndex = $r10;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r7,$r11,$r10
  // start choice_2
  // start seq_3
  $p8 = $this->currPos;
  $r11 = $param_preproc;
  $r7 = $param_th;
  $r9 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "{") {
    $r13 = false;
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r7;
    $param_headingIndex = $r9;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(6); }
    $r10 = self::$FAILED;
    goto seq_3;
  }
  $r10 = $this->parsetable_start_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r10===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r7;
    $param_headingIndex = $r9;
    $r10 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r10!==self::$FAILED) {
    goto choice_2;
  }
  // free $p8,$r11,$r7,$r9
  // start seq_4
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r7 = $param_th;
  $r11 = $param_headingIndex;
  if (strspn($this->input, "!{|", $this->currPos, 1) !== 0) {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r7;
    $param_headingIndex = $r11;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(93); }
    $r10 = self::$FAILED;
    goto seq_4;
  }
  $r10 = $this->parsetable_content_line($silence, $boolParams | 0x10, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r10===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r7;
    $param_headingIndex = $r11;
    $r10 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r10!==self::$FAILED) {
    goto choice_2;
  }
  // free $p8,$r9,$r7,$r11
  // start seq_5
  $p8 = $this->currPos;
  $r11 = $param_preproc;
  $r7 = $param_th;
  $r9 = $param_headingIndex;
  $r15 = $this->input[$this->currPos] ?? '';
  if ($r15 === "{" || $r15 === "|") {
    $r15 = false;
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r7;
    $param_headingIndex = $r9;
  } else {
    $r15 = self::$FAILED;
    if (!$silence) { $this->fail(94); }
    $r10 = self::$FAILED;
    goto seq_5;
  }
  $r10 = $this->parsetable_end_tag($silence);
  if ($r10===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r11;
    $param_th = $r7;
    $param_headingIndex = $r9;
    $r10 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  // free $p8,$r11,$r7,$r9
  choice_2:
  // tl <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a93($r6, $r10);
  }
  // free $r12,$r13,$r14,$r15
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardcomment() {
  $key = 539;
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
    // start choice_1
    $r6 = strcspn($this->input, "-", $this->currPos);
    if ($r6 > 0) {
      $this->currPos += $r6;
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
    }
    // start seq_2
    $p7 = $this->currPos;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
      $r8 = true;
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
    // free $r8,$r9
    // free $p7
    choice_1:
    if ($r6===self::$FAILED) {
      break;
    }
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
  // start choice_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-->", $this->currPos, 3, false) === 0) {
    $r6 = true;
    $this->currPos += 3;
    goto choice_2;
  } else {
    $r6 = self::$FAILED;
  }
  $this->savedPos = $this->currPos;
  $r6 = $this->a20($r4);
  if ($r6) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
  }
  choice_2:
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
    $r2 = $this->a21($r4, $r6);
  }
  // free $r3
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseinlineline_in_tpls($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([364, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->parsenested_inlineline($silence, ($boolParams & ~0x5c) | 0x20, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    $p8 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r7 = true;
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(46); }
      $r7 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r7 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a35();
    }
    // free $p8
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // il <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a94($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetemplate_param_value($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([360, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = $this->parsetemplate_param_text($silence, $boolParams & ~0x8, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // tpt <- $r6
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a95($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetemplate_param($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([356, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->parsetemplate_param_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // name <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r13 = $this->parsePOSITION($silence);
  // kEndPos <- $r13
  if (($this->input[$this->currPos] ?? null) === "=") {
    $r14 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(91); }
    $r14 = self::$FAILED;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r15 = $this->parsePOSITION($silence);
  // vStartPos <- $r15
  $p17 = $this->currPos;
  $p19 = $this->currPos;
  $r18 = strspn($this->input, "\x09 ", $this->currPos);
  // s <- $r18
  $this->currPos += $r18;
  $r18 = substr($this->input, $p19, $this->currPos - $p19);
  // free $p19
  $r16 = $r18;
  // optSp <- $r16
  $this->savedPos = $p17;
  $r16 = $this->a96($r6, $r13, $r15, $r18);
  // free $p17
  $r20 = $this->parsetemplate_param_value($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r20===self::$FAILED) {
    $r20 = null;
  }
  // tpv <- $r20
  $r7 = true;
  seq_2:
  if ($r7!==self::$FAILED) {
    $this->savedPos = $p8;
    $r7 = $this->a97($r6, $r13, $r15, $r16, $r20);
  } else {
    $r7 = null;
  }
  // free $r14
  // free $p9,$r10,$r11,$r12
  // free $p8
  // val <- $r7
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a98($r6, $r7);
    goto choice_1;
  }
  $r5 = $this->input[$this->currPos] ?? '';
  if ($r5 === "|" || $r5 === "}") {
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $this->savedPos = $p1;
    $r5 = $this->a99();
  } else {
    $r5 = self::$FAILED;
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardwikilink($boolParams, $param_tagType, &$param_th, &$param_headingIndex, &$param_preproc) {
  $key = json_encode([399, $boolParams & 0x1fff, $param_tagType, $param_th, $param_headingIndex, $param_preproc]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_headingIndex;
  $r4 = $param_preproc;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "[") {
    $r6 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->discardwikilink_preproc($boolParams, $param_tagType, self::newRef("]]"), $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "[") {
    $r7 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
  } else {
    $r7 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->discardbroken_wikilink($boolParams, $param_preproc, $param_tagType, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_headingIndex = $r3;
    $param_preproc = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r4 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsehtml_tag($silence, $boolParams, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([308, $boolParams & 0x1faf, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(89); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsexmlish_tag($silence, $boolParams, "html", $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsewellformed_extension_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([424, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(80); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parsemaybe_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // extToken <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r8 = $this->a100($r6);
  if ($r8) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a101($r6);
  }
  // free $r7,$r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardhtml_or_empty($param_tagType) {
  $key = json_encode([419, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a102($param_tagType);
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
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseautourl($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([336, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "//", $this->currPos, 2, false) === 0) {
    $r6 = true;
  } else {
    $r6 = self::$FAILED;
  }
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  // start seq_3
  $r14 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[\\/A-Za-z]/A", $r14)) {
    $r14 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(7); }
    $r13 = self::$FAILED;
    goto seq_3;
  }
  $r13 = $this->parseurl_protocol($silence);
  if ($r13===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r13 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  // proto <- $r13
  if ($r13===self::$FAILED) {
    $r7 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  // start seq_4
  $p16 = $this->currPos;
  $r17 = $param_preproc;
  $r18 = $param_th;
  $r19 = $param_headingIndex;
  $r20 = $this->input[$this->currPos] ?? '';
  if ($r20 === "[") {
    $r20 = false;
    $this->currPos = $p16;
    $param_preproc = $r17;
    $param_th = $r18;
    $param_headingIndex = $r19;
  } else {
    $r20 = self::$FAILED;
    if (!$silence) { $this->fail(8); }
    $r15 = self::$FAILED;
    goto seq_4;
  }
  $r15 = $this->parseipv6urladdr($silence);
  if ($r15===self::$FAILED) {
    $this->currPos = $p16;
    $param_preproc = $r17;
    $param_th = $r18;
    $param_headingIndex = $r19;
    $r15 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r15!==self::$FAILED) {
    goto choice_1;
  }
  // free $p16,$r17,$r18,$r19
  $r15 = '';
  choice_1:
  // addr <- $r15
  $r19 = [];
  for (;;) {
    // start seq_5
    $p16 = $this->currPos;
    $r17 = $param_preproc;
    $r21 = $param_th;
    $r22 = $param_headingIndex;
    $r23 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r23 === self::$FAILED) {
      $r23 = false;
    } else {
      $r23 = self::$FAILED;
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r21;
      $param_headingIndex = $r22;
      $r18 = self::$FAILED;
      goto seq_5;
    }
    // start choice_2
    if (preg_match("/[^\\x00- \"&-'<>\\[\\]{\\x7f\\x{a0}\\x{1680}\\x{180e}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r18, 0, $this->currPos)) {
      $r18 = $r18[0];
      $this->currPos += strlen($r18);
      goto choice_2;
    } else {
      $r18 = self::$FAILED;
      if (!$silence) { $this->fail(9); }
    }
    // start seq_6
    $p24 = $this->currPos;
    $r25 = $param_preproc;
    $r26 = $param_th;
    $r27 = $param_headingIndex;
    $r28 = $this->input[$this->currPos] ?? '';
    if ($r28 === "<") {
      $r28 = false;
      $this->currPos = $p24;
      $param_preproc = $r25;
      $param_th = $r26;
      $param_headingIndex = $r27;
    } else {
      $r28 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r18 = self::$FAILED;
      goto seq_6;
    }
    $r18 = $this->parsecomment($silence);
    if ($r18===self::$FAILED) {
      $this->currPos = $p24;
      $param_preproc = $r25;
      $param_th = $r26;
      $param_headingIndex = $r27;
      $r18 = self::$FAILED;
      goto seq_6;
    }
    seq_6:
    if ($r18!==self::$FAILED) {
      goto choice_2;
    }
    // free $p24,$r25,$r26,$r27
    // start seq_7
    $p24 = $this->currPos;
    $r27 = $param_preproc;
    $r26 = $param_th;
    $r25 = $param_headingIndex;
    $r29 = $this->input[$this->currPos] ?? '';
    if ($r29 === "{") {
      $r29 = false;
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
    } else {
      $r29 = self::$FAILED;
      if (!$silence) { $this->fail(11); }
      $r18 = self::$FAILED;
      goto seq_7;
    }
    $r18 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
    if ($r18===self::$FAILED) {
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
      $r18 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    if ($r18!==self::$FAILED) {
      goto choice_2;
    }
    // free $p24,$r27,$r26,$r25
    $p24 = $this->currPos;
    // start seq_8
    $p30 = $this->currPos;
    $r25 = $param_preproc;
    $r26 = $param_th;
    $r27 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "'") {
      $r31 = true;
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(86); }
      $r31 = self::$FAILED;
      $r18 = self::$FAILED;
      goto seq_8;
    }
    $p33 = $this->currPos;
    $r34 = $param_preproc;
    $r35 = $param_th;
    $r36 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "'") {
      $r32 = true;
    } else {
      $r32 = self::$FAILED;
    }
    if ($r32 === self::$FAILED) {
      $r32 = false;
    } else {
      $r32 = self::$FAILED;
      $this->currPos = $p33;
      $param_preproc = $r34;
      $param_th = $r35;
      $param_headingIndex = $r36;
      $this->currPos = $p30;
      $param_preproc = $r25;
      $param_th = $r26;
      $param_headingIndex = $r27;
      $r18 = self::$FAILED;
      goto seq_8;
    }
    // free $p33,$r34,$r35,$r36
    $r18 = true;
    seq_8:
    if ($r18!==self::$FAILED) {
      $r18 = substr($this->input, $p24, $this->currPos - $p24);
      goto choice_2;
    } else {
      $r18 = self::$FAILED;
    }
    // free $r31,$r32
    // free $p30,$r25,$r26,$r27
    // free $p24
    if (($this->input[$this->currPos] ?? null) === "{") {
      $r18 = "{";
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(36); }
      $r18 = self::$FAILED;
    }
    // start seq_9
    $p24 = $this->currPos;
    $r27 = $param_preproc;
    $r26 = $param_th;
    $r25 = $param_headingIndex;
    // start seq_10
    // start seq_11
    $r36 = $this->input[$this->currPos] ?? '';
    if ($r36 === "&") {
      $r36 = false;
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
    } else {
      $r36 = self::$FAILED;
      $r31 = self::$FAILED;
      goto seq_11;
    }
    $r31 = $this->parseraw_htmlentity(true);
    if ($r31===self::$FAILED) {
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
      $r31 = self::$FAILED;
      goto seq_11;
    }
    seq_11:
    // rhe <- $r31
    if ($r31===self::$FAILED) {
      $r32 = self::$FAILED;
      goto seq_10;
    }
    $this->savedPos = $this->currPos;
    $r35 = $this->a103($r13, $r15, $r31);
    if ($r35) {
      $r35 = false;
    } else {
      $r35 = self::$FAILED;
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
      $r32 = self::$FAILED;
      goto seq_10;
    }
    $r32 = true;
    seq_10:
    // free $r36,$r35
    if ($r32 === self::$FAILED) {
      $r32 = false;
    } else {
      $r32 = self::$FAILED;
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
      $r18 = self::$FAILED;
      goto seq_9;
    }
    // start choice_3
    // start seq_12
    $p30 = $this->currPos;
    $r35 = $param_preproc;
    $r36 = $param_th;
    $r34 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r37 = true;
      $r37 = false;
      $this->currPos = $p30;
      $param_preproc = $r35;
      $param_th = $r36;
      $param_headingIndex = $r34;
    } else {
      $r37 = self::$FAILED;
      $r18 = self::$FAILED;
      goto seq_12;
    }
    // start seq_13
    $p33 = $this->currPos;
    $r38 = $param_preproc;
    $r39 = $param_th;
    $r40 = $param_headingIndex;
    $r41 = $this->input[$this->currPos] ?? '';
    if ($r41 === "&") {
      $r41 = false;
      $this->currPos = $p33;
      $param_preproc = $r38;
      $param_th = $r39;
      $param_headingIndex = $r40;
    } else {
      $r41 = self::$FAILED;
      if (!$silence) { $this->fail(13); }
      $r18 = self::$FAILED;
      goto seq_13;
    }
    $r18 = $this->parsehtmlentity($silence);
    if ($r18===self::$FAILED) {
      $this->currPos = $p33;
      $param_preproc = $r38;
      $param_th = $r39;
      $param_headingIndex = $r40;
      $r18 = self::$FAILED;
      goto seq_13;
    }
    seq_13:
    if ($r18===self::$FAILED) {
      $this->currPos = $p30;
      $param_preproc = $r35;
      $param_th = $r36;
      $param_headingIndex = $r34;
      $r18 = self::$FAILED;
      goto seq_12;
    }
    // free $p33,$r38,$r39,$r40
    seq_12:
    if ($r18!==self::$FAILED) {
      goto choice_3;
    }
    // free $r41
    // free $p30,$r35,$r36,$r34
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r18 = "&";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(14); }
      $r18 = self::$FAILED;
    }
    choice_3:
    if ($r18===self::$FAILED) {
      $this->currPos = $p24;
      $param_preproc = $r27;
      $param_th = $r26;
      $param_headingIndex = $r25;
      $r18 = self::$FAILED;
      goto seq_9;
    }
    seq_9:
    // free $r37
    // free $p24,$r27,$r26,$r25
    choice_2:
    if ($r18===self::$FAILED) {
      $this->currPos = $p16;
      $param_preproc = $r17;
      $param_th = $r21;
      $param_headingIndex = $r22;
      $r18 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    if ($r18!==self::$FAILED) {
      $r19[] = $r18;
    } else {
      break;
    }
    // free $r28,$r29,$r32
    // free $p16,$r17,$r21,$r22
  }
  // path <- $r19
  // free $r18
  // free $r23
  $r7 = true;
  seq_2:
  // r <- $r7
  if ($r7!==self::$FAILED) {
    $this->savedPos = $p8;
    $r7 = $this->a104($r13, $r15, $r19);
  } else {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r14,$r20
  // free $p9,$r10,$r11,$r12
  // free $p8
  $this->savedPos = $this->currPos;
  $r12 = $this->a105($r7);
  if ($r12) {
    $r12 = false;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a106($r7);
  }
  // free $r6,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseautoref($silence) {
  $key = 328;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  // start choice_1
  // start seq_2
  $r4 = $this->input[$this->currPos] ?? '';
  if ($r4 === "R") {
    $r4 = false;
    $this->currPos = $p1;
  } else {
    $r4 = self::$FAILED;
    if (!$silence) { $this->fail(95); }
    $r3 = self::$FAILED;
    goto seq_2;
  }
  $r3 = $this->parseRFC($silence);
  if ($r3===self::$FAILED) {
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r3!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  $r5 = $this->input[$this->currPos] ?? '';
  if ($r5 === "P") {
    $r5 = false;
    $this->currPos = $p1;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(96); }
    $r3 = self::$FAILED;
    goto seq_3;
  }
  $r3 = $this->parsePMID($silence);
  if ($r3===self::$FAILED) {
    $this->currPos = $p1;
    $r3 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  choice_1:
  // ref <- $r3
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r6 = [];
  for (;;) {
    // start choice_2
    $r7 = $this->input[$this->currPos] ?? '';
    if ($r7 === "\x09" || $r7 === " ") {
      $this->currPos++;
      goto choice_2;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    if (preg_match("/[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r7, 0, $this->currPos)) {
      $r7 = $r7[0];
      $this->currPos += strlen($r7);
      goto choice_2;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(97); }
    }
    $p8 = $this->currPos;
    // start seq_4
    $p9 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r10 = true;
      $r10 = false;
      $this->currPos = $p9;
    } else {
      $r10 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_4;
    }
    // start seq_5
    $p12 = $this->currPos;
    $r13 = $this->input[$this->currPos] ?? '';
    if ($r13 === "&") {
      $r13 = false;
      $this->currPos = $p12;
    } else {
      $r13 = self::$FAILED;
      if (!$silence) { $this->fail(13); }
      $r11 = self::$FAILED;
      goto seq_5;
    }
    $r11 = $this->parsehtmlentity($silence);
    if ($r11===self::$FAILED) {
      $this->currPos = $p12;
      $r11 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    // he <- $r11
    if ($r11===self::$FAILED) {
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_4;
    }
    // free $p12
    $this->savedPos = $this->currPos;
    $r14 = $this->a107($r3, $r11);
    if ($r14) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p9;
      $r7 = self::$FAILED;
      goto seq_4;
    }
    $r7 = true;
    seq_4:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a108($r3, $r11);
    }
    // free $r10,$r13,$r14
    // free $p9
    // free $p8
    choice_2:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // sp <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r7
  $p8 = $this->currPos;
  $r7 = strspn($this->input, "0123456789", $this->currPos);
  // identifier <- $r7
  if ($r7 > 0) {
    $this->currPos += $r7;
    $r7 = substr($this->input, $p8, $this->currPos - $p8);
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(50); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p8
  // start choice_3
  $this->savedPos = $this->currPos;
  $r14 = $this->a109($r3, $r6, $r7);
  if ($r14) {
    $r14 = false;
    goto choice_3;
  } else {
    $r14 = self::$FAILED;
  }
  $p8 = $this->currPos;
  $r14 = $this->input[$this->currPos] ?? '';
  if (!(preg_match("/[0-9A-Z_a-z]/A", $r14))) {
    $r14 = self::$FAILED;
  }
  if ($r14 === self::$FAILED) {
    $r14 = false;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p8;
  }
  // free $p8
  choice_3:
  if ($r14===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a110($r3, $r6, $r7);
  }
  // free $r4,$r5,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parseisbn($silence) {
  $key = 330;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a111();
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
    if (!$silence) { $this->fail(98); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r5 = [];
  for (;;) {
    // start choice_1
    $r6 = $this->input[$this->currPos] ?? '';
    if ($r6 === "\x09" || $r6 === " ") {
      $this->currPos++;
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    if (preg_match("/[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r6, 0, $this->currPos)) {
      $r6 = $r6[0];
      $this->currPos += strlen($r6);
      goto choice_1;
    } else {
      $r6 = self::$FAILED;
      if (!$silence) { $this->fail(97); }
    }
    $p7 = $this->currPos;
    // start seq_2
    $p8 = $this->currPos;
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r9 = true;
      $r9 = false;
      $this->currPos = $p8;
    } else {
      $r9 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // start seq_3
    $p11 = $this->currPos;
    $r12 = $this->input[$this->currPos] ?? '';
    if ($r12 === "&") {
      $r12 = false;
      $this->currPos = $p11;
    } else {
      $r12 = self::$FAILED;
      if (!$silence) { $this->fail(13); }
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $r10 = $this->parsehtmlentity($silence);
    if ($r10===self::$FAILED) {
      $this->currPos = $p11;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    // he <- $r10
    if ($r10===self::$FAILED) {
      $this->currPos = $p8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    // free $p11
    $this->savedPos = $this->currPos;
    $r13 = $this->a112($r10);
    if ($r13) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p8;
      $r6 = self::$FAILED;
      goto seq_2;
    }
    $r6 = true;
    seq_2:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a113($r10);
    }
    // free $r9,$r12,$r13
    // free $p8
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
  // sp <- $r5
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r6
  // start seq_4
  $p7 = $this->currPos;
  if (strspn($this->input, "0123456789", $this->currPos, 1) !== 0) {
    $r13 = $this->input[$this->currPos];
    $this->currPos++;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(50); }
    $r6 = self::$FAILED;
    goto seq_4;
  }
  $r12 = [];
  for (;;) {
    // start seq_5
    $p8 = $this->currPos;
    // start choice_2
    // start choice_3
    // start choice_4
    $r14 = $this->input[$this->currPos] ?? '';
    if ($r14 === "\x09" || $r14 === " ") {
      $this->currPos++;
      goto choice_4;
    } else {
      $r14 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    if (preg_match("/[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r14, 0, $this->currPos)) {
      $r14 = $r14[0];
      $this->currPos += strlen($r14);
      goto choice_4;
    } else {
      $r14 = self::$FAILED;
      if (!$silence) { $this->fail(97); }
    }
    // start seq_6
    if (($this->input[$this->currPos] ?? null) === "&") {
      $r15 = true;
      $r15 = false;
      $this->currPos = $p8;
    } else {
      $r15 = self::$FAILED;
      $r14 = self::$FAILED;
      goto seq_6;
    }
    // start seq_7
    $p11 = $this->currPos;
    $r17 = $this->input[$this->currPos] ?? '';
    if ($r17 === "&") {
      $r17 = false;
      $this->currPos = $p11;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(13); }
      $r16 = self::$FAILED;
      goto seq_7;
    }
    $r16 = $this->parsehtmlentity($silence);
    if ($r16===self::$FAILED) {
      $this->currPos = $p11;
      $r16 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    // he <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p8;
      $r14 = self::$FAILED;
      goto seq_6;
    }
    // free $p11
    $this->savedPos = $this->currPos;
    $r18 = $this->a114($r5, $r16);
    if ($r18) {
      $r18 = false;
    } else {
      $r18 = self::$FAILED;
      $this->currPos = $p8;
      $r14 = self::$FAILED;
      goto seq_6;
    }
    $r14 = true;
    seq_6:
    if ($r14!==self::$FAILED) {
      $this->savedPos = $p8;
      $r14 = $this->a115($r5, $r16);
    }
    // free $r15,$r17,$r18
    choice_4:
    if ($r14!==self::$FAILED) {
      goto choice_3;
    }
    if (($this->input[$this->currPos] ?? null) === "-") {
      $r14 = "-";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(4); }
      $r14 = self::$FAILED;
    }
    choice_3:
    if ($r14!==self::$FAILED) {
      goto choice_2;
    }
    $r14 = '';
    choice_2:
    if (strspn($this->input, "0123456789", $this->currPos, 1) !== 0) {
      $r18 = $this->input[$this->currPos];
      $this->currPos++;
    } else {
      $r18 = self::$FAILED;
      if (!$silence) { $this->fail(50); }
      $this->currPos = $p8;
      $r9 = self::$FAILED;
      goto seq_5;
    }
    $r9 = [$r14,$r18];
    seq_5:
    if ($r9!==self::$FAILED) {
      $r12[] = $r9;
    } else {
      break;
    }
    // free $r14,$r18
    // free $p8
  }
  if (count($r12) === 0) {
    $r12 = self::$FAILED;
  }
  if ($r12===self::$FAILED) {
    $this->currPos = $p7;
    $r6 = self::$FAILED;
    goto seq_4;
  }
  // free $r9
  // start choice_5
  // start seq_8
  $p8 = $this->currPos;
  // start choice_6
  // start choice_7
  // start choice_8
  $r18 = $this->input[$this->currPos] ?? '';
  if ($r18 === "\x09" || $r18 === " ") {
    $this->currPos++;
    goto choice_8;
  } else {
    $r18 = self::$FAILED;
    if (!$silence) { $this->fail(5); }
  }
  if (preg_match("/[ \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{202f}\\x{205f}\\x{3000}]/Au", $this->input, $r18, 0, $this->currPos)) {
    $r18 = $r18[0];
    $this->currPos += strlen($r18);
    goto choice_8;
  } else {
    $r18 = self::$FAILED;
    if (!$silence) { $this->fail(97); }
  }
  // start seq_9
  if (($this->input[$this->currPos] ?? null) === "&") {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p8;
  } else {
    $r14 = self::$FAILED;
    $r18 = self::$FAILED;
    goto seq_9;
  }
  // start seq_10
  $p11 = $this->currPos;
  $r15 = $this->input[$this->currPos] ?? '';
  if ($r15 === "&") {
    $r15 = false;
    $this->currPos = $p11;
  } else {
    $r15 = self::$FAILED;
    if (!$silence) { $this->fail(13); }
    $r17 = self::$FAILED;
    goto seq_10;
  }
  $r17 = $this->parsehtmlentity($silence);
  if ($r17===self::$FAILED) {
    $this->currPos = $p11;
    $r17 = self::$FAILED;
    goto seq_10;
  }
  seq_10:
  // he <- $r17
  if ($r17===self::$FAILED) {
    $this->currPos = $p8;
    $r18 = self::$FAILED;
    goto seq_9;
  }
  // free $p11
  $this->savedPos = $this->currPos;
  $r19 = $this->a114($r5, $r17);
  if ($r19) {
    $r19 = false;
  } else {
    $r19 = self::$FAILED;
    $this->currPos = $p8;
    $r18 = self::$FAILED;
    goto seq_9;
  }
  $r18 = true;
  seq_9:
  if ($r18!==self::$FAILED) {
    $this->savedPos = $p8;
    $r18 = $this->a115($r5, $r17);
  }
  // free $r14,$r15,$r19
  choice_8:
  if ($r18!==self::$FAILED) {
    goto choice_7;
  }
  if (($this->input[$this->currPos] ?? null) === "-") {
    $r18 = "-";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(4); }
    $r18 = self::$FAILED;
  }
  choice_7:
  if ($r18!==self::$FAILED) {
    goto choice_6;
  }
  $r18 = '';
  choice_6:
  $r19 = $this->input[$this->currPos] ?? '';
  if ($r19 === "X" || $r19 === "x") {
    $this->currPos++;
  } else {
    $r19 = self::$FAILED;
    if (!$silence) { $this->fail(99); }
    $this->currPos = $p8;
    $r9 = self::$FAILED;
    goto seq_8;
  }
  $r9 = [$r18,$r19];
  seq_8:
  if ($r9!==self::$FAILED) {
    goto choice_5;
  }
  // free $r18,$r19
  // free $p8
  $r9 = '';
  choice_5:
  $r6 = [$r13,$r12,$r9];
  seq_4:
  // isbn <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $r13,$r12,$r9
  // free $p7
  $p7 = $this->currPos;
  // start choice_9
  $this->savedPos = $this->currPos;
  $r9 = $this->a116($r5, $r6);
  if ($r9) {
    $r9 = false;
    goto choice_9;
  } else {
    $r9 = self::$FAILED;
  }
  $p8 = $this->currPos;
  $r9 = $this->input[$this->currPos] ?? '';
  if (!(preg_match("/[0-9A-Z_a-z]/A", $r9))) {
    $r9 = self::$FAILED;
  }
  if ($r9 === self::$FAILED) {
    $r9 = false;
  } else {
    $r9 = self::$FAILED;
    $this->currPos = $p8;
  }
  // free $p8
  choice_9:
  // isbncode <- $r9
  if ($r9!==self::$FAILED) {
    $this->savedPos = $p7;
    $r9 = $this->a117($r5, $r6);
  } else {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p7
  $this->savedPos = $this->currPos;
  $r12 = $this->a118($r5, $r6, $r9);
  if ($r12) {
    $r12 = false;
  } else {
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a119($r5, $r6, $r9);
  }
  // free $r3,$r4,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardbehavior_text() {
  $key = 319;
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
    if (strcspn($this->input, "\x0a\x0d!':;<=[]{|}", $this->currPos, 1) !== 0) {
      $r6 = true;
      self::advanceChar($this->input, $this->currPos);
    } else {
      $r6 = self::$FAILED;
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
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsemaybe_extension_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([422, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->discardextension_check($param_tagType);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r6!==self::$FAILED) {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_3
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r13 = $this->input[$this->currPos] ?? '';
  if ($r13 === "<") {
    $r13 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(89); }
    $r8 = self::$FAILED;
    goto seq_3;
  }
  $r8 = $this->parsexmlish_tag($silence, $boolParams, "ext", $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  // t <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r10,$r11,$r12
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a120($r8);
  }
  // free $r6,$r7,$r13
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant($silence, $boolParams, $param_tagType, &$param_th, &$param_preproc, &$param_headingIndex) {
  $key = json_encode([370, $boolParams & 0x1ffb, $param_tagType, $param_th, $param_preproc, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_th;
  $r3 = $param_preproc;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "-") {
    $r6 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(100); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parselang_variant_preproc($silence, $boolParams & ~0x4, $param_tagType, self::newRef("}-"), $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "-") {
    $r7 = false;
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(101); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parsebroken_lang_variant($silence, $param_preproc);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_th = $r2;
    $param_preproc = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r3 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r2 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsewikilink_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([402, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "[") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(102); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsewikilink_preproc_internal($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r7 = "[[";
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(61); }
    $r7 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
    $r9 = "]]";
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(103); }
    $r9 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = [$r7,$r8,$r9];
  seq_2:
  // free $r7,$r8,$r9
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsebroken_wikilink($silence, $boolParams, &$param_preproc, $param_tagType, &$param_th, &$param_headingIndex) {
  $key = json_encode([400, $boolParams & 0x1fff, $param_preproc, $param_tagType, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r7 = $this->a121($param_preproc);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "[") {
    $r13 = "[";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(27); }
    $r13 = self::$FAILED;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  // start seq_3
  $p15 = $this->currPos;
  $r16 = $param_preproc;
  $r17 = $param_th;
  $r18 = $param_headingIndex;
  $r19 = $this->input[$this->currPos] ?? '';
  if ($r19 === "[") {
    $r19 = false;
    $this->currPos = $p15;
    $param_preproc = $r16;
    $param_th = $r17;
    $param_headingIndex = $r18;
  } else {
    $r19 = self::$FAILED;
    if (!$silence) { $this->fail(18); }
    $r14 = self::$FAILED;
    goto seq_3;
  }
  $r14 = $this->parseextlink($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r14===self::$FAILED) {
    $this->currPos = $p15;
    $param_preproc = $r16;
    $param_th = $r17;
    $param_headingIndex = $r18;
    $r14 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r14!==self::$FAILED) {
    goto choice_1;
  }
  // free $p15,$r16,$r17,$r18
  if (($this->input[$this->currPos] ?? null) === "[") {
    $r14 = "[";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(27); }
    $r14 = self::$FAILED;
  }
  choice_1:
  if ($r14===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = [$r13,$r14];
  seq_2:
  // a <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r13,$r14,$r19
  // free $p9,$r10,$r11,$r12
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a122($param_preproc, $r8);
  }
  // free $r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardinclude_check($param_tagType) {
  $key = json_encode([513, $param_tagType]);
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
  // start seq_2
  $p5 = $this->currPos;
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p5;
  } else {
    $r6 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r4 = $this->parsexmlish_start(true);
  if ($r4===self::$FAILED) {
    $this->currPos = $p5;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $this->savedPos = $this->currPos;
  $r7 = $this->a123($r4);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsexmlish_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([436, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $p7 = $this->currPos;
  $r8 = $param_preproc;
  $r9 = $param_th;
  $r10 = $param_headingIndex;
  $r11 = $this->input[$this->currPos] ?? '';
  if ($r11 === "<") {
    $r11 = false;
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
  } else {
    $r11 = self::$FAILED;
    if (!$silence) { $this->fail(104); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parsexmlish_start($silence);
  if ($r6===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r8;
    $param_th = $r9;
    $param_headingIndex = $r10;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // start <- $r6
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r8,$r9,$r10
  $this->savedPos = $this->currPos;
  $r10 = $this->a124($param_tagType, $r6);
  if ($r10) {
    $r10 = false;
  } else {
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r9 = $this->parsegeneric_newline_attributes($silence, $boolParams & ~0x50, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // attribs <- $r9
  for (;;) {
    // start seq_3
    $p7 = $this->currPos;
    $r13 = $param_preproc;
    $r14 = $param_th;
    $r15 = $param_headingIndex;
    if (strspn($this->input, "\x09\x0a\x0c\x0d /", $this->currPos, 1) !== 0) {
      $r16 = true;
      $r16 = false;
      $this->currPos = $p7;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
    } else {
      $r16 = self::$FAILED;
      if (!$silence) { $this->fail(105); }
      $r12 = self::$FAILED;
      goto seq_3;
    }
    $r12 = $this->discardspace_or_newline_or_solidus();
    if ($r12===self::$FAILED) {
      $this->currPos = $p7;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
      $r12 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r12===self::$FAILED) {
      break;
    }
    // free $p7,$r13,$r14,$r15
  }
  // free $r12
  // free $r16
  $r8 = true;
  // free $r8
  if (($this->input[$this->currPos] ?? null) === "/") {
    $r8 = "/";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(106); }
    $r8 = self::$FAILED;
    $r8 = null;
  }
  // selfclose <- $r8
  $r16 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r16;
  if (($this->input[$this->currPos] ?? null) === ">") {
    $r12 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(107); }
    $r12 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a125($param_tagType, $r6, $r9, $r8);
  }
  // free $r11,$r10,$r16,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetvar_old_syntax_closing_HACK($silence, $param_tagType) {
  $key = json_encode([412, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a126($param_tagType);
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
    if (!$silence) { $this->fail(108); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r5 = $this->a127($param_tagType);
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
    $r2 = $this->a128($param_tagType);
  }
  // free $r3,$r4,$r5
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardannotation_check($param_tagType) {
  $key = json_encode([415, $param_tagType]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a126($param_tagType);
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p5 = $this->currPos;
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p5;
  } else {
    $r6 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r4 = $this->parsexmlish_start(true);
  if ($r4===self::$FAILED) {
    $this->currPos = $p5;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $this->savedPos = $this->currPos;
  $r7 = $this->a129($param_tagType, $r4);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_content_line($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([476, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "!") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(109); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parsetable_heading_tags($silence, $boolParams, $param_tagType, $param_preproc, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "{" || $r7 === "|") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(110); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parsetable_row_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_3
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "{" || $r8 === "|") {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(111); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parsetable_data_tags($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_4
  $r9 = $this->input[$this->currPos] ?? '';
  if ($r9 === "{" || $r9 === "|") {
    $r9 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(112); }
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $r5 = $this->parsetable_caption_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_end_tag($silence) {
  $key = 500;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r3 = "|";
    $this->currPos++;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(2); }
    $r3 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r3 = "{{!}}";
    $this->currPos += 5;
  } else {
    if (!$silence) { $this->fail(3); }
    $r3 = self::$FAILED;
  }
  choice_1:
  // p <- $r3
  if ($r3===self::$FAILED) {
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // b <- $r4
  if (($this->input[$this->currPos] ?? null) === "}") {
    $r4 = "}";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(113); }
    $r4 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  if ($r2!==self::$FAILED) {
    $this->savedPos = $p1;
    $r2 = $this->a130($r3, $r4);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsenested_inlineline($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([294, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetemplate_param_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([362, $boolParams & 0x1f8b, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->parsenested_block($silence, ($boolParams & ~0x54) | 0x20, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    $p8 = $this->currPos;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r7 = true;
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(46); }
      $r7 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r7 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r7 = self::$FAILED;
    }
    choice_2:
    if ($r7!==self::$FAILED) {
      $this->savedPos = $p8;
      $r7 = $this->a35();
    }
    // free $p8
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // il <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a131($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetemplate_param_name($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([358, $boolParams & 0x1f83, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  $r5 = $this->parsetemplate_param_text($silence, $boolParams | 0x8, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "=") {
    $r6 = true;
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = '';
  seq_1:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardwikilink_preproc($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([403, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "[") {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->discardwikilink_preproc_internal($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r5!==self::$FAILED) {
    goto choice_1;
  }
  // start seq_2
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r7 = true;
    $this->currPos += 2;
  } else {
    $r7 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->discardinlineline($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
    $r9 = true;
    $this->currPos += 2;
  } else {
    $r9 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = true;
  seq_2:
  // free $r7,$r8,$r9
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardbroken_wikilink($boolParams, &$param_preproc, $param_tagType, &$param_th, &$param_headingIndex) {
  $key = json_encode([401, $boolParams & 0x1fff, $param_preproc, $param_tagType, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r7 = $this->a121($param_preproc);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === "[") {
    $r13 = "[";
    $this->currPos++;
  } else {
    $r13 = self::$FAILED;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  // start seq_3
  $p15 = $this->currPos;
  $r16 = $param_preproc;
  $r17 = $param_th;
  $r18 = $param_headingIndex;
  $r19 = $this->input[$this->currPos] ?? '';
  if ($r19 === "[") {
    $r19 = false;
    $this->currPos = $p15;
    $param_preproc = $r16;
    $param_th = $r17;
    $param_headingIndex = $r18;
  } else {
    $r19 = self::$FAILED;
    $r14 = self::$FAILED;
    goto seq_3;
  }
  $r14 = $this->parseextlink(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r14===self::$FAILED) {
    $this->currPos = $p15;
    $param_preproc = $r16;
    $param_th = $r17;
    $param_headingIndex = $r18;
    $r14 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r14!==self::$FAILED) {
    goto choice_1;
  }
  // free $p15,$r16,$r17,$r18
  if (($this->input[$this->currPos] ?? null) === "[") {
    $r14 = "[";
    $this->currPos++;
  } else {
    $r14 = self::$FAILED;
  }
  choice_1:
  if ($r14===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = [$r13,$r14];
  seq_2:
  // a <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r13,$r14,$r19
  // free $p9,$r10,$r11,$r12
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a122($param_preproc, $r8);
  }
  // free $r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseRFC($silence) {
  $key = 324;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a132();
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "RFC", $this->currPos, 3, false) === 0) {
    $r2 = "RFC";
    $this->currPos += 3;
  } else {
    if (!$silence) { $this->fail(114); }
    $r2 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsePMID($silence) {
  $key = 326;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  $this->savedPos = $this->currPos;
  $r3 = $this->a133();
  if ($r3) {
    $r3 = false;
  } else {
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "PMID", $this->currPos, 4, false) === 0) {
    $r2 = "PMID";
    $this->currPos += 4;
  } else {
    if (!$silence) { $this->fail(115); }
    $r2 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardextension_check($param_tagType) {
  $key = json_encode([421, $param_tagType]);
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
  // start seq_2
  $p5 = $this->currPos;
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p5;
  } else {
    $r6 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r4 = $this->parsexmlish_start(true);
  if ($r4===self::$FAILED) {
    $this->currPos = $p5;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $this->savedPos = $this->currPos;
  $r7 = $this->a134($r4);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parselang_variant_preproc($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([372, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // lv0 <- $r6
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "-{", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $this->currPos += 2;
    $this->savedPos = $p1;
    $r6 = $this->a135();
  } else {
    if (!$silence) { $this->fail(116); }
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  $p8 = $this->currPos;
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $this->savedPos = $this->currPos;
  $r13 = $this->a136($r6);
  if ($r13) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r14 = $this->parseopt_lang_variant_flags($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // ff <- $r14
  $r7 = true;
  seq_2:
  if ($r7!==self::$FAILED) {
    $this->savedPos = $p8;
    $r7 = $this->a137($r6, $r14);
    goto choice_1;
  }
  // free $r13
  // free $p9,$r10,$r11,$r12
  // free $p8
  $p8 = $this->currPos;
  // start seq_3
  $p9 = $this->currPos;
  $r12 = $param_preproc;
  $r11 = $param_th;
  $r10 = $param_headingIndex;
  $this->savedPos = $this->currPos;
  $r13 = $this->a138($r6);
  if ($r13) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $r7 = self::$FAILED;
    goto seq_3;
  }
  $r7 = true;
  seq_3:
  if ($r7!==self::$FAILED) {
    $this->savedPos = $p8;
    $r7 = $this->a139($r6);
  }
  // free $r13
  // free $p9,$r12,$r11,$r10
  // free $p8
  choice_1:
  // f <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_2
  $p8 = $this->currPos;
  // start seq_4
  $p9 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  $this->savedPos = $this->currPos;
  $r15 = $this->a140($r6, $r7);
  if ($r15) {
    $r15 = false;
  } else {
    $r15 = self::$FAILED;
    $r10 = self::$FAILED;
    goto seq_4;
  }
  $r16 = $this->parselang_variant_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // lv <- $r16
  $r10 = true;
  seq_4:
  if ($r10!==self::$FAILED) {
    $this->savedPos = $p8;
    $r10 = $this->a141($r6, $r7, $r16);
    goto choice_2;
  }
  // free $r15
  // free $p9,$r11,$r12,$r13
  // free $p8
  // start seq_5
  $p8 = $this->currPos;
  $r13 = $param_preproc;
  $r12 = $param_th;
  $r11 = $param_headingIndex;
  $this->savedPos = $this->currPos;
  $r15 = $this->a142($r6, $r7);
  if ($r15) {
    $r15 = false;
  } else {
    $r15 = self::$FAILED;
    $r10 = self::$FAILED;
    goto seq_5;
  }
  $r10 = $this->parselang_variant_option_list($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  seq_5:
  // free $p8,$r13,$r12,$r11
  choice_2:
  // ts <- $r10
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r11 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r11===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_6
  $p8 = $this->currPos;
  $r13 = $param_preproc;
  $r17 = $param_th;
  $r18 = $param_headingIndex;
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "}-", $this->currPos, 2, false) === 0) {
    $r19 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(117); }
    $r19 = self::$FAILED;
    $r12 = self::$FAILED;
    goto seq_6;
  }
  $r12 = $this->parsePOSITION($silence);
  seq_6:
  // lv1 <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r13,$r17,$r18
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a143($r6, $r7, $r10, $r12);
  }
  // free $r15,$r11,$r19
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsebroken_lang_variant($silence, &$param_preproc) {
  $key = json_encode([368, $param_preproc]);
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
    if (!$silence) { $this->fail(116); }
    $r4 = self::$FAILED;
    $r3 = self::$FAILED;
    goto seq_1;
  }
  $r3 = true;
  seq_1:
  if ($r3!==self::$FAILED) {
    $this->savedPos = $p1;
    $r3 = $this->a144($r4, $param_preproc);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r3,
    self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r3;
}
private function parsewikilink_preproc_internal($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([404, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(61); }
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parsePOSITION($silence);
  // spos <- $r7
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r13 = self::charAt($this->input, $this->currPos);
  if ($r13 !== '' && !($r13 === "[" || $r13 === "|")) {
    $r13 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r13 = self::$FAILED;
    if (!$silence) { $this->fail(118); }
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->parsewikilink_preprocessor_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // free $p9,$r10,$r11,$r12
  // target <- $r8
  $r12 = $this->parsePOSITION($silence);
  // tpos <- $r12
  $r11 = $this->parsewikilink_content($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // lcs <- $r11
  $r10 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
    $r14 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(103); }
    $r14 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a145($r7, $r8, $r12, $r11);
  }
  // free $r6,$r13,$r10,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsexmlish_start($silence) {
  $key = 434;
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;

    return $cached->result;
  }
  $p1 = $this->currPos;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "<") {
    $r3 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(119); }
    $r3 = self::$FAILED;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "/") {
    $r4 = "/";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(106); }
    $r4 = self::$FAILED;
    $r4 = null;
  }
  $p5 = $this->currPos;
  $r6 = strcspn($this->input, "\x00\x09\x0a\x0b />", $this->currPos);
  if ($r6 > 0) {
    $this->currPos += $r6;
    $r6 = substr($this->input, $p5, $this->currPos - $p5);
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(120); }
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $r2 = [$r4,$r6];
  seq_1:
  // free $r4,$r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function parsetable_heading_tags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_headingIndex) {
  $key = json_encode([486, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_headingIndex;
  // start seq_1
  $r5 = $this->input[$this->currPos] ?? '';
  if ($r5 === "!") {
    $r5 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_headingIndex = $r3;
  } else {
    $r5 = self::$FAILED;
    if (!$silence) { $this->fail(121); }
    $r4 = self::$FAILED;
    goto seq_1;
  }
  $r4 = $this->parsetable_heading_tags_parameterized($silence, $boolParams, $param_tagType, $param_preproc, self::newRef(true), $param_headingIndex);
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_headingIndex = $r3;
    $r4 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r4,
    $r3 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r4;
}
private function parsetable_data_tags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([494, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r7 = "|";
    $this->currPos++;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(2); }
    $r7 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r7 = "{{!}}";
    $this->currPos += 5;
  } else {
    if (!$silence) { $this->fail(3); }
    $r7 = self::$FAILED;
  }
  choice_1:
  // p <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r8 = $this->input[$this->currPos] ?? '';
  if (!($r8 === "+" || $r8 === "-")) {
    $r8 = self::$FAILED;
  }
  if ($r8 === self::$FAILED) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p9,$r10,$r11,$r12
  $r12 = $this->parsetable_data_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // td <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r11 = $this->parsetds($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // tds <- $r11
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a146($r7, $r12, $r11);
  }
  // free $r6,$r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_caption_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([482, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (!(/*tableDataBlock*/($boolParams & 0x1) !== 0)) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start choice_1
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r7 = "|";
    $this->currPos++;
    goto choice_1;
  } else {
    if (!$silence) { $this->fail(2); }
    $r7 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r7 = "{{!}}";
    $this->currPos += 5;
  } else {
    if (!$silence) { $this->fail(3); }
    $r7 = self::$FAILED;
  }
  choice_1:
  // p <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  if (($this->input[$this->currPos] ?? null) === "+") {
    $r8 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(122); }
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p10 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  $r14 = self::charAt($this->input, $this->currPos);
  if ($r14 !== '' && !($r14 === "\x0a" || $r14 === "\x0d")) {
    $r14 = false;
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(123); }
    $r9 = self::$FAILED;
    goto seq_2;
  }
  $r9 = $this->parserow_syntax_table_args($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r9===self::$FAILED) {
    $this->currPos = $p10;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $r9 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r9===self::$FAILED) {
    $r9 = null;
  }
  // free $p10,$r11,$r12,$r13
  // args <- $r9
  $r13 = $this->parsePOSITION($silence);
  // tagEndPos <- $r13
  $r12 = [];
  for (;;) {
    $r11 = $this->parsenested_block_in_table($silence, $boolParams | 0x1000, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r11!==self::$FAILED) {
      $r12[] = $r11;
    } else {
      break;
    }
  }
  // c <- $r12
  // free $r11
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a147($r7, $r9, $r13, $r12);
  }
  // free $r6,$r8,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsenested_block($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([290, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = $this->parseblock($silence, $boolParams, $param_tagType, $param_th, $param_headingIndex, $param_preproc);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardwikilink_preproc_internal($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([405, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "[[", $this->currPos, 2, false) === 0) {
    $r6 = true;
    $this->currPos += 2;
  } else {
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parsePOSITION(true);
  // spos <- $r7
  // start seq_2
  $p9 = $this->currPos;
  $r10 = $param_preproc;
  $r11 = $param_th;
  $r12 = $param_headingIndex;
  $r13 = self::charAt($this->input, $this->currPos);
  if ($r13 !== '' && !($r13 === "[" || $r13 === "|")) {
    $r13 = false;
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
  } else {
    $r13 = self::$FAILED;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->parsewikilink_preprocessor_text(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r10;
    $param_th = $r11;
    $param_headingIndex = $r12;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r8===self::$FAILED) {
    $r8 = null;
  }
  // free $p9,$r10,$r11,$r12
  // target <- $r8
  $r12 = $this->parsePOSITION(true);
  // tpos <- $r12
  $r11 = $this->parsewikilink_content(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // lcs <- $r11
  $r10 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
    $r14 = true;
    $this->currPos += 2;
  } else {
    $r14 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a145($r7, $r8, $r12, $r11);
  }
  // free $r6,$r13,$r10,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardinlineline($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([307, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->parseurltext(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r12 === self::$FAILED) {
      $r12 = false;
    } else {
      $r12 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // start choice_2
    // start seq_2
    $p13 = $this->currPos;
    $r14 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "'-<[{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parseinline_element(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p13;
      $param_preproc = $r14;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_2;
    }
    // free $p13,$r14,$r15,$r16
    // start seq_3
    $p13 = $this->currPos;
    $r16 = $param_preproc;
    $r15 = $param_th;
    $r14 = $param_headingIndex;
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r18 = true;
      goto choice_3;
    } else {
      $r18 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r18 = true;
    } else {
      $r18 = self::$FAILED;
    }
    choice_3:
    if ($r18 === self::$FAILED) {
      $r18 = false;
    } else {
      $r18 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r16;
      $param_th = $r15;
      $param_headingIndex = $r14;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    if ($this->currPos < $this->inputLength) {
      $r7 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r7 = self::$FAILED;
      $this->currPos = $p13;
      $param_preproc = $r16;
      $param_th = $r15;
      $param_headingIndex = $r14;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    // free $p13,$r16,$r15,$r14
    choice_2:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r17,$r18
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // c <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a26($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseopt_lang_variant_flags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([374, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->parselang_variant_flags($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r7 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(2); }
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  if ($r6===self::$FAILED) {
    $r6 = null;
  }
  // f <- $r6
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a148($r6);
  // free $r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([390, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->parseinlineline($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r7 = "|";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(2); }
      $r7 = self::$FAILED;
    }
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // tokens <- $r6
  // free $r7
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a149($r6);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_option_list($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([382, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $r6 = $this->parselang_variant_option($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // o <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = [];
  for (;;) {
    // start seq_2
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $r13 = true;
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(41); }
      $r13 = self::$FAILED;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    $r8 = $this->parselang_variant_option($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r8===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r8 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r8!==self::$FAILED) {
      $r7[] = $r8;
    } else {
      break;
    }
    // free $p9,$r10,$r11,$r12
  }
  // rest <- $r7
  // free $r8
  // free $r13
  $r13 = [];
  for (;;) {
    // start seq_3
    $p9 = $this->currPos;
    $r12 = $param_preproc;
    $r11 = $param_th;
    $r10 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === ";") {
      $r14 = ";";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(41); }
      $r14 = self::$FAILED;
      $r8 = self::$FAILED;
      goto seq_3;
    }
    $p15 = $this->currPos;
    $r16 = $this->discardbogus_lang_variant_option($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r16!==self::$FAILED) {
      $r16 = substr($this->input, $p15, $this->currPos - $p15);
    } else {
      $r16 = self::$FAILED;
    }
    // free $p15
    $r8 = [$r14,$r16];
    seq_3:
    if ($r8!==self::$FAILED) {
      $r13[] = $r8;
    } else {
      break;
    }
    // free $r14,$r16
    // free $p9,$r12,$r11,$r10
  }
  // tr <- $r13
  // free $r8
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a150($r6, $r7, $r13);
    goto choice_1;
  }
  $r8 = $this->parselang_variant_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // lvtext <- $r8
  $r5 = $r8;
  $this->savedPos = $p1;
  $r5 = $this->a151($r8);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsewikilink_preprocessor_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([518, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $p9 = $this->currPos;
    $r8 = strcspn($this->input, "\x09\x0a\x0d !&-<[]{|}", $this->currPos);
    // t <- $r8
    if ($r8 > 0) {
      $this->currPos += $r8;
      $r8 = substr($this->input, $p9, $this->currPos - $p9);
    } else {
      $r8 = self::$FAILED;
      if (!$silence) { $this->fail(124); }
      $r8 = self::$FAILED;
    }
    // free $p9
    $r7 = $r8;
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // start seq_1
    $p9 = $this->currPos;
    $r10 = $param_preproc;
    $r11 = $param_th;
    $r12 = $param_headingIndex;
    $r13 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r13 === self::$FAILED) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    $p15 = $this->currPos;
    $r16 = $param_preproc;
    $r17 = $param_th;
    $r18 = $param_headingIndex;
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r14 = true;
      goto choice_2;
    } else {
      $r14 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r14 = true;
    } else {
      $r14 = self::$FAILED;
    }
    choice_2:
    if ($r14 === self::$FAILED) {
      $r14 = false;
    } else {
      $r14 = self::$FAILED;
      $this->currPos = $p15;
      $param_preproc = $r16;
      $param_th = $r17;
      $param_headingIndex = $r18;
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // free $p15,$r16,$r17,$r18
    // start choice_3
    // start seq_2
    $p15 = $this->currPos;
    $r18 = $param_preproc;
    $r17 = $param_th;
    $r16 = $param_headingIndex;
    if (strspn($this->input, "&-<{", $this->currPos, 1) !== 0) {
      $r19 = true;
      $r19 = false;
      $this->currPos = $p15;
      $param_preproc = $r18;
      $param_th = $r17;
      $param_headingIndex = $r16;
    } else {
      $r19 = self::$FAILED;
      if (!$silence) { $this->fail(125); }
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsedirective($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r18;
      $param_th = $r17;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    if ($r7!==self::$FAILED) {
      goto choice_3;
    }
    // free $p15,$r18,$r17,$r16
    $p15 = $this->currPos;
    // start seq_3
    $p20 = $this->currPos;
    $r16 = $param_preproc;
    $r17 = $param_th;
    $r18 = $param_headingIndex;
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r21 = true;
    } else {
      $r21 = self::$FAILED;
    }
    if ($r21 === self::$FAILED) {
      $r21 = false;
    } else {
      $r21 = self::$FAILED;
      $this->currPos = $p20;
      $param_preproc = $r16;
      $param_th = $r17;
      $param_headingIndex = $r18;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    if (strcspn($this->input, "':;=[{|", $this->currPos, 1) !== 0) {
      $r22 = true;
      self::advanceChar($this->input, $this->currPos);
    } else {
      $r22 = self::$FAILED;
      if (!$silence) { $this->fail(126); }
      $this->currPos = $p20;
      $param_preproc = $r16;
      $param_th = $r17;
      $param_headingIndex = $r18;
      $r7 = self::$FAILED;
      goto seq_3;
    }
    $r7 = true;
    seq_3:
    if ($r7!==self::$FAILED) {
      $r7 = substr($this->input, $p15, $this->currPos - $p15);
    } else {
      $r7 = self::$FAILED;
    }
    // free $r21,$r22
    // free $p20,$r16,$r17,$r18
    // free $p15
    choice_3:
    if ($r7===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r10;
      $param_th = $r11;
      $param_headingIndex = $r12;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    seq_1:
    // free $r19
    // free $p9,$r10,$r11,$r12
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // r <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a46($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsewikilink_content($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([396, $boolParams & 0x1df7, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = [];
  for (;;) {
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r12 = "|";
      $this->currPos++;
      goto choice_1;
    } else {
      if (!$silence) { $this->fail(2); }
      $r12 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r12 = "{{!}}";
      $this->currPos += 5;
    } else {
      if (!$silence) { $this->fail(3); }
      $r12 = self::$FAILED;
    }
    choice_1:
    // p <- $r12
    if ($r12===self::$FAILED) {
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r13 = $this->parsePOSITION($silence);
    // startPos <- $r13
    $r14 = $this->parselink_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r14===self::$FAILED) {
      $r14 = null;
    }
    // lt <- $r14
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a152($r12, $r13, $r14);
      $r5[] = $r6;
    } else {
      break;
    }
    // free $p8,$r9,$r10,$r11
    // free $p7
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_heading_tags_parameterized($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([488, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "!") {
    $r6 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(127); }
    $r6 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parsetable_heading_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // thTag <- $r7
  $r8 = $this->parseths($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // thTags <- $r8
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a153($r7, $r8);
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_data_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([496, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  if (($this->input[$this->currPos] ?? null) === "}") {
    $r6 = true;
  } else {
    $r6 = self::$FAILED;
  }
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = self::charAt($this->input, $this->currPos);
  if ($r12 !== '' && !($r12 === "\x0a" || $r12 === "\x0d")) {
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(123); }
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parserow_syntax_table_args($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r7===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r7===self::$FAILED) {
    $r7 = null;
  }
  // free $p8,$r9,$r10,$r11
  // arg <- $r7
  $r11 = $this->parsePOSITION($silence);
  // tagEndPos <- $r11
  $r10 = [];
  for (;;) {
    $r9 = $this->parsenested_block_in_table($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r9!==self::$FAILED) {
      $r10[] = $r9;
    } else {
      break;
    }
  }
  // td <- $r10
  // free $r9
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a154($r7, $r11, $r10);
  }
  // free $r6,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetds($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([498, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = [];
  for (;;) {
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $p13 = $this->currPos;
    // start seq_2
    // start choice_1
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r14 = true;
      $this->currPos++;
      goto choice_1;
    } else {
      if (!$silence) { $this->fail(2); }
      $r14 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r14 = true;
      $this->currPos += 5;
    } else {
      if (!$silence) { $this->fail(3); }
      $r14 = self::$FAILED;
    }
    choice_1:
    if ($r14===self::$FAILED) {
      $r12 = self::$FAILED;
      goto seq_2;
    }
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r15 = true;
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(2); }
      $r15 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r15 = true;
      $this->currPos += 5;
    } else {
      if (!$silence) { $this->fail(3); }
      $r15 = self::$FAILED;
    }
    choice_2:
    if ($r15===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r12 = self::$FAILED;
      goto seq_2;
    }
    $r12 = true;
    seq_2:
    // pp <- $r12
    if ($r12!==self::$FAILED) {
      $r12 = substr($this->input, $p13, $this->currPos - $p13);
    } else {
      $r12 = self::$FAILED;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    // free $r14,$r15
    // free $p13
    $r15 = $this->parsetable_data_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    // tdt <- $r15
    if ($r15===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a155($r12, $r15);
      $r5[] = $r6;
    } else {
      break;
    }
    // free $p8,$r9,$r10,$r11
    // free $p7
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsenested_block_in_table($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([292, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->discardinline_breaks($boolParams | 0x1, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  // start seq_2
  // start seq_3
  $this->savedPos = $this->currPos;
  $r13 = $this->a34();
  if ($r13) {
    $r13 = false;
  } else {
    $r13 = self::$FAILED;
    $r12 = self::$FAILED;
    goto seq_3;
  }
  // start choice_1
  $p15 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r14 = true;
    $this->currPos++;
    goto choice_2;
  } else {
    $r14 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r14 = true;
    $this->currPos += 2;
  } else {
    $r14 = self::$FAILED;
  }
  choice_2:
  if ($r14!==self::$FAILED) {
    $this->savedPos = $p15;
    $r14 = $this->a35();
    goto choice_1;
  }
  // free $p15
  $p15 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r14 = $this->a36();
  if ($r14) {
    $r14 = false;
    $this->savedPos = $p15;
    $r14 = $this->a37();
  } else {
    $r14 = self::$FAILED;
  }
  // free $p15
  choice_1:
  // sp <- $r14
  if ($r14===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r12 = self::$FAILED;
    goto seq_3;
  }
  // start seq_4
  $p15 = $this->currPos;
  $r17 = $param_preproc;
  $r18 = $param_th;
  $r19 = $param_headingIndex;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r20 = true;
    $r20 = false;
    $this->currPos = $p15;
    $param_preproc = $r17;
    $param_th = $r18;
    $param_headingIndex = $r19;
  } else {
    $r20 = self::$FAILED;
    $r16 = self::$FAILED;
    goto seq_4;
  }
  $r16 = $this->parseempty_lines_with_comments(true);
  if ($r16===self::$FAILED) {
    $this->currPos = $p15;
    $param_preproc = $r17;
    $param_th = $r18;
    $param_headingIndex = $r19;
    $r16 = self::$FAILED;
    goto seq_4;
  }
  seq_4:
  if ($r16===self::$FAILED) {
    $r16 = null;
  }
  // free $p15,$r17,$r18,$r19
  // elc <- $r16
  $r19 = [];
  for (;;) {
    // start seq_5
    $p15 = $this->currPos;
    $r17 = $param_preproc;
    $r21 = $param_th;
    $r22 = $param_headingIndex;
    $r23 = $this->input[$this->currPos] ?? '';
    if ($r23 === "<" || $r23 === "_") {
      $r23 = false;
      $this->currPos = $p15;
      $param_preproc = $r17;
      $param_th = $r21;
      $param_headingIndex = $r22;
    } else {
      $r23 = self::$FAILED;
      $r18 = self::$FAILED;
      goto seq_5;
    }
    $r18 = $this->parsesol_transparent(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r18===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r17;
      $param_th = $r21;
      $param_headingIndex = $r22;
      $r18 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    if ($r18!==self::$FAILED) {
      $r19[] = $r18;
    } else {
      break;
    }
    // free $p15,$r17,$r21,$r22
  }
  // st <- $r19
  // free $r18
  // free $r23
  $r12 = true;
  seq_3:
  if ($r12!==self::$FAILED) {
    $this->savedPos = $p8;
    $r12 = $this->a38($r14, $r16, $r19);
  } else {
    $r7 = self::$FAILED;
    goto seq_2;
  }
  // free $r13,$r20
  // start seq_6
  $p15 = $this->currPos;
  $r13 = $param_preproc;
  $r23 = $param_th;
  $r18 = $param_headingIndex;
  $r22 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r22;
  $p24 = $this->currPos;
  // start seq_7
  $p25 = $this->currPos;
  $r17 = $param_preproc;
  $r26 = $param_th;
  $r27 = $param_headingIndex;
  $this->savedPos = $this->currPos;
  $r28 = $this->a34();
  if ($r28) {
    $r28 = false;
  } else {
    $r28 = self::$FAILED;
    $r21 = self::$FAILED;
    goto seq_7;
  }
  // start choice_3
  $p30 = $this->currPos;
  // start choice_4
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r29 = true;
    $this->currPos++;
    goto choice_4;
  } else {
    $r29 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r29 = true;
    $this->currPos += 2;
  } else {
    $r29 = self::$FAILED;
  }
  choice_4:
  if ($r29!==self::$FAILED) {
    $this->savedPos = $p30;
    $r29 = $this->a35();
    goto choice_3;
  }
  // free $p30
  $p30 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r29 = $this->a36();
  if ($r29) {
    $r29 = false;
    $this->savedPos = $p30;
    $r29 = $this->a37();
  } else {
    $r29 = self::$FAILED;
  }
  // free $p30
  choice_3:
  // sp <- $r29
  if ($r29===self::$FAILED) {
    $this->currPos = $p25;
    $param_preproc = $r17;
    $param_th = $r26;
    $param_headingIndex = $r27;
    $r21 = self::$FAILED;
    goto seq_7;
  }
  // start seq_8
  $p30 = $this->currPos;
  $r32 = $param_preproc;
  $r33 = $param_th;
  $r34 = $param_headingIndex;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r35 = true;
    $r35 = false;
    $this->currPos = $p30;
    $param_preproc = $r32;
    $param_th = $r33;
    $param_headingIndex = $r34;
  } else {
    $r35 = self::$FAILED;
    $r31 = self::$FAILED;
    goto seq_8;
  }
  $r31 = $this->parseempty_lines_with_comments(true);
  if ($r31===self::$FAILED) {
    $this->currPos = $p30;
    $param_preproc = $r32;
    $param_th = $r33;
    $param_headingIndex = $r34;
    $r31 = self::$FAILED;
    goto seq_8;
  }
  seq_8:
  if ($r31===self::$FAILED) {
    $r31 = null;
  }
  // free $p30,$r32,$r33,$r34
  // elc <- $r31
  $r34 = [];
  for (;;) {
    // start seq_9
    $p30 = $this->currPos;
    $r32 = $param_preproc;
    $r36 = $param_th;
    $r37 = $param_headingIndex;
    $r38 = $this->input[$this->currPos] ?? '';
    if ($r38 === "<" || $r38 === "_") {
      $r38 = false;
      $this->currPos = $p30;
      $param_preproc = $r32;
      $param_th = $r36;
      $param_headingIndex = $r37;
    } else {
      $r38 = self::$FAILED;
      $r33 = self::$FAILED;
      goto seq_9;
    }
    $r33 = $this->parsesol_transparent(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r33===self::$FAILED) {
      $this->currPos = $p30;
      $param_preproc = $r32;
      $param_th = $r36;
      $param_headingIndex = $r37;
      $r33 = self::$FAILED;
      goto seq_9;
    }
    seq_9:
    if ($r33!==self::$FAILED) {
      $r34[] = $r33;
    } else {
      break;
    }
    // free $p30,$r32,$r36,$r37
  }
  // st <- $r34
  // free $r33
  // free $r38
  $r21 = true;
  seq_7:
  if ($r21!==self::$FAILED) {
    $this->savedPos = $p24;
    $r21 = $this->a38($r29, $r31, $r34);
  } else {
    $this->currPos = $p15;
    $param_preproc = $r13;
    $param_th = $r23;
    $param_headingIndex = $r18;
    $r20 = self::$FAILED;
    goto seq_6;
  }
  // free $r28,$r35
  // free $p25,$r17,$r26,$r27
  // free $p24
  $r20 = true;
  seq_6:
  if ($r20===self::$FAILED) {
    $r20 = null;
  }
  // free $r22,$r21
  // free $p15,$r13,$r23,$r18
  $r18 = strspn($this->input, "\x09 ", $this->currPos);
  $this->currPos += $r18;
  // start choice_5
  // start choice_6
  if (($this->input[$this->currPos] ?? null) === "|") {
    $r23 = true;
    goto choice_6;
  } else {
    $r23 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
    $r23 = true;
  } else {
    $r23 = self::$FAILED;
  }
  choice_6:
  if ($r23!==self::$FAILED) {
    goto choice_5;
  }
  if (($this->input[$this->currPos] ?? null) === "!") {
    $r23 = true;
  } else {
    $r23 = self::$FAILED;
  }
  choice_5:
  if ($r23===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = true;
  seq_2:
  // free $r12,$r20,$r18,$r23
  if ($r7 === self::$FAILED) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10,$r11
  $r11 = $this->parsenested_block($silence, $boolParams | 0x1, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  // b <- $r11
  if ($r11===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a156($r11);
  }
  // free $r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_flags($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([376, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $p7 = $this->currPos;
  $r6 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp1 <- $r6
  $this->currPos += $r6;
  $r6 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start seq_2
  $p7 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  if (strcspn($this->input, ";{|}", $this->currPos, 1) !== 0) {
    $r12 = true;
    $r12 = false;
    $this->currPos = $p7;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(128); }
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->parselang_variant_flag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // f <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r9,$r10,$r11
  $p7 = $this->currPos;
  $r11 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp2 <- $r11
  $this->currPos += $r11;
  $r11 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start seq_3
  $p7 = $this->currPos;
  $r9 = $param_preproc;
  $r13 = $param_th;
  $r14 = $param_headingIndex;
  if (($this->input[$this->currPos] ?? null) === ";") {
    $r15 = ";";
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(41); }
    $r15 = self::$FAILED;
    $r10 = self::$FAILED;
    goto seq_3;
  }
  $r16 = $this->parselang_variant_flags($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r16===self::$FAILED) {
    $r16 = null;
  }
  $r10 = [$r15,$r16];
  seq_3:
  if ($r10===self::$FAILED) {
    $r10 = null;
  }
  // free $r15,$r16
  // free $p7,$r9,$r13,$r14
  // more <- $r10
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a157($r6, $r8, $r11, $r10);
    goto choice_1;
  }
  // free $r12
  $p7 = $this->currPos;
  $r12 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp <- $r12
  $this->currPos += $r12;
  $r12 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  $r5 = $r12;
  $this->savedPos = $p1;
  $r5 = $this->a158($r12);
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_option($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([386, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  // start seq_1
  $p7 = $this->currPos;
  $r6 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp1 <- $r6
  $this->currPos += $r6;
  $r6 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start seq_2
  $p7 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[<a-z]/A", $r12)) {
    $r12 = false;
    $this->currPos = $p7;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(129); }
    $r8 = self::$FAILED;
    goto seq_2;
  }
  $r8 = $this->parselang_variant_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r8===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r8 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // lang <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p7,$r9,$r10,$r11
  $p7 = $this->currPos;
  $r11 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp2 <- $r11
  $this->currPos += $r11;
  $r11 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  if (($this->input[$this->currPos] ?? null) === ":") {
    $r10 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(26); }
    $r10 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p7 = $this->currPos;
  $r9 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp3 <- $r9
  $this->currPos += $r9;
  $r9 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start choice_2
  // start seq_3
  $p7 = $this->currPos;
  $r14 = $param_preproc;
  $r15 = $param_th;
  $r16 = $param_headingIndex;
  $r17 = $this->input[$this->currPos] ?? '';
  if ($r17 === "<") {
    $r17 = false;
    $this->currPos = $p7;
    $param_preproc = $r14;
    $param_th = $r15;
    $param_headingIndex = $r16;
  } else {
    $r17 = self::$FAILED;
    if (!$silence) { $this->fail(130); }
    $r13 = self::$FAILED;
    goto seq_3;
  }
  $r13 = $this->parselang_variant_nowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r13===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r14;
    $param_th = $r15;
    $param_headingIndex = $r16;
    $r13 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r13!==self::$FAILED) {
    goto choice_2;
  }
  // free $p7,$r14,$r15,$r16
  $r13 = $this->parselang_variant_text_no_semi($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  choice_2:
  // lvtext <- $r13
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a159($r6, $r8, $r11, $r9, $r13);
    goto choice_1;
  }
  // free $r12,$r10,$r17
  // start seq_4
  $p7 = $this->currPos;
  $r17 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp1 <- $r17
  $this->currPos += $r17;
  $r17 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start choice_3
  // start seq_5
  $p7 = $this->currPos;
  $r12 = $param_preproc;
  $r16 = $param_th;
  $r15 = $param_headingIndex;
  $r14 = $this->input[$this->currPos] ?? '';
  if ($r14 === "<") {
    $r14 = false;
    $this->currPos = $p7;
    $param_preproc = $r12;
    $param_th = $r16;
    $param_headingIndex = $r15;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(130); }
    $r10 = self::$FAILED;
    goto seq_5;
  }
  $r10 = $this->parselang_variant_nowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r10===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r12;
    $param_th = $r16;
    $param_headingIndex = $r15;
    $r10 = self::$FAILED;
    goto seq_5;
  }
  seq_5:
  if ($r10!==self::$FAILED) {
    goto choice_3;
  }
  // free $p7,$r12,$r16,$r15
  $r10 = $this->parselang_variant_text_no_semi_or_arrow($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  choice_3:
  // from <- $r10
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "=>", $this->currPos, 2, false) === 0) {
    $r15 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(131); }
    $r15 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $p7 = $this->currPos;
  $r16 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp2 <- $r16
  $this->currPos += $r16;
  $r16 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start seq_6
  $p7 = $this->currPos;
  $r18 = $param_preproc;
  $r19 = $param_th;
  $r20 = $param_headingIndex;
  $r21 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[<a-z]/A", $r21)) {
    $r21 = false;
    $this->currPos = $p7;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
  } else {
    $r21 = self::$FAILED;
    if (!$silence) { $this->fail(129); }
    $r12 = self::$FAILED;
    goto seq_6;
  }
  $r12 = $this->parselang_variant_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r12===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r18;
    $param_th = $r19;
    $param_headingIndex = $r20;
    $r12 = self::$FAILED;
    goto seq_6;
  }
  seq_6:
  // lang <- $r12
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  // free $p7,$r18,$r19,$r20
  $p7 = $this->currPos;
  $r20 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp3 <- $r20
  $this->currPos += $r20;
  $r20 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  if (($this->input[$this->currPos] ?? null) === ":") {
    $r19 = true;
    $this->currPos++;
  } else {
    if (!$silence) { $this->fail(26); }
    $r19 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_4;
  }
  $p7 = $this->currPos;
  $r18 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp4 <- $r18
  $this->currPos += $r18;
  $r18 = substr($this->input, $p7, $this->currPos - $p7);
  // free $p7
  // start choice_4
  // start seq_7
  $p7 = $this->currPos;
  $r23 = $param_preproc;
  $r24 = $param_th;
  $r25 = $param_headingIndex;
  $r26 = $this->input[$this->currPos] ?? '';
  if ($r26 === "<") {
    $r26 = false;
    $this->currPos = $p7;
    $param_preproc = $r23;
    $param_th = $r24;
    $param_headingIndex = $r25;
  } else {
    $r26 = self::$FAILED;
    if (!$silence) { $this->fail(130); }
    $r22 = self::$FAILED;
    goto seq_7;
  }
  $r22 = $this->parselang_variant_nowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r22===self::$FAILED) {
    $this->currPos = $p7;
    $param_preproc = $r23;
    $param_th = $r24;
    $param_headingIndex = $r25;
    $r22 = self::$FAILED;
    goto seq_7;
  }
  seq_7:
  if ($r22!==self::$FAILED) {
    goto choice_4;
  }
  // free $p7,$r23,$r24,$r25
  $r22 = $this->parselang_variant_text_no_semi($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  choice_4:
  // to <- $r22
  $r5 = true;
  seq_4:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a160($r17, $r10, $r16, $r12, $r20, $r18, $r22);
  }
  // free $r14,$r15,$r21,$r19,$r26
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardbogus_lang_variant_option($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([385, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = $this->discardlang_variant_text($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $r5 = null;
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselink_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([406, $boolParams & 0x1df7, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = $this->parselink_text_parameterized($silence, ($boolParams & ~0x8) | 0x200, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsetable_heading_tag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([490, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = self::charAt($this->input, $this->currPos);
  if ($r7 !== '' && !($r7 === "\x0a" || $r7 === "\x0d")) {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(123); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parserow_syntax_table_args($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r6===self::$FAILED) {
    $r6 = null;
  }
  // arg <- $r6
  $r8 = $this->parsePOSITION($silence);
  // tagEndPos <- $r8
  $r9 = [];
  for (;;) {
    $p11 = $this->currPos;
    // start seq_3
    $p12 = $this->currPos;
    $r13 = $param_preproc;
    $r14 = $param_th;
    $r15 = $param_headingIndex;
    $r16 = $this->parsenested_block_in_table($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    // d <- $r16
    if ($r16===self::$FAILED) {
      $this->currPos = $p12;
      $param_preproc = $r13;
      $param_th = $r14;
      $param_headingIndex = $r15;
      $r10 = self::$FAILED;
      goto seq_3;
    }
    $r10 = true;
    seq_3:
    if ($r10!==self::$FAILED) {
      $this->savedPos = $p11;
      $r10 = $this->a161($r6, $r8, $param_th, $r16);
      $r9[] = $r10;
    } else {
      break;
    }
    // free $p12,$r13,$r14,$r15
    // free $p11
  }
  // c <- $r9
  // free $r10
  $r5 = true;
  seq_1:
  $this->savedPos = $p1;
  $r5 = $this->a162($r6, $r8, $r9);
  // free $r7
  // free $p1,$r2,$r3,$r4
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseths($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([492, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = [];
  for (;;) {
    $p7 = $this->currPos;
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    // start choice_1
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "!!", $this->currPos, 2, false) === 0) {
      $r12 = "!!";
      $this->currPos += 2;
      goto choice_1;
    } else {
      if (!$silence) { $this->fail(132); }
      $r12 = self::$FAILED;
    }
    $p13 = $this->currPos;
    // start seq_2
    // start choice_2
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r14 = true;
      $this->currPos++;
      goto choice_2;
    } else {
      if (!$silence) { $this->fail(2); }
      $r14 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r14 = true;
      $this->currPos += 5;
    } else {
      if (!$silence) { $this->fail(3); }
      $r14 = self::$FAILED;
    }
    choice_2:
    if ($r14===self::$FAILED) {
      $r12 = self::$FAILED;
      goto seq_2;
    }
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r15 = true;
      $this->currPos++;
      goto choice_3;
    } else {
      if (!$silence) { $this->fail(2); }
      $r15 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "{{!}}", $this->currPos, 5, false) === 0) {
      $r15 = true;
      $this->currPos += 5;
    } else {
      if (!$silence) { $this->fail(3); }
      $r15 = self::$FAILED;
    }
    choice_3:
    if ($r15===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r12 = self::$FAILED;
      goto seq_2;
    }
    $r12 = true;
    seq_2:
    if ($r12!==self::$FAILED) {
      $r12 = substr($this->input, $p13, $this->currPos - $p13);
    } else {
      $r12 = self::$FAILED;
    }
    // free $r14,$r15
    // free $p13
    choice_1:
    // pp <- $r12
    if ($r12===self::$FAILED) {
      $r6 = self::$FAILED;
      goto seq_1;
    }
    $r15 = $this->parsetable_heading_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    // tht <- $r15
    $r6 = true;
    seq_1:
    if ($r6!==self::$FAILED) {
      $this->savedPos = $p7;
      $r6 = $this->a163($r12, $r15);
      $r5[] = $r6;
    } else {
      break;
    }
    // free $p8,$r9,$r10,$r11
    // free $p7
  }
  // free $r6
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_flag($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([378, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  $r6 = $this->input[$this->currPos] ?? '';
  // f <- $r6
  if (preg_match("/[+\\-A-Z]/A", $r6)) {
    $this->currPos++;
  } else {
    $r6 = self::$FAILED;
    if (!$silence) { $this->fail(133); }
  }
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a164($r6);
    goto choice_1;
  }
  // start seq_1
  $r8 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[<a-z]/A", $r8)) {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(129); }
    $r7 = self::$FAILED;
    goto seq_1;
  }
  $r7 = $this->parselang_variant_name($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r7 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  // v <- $r7
  $r5 = $r7;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a165($r7);
    goto choice_1;
  }
  // free $r8
  $p9 = $this->currPos;
  $r8 = self::$FAILED;
  for (;;) {
    // start seq_2
    $p11 = $this->currPos;
    $r12 = $param_preproc;
    $r13 = $param_th;
    $r14 = $param_headingIndex;
    if (strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos, 1) !== 0) {
      $r15 = true;
    } else {
      $r15 = self::$FAILED;
    }
    if ($r15 === self::$FAILED) {
      $r15 = false;
    } else {
      $r15 = self::$FAILED;
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $param_headingIndex = $r14;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    $p17 = $this->currPos;
    $r18 = $param_preproc;
    $r19 = $param_th;
    $r20 = $param_headingIndex;
    // start seq_3
    $r21 = $this->input[$this->currPos] ?? '';
    if ($r21 === "<") {
      $r21 = false;
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
    } else {
      $r21 = self::$FAILED;
      $r16 = self::$FAILED;
      goto seq_3;
    }
    $r16 = $this->discardnowiki($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r16===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $r16 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r16 === self::$FAILED) {
      $r16 = false;
    } else {
      $r16 = self::$FAILED;
      $this->currPos = $p17;
      $param_preproc = $r18;
      $param_th = $r19;
      $param_headingIndex = $r20;
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $param_headingIndex = $r14;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    // free $p17,$r18,$r19,$r20
    if (strcspn($this->input, ";{|}", $this->currPos, 1) !== 0) {
      $r20 = true;
      self::advanceChar($this->input, $this->currPos);
    } else {
      $r20 = self::$FAILED;
      if (!$silence) { $this->fail(134); }
      $this->currPos = $p11;
      $param_preproc = $r12;
      $param_th = $r13;
      $param_headingIndex = $r14;
      $r10 = self::$FAILED;
      goto seq_2;
    }
    $r10 = true;
    seq_2:
    if ($r10!==self::$FAILED) {
      $r8 = true;
    } else {
      break;
    }
    // free $r15,$r16,$r21,$r20
    // free $p11,$r12,$r13,$r14
  }
  // b <- $r8
  if ($r8!==self::$FAILED) {
    $r8 = substr($this->input, $p9, $this->currPos - $p9);
  } else {
    $r8 = self::$FAILED;
  }
  // free $r10
  // free $p9
  $r5 = $r8;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a166($r8);
  }
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_name($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([380, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start choice_1
  $p6 = $this->currPos;
  // start seq_1
  $r7 = $this->input[$this->currPos] ?? '';
  if (preg_match("/[a-z]/A", $r7)) {
    $this->currPos++;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(135); }
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r8 = null;
  if (preg_match("/[\\-A-Za-z]+/A", $this->input, $r8, 0, $this->currPos)) {
    $this->currPos += strlen($r8[0]);
    $r8 = true;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(136); }
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $r5 = substr($this->input, $p6, $this->currPos - $p6);
    goto choice_1;
  } else {
    $r5 = self::$FAILED;
  }
  // free $r7,$r8
  // free $p6
  // start seq_2
  $r8 = $this->input[$this->currPos] ?? '';
  if ($r8 === "<") {
    $r8 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r8 = self::$FAILED;
    if (!$silence) { $this->fail(137); }
    $r5 = self::$FAILED;
    goto seq_2;
  }
  $r5 = $this->parsenowiki_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  choice_1:
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_nowiki($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([388, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(137); }
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parsenowiki_text($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // n <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $p9 = $this->currPos;
  $r8 = strspn($this->input, "\x09\x0a\x0c\x0d ", $this->currPos);
  // sp <- $r8
  $this->currPos += $r8;
  $r8 = substr($this->input, $p9, $this->currPos - $p9);
  // free $p9
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a167($r6, $r8);
  }
  // free $r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_text_no_semi($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([392, $boolParams & 0x1f7f, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = $this->parselang_variant_text($silence, $boolParams | 0x80, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselang_variant_text_no_semi_or_arrow($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([394, $boolParams & 0x1e7f, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r5 = $this->parselang_variant_text_no_semi($silence, $boolParams | 0x100, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardlang_variant_text($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([391, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->parseinlineline(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    if (($this->input[$this->currPos] ?? null) === "|") {
      $r7 = "|";
      $this->currPos++;
    } else {
      $r7 = self::$FAILED;
    }
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // tokens <- $r6
  // free $r7
  $r5 = $r6;
  $this->savedPos = $p1;
  $r5 = $this->a149($r6);
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parselink_text_parameterized($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([408, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  $r6 = [];
  for (;;) {
    // start choice_1
    // start seq_1
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    // start seq_2
    $this->savedPos = $this->currPos;
    $r13 = $this->a34();
    if ($r13) {
      $r13 = false;
    } else {
      $r13 = self::$FAILED;
      $r12 = self::$FAILED;
      goto seq_2;
    }
    // start choice_2
    $p15 = $this->currPos;
    // start choice_3
    if (($this->input[$this->currPos] ?? null) === "\x0a") {
      $r14 = true;
      $this->currPos++;
      goto choice_3;
    } else {
      if (!$silence) { $this->fail(46); }
      $r14 = self::$FAILED;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
      $r14 = true;
      $this->currPos += 2;
    } else {
      if (!$silence) { $this->fail(47); }
      $r14 = self::$FAILED;
    }
    choice_3:
    if ($r14!==self::$FAILED) {
      $this->savedPos = $p15;
      $r14 = $this->a35();
      goto choice_2;
    }
    // free $p15
    $p15 = $this->currPos;
    $this->savedPos = $this->currPos;
    $r14 = $this->a36();
    if ($r14) {
      $r14 = false;
      $this->savedPos = $p15;
      $r14 = $this->a37();
    } else {
      $r14 = self::$FAILED;
    }
    // free $p15
    choice_2:
    // sp <- $r14
    if ($r14===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r12 = self::$FAILED;
      goto seq_2;
    }
    // start seq_3
    $p15 = $this->currPos;
    $r17 = $param_preproc;
    $r18 = $param_th;
    $r19 = $param_headingIndex;
    if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
      $r20 = true;
      $r20 = false;
      $this->currPos = $p15;
      $param_preproc = $r17;
      $param_th = $r18;
      $param_headingIndex = $r19;
    } else {
      $r20 = self::$FAILED;
      if (!$silence) { $this->fail(48); }
      $r16 = self::$FAILED;
      goto seq_3;
    }
    $r16 = $this->parseempty_lines_with_comments($silence);
    if ($r16===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r17;
      $param_th = $r18;
      $param_headingIndex = $r19;
      $r16 = self::$FAILED;
      goto seq_3;
    }
    seq_3:
    if ($r16===self::$FAILED) {
      $r16 = null;
    }
    // free $p15,$r17,$r18,$r19
    // elc <- $r16
    $r19 = [];
    for (;;) {
      // start seq_4
      $p15 = $this->currPos;
      $r17 = $param_preproc;
      $r21 = $param_th;
      $r22 = $param_headingIndex;
      $r23 = $this->input[$this->currPos] ?? '';
      if ($r23 === "<" || $r23 === "_") {
        $r23 = false;
        $this->currPos = $p15;
        $param_preproc = $r17;
        $param_th = $r21;
        $param_headingIndex = $r22;
      } else {
        $r23 = self::$FAILED;
        if (!$silence) { $this->fail(43); }
        $r18 = self::$FAILED;
        goto seq_4;
      }
      $r18 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
      if ($r18===self::$FAILED) {
        $this->currPos = $p15;
        $param_preproc = $r17;
        $param_th = $r21;
        $param_headingIndex = $r22;
        $r18 = self::$FAILED;
        goto seq_4;
      }
      seq_4:
      if ($r18!==self::$FAILED) {
        $r19[] = $r18;
      } else {
        break;
      }
      // free $p15,$r17,$r21,$r22
    }
    // st <- $r19
    // free $r18
    // free $r23
    $r12 = true;
    seq_2:
    if ($r12!==self::$FAILED) {
      $this->savedPos = $p8;
      $r12 = $this->a38($r14, $r16, $r19);
    } else {
      $r7 = self::$FAILED;
      goto seq_1;
    }
    // free $r13,$r20
    // start choice_4
    // start seq_5
    $p15 = $this->currPos;
    $r13 = $param_preproc;
    $r23 = $param_th;
    $r18 = $param_headingIndex;
    $r22 = $this->input[$this->currPos] ?? '';
    if ($r22 === "=") {
      $r22 = false;
      $this->currPos = $p15;
      $param_preproc = $r13;
      $param_th = $r23;
      $param_headingIndex = $r18;
    } else {
      $r22 = self::$FAILED;
      if (!$silence) { $this->fail(68); }
      $r20 = self::$FAILED;
      goto seq_5;
    }
    $r20 = $this->parseheading($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r20===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r13;
      $param_th = $r23;
      $param_headingIndex = $r18;
      $r20 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    if ($r20!==self::$FAILED) {
      goto choice_4;
    }
    // free $p15,$r13,$r23,$r18
    // start seq_6
    $p15 = $this->currPos;
    $r18 = $param_preproc;
    $r23 = $param_th;
    $r13 = $param_headingIndex;
    $r21 = $this->input[$this->currPos] ?? '';
    if ($r21 === "-") {
      $r21 = false;
      $this->currPos = $p15;
      $param_preproc = $r18;
      $param_th = $r23;
      $param_headingIndex = $r13;
    } else {
      $r21 = self::$FAILED;
      if (!$silence) { $this->fail(70); }
      $r20 = self::$FAILED;
      goto seq_6;
    }
    $r20 = $this->parsehr($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r20===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r18;
      $param_th = $r23;
      $param_headingIndex = $r13;
      $r20 = self::$FAILED;
      goto seq_6;
    }
    seq_6:
    if ($r20!==self::$FAILED) {
      goto choice_4;
    }
    // free $p15,$r18,$r23,$r13
    // start seq_7
    $p15 = $this->currPos;
    $r13 = $param_preproc;
    $r23 = $param_th;
    $r18 = $param_headingIndex;
    if (strspn($this->input, "\x09 <{", $this->currPos, 1) !== 0) {
      $r17 = true;
      $r17 = false;
      $this->currPos = $p15;
      $param_preproc = $r13;
      $param_th = $r23;
      $param_headingIndex = $r18;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(138); }
      $r20 = self::$FAILED;
      goto seq_7;
    }
    $r20 = $this->parsefull_table_in_link_caption($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r20===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r13;
      $param_th = $r23;
      $param_headingIndex = $r18;
      $r20 = self::$FAILED;
      goto seq_7;
    }
    seq_7:
    // free $p15,$r13,$r23,$r18
    choice_4:
    if ($r20===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_1;
    }
    $r7 = [$r12,$r20];
    seq_1:
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // free $r12,$r20,$r22,$r21,$r17
    // free $p8,$r9,$r10,$r11
    $r7 = $this->parseurltext($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7!==self::$FAILED) {
      goto choice_1;
    }
    // start seq_8
    $p8 = $this->currPos;
    $r11 = $param_preproc;
    $r10 = $param_th;
    $r9 = $param_headingIndex;
    $r17 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
    if ($r17 === self::$FAILED) {
      $r17 = false;
    } else {
      $r17 = self::$FAILED;
      $this->currPos = $p8;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r7 = self::$FAILED;
      goto seq_8;
    }
    // start choice_5
    // start seq_9
    $p15 = $this->currPos;
    $r21 = $param_preproc;
    $r22 = $param_th;
    $r20 = $param_headingIndex;
    if (strspn($this->input, "'-<[{", $this->currPos, 1) !== 0) {
      $r12 = true;
      $r12 = false;
      $this->currPos = $p15;
      $param_preproc = $r21;
      $param_th = $r22;
      $param_headingIndex = $r20;
    } else {
      $r12 = self::$FAILED;
      if (!$silence) { $this->fail(39); }
      $r7 = self::$FAILED;
      goto seq_9;
    }
    $r7 = $this->parseinline_element($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r7===self::$FAILED) {
      $this->currPos = $p15;
      $param_preproc = $r21;
      $param_th = $r22;
      $param_headingIndex = $r20;
      $r7 = self::$FAILED;
      goto seq_9;
    }
    seq_9:
    if ($r7!==self::$FAILED) {
      goto choice_5;
    }
    // free $p15,$r21,$r22,$r20
    // start seq_10
    $p15 = $this->currPos;
    $r20 = $param_preproc;
    $r22 = $param_th;
    $r21 = $param_headingIndex;
    if (($this->input[$this->currPos] ?? null) === "[") {
      $r18 = "[";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(27); }
      $r18 = self::$FAILED;
      $r7 = self::$FAILED;
      goto seq_10;
    }
    $r23 = strcspn($this->input, "\x0a\x0d!'-:;<=[]{|}", $this->currPos);
    if ($r23 > 0) {
      $this->currPos += $r23;
      $r23 = substr($this->input, $this->currPos - $r23, $r23);
      $r23 = mb_str_split($r23, 1, "utf-8");
    } else {
      $r23 = self::$FAILED;
      if (!$silence) { $this->fail(58); }
      $this->currPos = $p15;
      $param_preproc = $r20;
      $param_th = $r22;
      $param_headingIndex = $r21;
      $r7 = self::$FAILED;
      goto seq_10;
    }
    if (($this->input[$this->currPos] ?? null) === "]") {
      $r13 = "]";
      $this->currPos++;
    } else {
      if (!$silence) { $this->fail(29); }
      $r13 = self::$FAILED;
      $this->currPos = $p15;
      $param_preproc = $r20;
      $param_th = $r22;
      $param_headingIndex = $r21;
      $r7 = self::$FAILED;
      goto seq_10;
    }
    $p24 = $this->currPos;
    $p26 = $this->currPos;
    $r27 = $param_preproc;
    $r28 = $param_th;
    $r29 = $param_headingIndex;
    // start choice_6
    if (($this->input[$this->currPos] ?? null) === "]") {
      $r25 = true;
    } else {
      $r25 = self::$FAILED;
    }
    if ($r25 === self::$FAILED) {
      $r25 = false;
      goto choice_6;
    } else {
      $r25 = self::$FAILED;
      $this->currPos = $p26;
      $param_preproc = $r27;
      $param_th = $r28;
      $param_headingIndex = $r29;
    }
    if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "]]", $this->currPos, 2, false) === 0) {
      $r25 = true;
    } else {
      $r25 = self::$FAILED;
    }
    choice_6:
    if ($r25!==self::$FAILED) {
      $r25 = false;
      $this->currPos = $p26;
      $param_preproc = $r27;
      $param_th = $r28;
      $param_headingIndex = $r29;
      $r25 = substr($this->input, $p24, $this->currPos - $p24);
    } else {
      $r25 = self::$FAILED;
      $this->currPos = $p15;
      $param_preproc = $r20;
      $param_th = $r22;
      $param_headingIndex = $r21;
      $r7 = self::$FAILED;
      goto seq_10;
    }
    // free $p26,$r27,$r28,$r29
    // free $p24
    $r7 = [$r18,$r23,$r13,$r25];
    seq_10:
    if ($r7!==self::$FAILED) {
      goto choice_5;
    }
    // free $r18,$r23,$r13,$r25
    // free $p15,$r20,$r22,$r21
    if ($this->currPos < $this->inputLength) {
      $r7 = self::consumeChar($this->input, $this->currPos);;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(17); }
    }
    choice_5:
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r11;
      $param_th = $r10;
      $param_headingIndex = $r9;
      $r7 = self::$FAILED;
      goto seq_8;
    }
    seq_8:
    // free $r12
    // free $p8,$r11,$r10,$r9
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  if (count($r6) === 0) {
    $r6 = self::$FAILED;
  }
  // c <- $r6
  // free $r7
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a26($r6);
  }
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardnowiki($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([429, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->discardnowiki_check($param_tagType);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r6!==self::$FAILED) {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_3
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if ($r12 === "<") {
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->discardwellformed_extension_tag($boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10,$r11
  seq_1:
  // free $r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsenowiki_text($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([430, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    if (!$silence) { $this->fail(139); }
    $r6 = self::$FAILED;
    goto seq_1;
  }
  $r6 = $this->parsenowiki($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_1;
  }
  seq_1:
  // extToken <- $r6
  $r5 = $r6;
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a168($r6);
  }
  // free $r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsefull_table_in_link_caption($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([468, $boolParams & 0x17fe, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = $this->discardinline_breaks($boolParams, $param_tagType, $param_preproc, $param_th);
  if ($r6 === self::$FAILED) {
    $r6 = false;
  } else {
    $r6 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_2
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  if (strspn($this->input, "\x09 <{", $this->currPos, 1) !== 0) {
    $r12 = true;
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(140); }
    $r7 = self::$FAILED;
    goto seq_2;
  }
  $r7 = $this->parseembedded_full_table($silence, ($boolParams & ~0x201) | 0x810, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r7===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r7 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // r <- $r7
  if ($r7===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10,$r11
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a169($r7);
  }
  // free $r6,$r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function discardnowiki_check($param_tagType) {
  $key = json_encode([427, $param_tagType]);
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
  // start seq_2
  $p5 = $this->currPos;
  $r6 = $this->input[$this->currPos] ?? '';
  if ($r6 === "<") {
    $r6 = false;
    $this->currPos = $p5;
  } else {
    $r6 = self::$FAILED;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  $r4 = $this->parsexmlish_start(true);
  if ($r4===self::$FAILED) {
    $this->currPos = $p5;
    $r4 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // start <- $r4
  if ($r4===self::$FAILED) {
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  // free $p5
  $this->savedPos = $this->currPos;
  $r7 = $this->a170($r4);
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $this->currPos = $p1;
    $r2 = self::$FAILED;
    goto seq_1;
  }
  $r2 = true;
  seq_1:
  // free $r3,$r6,$r7
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r2,
    self::$UNDEFINED,
    self::$UNDEFINED,
    self::$UNDEFINED
  );
  return $r2;
}
private function discardwellformed_extension_tag($boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([425, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->parsemaybe_extension_tag(true, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  // extToken <- $r6
  if ($r6===self::$FAILED) {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $this->savedPos = $this->currPos;
  $r8 = $this->a100($r6);
  if ($r8) {
    $r8 = false;
  } else {
    $r8 = self::$FAILED;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  $r5 = true;
  seq_1:
  if ($r5!==self::$FAILED) {
    $this->savedPos = $p1;
    $r5 = $this->a101($r6);
  }
  // free $r7,$r8
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parsenowiki($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([428, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $r7 = $this->input[$this->currPos] ?? '';
  if ($r7 === "<") {
    $r7 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  $r6 = $this->discardnowiki_check($param_tagType);
  if ($r6===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  seq_2:
  if ($r6!==self::$FAILED) {
    $r6 = false;
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // start seq_3
  $p8 = $this->currPos;
  $r9 = $param_preproc;
  $r10 = $param_th;
  $r11 = $param_headingIndex;
  $r12 = $this->input[$this->currPos] ?? '';
  if ($r12 === "<") {
    $r12 = false;
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
  } else {
    $r12 = self::$FAILED;
    if (!$silence) { $this->fail(74); }
    $r5 = self::$FAILED;
    goto seq_3;
  }
  $r5 = $this->parsewellformed_extension_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r5===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r9;
    $param_th = $r10;
    $param_headingIndex = $r11;
    $r5 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r5===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r9,$r10,$r11
  seq_1:
  // free $r12
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseembedded_full_table($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([472, $boolParams & 0x1fff, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  $r6 = [];
  for (;;) {
    // start choice_1
    $r7 = $this->input[$this->currPos] ?? '';
    if ($r7 === "\x09" || $r7 === " ") {
      $this->currPos++;
      goto choice_1;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_2
    $p8 = $this->currPos;
    $r9 = $param_preproc;
    $r10 = $param_th;
    $r11 = $param_headingIndex;
    $r12 = $this->input[$this->currPos] ?? '';
    if ($r12 === "<") {
      $r12 = false;
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
    } else {
      $r12 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r7 = self::$FAILED;
      goto seq_2;
    }
    $r7 = $this->parsecomment($silence);
    if ($r7===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r9;
      $param_th = $r10;
      $param_headingIndex = $r11;
      $r7 = self::$FAILED;
      goto seq_2;
    }
    seq_2:
    // free $p8,$r9,$r10,$r11
    choice_1:
    if ($r7!==self::$FAILED) {
      $r6[] = $r7;
    } else {
      break;
    }
  }
  // free $r7
  // free $r12
  // start seq_3
  $p8 = $this->currPos;
  $r7 = $param_preproc;
  $r11 = $param_th;
  $r10 = $param_headingIndex;
  $r9 = $this->input[$this->currPos] ?? '';
  if ($r9 === "{") {
    $r9 = false;
    $this->currPos = $p8;
    $param_preproc = $r7;
    $param_th = $r11;
    $param_headingIndex = $r10;
  } else {
    $r9 = self::$FAILED;
    if (!$silence) { $this->fail(6); }
    $r12 = self::$FAILED;
    goto seq_3;
  }
  $r12 = $this->parsetable_start_tag($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
  if ($r12===self::$FAILED) {
    $this->currPos = $p8;
    $param_preproc = $r7;
    $param_th = $r11;
    $param_headingIndex = $r10;
    $r12 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r12===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $p8,$r7,$r11,$r10
  $r10 = [];
  for (;;) {
    // start seq_4
    $p8 = $this->currPos;
    $r7 = $param_preproc;
    $r13 = $param_th;
    $r14 = $param_headingIndex;
    $r15 = [];
    for (;;) {
      // start seq_5
      $p17 = $this->currPos;
      $r18 = $param_preproc;
      $r19 = $param_th;
      $r20 = $param_headingIndex;
      $r21 = [];
      for (;;) {
        $r22 = $this->parseembedded_full_table_line_prefix($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
        if ($r22!==self::$FAILED) {
          $r21[] = $r22;
        } else {
          break;
        }
      }
      if (count($r21) === 0) {
        $r21 = self::$FAILED;
      }
      if ($r21===self::$FAILED) {
        $r16 = self::$FAILED;
        goto seq_5;
      }
      // free $r22
      // start choice_2
      // start seq_6
      $p23 = $this->currPos;
      $r24 = $param_preproc;
      $r25 = $param_th;
      $r26 = $param_headingIndex;
      if (strspn($this->input, "!{|", $this->currPos, 1) !== 0) {
        $r27 = true;
        $r27 = false;
        $this->currPos = $p23;
        $param_preproc = $r24;
        $param_th = $r25;
        $param_headingIndex = $r26;
      } else {
        $r27 = self::$FAILED;
        if (!$silence) { $this->fail(93); }
        $r22 = self::$FAILED;
        goto seq_6;
      }
      $r22 = $this->parsetable_content_line($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
      if ($r22===self::$FAILED) {
        $this->currPos = $p23;
        $param_preproc = $r24;
        $param_th = $r25;
        $param_headingIndex = $r26;
        $r22 = self::$FAILED;
        goto seq_6;
      }
      seq_6:
      if ($r22!==self::$FAILED) {
        goto choice_2;
      }
      // free $p23,$r24,$r25,$r26
      // start seq_7
      $p23 = $this->currPos;
      $r26 = $param_preproc;
      $r25 = $param_th;
      $r24 = $param_headingIndex;
      $r28 = $this->input[$this->currPos] ?? '';
      if ($r28 === "{") {
        $r28 = false;
        $this->currPos = $p23;
        $param_preproc = $r26;
        $param_th = $r25;
        $param_headingIndex = $r24;
      } else {
        $r28 = self::$FAILED;
        if (!$silence) { $this->fail(11); }
        $r22 = self::$FAILED;
        goto seq_7;
      }
      $r22 = $this->parsetplarg_or_template($silence, $boolParams, $param_tagType, $param_th, $param_preproc, $param_headingIndex);
      if ($r22===self::$FAILED) {
        $this->currPos = $p23;
        $param_preproc = $r26;
        $param_th = $r25;
        $param_headingIndex = $r24;
        $r22 = self::$FAILED;
        goto seq_7;
      }
      seq_7:
      // free $p23,$r26,$r25,$r24
      choice_2:
      if ($r22===self::$FAILED) {
        $this->currPos = $p17;
        $param_preproc = $r18;
        $param_th = $r19;
        $param_headingIndex = $r20;
        $r16 = self::$FAILED;
        goto seq_5;
      }
      $r16 = [$r21,$r22];
      seq_5:
      if ($r16!==self::$FAILED) {
        $r15[] = $r16;
      } else {
        break;
      }
      // free $r21,$r22,$r27,$r28
      // free $p17,$r18,$r19,$r20
    }
    // free $r16
    $r16 = [];
    for (;;) {
      $r20 = $this->parseembedded_full_table_line_prefix($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
      if ($r20!==self::$FAILED) {
        $r16[] = $r20;
      } else {
        break;
      }
    }
    if (count($r16) === 0) {
      $r16 = self::$FAILED;
    }
    if ($r16===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r7;
      $param_th = $r13;
      $param_headingIndex = $r14;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    // free $r20
    // start seq_8
    $p17 = $this->currPos;
    $r19 = $param_preproc;
    $r18 = $param_th;
    $r28 = $param_headingIndex;
    $r27 = $this->input[$this->currPos] ?? '';
    if ($r27 === "{" || $r27 === "|") {
      $r27 = false;
      $this->currPos = $p17;
      $param_preproc = $r19;
      $param_th = $r18;
      $param_headingIndex = $r28;
    } else {
      $r27 = self::$FAILED;
      if (!$silence) { $this->fail(94); }
      $r20 = self::$FAILED;
      goto seq_8;
    }
    $r20 = $this->parsetable_end_tag($silence);
    if ($r20===self::$FAILED) {
      $this->currPos = $p17;
      $param_preproc = $r19;
      $param_th = $r18;
      $param_headingIndex = $r28;
      $r20 = self::$FAILED;
      goto seq_8;
    }
    seq_8:
    if ($r20===self::$FAILED) {
      $this->currPos = $p8;
      $param_preproc = $r7;
      $param_th = $r13;
      $param_headingIndex = $r14;
      $r11 = self::$FAILED;
      goto seq_4;
    }
    // free $p17,$r19,$r18,$r28
    $r11 = [$r15,$r16,$r20];
    seq_4:
    if ($r11!==self::$FAILED) {
      $r10[] = $r11;
    } else {
      break;
    }
    // free $r15,$r16,$r20,$r27
    // free $p8,$r7,$r13,$r14
  }
  if (count($r10) === 0) {
    $r10 = self::$FAILED;
  }
  if ($r10===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r11
  $r5 = [$r6,$r12,$r10];
  seq_1:
  // free $r6,$r12,$r9,$r10
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}
private function parseembedded_full_table_line_prefix($silence, $boolParams, $param_tagType, &$param_preproc, &$param_th, &$param_headingIndex) {
  $key = json_encode([470, $boolParams & 0x1faf, $param_tagType, $param_preproc, $param_th, $param_headingIndex]);
  $bucket = $this->currPos;
  $cached = $this->cache[$bucket][$key] ?? null;
  if ($cached) {
    $this->currPos = $cached->nextPos;
    if ($cached->preproc !== self::$UNDEFINED) { $param_preproc = $cached->preproc; }
    if ($cached->th !== self::$UNDEFINED) { $param_th = $cached->th; }
    if ($cached->headingIndex !== self::$UNDEFINED) { $param_headingIndex = $cached->headingIndex; }
    return $cached->result;
  }
  $p1 = $this->currPos;
  $r2 = $param_preproc;
  $r3 = $param_th;
  $r4 = $param_headingIndex;
  // start seq_1
  // start seq_2
  $this->savedPos = $this->currPos;
  $r7 = $this->a34();
  if ($r7) {
    $r7 = false;
  } else {
    $r7 = self::$FAILED;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start choice_1
  $p9 = $this->currPos;
  // start choice_2
  if (($this->input[$this->currPos] ?? null) === "\x0a") {
    $r8 = true;
    $this->currPos++;
    goto choice_2;
  } else {
    if (!$silence) { $this->fail(46); }
    $r8 = self::$FAILED;
  }
  if ($this->currPos >= $this->inputLength ? false : substr_compare($this->input, "\x0d\x0a", $this->currPos, 2, false) === 0) {
    $r8 = true;
    $this->currPos += 2;
  } else {
    if (!$silence) { $this->fail(47); }
    $r8 = self::$FAILED;
  }
  choice_2:
  if ($r8!==self::$FAILED) {
    $this->savedPos = $p9;
    $r8 = $this->a35();
    goto choice_1;
  }
  // free $p9
  $p9 = $this->currPos;
  $this->savedPos = $this->currPos;
  $r8 = $this->a36();
  if ($r8) {
    $r8 = false;
    $this->savedPos = $p9;
    $r8 = $this->a37();
  } else {
    $r8 = self::$FAILED;
  }
  // free $p9
  choice_1:
  // sp <- $r8
  if ($r8===self::$FAILED) {
    $this->currPos = $p1;
    $param_preproc = $r2;
    $param_th = $r3;
    $param_headingIndex = $r4;
    $r6 = self::$FAILED;
    goto seq_2;
  }
  // start seq_3
  $p9 = $this->currPos;
  $r11 = $param_preproc;
  $r12 = $param_th;
  $r13 = $param_headingIndex;
  if (strspn($this->input, "\x09 <", $this->currPos, 1) !== 0) {
    $r14 = true;
    $r14 = false;
    $this->currPos = $p9;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
  } else {
    $r14 = self::$FAILED;
    if (!$silence) { $this->fail(48); }
    $r10 = self::$FAILED;
    goto seq_3;
  }
  $r10 = $this->parseempty_lines_with_comments($silence);
  if ($r10===self::$FAILED) {
    $this->currPos = $p9;
    $param_preproc = $r11;
    $param_th = $r12;
    $param_headingIndex = $r13;
    $r10 = self::$FAILED;
    goto seq_3;
  }
  seq_3:
  if ($r10===self::$FAILED) {
    $r10 = null;
  }
  // free $p9,$r11,$r12,$r13
  // elc <- $r10
  $r13 = [];
  for (;;) {
    // start seq_4
    $p9 = $this->currPos;
    $r11 = $param_preproc;
    $r15 = $param_th;
    $r16 = $param_headingIndex;
    $r17 = $this->input[$this->currPos] ?? '';
    if ($r17 === "<" || $r17 === "_") {
      $r17 = false;
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r15;
      $param_headingIndex = $r16;
    } else {
      $r17 = self::$FAILED;
      if (!$silence) { $this->fail(43); }
      $r12 = self::$FAILED;
      goto seq_4;
    }
    $r12 = $this->parsesol_transparent($silence, $boolParams, $param_tagType, $param_preproc, $param_th, $param_headingIndex);
    if ($r12===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r11;
      $param_th = $r15;
      $param_headingIndex = $r16;
      $r12 = self::$FAILED;
      goto seq_4;
    }
    seq_4:
    if ($r12!==self::$FAILED) {
      $r13[] = $r12;
    } else {
      break;
    }
    // free $p9,$r11,$r15,$r16
  }
  // st <- $r13
  // free $r12
  // free $r17
  $r6 = true;
  seq_2:
  if ($r6!==self::$FAILED) {
    $this->savedPos = $p1;
    $r6 = $this->a38($r8, $r10, $r13);
  } else {
    $r5 = self::$FAILED;
    goto seq_1;
  }
  // free $r7,$r14
  $r14 = [];
  for (;;) {
    // start choice_3
    $r7 = $this->input[$this->currPos] ?? '';
    if ($r7 === "\x09" || $r7 === " ") {
      $this->currPos++;
      goto choice_3;
    } else {
      $r7 = self::$FAILED;
      if (!$silence) { $this->fail(5); }
    }
    // start seq_5
    $p9 = $this->currPos;
    $r17 = $param_preproc;
    $r12 = $param_th;
    $r16 = $param_headingIndex;
    $r15 = $this->input[$this->currPos] ?? '';
    if ($r15 === "<") {
      $r15 = false;
      $this->currPos = $p9;
      $param_preproc = $r17;
      $param_th = $r12;
      $param_headingIndex = $r16;
    } else {
      $r15 = self::$FAILED;
      if (!$silence) { $this->fail(10); }
      $r7 = self::$FAILED;
      goto seq_5;
    }
    $r7 = $this->parsecomment($silence);
    if ($r7===self::$FAILED) {
      $this->currPos = $p9;
      $param_preproc = $r17;
      $param_th = $r12;
      $param_headingIndex = $r16;
      $r7 = self::$FAILED;
      goto seq_5;
    }
    seq_5:
    // free $p9,$r17,$r12,$r16
    choice_3:
    if ($r7!==self::$FAILED) {
      $r14[] = $r7;
    } else {
      break;
    }
  }
  // free $r7
  // free $r15
  $r5 = [$r6,$r14];
  seq_1:
  // free $r6,$r14
  $this->cache[$bucket][$key] = new GrammarCacheEntry(
    $this->currPos,
    $r5,
    $r4 !== $param_headingIndex ? $param_headingIndex : self::$UNDEFINED,
    $r2 !== $param_preproc ? $param_preproc : self::$UNDEFINED,
    $r3 !== $param_th ? $param_th : self::$UNDEFINED
  );
  return $r5;
}

	public function parse( $input, $options = [] ) {
		$this->initInternal( $input, $options );
		$startRule = $options['startRule'] ?? '(DEFAULT)';
		$result = null;

		if ( !empty( $options['stream'] ) ) {
			switch ( $startRule ) {
				case '(DEFAULT)':
case "start_async":
  return $this->streamstart_async(false, self::newRef(null), self::newRef(null), self::newRef(null));
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

case "table_row_tag":
  $result = $this->parsetable_row_tag(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "table_start_tag":
  $result = $this->parsetable_start_tag(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "url":
  $result = $this->parseurl(false, self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "row_syntax_table_args":
  $result = $this->parserow_syntax_table_args(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "table_attributes":
  $result = $this->parsetable_attributes(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "generic_newline_attributes":
  $result = $this->parsegeneric_newline_attributes(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "tplarg_or_template_or_bust":
  $result = $this->parsetplarg_or_template_or_bust(false, self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "extlink":
  $result = $this->parseextlink(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
  break;

case "list_item":
  $result = $this->parselist_item(false, 0, "", self::newRef(null), self::newRef(null), self::newRef(null));
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
