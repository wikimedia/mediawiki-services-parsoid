<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Handlers;

enum ReparseScenario {
	case NOT_NEEDED;
	case MAYBE_COMBINE_WITH_PREV_CELL;
	case MAYBE_REPARSE_ATTRS;
	case MAYBE_SPLIT_CELL;
}
