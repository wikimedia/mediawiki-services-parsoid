<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\Core\LinkTargetTrait;

/**
 * Lightweight title class
 */
class TitleValue implements LinkTarget {
	use LinkTargetTrait;

	/** @var string */
	private $interwiki;

	/** @var int */
	private $namespaceId;

	/** @var string */
	private $dbkey;

	/** @var string */
	private $fragment;

	/**
	 * @param int $namespaceId
	 * @param string $dbkey Page DBkey (with underscores, not spaces)
	 * @param string $fragment Fragment suffix, or empty string if none
	 * @param string $interwiki Interwiki prefix, or empty string if none
	 */
	private function __construct(
		int $namespaceId, string $dbkey, string $fragment = '', string $interwiki = ''
	) {
		$this->namespaceId = $namespaceId;
		$this->dbkey = strtr( $dbkey, ' ', '_' );
		$this->fragment = $fragment;
		$this->interwiki = $interwiki;
	}

	/**
	 * Constructs a TitleValue, or returns null if the parameters are not valid.
	 *
	 * @note This does not perform any normalization, and only basic validation.
	 *
	 * @param int $namespace The namespace ID. This is not validated.
	 * @param string $title The page title in either DBkey or text form. No normalization is applied
	 *   beyond underscore/space conversion.
	 * @param string $fragment The fragment title. Use '' to represent the whole page.
	 *   No validation or normalization is applied.
	 * @param string $interwiki The interwiki component.
	 *   No validation or normalization is applied.
	 * @return TitleValue|null
	 */
	public static function tryNew(
		int $namespace,
		string $title,
		string $fragment = '',
		string $interwiki = ''
	): ?TitleValue {
		return new static( $namespace, $title, $fragment, $interwiki );
	}

	/** @inheritDoc */
	public function getNamespace(): int {
		return $this->namespaceId;
	}

	/** @inheritDoc */
	public function getFragment(): string {
		return $this->fragment;
	}

	/** @inheritDoc */
	public function getDBkey(): string {
		return $this->dbkey;
	}

	/** @inheritDoc */
	public function createFragmentTarget( string $fragment ): self {
		return new static( $this->namespaceId, $this->dbkey, $fragment, $this->interwiki );
	}

	/** @inheritDoc */
	public function getInterwiki(): string {
		return $this->interwiki;
	}
}
