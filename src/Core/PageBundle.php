<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

// This class was renamed in Parsoid v0.22.0
require __DIR__ . '/HtmlPageBundle.php';

// phpcs:ignore Generic.CodeAnalysis.UnconditionalIfStatement.Found
if ( false ) {
	// For classmap-authoritative support (T393983)
	class PageBundle extends HtmlPageBundle {
	}
}
