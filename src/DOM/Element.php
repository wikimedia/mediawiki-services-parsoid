<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\Element::class, Element::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\Element::class, Element::class );

} else {

	class Element extends \DOMElement implements Node {
	}

}
