<?php
namespace spec\Parsoid\Utils;

use Parsoid\Config\Env;
use Parsoid\Html2Wt\DiffUtils;
use Parsoid\Html2Wt\DOMDiff;
use Parsoid\Tests\MockEnv;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;
use PhpSpec\Exception\Example\FailureException;
use PhpSpec\ObjectBehavior;
use PhpSpec\Wrapper\Subject;

class DOMUtilsSpec extends ObjectBehavior {

	public function it_is_initializable() {
		$this->shouldHaveType( DOMUtils::class );
	}

	/**
	 * @param string $dom1
	 * @param string $dom2
	 * @return \stdClass
	 */
	private function parseAndDiff( $dom1, $dom2 ) {
		$env = new MockEnv( [] );
		$doc1 = DOMCompat::getBody( $env->createDocument( $dom1 ) );
		$doc2 = DOMCompat::getBody( $env->createDocument( $dom2 ) );

		$domDiff = new DOMDiff( $env );
		$domDiff->diff( $doc1, $doc2 );

		return (object)[
			'body' => $doc2,
			'env' => $env,
		];
	}

	public function it_should_find_a_diff_when_changing_text_in_a_node() {
		$dom1 = <<<EOD
<p>a</p>
<p>b</p>
EOD;
		$dom2 = <<<EOD
<p>A</p>
<p>b</p>
EOD;

		$std = self::parseAndDiff( $dom1, $dom2 );
		/** @var \DOMElement $body */
		$body = $std->body;
		$meta = $body->firstChild->firstChild;
		/** @var Subject $ret */
		$ret = $this::isDiffMarker( $meta, 'deleted' );
		$ret->shouldBe( true );
	}

	public function it_should_find_a_diff_deleting_a_node() {
		$dom1 = <<<EOD
<p>a</p>
<p>b</p>
EOD;
		$dom2 = <<<EOD
<p>a</p>
EOD;

		$std = self::parseAndDiff( $dom1, $dom2 );
		/** @var \DOMElement $body */
		$body = $std->body;
		$meta = $body->firstChild->nextSibling;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );
	}

	public function it_should_find_a_diff_when_reordering_nodes() {
		$dom1 = <<<EOD
<p>a</p>
<p>b</p>
EOD;
		$dom2 = <<<EOD
<p>b</p>
<p>a</p>
EOD;

		$std = self::parseAndDiff( $dom1, $dom2 );
		/** @var \DOMElement $body */
		$body = $std->body;
		$meta = $body->firstChild->firstChild;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );

		$meta = $body->firstChild->nextSibling->nextSibling->firstChild;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );
	}

	public function it_should_find_a_diff_when_adding_multiple_nodes() {
		$dom1 = <<<EOD
<p>a</p>
<p>b</p>
EOD;
		$dom2 = <<<EOD
<p>p</p>
<p>q</p>
<p>a</p>
<p>b</p>
<p>r</p>
<p>s</p>
EOD;

		$std = self::parseAndDiff( $dom1, $dom2 );
		/** @var \DOMElement $body */
		$body = $std->body;
		$meta = $body->firstChild->firstChild;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );

		$meta = $body->firstChild->nextSibling->nextSibling->firstChild;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );

		$meta = $body->firstChild->nextSibling->nextSibling->nextSibling;
		$this::isDiffMarker( $meta, 'inserted' )->shouldEqual( true );

		$meta = $meta->nextSibling->nextSibling->nextSibling;
		$this::isDiffMarker( $meta, 'inserted' )->shouldEqual( true );

		$meta = $meta->nextSibling->nextSibling->nextSibling;
		$this::isDiffMarker( $meta, 'inserted' )->shouldEqual( true );

		$meta = $meta->nextSibling->nextSibling->nextSibling;
		$this::isDiffMarker( $meta, 'inserted' )->shouldEqual( true );
	}

	public function it_should_find_a_diff_when_adding_and_deleting_nodes() {
		$dom1 = <<<EOD
<p>a</p>
<p>b</p>
<p>c</p>
EOD;
		$dom2 = <<<EOD
<p>p</p>
<p>b</p>
EOD;

		$std = self::parseAndDiff( $dom1, $dom2 );
		/** @var \DOMElement $body */
		$body = $std->body;
		$meta = $body->firstChild->firstChild;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );

		$meta = $body->firstChild->nextSibling->nextSibling->nextSibling;
		$this::isDiffMarker( $meta, 'deleted' )->shouldEqual( true );
	}

	public function it_should_find_a_diff_when_changing_an_attribute() {
		$dom1 = <<<EOD
<p id='a'>a</p>
<p id='b'>b</p>
EOD;
		$dom2 = <<<EOD
<p id='aa'>a</p>
<p id='b'>b</p>
EOD;

		$std = self::parseAndDiff( $dom1, $dom2 );
		/** @var \DOMElement $body */
		$body = $std->body;
		/** @var Env $env */
		$env = $std->env;

		$diff = DiffUtils::getDiffMark( $body->firstChild, $env )->diff;
		if ( !in_array( 'modified-wrapper', $diff ) ) {
			throw new FailureException( 'diff should contain "modified-wrapper" value' );
		}
	}

}
