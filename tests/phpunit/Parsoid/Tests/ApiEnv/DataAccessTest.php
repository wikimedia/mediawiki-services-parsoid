<?php

namespace Parsoid\Tests\ApiEnv;

use Parsoid\Config\PageContent;

/**
 * @covers \Parsoid\Tests\ApiEnv\DataAccess
 */
class DataAccessTest extends \PHPUnit\Framework\TestCase {

	protected function getDataAccess( string $filename ) {
		$helper = new TestApiHelper( $this, $filename );
		return new DataAccess( $helper, [] );
	}

	public function testGetRedlinkData() {
		$data = $this->getDataAccess( 'redlinkdata' )->getRedlinkData( [
			'Foo',
			'Bar_(disambiguation)',
			'Special:SpecialPages',
			'ThisPageDoesNotExist',
			'File:Example.svg',
		] );

		$this->assertSame( [
			'Foo' => [ 'missing' => false, 'known' => true, 'redirect' => true, 'disambiguation' => false ],
			'Bar_(disambiguation)' => [
				'missing' => false, 'known' => true, 'redirect' => false, 'disambiguation' => true
			],
			'Special:SpecialPages' => [
				'missing' => false, 'known' => true, 'redirect' => false, 'disambiguation' => false
			],
			'ThisPageDoesNotExist' => [
				'missing' => true, 'known' => false, 'redirect' => false, 'disambiguation' => false
			],
			'File:Example.svg' => [
				'missing' => true, 'known' => true, 'redirect' => false, 'disambiguation' => false
			],
		], $data );
	}

	public function testGetFileInfo() {
		$data = $this->getDataAccess( 'fileinfo' )->getFileInfo( 'Foobar', [
			'Example.svg' => [ 'width' => 100 ],
			'DoesNotExist.png' => [ 'width' => 200 ],
		] );

		$this->assertSame( [
			'Example.svg' => [
				'width' => 600,
				'height' => 600,
				'size' => 10009,
				'mediatype' => 'DRAWING',
				'mime' => 'image/svg+xml',
				'url' => 'https://upload.wikimedia.org/wikipedia/commons/8/84/Example.svg',
				'mustRender' => true,
				'badFile' => false,
				'responsiveUrls' => [
					// phpcs:ignore Generic.Files.LineLength.TooLong
					'1.5' => 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Example.svg/150px-Example.svg.png',
					// phpcs:ignore Generic.Files.LineLength.TooLong
					'2' => 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Example.svg/200px-Example.svg.png',
				],
				// phpcs:ignore Generic.Files.LineLength.TooLong
				'thumburl' => 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Example.svg/100px-Example.svg.png',
				'thumbwidth' => 100,
				'thumbheight' => 100,
			],
			'DoesNotExist.png' => null,
		], $data );
	}

	public function testDoPst() {
		$da = $this->getDataAccess( 'dopst' );
		$ret = $da->doPst( 'Foobar', 'Foobar.{{cn}} {{subst:unsigned|Example}} ~~~~~' );
		$this->assertInternalType( 'string', $ret );
		$this->assertSame( 'Foobar.{{cn}} <!-- Template:Unsigned -->', substr( $ret, 0, 40 ) );

		// Test caching. Cache miss would make TestApiHelper throw.
		$this->assertSame(
			$ret, $da->doPst( 'Foobar', 'Foobar.{{cn}} {{subst:unsigned|Example}} ~~~~~' )
		);
	}

	public function testParseWikitext() {
		$da = $this->getDataAccess( 'parse' );
		$ret = $da->parseWikitext( 'Foobar', 'Foobar.{{cn}} {{subst:unsigned|Example}} ~~~~~' );
		$this->assertEquals( [
			// phpcs:ignore Generic.Files.LineLength.TooLong
			'html' => "<p>Foobar.<sup class=\"noprint Inline-Template Template-Fact\" style=\"white-space:nowrap;\">&#91;<i><a href=\"/wiki/Wikipedia:Citation_needed\" title=\"Wikipedia:Citation needed\"><span title=\"This claim needs references to reliable sources.\">citation needed</span></a></i>&#93;</sup> {{subst:unsigned|Example}} ~~~~~\n</p>",
			'modules' => [],
			'modulestyles' => [],
			'modulescripts' => [],
			'categories' => [
				'All_articles_with_unsourced_statements' => '',
				'Articles_with_unsourced_statements' => '',
			],
		], $ret );

		// Test caching. Cache miss would make TestApiHelper throw.
		$this->assertSame(
			$ret, $da->parseWikitext( 'Foobar', 'Foobar.{{cn}} {{subst:unsigned|Example}} ~~~~~' )
		);
	}

	public function testPreprocessWikitext() {
		$da = $this->getDataAccess( 'preprocess' );
		$ret = $da->preprocessWikitext( 'Foobar', 'Foobar.{{cn}} {{subst:unsigned|Example}} ~~~~~' );
		$this->assertEquals( [
			// phpcs:ignore Generic.Files.LineLength.TooLong
			'wikitext' => "Foobar.[[Category:All articles with unsourced statements]][[Category:Articles with unsourced statements ]]<sup class=\"noprint Inline-Template Template-Fact\" style=\"white-space:nowrap;\">&#91;<i>[[Wikipedia:Citation needed|<span title=\"This claim needs references to reliable sources.\">citation needed</span>]]</i>&#93;</sup> {{subst:unsigned|Example}} ~~~~~",
			'modules' => [],
			'modulestyles' => [],
			'modulescripts' => [],
			'categories' => [],
		], $ret );

		// Test caching. Cache miss would make TestApiHelper throw.
		$this->assertSame(
			$ret, $da->preprocessWikitext( 'Foobar', 'Foobar.{{cn}} {{subst:unsigned|Example}} ~~~~~' )
		);
	}

	public function testFetchPageContent() {
		$da = $this->getDataAccess( 'pagecontent-cur' );
		$c = $da->fetchPageContent( 'Help:Sample page' );
		$this->assertInstanceOf( PageContent::class, $c );
		$this->assertSame( [ 'main' ], $c->getRoles() );
		$this->assertSame( 'wikitext', $c->getModel( 'main' ) );
		$this->assertSame( 'text/x-wiki', $c->getFormat( 'main' ) );
		$this->assertSame(
			// phpcs:ignore Generic.Files.LineLength.TooLong
			"Our '''world''' is a planet where human beings have formed many societies.\n\nNobody knows whether there are intelligent beings on other worlds.\n\nThere are about one septillion (10<sup>24</sup>) worlds in the universe.<ref name=\"Kluwer Law book\">Burci, Gian Luca; Vignes, Claude-Henri (2004). [https://books.google.com/books?id=Xou_nD9jJF0C ''World Health Organization'']. Kluwer Law International. {{ISBN|9789041122735}}. Pages 15–20.</ref><ref>{{Cite journal|title = Mortality in mental disorders and global disease burden implications: a systematic review and meta-analysis|url = https://www.ncbi.nlm.nih.gov/pubmed/25671328|journal = JAMA psychiatry|date = 2015-04-01|issn = 2168-6238|pmc = 4461039|pmid = 25671328|pages = 334-341|volume = 72|issue = 4|doi = 10.1001/jamapsychiatry.2014.2502|first = Elizabeth Reisinger|last = Walker|first2 = Robin E.|last2 = McGee|first3 = Benjamin G.|last3 = Druss}}  {{Open access}}</ref><ref>{{Cite journal|title = Essential surgery: key messages from Disease Control Priorities, 3rd edition|url = https://www.ncbi.nlm.nih.gov/pubmed/25662414|journal = Lancet|date = 2015-05-30|issn = 1474-547X|pmid = 25662414|pages = 2209-2219|volume = 385|issue = 9983|doi = 10.1016/S0140-6736(15)60091-5|first = Charles N.|last = Mock|first2 = Peter|last2 = Donkor|first3 = Atul|last3 = Gawande|first4 = Dean T.|last4 = Jamison|first5 = Margaret E.|last5 = Kruk|first6 = Haile T.|last6 = Debas}}</ref>\n\n== References ==\n<references />\n\n<!-- All the contet here is public domain and has been copied from https://www.mediawiki.org/w/index.php?title=Help:Sample_page&oldid=2331983. Only add content here that has been previously been placed in the public domain as this page is used to generate screenshots -->",
			$c->getContent( 'main' )
		);

		// Test caching. Cache miss would make TestApiHelper throw.
		$this->assertEquals( $c, $da->fetchPageContent( 'Help:Sample page' ) );

		$c = $this->getDataAccess( 'pagecontent-old' )
			  ->fetchPageContent( 'Help:Sample page', 776171508 );
		$this->assertInstanceOf( PageContent::class, $c );
		$this->assertSame( [ 'main' ], $c->getRoles() );
		$this->assertSame( 'wikitext', $c->getModel( 'main' ) );
		$this->assertSame( 'text/x-wiki', $c->getFormat( 'main' ) );
		$this->assertSame(
			// phpcs:ignore Generic.Files.LineLength.TooLong
			"Our '''world''' is a planet where human beings have formed many societies.\n\nNobody knows whether there are intelligent beings on other worlds.\n\nThere are about one septillion (10<sup>24</sup>) worlds in the universe.\n\n<!-- All the contet here is public domain and has been copied from https://www.mediawiki.org/w/index.php?title=Help:Sample_page&oldid=2331983. Only add content here that has been previously been placed in the public domain as this page is used to generate screenshots -->",
			$c->getContent( 'main' )
		);
	}

	public function testFetchTemplateData() {
		$da = $this->getDataAccess( 'templatedata' );
		$ret = $da->fetchTemplateData( 'Template:Citation needed' );
		$this->assertInternalType( 'array', $ret );
		$this->assertArrayHasKey( 'description', $ret );
		$this->assertArrayHasKey( 'params', $ret );

		// Test caching. Cache miss would make TestApiHelper throw.
		$this->assertSame( $ret, $da->fetchTemplateData( 'Template:Citation needed' ) );
	}

}
