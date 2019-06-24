<?php
declare( strict_types = 1 );

namespace Parsoid;

use Composer\Semver\Semver;

/**
 * PORT-FIXME: This is just a placeholder for data that was previously passed
 * to entrypoint in JavaScript.  Who will construct these objects and whether
 * this is the correct interface is yet to be determined.
 */
class PageBundle {
	/** @var string */
	public $html;

	/** @var array|null */
	public $parsoid;

	/** @var array|null */
	public $mw;

	/**
	 * @param string $html
	 * @param array|null $parsoid
	 * @param array|null $mw
	 */
	public function __construct( string $html, array $parsoid = null, array $mw = null ) {
		$this->html = $html;
		$this->parsoid = $parsoid;
		$this->mw = $mw;
	}

	/**
	 * Check if this pagebundle is valid.
	 * @param string $contentVersion Document content version to validate against.
	 * @param string|null &$errorMessage Error message will be returned here.
	 * @return bool
	 */
	public function validate( string $contentVersion, string &$errorMessage = null ) {
		if ( !$this->parsoid || !isset( $this->parsoid['ids'] ) ) {
			$errorMessage = 'Invalid data-parsoid was provided.';
			return false;
		} elseif ( Semver::satisfies( $contentVersion, '^999.0.0' )
			&& ( !$this->mw || !isset( $this->mw['ids'] ) )
		) {
			$errorMessage = 'Invalid data-mw was provided.';
			return false;
		}
		return true;
	}

}
