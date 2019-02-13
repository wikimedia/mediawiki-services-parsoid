<?php

namespace Test\Parsoid\Wt2Html;

use Parsoid\Wt2Html\XMLSerializer;
use Wikimedia\TestingAccessWrapper;

/**
 * Test the entity encoding logic (which the JS version did not have as it called
 * on the entities npm package). phpspec does not allow testing private methods so
 * this is done in PHPUnit.
 */
class XMLSerializerTest extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers encodeHtmlEntities
	 * @dataProvider provideEncodeHtmlEntities
	 */
	public function testEncodeHtmlEntities( $raw, $whitelist, $expected ) {
		$XMLSerializer = TestingAccessWrapper::newFromClass( XMLSerializer::class );
		$actual = $XMLSerializer->encodeHtmlEntities( $raw, $whitelist );
		$this->assertEquals( $expected, $actual );
	}

	public function provideEncodeHtmlEntities() {
		return [
			[ 'ab&cd<>e"f\'g&h"j', '&<\'"', 'ab&amp;cd&lt;>e&quot;f&apos;g&amp;h&quot;j' ],
			[ 'ab&cd<>e"f\'g&h"j', '&<"', 'ab&amp;cd&lt;>e&quot;f\'g&amp;h&quot;j' ],
			[ 'ab&cd<>e"f\'g&h"j', '&<', 'ab&amp;cd&lt;>e"f\'g&amp;h"j' ],
		];
	}

}
