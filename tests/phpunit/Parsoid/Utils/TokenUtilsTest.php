<?php
declare( strict_types = 1 );

namespace Test\Parsoid\Utils;

use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\KVSourceRange;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\TagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Utils\TokenUtils;

/**
 * @coversDefaultClass \Wikimedia\Parsoid\Utils\TokenUtils
 */
class TokenUtilsTest extends \PHPUnit\Framework\TestCase {

	private const TOKEN_TEST_DATA = [
		[
			'token' => 'string',
			'tokensToString' => 'string',
		],
		[
			'token' => [ 'type' => 'NlTk' ],
			'tokenTrimTransparent' => true,
		],
		[
			'name' => '<div>',
			'token' => [
				'type' => 'TagTk',
				'name' => 'div',
				'attribs' => [],
			],
			'tagClosesBlockScope' => true,
		],
		[
			'name' => '<p>',
			'token' => [
				'type' => 'TagTk',
				'name' => 'p',
				'attribs' => [],
			],
			'tagOpensBlockScope' => true,
		],
		[
			'name' => '<td>',
			'token' => [
				'type' => 'TagTk',
				'name' => 'td',
				'attribs' => [],
			],
			'tagClosesBlockScope' => true,
			'isTableTag' => true,
		],
		[
			'name' => 'template token',
			'token' => [
				'type' => 'SelfclosingTagTk',
				'name' => 'template',
				'attribs' => [],
			],
			'isTemplateToken' => true,
		],
		[
			'name' => 'html tag token',
			'token' => [
				'type' => 'TagTk',
				'name' => 'div',
				'attribs' => [
					[ 'k' => 'role', 'v' => 'note' ],
					[ 'k' => 'class', 'v' => 'hatnote navigation-not-searchable' ],
				],
				'dataParsoid' => [
					'stx' => 'html',
				],
			],
			'tagClosesBlockScope' => true,
			'isHTMLTag' => true,
		],
		[
			'name' => 'DOMFragment',
			'token' => [
				'type' => 'TagTk',
				'name' => 'span',
				'attribs' => [
					[ 'k' => 'data-parsoid', 'v' => '{}' ],
					[ 'k' => 'typeof', 'v' => 'mw:DOMFragment' ],
				],
				'dataParsoid' => [
					'tmp' => [ 'setDSR' => true ],
					'html' => 'mwf13',
					'tagWidths' => [ 8, 9 ]
				],
			],
			'hasDOMFragmentType' => true,
		],
		[
			'name' => 'SOL-transparent <link>',
			'token' => [
				'type' => 'SelfclosingTagTk',
				'name' => 'link',
				'attribs' => [
					[ 'k' => 'rel', 'v' => 'mw:PageProp/Category' ],
					[ 'k' => 'href', 'v' => './Category:Articles_with_short_description' ],
				],
				'dataParsoid' => [
					'stx' => 'simple',
					'a' => [
						'href' => './Category:Articles_with_short_description',
					],
					'sa' => [
						'href' => 'Category:articles with short description'
					],
				],
			],
			'isSolTransparentLinkTag' => true,
		],
		[
			'name' => 'comment',
			'token' => [
				'type' => 'CommentTk',
				'value' => ' THIS IS A COMMENT ',
				'dataParsoid' => [
					'tsr' => [ 2104, 2147 ],
				],
			],
		],
	];

	public static function provideTokens() {
		foreach ( self::TOKEN_TEST_DATA as $k => $t ) {
			$t['name'] = $t['name'] ?? "Token Test #$k";
			$t['token'] = Token::getToken( $t['token'] );
			yield $t['name'] => [ $t ];
		}
	}

	/**
	 * @covers ::tagOpensBlockScope
	 * @dataProvider provideTokens
	 */
	public function testTagOpensBlockScope( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['tagOpensBlockScope'] ?? false,
			$token instanceof XMLTagTk ?
				TokenUtils::tagOpensBlockScope( $token->getName() ) : false
		);
	}

	/**
	 * @covers ::tagClosesBlockScope
	 * @dataProvider provideTokens
	 */
	public function testTagClosesBlockScope( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['tagClosesBlockScope'] ?? false,
			$token instanceof XMLTagTk ?
				TokenUtils::tagClosesBlockScope( $token->getName() ) : false
		);
	}

	/**
	 * @covers ::isTemplateToken
	 * @dataProvider provideTokens
	 */
	public function testIsTemplateToken( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['isTemplateToken'] ?? false,
			TokenUtils::isTemplateToken( $token )
		);
	}

	/**
	 * @covers ::isHTMLTag
	 * @dataProvider provideTokens
	 */
	public function testIsHTMLTag( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['isHTMLTag'] ?? false,
			TokenUtils::isHTMLTag( $token )
		);
	}

	/**
	 * @covers ::hasDOMFragmentType
	 * @dataProvider provideTokens
	 */
	public function testIsDOMFragmentType( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['hasDOMFragmentType'] ?? false,
			( $token instanceof TagTk || $token instanceof SelfclosingTagTk ) ?
			TokenUtils::hasDOMFragmentType(
				$token
			) : false
		);
	}

	/**
	 * @covers ::isTableTag
	 * @dataProvider provideTokens
	 */
	public function testIsTableTag( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['isTableTag'] ?? false,
			TokenUtils::isTableTag( $token )
		);
	}

	/**
	 * @covers ::isSolTransparentLinkTag
	 * @dataProvider provideTokens
	 */
	public function testIsSolTransparentLinkTag( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['isSolTransparentLinkTag'] ?? false,
			TokenUtils::isSolTransparentLinkTag( $token )
		);
	}

	/**
	 * @covers ::isEntitySpanToken
	 * @dataProvider provideTokens
	 */
	public function testIsEntitySpanToken( array $testCase ) {
		$token = $testCase['token'];
		$this->assertEquals(
			$testCase['isEntitySpanToken'] ?? false,
			TokenUtils::isEntitySpanToken( $token )
		);
	}

	/**
	 * @covers ::tokensToString
	 * @dataProvider provideTokens
	 */
	public function testTokensToString( array $testCase ) {
		$tokens = [ 'abc', $testCase['token'], 'def', new NlTk( null ) ];
		$this->assertEquals(
			'abc' . ( $testCase['tokensToString'] ?? '' ) . 'def',
			TokenUtils::tokensToString( $tokens )
		);
	}

	/**
	 * @covers ::kvToHash
	 * @covers ::tokenTrim
	 * @dataProvider provideTokens
	 */
	public function testKvToHash( array $testCase ) {
		$k = [ '  key', $testCase['token'], 'ABC  ' ];
		$v = [ ' vaLUE', $testCase['token'], new NlTk( null ) ];
		$kExpect = 'key' . ( $testCase['tokensToString'] ?? '' ) . 'abc';
		$vExpect = 'vaLUE' . ( $testCase['tokensToString'] ?? '' );
		$srcOffsets = new KVSourceRange( 0, 10, 11, 20 );
		$expected = [];
		$expected[$kExpect] = $vExpect;
		$this->assertEquals(
			$expected,
			TokenUtils::kvToHash( [ new KV( $k, $v, $srcOffsets ) ] )
		);
	}

	/**
	 * @covers ::convertOffsets()
	 * @dataProvider provideConvertOffsets
	 */
	public function testConvertOffsets( $str, $from, $to, $input, $expect ) {
		$offsets = [];
		foreach ( $input as &$v ) {
			$offsets[] = &$v;
		}
		unset( $v );

		TokenUtils::convertOffsets( $str, $from, $to, $offsets );
		$this->assertSame( $expect, $offsets, "$from → $to" );
	}

	public static function provideConvertOffsets() {
		# Ensure that we have char from each UTF-8 class here.
		#
		#      "foo bár 💩💩 baz AԱ人💩"
		# char  012345678 9 01234567 8
		# ucs   012345678 0 23456789 0
		# byte  012345789 3 78901235 8
		#
		$str = "foo bár \u{1F4A9}\u{1F4A9} baz A\u{0531}\u{4EBA}\u{1F4A9}";
		$offsets = [
			# 0th offset must be zero, 1st should be length of string
			'byte' => [ 0, 32, 4, 13, 9, 18, 21, 22, 23, 25, 28 ],
			'char' => [ 0, 19, 4, 9, 8, 11, 14, 15, 16, 17, 18 ],
			'ucs2' => [ 0, 22, 4, 10, 8, 13, 16, 17, 18, 19, 20 ],
		];
		foreach ( $offsets as $from => $input ) {
			foreach ( $offsets as $to => $expect ) {
				yield "$from → $to" => [ $str, $from, $to, $input, $expect ];
			}
		}

		yield "Passing 0 offsets doesn't error" => [ $str, 'byte', 'char', [], [] ];

		yield "No error if we run out of offsets before EOS"
			=> [ $str, 'byte', 'char', [ 0, 9 ], [ 0, 8 ] ];

		foreach ( $offsets as $from => $input ) {
			foreach ( $offsets as $to => $expect ) {
				yield "Out of bounds offsets, $from → $to"
					=> [ $str, $from, $to, [ -10, 500 ], [ $expect[0], $expect[1] ] ];
			}
		}

		yield "Rounding bytes"
			=> [ "💩💩💩", 'byte', 'byte', [ 0, 1, 2, 3, 4, 5 ], [ 0, 4, 4, 4, 4, 8 ] ];
		yield "Rounding ucs2"
			=> [ "💩💩💩", 'ucs2', 'ucs2', [ 0, 1, 2, 3, 4 ], [ 0, 2, 2, 4, 4 ] ];
	}

}
