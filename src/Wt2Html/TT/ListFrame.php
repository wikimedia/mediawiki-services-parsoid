<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\ListTk;
use Wikimedia\Parsoid\Tokens\NlTk;
use Wikimedia\Parsoid\Tokens\TagTk;

/**
 * Private helper class for ListHandler.
 *
 * NOTE: This is *not* a per-list frame.
 *
 * This is a frame for every nested context within which list
 * processing proceeds independent of any parent context.
 * Currently, *only* tables introduce a new nested parsing context
 * and lists embedded in a table cell are independent of any list
 * that the table itself might be embedded in.
 *
 * So, if you ignore tables, there will only be a single list frame ever
 * in the list-frame stack maintained in ListHandler.
 *
 * @private
 */
class ListFrame {
	/**
	 * Flag indicating a list-less line that terminates a list block
	 */
	public bool $atEOL = true;
	/**
	 * NlTk that triggered atEOL
	 */
	public ?NlTk $nlTk = null;
	public array $solTokens = [];
	/**
	 * Bullet stack, previous element's listStyle
	 */
	public array $bstack = [];
	/**
	 * Stack of end tags
	 * @var list<EndTagTk>
	 */
	public array $endtags = [];
	/**
	 * Partial DOM building heuristic:
	 * Number of open block tags encountered within list context.
	 */
	public int $numOpenBlockTags = 0;
	/**
	 * Number of open tags encountered within list context.
	 */
	public int $numOpenTags = 0;

	/**
	 * Did we generate a <dd> already on this line?
	 * Used to convert extra : listitems to ":" instead of extra <dl>s.
	 * Gets reset on encountering a NlTk or a ; listitem.
	 */
	public bool $haveDD = false;

	public ListTk $listTk;

	public function __construct() {
		$this->listTk = new ListTk;
	}

	/**
	 * Handle popping tags after processing
	 *
	 * @param int $n
	 * @return list<EndTagTk>
	 */
	public function popTags( int $n ): array {
		$tokens = [];
		while ( $n > 0 ) {
			// push list item..
			$temp = array_pop( $this->endtags );
			if ( $temp ) {
				$tokens[] = $temp;
			}
			// and the list end tag
			$temp = array_pop( $this->endtags );
			if ( $temp ) {
				$tokens[] = $temp;
			}
			$n--;
		}
		return $tokens;
	}

	/**
	 * Push a list
	 *
	 * @return list{TagTk, TagTk}
	 */
	public function pushList(
		array $container, DataParsoid $dp1, DataParsoid $dp2
	): array {
		$this->endtags[] = new EndTagTk( $container['list'] );
		$this->endtags[] = new EndTagTk( $container['item'] );

		if ( $container['item'] === 'dd' ) {
			$this->haveDD = true;
		} elseif ( $container['item'] === 'dt' ) {
			$this->haveDD = false; // reset
		}

		return [
			new TagTk( $container['list'], [], $dp1 ),
			new TagTk( $container['item'], [], $dp2 )
		];
	}

}
