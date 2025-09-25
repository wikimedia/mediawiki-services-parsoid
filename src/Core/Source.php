<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Represents a "source text" for a SourceRange.
 *
 * Fundamentally this just consists of a source string.
 *
 * Maybe eventually we'll support "derived sources" which are substrings
 * of another source?  And we'll probably want some sort of short name or
 * ID so these can be serialized eventually; maybe that will want to map
 * to a particular slot of a particular revision of a particular title
 * in MediaWiki so that an editor can replace or update the substring
 * corresponding to a particular DOM element.
 */
interface Source {

	public function getSrcText(): string;

}
