<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Utils\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\DocumentFragment::class, DocumentFragment::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\DocumentFragment::class, DocumentFragment::class );

} else {

	class DocumentFragment extends \DOMDocumentFragment implements Node {
	}

}
