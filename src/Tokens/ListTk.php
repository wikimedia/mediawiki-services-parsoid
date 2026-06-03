<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;

/**
 * Compound token representing a list.
 */
class ListTk extends CompoundTk {
	public ?string $listType = null;

	public function setsEOLContext(): bool {
		return true;
	}

	/** @param string|Token $token */
	private static function isDLList( $token ): bool {
		return $token instanceof XMLTagTk && $token->getName() === 'dl';
	}

	/** @param string|Token $token */
	private static function isDDListItem( $token ): bool {
		return $token instanceof XMLTagTk && $token->getName() === 'dd';
	}

	public function isDLDDList(): bool {
		if ( $this->listType !== 'dl' ) {
			return false;
		}

		// Skip all dl-dd wrappers
		$n = count( $this->nestedTokens );
		Assert::invariant( $n > 0, "ListTk has zero tokens!" );
		// $this->nestedTokens[0] will be a <dl>
		$i = 0;
		do {
			if ( !self::isDDListItem( $this->nestedTokens[$i + 1] ) ) {
				return false;
			}
			$i += 2;
		} while ( $i < $n && self::isDLList( $this->nestedTokens[$i] ) );

		return true;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self( $json['nestedTokens'] ?? [] );
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		$ret = parent::jsonSerialize();
		$ret['listType'] = $this->listType ?? '--NULL--';
		return $ret;
	}
}
