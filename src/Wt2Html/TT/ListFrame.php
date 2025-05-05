<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\ListTk;
use Wikimedia\Parsoid\Tokens\NlTk;

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
	 * @var array<EndTagTk>
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
}
