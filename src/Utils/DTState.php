<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;

/**
 * State carried while DOM Traversing.
 *
 * FIXME: As it stands, DTState cannot be constructed outside of Parsoid.
 * However, extensions and core code might benefit from a non-Parsoid-specific
 * state object that DOMTraverser users outside of Parsoid could use.
 */
class DTState {
	public Env $env;
	public array $options;
	public bool $atTopLevel;
	public ?stdClass $tplInfo = null;
	public array $abouts = [];
	public array $seenIds = [];
	public array $usedIdIndex = [];
	public ?PegTokenizer $tokenizer = null; // Needed by TableFixups handlers

	public function __construct( Env $env, array $options = [], bool $atTopLevel = false ) {
		$this->env = $env;
		$this->options = $options;
		$this->atTopLevel = $atTopLevel;
	}
}
