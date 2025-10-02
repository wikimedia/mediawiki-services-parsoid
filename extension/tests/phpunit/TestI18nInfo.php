<?php
declare( strict_types = 1 );

namespace Test\Parsoid;

use Wikimedia\Message\ListType;
use Wikimedia\Message\MessageValue;
use Wikimedia\Message\ParamType;
use Wikimedia\Message\ScalarParam;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * @coversDefaultClass  \Wikimedia\Parsoid\NodeData\I18nInfo
 */
class TestI18nInfo extends \PHPUnit\Framework\TestCase {

	/**
	 * @covers ::jsonClassHintFor()
	 */
	public function testI18nInfoSerialization() {
		$doc = ContentUtils::createAndLoadDocument( '' );
		$msg = ( new MessageValue( 'testkey' ) )->listParamsOfType(
			ListType::AND, [
				new ScalarParam( ParamType::NUM, 1 ),
				new ScalarParam( ParamType::NUM, 2 ),
				new ScalarParam( ParamType::NUM, 3 ),
			]
		);
		$frag = WTUtils::createInterfaceI18nFragment(
			$doc, 'testkey', $msg->getParams()
		);
		DOMCompat::getBody( $doc )->append( $frag );
		$html = DomPageBundle::fromLoadedDocument( $doc )->toInlineAttributeHtml( [
			'body_only' => true,
		] );
		// Verify that the 'params' list in data-mw-i18n doesn't have
		// unnecessary _type_ information.
		// phpcs:ignore Generic.Files.LineLength.TooLong
		$this->assertEquals( '<span typeof="mw:I18n" data-mw-i18n=\'{"/":{"lang":"x-user","key":"testkey","params":[{"list":[{"num":1},{"num":2},{"num":3}],"type":"text"}]}}\' id="mwAA" data-parsoid="{}"></span>', $html );
	}
}
