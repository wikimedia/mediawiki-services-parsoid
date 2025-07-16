<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Exception;
use Wikimedia\Parsoid\NodeData\DataMwError;

/**
 * Exception thrown to halt extension tag content parsing and produce standard
 * error output.
 *
 * $key and $params are basically the arguments to wfMessage, although they
 * will be stored in the data-mw of the encapsulation wrapper.
 *
 * See https://www.mediawiki.org/wiki/Specs/HTML#Error_handling
 */
class ExtensionError extends Exception {

	public readonly DataMwError $err;

	/**
	 * @param DataMwError|string $key
	 * @param mixed ...$params
	 */
	public function __construct(
		DataMwError|string $key = 'mw-extparse-error', ...$params
	) {
		parent::__construct();
		$this->err = $key instanceof DataMwError ? $key : new DataMwError( $key, $params );
	}

}
