<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html;

// This class was renamed in Parsoid v0.21.0
require __DIR__ . '/XHtmlSerializer.php';

// phpcs:ignore Generic.CodeAnalysis.UnconditionalIfStatement.Found
if ( false ) {
	// For classmap-authoritative support (T393983)
	class XMLSerializer extends XHtmlSerializer {
	}
}
