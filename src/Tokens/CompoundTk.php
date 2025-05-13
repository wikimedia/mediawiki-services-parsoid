<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Compound token representing lists, tables, etc.
 * The actual tokens representing the list are stored
 * as a token array in this token.
 */
abstract class CompoundTk extends Token {
	/** @var array<Token|string> */
	protected array $nestedTokens;

	/**
	 * @param array<string|Token> $nestedToks
	 */
	public function __construct( array $nestedToks = [] ) {
		parent::__construct( null, null );
		$this->nestedTokens = $nestedToks;
	}

	public function __clone() {
		parent::__clone();
		$this->nestedTokens = Utils::cloneArray( $this->nestedTokens );
	}

	/** @param string|Token $token */
	public function addToken( $token ): void {
		$this->nestedTokens[] = $token;
	}

	/** @param array<string|Token> $tokens */
	public function addTokens( array $tokens ): void {
		PHPUtils::pushArray( $this->nestedTokens, $tokens );
	}

	/** @return array<string|Token> */
	public function getNestedTokens(): array {
		return $this->nestedTokens;
	}

	public function setNestedTokens( array $tokens ): void {
		$this->nestedTokens = $tokens;
	}

	/**
	 * Does this token implicitly induce an end-of-line context?
	 * This is true for tokens that are only generated on seeing
	 * EOL & EOF (ex: IndentPreTk, ListTk)
	 */
	abstract public function setsEOLContext(): bool;

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType(),
			'nestedTokens' => $this->nestedTokens
		];
	}
}
