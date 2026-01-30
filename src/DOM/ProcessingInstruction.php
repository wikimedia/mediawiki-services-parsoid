<?php
// phpcs:disable Generic.Classes.DuplicateClassName.Found
// phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM;

use Wikimedia\Parsoid\Core\DOMCompat;

if ( DOMCompat::isUsingDodo() ) {

	class_alias( \Wikimedia\Dodo\ProcessingInstruction::class, ProcessingInstruction::class );

} elseif ( DOMCompat::isUsing84Dom() ) {

	class_alias( \Dom\ProcessingInstruction::class, ProcessingInstruction::class );

} else {

	class ProcessingInstruction extends \DOMProcessingInstruction implements Node {
	}
}
