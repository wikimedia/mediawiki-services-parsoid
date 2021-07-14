<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\Text::class, Text::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\Text::class, Text::class );

} else {

	class Text extends \DOMText implements Node, CharacterData {
	}

}
