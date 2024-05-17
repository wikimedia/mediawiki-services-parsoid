<?php
namespace Test\Parsoid\Language;

use DOMDocument;
use PHPUnit\Framework\TestCase;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Language\LanguageConverter;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;

class LanguageConverterTest extends TestCase {

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testAutoConvertShouldReturnNoResultsIfNoConverterExistsForPageLanguage(): void {
		$env = self::getMockEnv( 'de' );
		$doc = new DOMDocument();

		$variants = LanguageConverter::autoConvertToAllVariants( $env, $doc, 'test' );

		$this->assertSame( [], $variants );
	}

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testAutoConvertShouldReturnNoResultsIfConvertedTextIsTheSame(): void {
		$env = self::getMockEnv( 'sr' );
		$doc = new DOMDocument();

		$variants = LanguageConverter::autoConvertToAllVariants( $env, $doc, '123' );

		$this->assertSame( [], $variants );
	}

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testAutoConvertShouldReturnResultsKeyedByVariantCode(): void {
		$env = self::getMockEnv( 'sr' );
		$doc = new DOMDocument();

		$variants = LanguageConverter::autoConvertToAllVariants( $env, $doc, 'test' );

		$this->assertSame( [ 'sr-ec' => 'тест' ], $variants );
	}

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testShouldNotPerformAutoConvertForChinese(): void {
		$env = self::getMockEnv( 'zh' );
		$doc = new DOMDocument();

		$variants = LanguageConverter::autoConvertToAllVariants( $env, $doc, 'test' );

		$this->assertSame( [], $variants );
	}

	private static function getMockEnv( string $pageLanguageCode ): Env {
		$siteConfig = new MockSiteConfig( [] );
		return new MockEnv( [
			'pageConfig' => new MockPageConfig(
				$siteConfig,
				[ 'pageLanguage' => $pageLanguageCode ],
				null
			)
		] );
	}
}
