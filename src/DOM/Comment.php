<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\Comment::class, Comment::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\Comment::class, Comment::class );

} else {

	class Comment extends \DOMComment implements Node, CharacterData {
	}

}
