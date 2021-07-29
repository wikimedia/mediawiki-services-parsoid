<?php
# Select a DOM implementation: either PHP's default, or Dodo.
# The selected implementation is aliased to \Wikimedia\Parsoid\DOM\*
# which is a 'virtual' package that doesn't exist on disk.

# Note than phan can not handle conditional/computed calls to `class_alias`
# such as the one below, and just ignores them.  See `.phan/stubs/DomImpl.php`
# for a "simpler" version of this for phan to use.

$wgParsoidUseDodo = false;

foreach ( [
	# This list should match the one in src/DOM/Compat/Document.php
	'Attr',
	'CharacterData',
	'Comment',
	'Document',
	'DocumentFragment',
	'DocumentType',
	'DOMException', # see below caveat for NodeList; same applies.
	'DOMParser', # this doesn't exist in PHP's dom extension
	'Element',
	'Node',
	# We're going to alias NodeList, but be careful: unlike the other classes
	# here it cannot be passed to DOMDocument::registerNodeClass() and so when
	# running with the DOM\Compat classes every NodeList will be a
	# \DOMNodeList, not Wikimedia\Parsoid\DOM\NodeList or
	# Wikimedia\Parsoid\DOM\Compat\NodeList (both of which will be aliased).
	# We will avoid using NodeList in PHP type checks for this reason, although
	# it's fine to use in PHPDoc because phan thinks we're always using Dodo.
	'NodeList',
	'ProcessingInstruction',
	'Text',
] as $cls ) {
	if ( $wgParsoidUseDodo ) {
		$domImpl = '\\Wikimedia\\Dodo\\';
	} else {
		# class alias only works for "non-built in" classes, so we need to
		# create our own subclass of DOMDocument if we're going to use the
		# built-in DOMDocument.
		$domImpl = 'Wikimedia\\Parsoid\\DOM\\Compat\\';
		if ( $cls === 'NodeList' || $cls === 'DOMParser' || $cls === 'DOMException' ) {
			continue;
		}
	}
	class_alias( $domImpl . $cls, 'Wikimedia\\Parsoid\\DOM\\' . $cls );
}
