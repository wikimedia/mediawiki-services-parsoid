<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\LST;

use DOMElement;
use Wikimedia\Parsoid\Ext\Extension;
use Wikimedia\Parsoid\Ext\ExtensionTag;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;

class LST extends ExtensionTag implements Extension {

	/** @inheritDoc */
	public function fromDOM(
		ParsoidExtensionAPI $extApi, DOMElement $node, bool $wrapperUnmodified
	) {
		// TODO: We're keeping this serial handler around to remain backwards
		// compatible with stored content version 1.3.0 and below.  Remove it
		// when those versions are no longer supported.

		$typeOf = $node->getAttribute( 'typeof' ) ?? '';
		$dp = DOMDataUtils::getDataParsoid( $node );
		$src = null;
		if ( isset( $dp->src ) ) {
			$src = $dp->src;
		} elseif ( preg_match( '/begin/', $typeOf ) ) {
			$src = '<section begin="' . $node->getAttribute( 'content' ) . '" />';
		} elseif ( preg_match( '/end/', $typeOf ) ) {
			$src = '<section end="' . $node->getAttribute( 'content' ) . '" />';
		} else {
			$extApi->log( 'error', 'LST <section> without content in: ' .
				DOMCompat::getOuterHTML( $node ) );
			$src = '<section />';
		}
		return $src;
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[
					'name' => 'labeledsectiontransclusion',
					'class' => self::class
				],
				[
					'name' => 'labeledsectiontransclusion/begin',
					'class' => self::class
				],
				[
					'name' => 'labeledsectiontransclusion/end',
					'class' => self::class
				]
			]
		];
	}

}
