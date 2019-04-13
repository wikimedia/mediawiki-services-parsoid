<?php

namespace Parsoid\Wt2Html\TT;

use Parsoid\Config\Env;
use Parsoid\Tokens\Token;
use Parsoid\Wt2Html\Frame;

/**
 * Wikitext parsing state exposed to extensions.
 * Porting note: this is the equivalent of the POJO defined in ExtensionHandler.onExtension.
 */
class ParserState {
	// PORT-TODO: finish + document

	/** @var Token */
	public $extToken;

	/**
	 * FIXME: This is only used by extapi.js but leaks to extensions right now
	 * @var Frame
	 */
	public $frame;

	/** @var Env */
	public $env;

	/**
	 * FIXME: extTag, extTagOpts, inTemplate are used by extensions.
	 * Should we directly export those instead?
	 * @var array TokenHandler options
	 */
	public $parseContext;

}
