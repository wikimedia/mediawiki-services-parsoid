<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Tokens;

use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Tokens\PreprocTk;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;

/**
 * Test the methods in PreprocTk.
 * @coversDefaultClass \Wikimedia\Parsoid\Tokens\PreprocTk
 */
class PreprocTkTest extends \PHPUnit\Framework\TestCase {
	/**
	 * @dataProvider provideSplitContentsBy
	 * @covers ::splitContentsBy
	 */
	public function testSplitContentsBy(
		string $input, $splitter, int $limit, array $expected
	) {
		$env = new MockEnv( [] );
		$pt = new PegTokenizer( $env );
		$pieces = $pt->tokenizeAs( $input, "preproc_pieces", false );
		$kv = $pieces[0]->getContentsKV();
		$source = $kv->srcOffsets->value->source;
		$result = PreprocTk::splitContentsBy( $splitter, $kv, $limit );
		foreach ( $result as $p ) {
			$this->assertSame( $source, $p->srcOffsets->key->source );
			$this->assertSame( $source, $p->srcOffsets->value->source );
		}
		$fmtOffsets = static fn ( $kvsr ) =>
			"[" . $kvsr->value->start . "," . $kvsr->value->end . "] ";
		$format = static fn ( $kv ) =>
			$fmtOffsets( $kv->srcOffsets ) . PreprocTk::printContents( $kv );
		$this->assertEquals( $expected, array_map( $format, $result ) );
	}

	public static function provideSplitContentsBy() {
		yield "Split empty string" => [
			'{{}}',
			'|',
			-1,
			[
				// Always at least one item in the result
				'[2,2] ',
			],
		];
		yield "Split parser function on colon" => [
			'{{#foo:bar|bat}}',
			':',
			1,
			[
				'[2,6] "#foo"',
				'[6,7] ":"',
				'[7,14] "bar|bat"'
			],
		];
		yield "Split parser function on vertical bar" => [
			'{{#foo:bar|bat|baz=back|limited}}',
			'|',
			2,
			[
				'[2,10] "#foo:bar"',
				'[10,11] "|"',
				'[11,14] "bat"',
				'[14,15] "|"',
				'[15,31] "baz=back|limited"',
			],
		];
		yield "Split on whitespace with complex input" => [
			'[[  File:Foo {{{1| }}}<pre x="y z"> ignore whitespace </pre>]]',
			static fn ( $s, $l ) => preg_split( '/(\s+)/', $s, -1, PREG_SPLIT_DELIM_CAPTURE ),
			-1,
			[
				'[2,2] ""',
				'[2,4] "  "',
				'[4,12] "File:Foo"',
				'[12,13] " "',
				<<<END
				[13,60] {{{
				  "1| "
				}}}
				<pre x="y z">
				  " ignore whitespace "
				</pre>
				END,
			],
		];
		yield "Split parser function on vertical bar w/ ext tag" => [
			'{{#foo:bar|ext=<pre>foo|bar</pre>|pf={{pf|1|2}}}}',
			'|',
			-1,
			[
				'[2,10] "#foo:bar"',
				'[10,11] "|"',
				<<<END
				[11,33] "ext="
				<pre>
				  "foo|bar"
				</pre>
				END,
				'[33,34] "|"',
				<<<END
				[34,47] "pf="
				{{
				  "pf|1|2"
				}}
				END,
			],
		];
		yield "Split template on vertical bar with heading" => [
			// (headings have precedence!)
			"{{1x|\n==Foo | Bar == <!-- x|y -->\t\nBat}}",
			'|',
			-1,
			[
				'[2,4] "1x"',
				'[4,5] "|"',
				<<<END
				[5,38] "\\n"
				==
				  "Foo | Bar "
				==
				|" "
				|<!--
				|  " x|y "
				|-->
				|"\\t"
				"\\n"
				"Bat"
				END,
			],
		];
		yield "Split around a parsoid fragment marker" => [
			"{{ Foo " . PipelineUtils::PARSOID_FRAGMENT_PREFIX . "123}} bar}}",
			':',
			-1,
			[
				<<<END
				[2,36] " Foo "
				<Parsoid Fragment 123>
				" bar"
				END,
			],
		];
	}
}
