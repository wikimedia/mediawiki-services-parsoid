<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

class CaptionHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$dp = DOMDataUtils::getDataParsoid( $node );
		// Serialize the tag itself
		$tableTag = /* await */ $this->serializeTableTag(
			$dp->startTagSrc || '|+', null, $state, $node,
			$wrapperUnmodified
		);
		WTSUtils::emitStartTag( $tableTag, $node, $state );
		/* await */ $state->serializeChildren( $node );
	}
	public function before( $node, $otherNode ) {
		return ( $otherNode->nodeName !== 'TABLE' ) ?
		[ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ] :
		[ 'min' => 0, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
	}
	public function after( $node, $otherNode ) {
		return [ 'min' => 1, 'max' => $this->maxNLsInTable( $node, $otherNode ) ];
	}
}

$module->exports = $CaptionHandler;
