<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\CharacterData::class, CharacterData::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\CharacterData::class, CharacterData::class );

} else {

	interface CharacterData { # can't extend \DOMCharacterData due to inheritance limitations
	}

}
