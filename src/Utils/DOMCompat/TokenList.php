<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils\DOMCompat;

// This class was re-namespaced in Parsoid v0.23.0
require __DIR__ . '/../Core/DOMCompatTokenList.php';

// phpcs:ignore Generic.CodeAnalysis.UnconditionalIfStatement.Found
if ( false ) {
	/**
	 * For classmap-authoritative support (T393983)
	 */
	class TokenList extends \Wikimedia\Parsoid\Core\DOMCompatTokenList {
	}
}
