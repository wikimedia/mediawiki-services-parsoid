<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Handlers;

/** The backing strings are debugging aids */
enum ReparseScenario: string {
	case NOT_NEEDED = "not_needed";
	case MAYBE_COMBINE_WITH_PREV_CELL = "maybe_combine_with_prev_cell";
	case MAYBE_REPARSE_ATTRS = "maybe_reparse_attrs";
	case MAYBE_SPLIT_CELL = "maybe_split_cell";
}
