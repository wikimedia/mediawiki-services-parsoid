<?php
declare( strict_types = 1 );
// phpcs:disable Generic.Files.LineLength.TooLong

namespace Test\Parsoid\Wt2Html;

use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Tokens\PreprocTk;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;
use Wikimedia\WikiPEG\DefaultTracer;

/**
 * Test certain rules in the PegTokenizer
 * @coversDefaultClass \Wikimedia\Parsoid\Wt2Html\PegTokenizer
 */
class PegTokenizerTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers \Wikimedia\Parsoid\Wt2Html\Grammar
	 * @covers ::tokenizeAs
	 * @dataProvider providePieces
	 */
	public function testPreprocPieces( $input, $expected, $options = [] ) {
		$env = new MockEnv( [] );
		$pt = new PegTokenizer( $env, $options );
		$pieces = $pt->tokenizeAs( $input, "preproc_pieces", $options['sol'] ?? false );
		$pieces = PreprocTk::newContentsKV( $pieces, null );
		$actual = PreprocTk::printContents( $pieces );
		$this->assertSame( $expected, $actual );
	}

	public static function providePieces() {
		yield "Simple wikilink" => [
			"[[Foo|bar]]", <<<END
			[[
			  "Foo|bar"
			]]
			END,
		];
		yield "Language converter markup" => [
			"-{foo}-", <<<END
			-{
			  "foo"
			}-
			END,
		];
		yield "Template argument" => [
			"{{{1}}}", <<<END
			{{{
			  "1"
			}}}
			END,
		];
		yield "Parser function" => [
			"{{#foo:bar|bat|baz=barmy|=rah}}", <<<END
			{{
			  "#foo:bar|bat|baz=barmy|=rah"
			}}
			END,
		];
		yield "Single unmatched close curly" => [
			"{{foo}bar}}", <<<END
			{{
			  "foo"
			  "}"
			  "bar"
			}}
			END,
		];
		yield "Four open curlies" => [
			"{{{{foo}}bar}}", <<<END
			{{
			  {{
			    "foo"
			  }}
			  "bar"
			}}
			END,
		];
		// See https://www.mediawiki.org/wiki/Preprocessor_ABNF#Ideal_precedence
		yield "4 Matching braces" => [
			"{{{{foo}}}}", <<<END
			"{"
			{{{
			  "foo"
			}}}
			"}"
			END,
		];
		yield "5 Matching braces" => [
			"{{{{{foo}}}}}", <<<END
			{{
			  {{{
			    "foo"
			  }}}
			}}
			END,
		];
		yield "6 Matching braces" => [
			"{{{{{{foo}}}}}}", <<<END
			{{{
			  {{{
			    "foo"
			  }}}
			}}}
			END,
		];
		yield "7 Matching braces" => [
			"{{{{{{{foo}}}}}}}", <<<END
			"{"
			{{{
			  {{{
			    "foo"
			  }}}
			}}}
			"}"
			END,
		];
		# note that tplarg (three braces) has precedence, and rightmost
		# opening has precedence, leaving a single orphaned curly brace
		# on the left.  Similarly, wikilink (two square brackets) and
		# rightmost has precedence, leaving the extlink (single square) on
		# the left.
		yield "Proper grouping of curly and square brackets" => [
			"{{{{x}}}} [[[foo]]]", <<<END
			"{"
			{{{
			  "x"
			}}}
			"}"
			" "
			"["
			[[
			  "foo"
			]]
			"]"
			END,
		];
		yield "Complex mixed example" => [
			"[[foo -{-{foo}bar}-}}- [foo [[bar]]] [[[foo]bar]]", <<<END
			"["
			"["
			"foo "
			-{
			  -{
			    "foo"
			    "}"
			    "bar"
			  }-
			  "}"
			}-
			" "
			"["
			"foo "
			[[
			  "bar"
			]]
			"]"
			" "
			"["
			[[
			  "foo"
			  "]"
			  "bar"
			]]
			END,
		];
		yield 'Unbalanced triple brace' => [
			'{{1x|{{{!}}{{!}}-}}', <<<END
			{{
			  "1x|"
			  "{"
			  {{
			    "!"
			  }}
			  {{
			    "!"
			  }}
			  "-"
			}}
			END,
		];
		yield 'Mixed language converter and double braces, rightmost wins (1)' => [
			'-{{foo}}- -{{bar}} -{{bat}-', <<<END
			"-"
			{{
			  "foo"
			}}
			"-"
			" "
			"-"
			{{
			  "bar"
			}}
			" "
			-{
			  "{"
			  "bat"
			}-
			END,
		];
		yield 'Mixed language converter and double braces, rightmost wins (2)' => [
			'-{{{{x}}-', <<<END
			"-"
			"{"
			"{"
			{{
			  "x"
			}}
			"-"
			END,
		];
		// Demonstrate that single square brackets are *not* a preprocessor
		// construct.
		yield "Simple extlink (not a preprocessor construct)" => [
			"[http://cscott.net caption]", <<<END
			"["
			"http://cscott.net caption"
			"]"
			END,
		];
		yield "Wikilink prevents template close" => [
			'{{[[foo|bar}}]]', <<<END
			"{"
			"{"
			[[
			  "foo|bar"
			  "}"
			  "}"
			]]
			END,
		];
		yield "Wikilink prevents template close, even if [ is present" => [
			'{{[[foo|bar[}}]]', <<<END
			"{"
			"{"
			[[
			  "foo|bar"
			  "["
			  "}"
			  "}"
			]]
			END,
		];
		yield "Wikilink prevents template close, even if ] is present" => [
			'{{[[foo|bar]}}]]', <<<END
			"{"
			"{"
			[[
			  "foo|bar"
			  "]"
			  "}"
			  "}"
			]]
			END,
		];
		yield "Extlink does *not* prevent template close" => [
			'{{[foo bar}}]', <<<END
			{{
			  "["
			  "foo bar"
			}}
			"]"
			END,
		];
		yield 'Preprocessor precedence 11' => [
			'{{#tag:span|-{{#tag:span|-{{1x|x}}}}}}', <<<END
			{{
			  "#tag:span|"
			  "-"
			  {{
			    "#tag:span|"
			    "-"
			    {{
			      "1x|x"
			    }}
			  }}
			}}
			END,
		];
		yield 'Braces and noinclude' => [
			'{{{{{1<noinclude>|1x</noinclude>}}}|123}}', <<<END
			{{
			  {{{
			    "1"
			    <ignore>
			      "<noinclude>"
			    </ignore>
			    "|1x"
			    <ignore>
			      "</noinclude>"
			    </ignore>
			  }}}
			  "|123"
			}}
			END,
		];
		yield 'Parsoid fragment tokens' => [
			'{' . PipelineUtils::PARSOID_FRAGMENT_PREFIX . '123}}}', <<<END
			"{"
			<Parsoid Fragment 123>
			"}"
			END,
		];
		yield "Comment" => [
			// Note that the unclosed comment is closed here, which
			// make this not *quite* round-trip cleanly.  This would
			// only occur at the very end of the file, though.
			"<!-- foo --> <!-- unclosed {{t}} [[link]]", <<<END
			<!--
			  " foo "
			-->
			" "
			<!--
			  " unclosed {{t}} [[link]]"
			-->
			END,
		];
		yield "Self-closed extension tag (1)" => [
			"<pre/>", <<<END
			<pre/>
			END,
		];
		yield "Self-closed extension tag (2)" => [
			"<pre attr=value/>", <<<END
			<pre attr=value/>
			END,
		];
		yield "Simple extension tag" => [
			"<pre attr=value>foo</pre>", <<<END
			<pre attr=value>
			  "foo"
			</pre>
			END,
		];
		yield "Unclosed extension tag (1)" => [
			"<pre attr=value", <<<END
			"<"
			"pre attr=value"
			END,
		];
		yield "Unclosed extension tag (2)" => [
			"<pre attr=value>contents</pre", <<<END
			"<"
			"pre attr=value>contents"
			"<"
			"/pre"
			END,
		];
		yield "Unclosed extension tag (3)" => [
			"<pre//>", <<<END
			"<"
			"pre//>"
			END,
		];
		yield "Extension tag with hash" => [
			"<pre#id> ... <pre>foo</pre> ... </pre#id>", <<<END
			<pre#id>
			  " ... <pre>foo</pre> ... "
			</pre#id>
			END,
		];
		// <onlyinclude> when in template mode
		yield "<onlyinclude> in template mode" => [
			"Stuff [[ link <onlyinclude> otherstuff </onlyinclude> " .
			"more <onlyinclude>[[link]]</onlyinclude>xyz", <<<END
			" otherstuff "
			[[
			  "link"
			]]
			END, [
				'inTemplate' => true,
				'enableOnlyInclude' => true,
			]
		];
		yield "Headings and templates" => [
			"{{1x|\n===[[Foo]]===\t <!--one--><!--two--> \nMore}}",
			<<<END
			{{
			  "1x|"
			  "\\n"
			  ===
			    [[
			      "Foo"
			    ]]
			  ===
			  |"\\t "
			  |<!--
			  |  "one"
			  |-->
			  |<!--
			  |  "two"
			  |-->
			  |" "
			  "\\n"
			  "More"
			}}
			END
		];
		yield "Heading with unequal open and close" => [
			"===foo==", <<<END
			==
			  "="
			  "foo"
			==
			END, [ 'sol' => true ]
		];
		yield "Long all-equals heading" => [
			"===============", <<<END
			======
			  "==="
			======
			END, [ 'sol' => true ]
		];
	}

	/**
	 * @covers \Wikimedia\Parsoid\Wt2Html\Grammar
	 * @covers ::tokenizeAs
	 * @dataProvider providePiecesPerformance
	 */
	public function testPreprocPiecesPerformance( $prefix, $repeat, $suffix, $limit ) {
		$iterations = 10000;
		$input = $prefix . str_repeat( $repeat, 10000 ) . $suffix;
		$env = new MockEnv( [] );
		$options = [
			// Use custom tracer to count parse steps
			'tracer' => new class extends DefaultTracer {
				public int $steps = 0;

				protected function log( $event ): void {
					$this->steps++;
				}
			},
		];
		$pt = new PegTokenizer( $env, $options );
		$pieces = $pt->tokenizeAs( $input, "preproc_pieces", $options['sol'] ?? false );
		$steps = $options['tracer']->steps;
		// We want to ensure this doesn't take O($iterations^2) to parse.
		// Verify this by using a linear upper limit on $steps
		$this->assertTrue(
			$steps <= $limit * $iterations,
			"Took $steps to perform $iterations iterations"
		);
	}

	public static function providePiecesPerformance() {
		yield "<pre <pre <pre <pre" => [
			'', '<pre ', '', 40
		];
		yield "<pre><pre><pre><pre>" => [
			'', "<pre>", '', 40
		];
	}
}
