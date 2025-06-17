<?php
namespace Test\Parsoid\Language;

use PHPUnit\Framework\TestCase;
use Wikimedia\Bcp47Code\Bcp47CodeValue;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Language\LanguageConverter;
use Wikimedia\Parsoid\Mocks\MockEnv;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\DOMCompat;

class LanguageConverterTest extends TestCase {

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testAutoConvertShouldReturnNoResultsIfNoConverterExistsForPageLanguage(): void {
		$env = self::getMockEnv( 'de' );
		$doc = DOMCompat::newDocument( true );

		$langconv = LanguageConverter::loadLanguageConverter( $env );
		$variants = LanguageConverter::autoConvertToAllVariants( $doc, 'test', $langconv );

		$this->assertSame( [], $variants );
	}

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testAutoConvertShouldReturnNoResultsIfConvertedTextIsTheSame(): void {
		$env = self::getMockEnv( 'sr' );
		$doc = DOMCompat::newDocument( true );

		$langconv = LanguageConverter::loadLanguageConverter( $env );
		$variants = LanguageConverter::autoConvertToAllVariants( $doc, '123', $langconv );

		$this->assertSame( [], $variants );
	}

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testAutoConvertShouldReturnResultsKeyedByVariantCode(): void {
		$env = self::getMockEnv( 'sr' );
		$doc = DOMCompat::newDocument( true );

		$langconv = LanguageConverter::loadLanguageConverter( $env );
		$variants = LanguageConverter::autoConvertToAllVariants( $doc, 'test', $langconv );

		$this->assertSame( [ 'sr-ec' => 'тест' ], $variants );
	}

	/** @covers \Wikimedia\Parsoid\Language\LanguageConverter::autoConvertToAllVariants */
	public function testShouldNotPerformAutoConvertForChinese(): void {
		$env = self::getMockEnv( 'zh' );
		$doc = DOMCompat::newDocument( true );

		$langconv = LanguageConverter::loadLanguageConverter( $env );
		$variants = LanguageConverter::autoConvertToAllVariants( $doc, 'test', $langconv );

		$this->assertNull( $langconv );
		$this->assertSame( [], $variants );
	}

	private static function getMockEnv( string $pageLanguageCode ): Env {
		$siteConfig = new MockSiteConfig( [] );
		return new MockEnv( [
			'pageConfig' => new MockPageConfig(
				$siteConfig,
				[ 'pageLanguage' => new Bcp47CodeValue( $pageLanguageCode ) ],
				null
			)
		] );
	}
}
