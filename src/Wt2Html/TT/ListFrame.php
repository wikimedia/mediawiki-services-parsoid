<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\NlTk;

/**
 * Private helper class for ListHandler.
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
}
