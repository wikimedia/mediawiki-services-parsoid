<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Wrapper so that the internal token isn't exposed
 */
class ExtensionTag {

	/** @var Token */
	private $extToken;

	/**
	 * @param Token $extToken
	 */
	public function __construct( Token $extToken ) {
		$this->extToken = $extToken;
	}

	/**
	 * Return the name of the extension tag
	 * @return string
	 */
	public function getName(): string {
		return $this->extToken->getAttribute( 'name' );
	}

	/**
	 * Return the source offsets for this extension tag usage
	 * @return DomSourceRange|null
	 */
	public function getOffsets(): ?DomSourceRange {
		return $this->extToken->dataParsoid->extTagOffsets ?? null;
	}

	/**
	 * Return the full extension source
	 * @return string|null
	 */
	public function getSource(): ?string {
		if ( $this->extToken->hasAttribute( 'source' ) ) {
			return $this->extToken->getAttribute( 'source' );
		} else {
			return null;
		}
	}

	/**
	 * Is this extension tag self-closed?
	 * @return bool
	 */
	public function isSelfClosed(): bool {
		return !empty( $this->extToken->dataParsoid->selfClose );
	}

	/**
	 * @return DataMw
	 */
	public function getDefaultDataMw(): DataMw {
		return Utils::getExtArgInfo( $this->extToken );
	}
}
