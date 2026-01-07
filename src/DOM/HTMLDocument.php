<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\HTMLDocument::class, HTMLDocument::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\HTMLDocument::class, HTMLDocument::class );
	// Ensure other aliases are loaded as well before an HTMLDocument is
	// first created.
	foreach ( [
		'Attr',
		'CharacterData',
		'Comment',
		'DOMException',
		'DOMImplementation',
		'Document',
		'DocumentFragment',
		'DocumentType',
		'Element',
		'Node',
		'ProcessingInstruction',
		'Text',
	] as $cls ) {
		class_exists( "\\Wikimedia\\Parsoid\\DOM\\$cls" );
	}

} else {

	/* This class doesn't exist for PHP < 8.4 */

}

// phpcs:ignore Generic.CodeAnalysis.UnconditionalIfStatement.Found
if ( false ) {
	/**
	 * This is needed for classmap-authoritative support (T409283)
	 * This should be re-evaluated once support for PHP 8.3 is dropped
	 */
	class HTMLDocument {
	}
}
