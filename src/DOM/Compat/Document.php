<?php

declare( strict_types = 1 );

namespace Wikimedia\Parsoid\DOM\Compat;

class Document extends \DOMDocument implements Node {
	public function __construct() {
		parent::__construct();
		# Register our alias classes.  This matches the list in /DomImpl.php
		# with five exceptions:
		# 1) NodeList can't be passed to registerNodeClass, and so in
		#    "DOMDocument" mode we're always going to be using DOMNodeList,
		#    not the Wikimedia\Parsoid\DOM\Compat\NodeList class defined here.
		# 2) Similarly, DOMException is always going to be \DOMException
		#    when we're in DOMDocument mode.
		# 3,4) CharacterData and Node are abstract superclasses.  Due to the
		#    limitations of PHP multiple inheritance, we can't make them
		#    proper subclasses of DOMCharacterData/DOMNode.  Instead we make
		#    them marker interfaces, and ensure that all subclasses of
		#    DOMNode also implement our Node interface, and similarly all
		#    subclasses of DOMCharacterData implement our CharacterData marker
		#    interface.
		# 5) PHP doesn't have a DOMParser equivalent in the dom extension
		foreach ( [
			'Document',
			'Attr',
			# 'CharacterData', # see above
			'Comment',
			'DocumentFragment',
			# 'DOMException', # see above
			# 'DOMParser', # see above
			'Element',
			# 'Node', # see above
			# 'NodeList', # see above
			'Text',
		] as $cls ) {
			$this->registerNodeClass(
				"DOM$cls",
				"Wikimedia\\Parsoid\\DOM\\Compat\\$cls"
			);
		}
	}
}
