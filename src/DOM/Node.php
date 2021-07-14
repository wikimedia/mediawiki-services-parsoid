<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\Node::class, Node::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\Node::class, Node::class );

} else {

	interface Node { # can't extend \DOMNode due to inheritance limitations
	}

}
