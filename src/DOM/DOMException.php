<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\DOMException::class, DOMException::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \DOMException::class, DOMException::class );

} else {

	class_alias( \DOMException::class, DOMException::class );

}
