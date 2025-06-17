<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

enum DiffMarkers: string {

	case DELETED = 'deleted';

	case INSERTED = 'inserted';

	case MOVED = 'moved';

	case CHILDREN_CHANGED = 'children-changed';

	case SUBTREE_CHANGED = 'subtree-changed';

	case MODIFIED_WRAPPER = 'modified-wrapper';
}
