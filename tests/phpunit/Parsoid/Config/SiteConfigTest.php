<?php

namespace Test\Parsoid\Config;

use Parsoid\Config\SiteConfig;

/**
 * @covers \Parsoid\Config\SiteConfig
 */
class SiteConfigTest extends \PHPUnit\Framework\TestCase {

	private function getSiteConfig( array $methods = [] ) {
		return $this->getMockBuilder( SiteConfig::class )
			->setMethods( $methods )
			->getMockForAbstractClass();
	}

	public function testNamespaceIsTalk() {
		$siteConfig = $this->getSiteConfig();
		$this->assertFalse( $siteConfig->namespaceIsTalk( -2 ) );
		$this->assertFalse( $siteConfig->namespaceIsTalk( -1 ) );
		$this->assertFalse( $siteConfig->namespaceIsTalk( 0 ) );
		$this->assertTrue( $siteConfig->namespaceIsTalk( 1 ) );
		$this->assertFalse( $siteConfig->namespaceIsTalk( 2 ) );
		$this->assertTrue( $siteConfig->namespaceIsTalk( 3 ) );
	}

	public function testUcfirst() {
		$siteConfig = $this->getSiteConfig( [ 'lang' ] );
		$siteConfig->method( 'lang' )->willReturn( 'en' );

		$this->assertSame( 'Foo', $siteConfig->ucfirst( 'Foo' ) );
		$this->assertSame( 'Foo', $siteConfig->ucfirst( 'foo' ) );
		$this->assertSame( 'Ááá', $siteConfig->ucfirst( 'ááá' ) );
		$this->assertSame( 'Iii', $siteConfig->ucfirst( 'iii' ) );

		foreach ( [ 'tr', 'kaa', 'kk', 'az' ] as $lang ) {
			$siteConfig = $this->getSiteConfig( [ 'lang' ] );
			$siteConfig->method( 'lang' )->willReturn( $lang );
			$this->assertSame( 'İii', $siteConfig->ucfirst( 'iii' ), "Special logic for $lang" );
		}
	}

}
