<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\LST;

use DOMElement;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;

class LST extends ExtensionTag implements Extension {

	/** @inheritDoc */
	public function fromHTML( DOMElement $node, SerializerState $state,
							  bool $wrapperUnmodified ): string {
		// TODO: We're keeping this serial handler around to remain backwards
		// compatible with stored content version 1.3.0 and below.  Remove it
		// when those versions are no longer supported.

		$env = $state->getEnv();
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
			$env->log( 'error', 'LST <section> without content in: ' .
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
