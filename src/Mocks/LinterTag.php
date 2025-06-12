<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Mocks;

use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Ext\ExtensionModule;
use Wikimedia\Parsoid\Ext\ExtensionTagHandler;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

class LinterTag extends ExtensionTagHandler implements ExtensionModule {
	/** @inheritDoc */
	public function sourceToDom(
		ParsoidExtensionAPI $extApi, string $content, array $args
	): DocumentFragment {
		$documentFragment = $extApi->extTagToDOM( $args, $content, [
			'wrapperTag' => 'div',
		] );
		$doc = $documentFragment->ownerDocument;
		$linterTag = $doc->createElement( 'div' );
		// <center> is an obsolete tag
		$center = $doc->createElement( 'center' );
		$center->appendChild( $doc->createTextNode( 'ccc' ) );
		$linterTag->appendChild( $center );
		$linterTag->appendChild( $documentFragment->firstChild );
		// Now we have <div><center>...</center><div>...</div></div> in $linterTag
		$documentFragment->appendChild( $linterTag );
		return $documentFragment;
	}

	/** @inheritDoc */
	public function lintHandler(
		ParsoidExtensionAPI $extApi, Element $linterTag, callable $defaultHandler
	): bool {
		// We don't want to lint <center> from above
		$wrapperTag = $linterTag->firstChild->nextSibling;
		$defaultHandler( $wrapperTag );
		return true;
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'name' => 'LinterTag',
			'tags' => [
				[ 'name' => 'linter', 'handler' => self::class ],
			],
		];
	}
}
