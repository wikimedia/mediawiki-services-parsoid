<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\JSUtils as JSUtils;
use Parsoid\Util as Util;

use Parsoid\DOMHandler as DOMHandler;

class PreHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		// Handle indent pre

		// XXX: Use a pre escaper?
		$content = /* await */ $state->serializeIndentPreChildrenToString( $node );
		// Strip (only the) trailing newline
		$trailingNL = preg_match( '/\n$/', $content );
		$content = preg_replace( '/\n$/', '', $content, 1 );

		// Insert indentation
		$solRE = JSUtils::rejoin(
			'(\n(',
			// SSS FIXME: What happened to the includeonly seen
			// in wts.separators.js?
			Util\COMMENT_REGEXP,
			')*)',
			[ 'flags' => 'g' ]
		);
		$content = ' ' . str_replace( $solRE, '$1 ', $content );

		// But skip "empty lines" (lines with 1+ comment and
		// optional whitespace) since empty-lines sail through all
		// handlers without being affected.
		//
		// See empty_line_with_comments rule in pegTokenizer.pegjs
		//
		// We could use 'split' to split content into lines and
		// selectively add indentation, but the code will get
		// unnecessarily complex for questionable benefits. So, going
		// this route for now.
		$emptyLinesRE = JSUtils::rejoin(
			// This space comes from what we inserted earlier
			/* RegExp */ '/(^|\n) /',
			'((?:',
			/* RegExp */ '/[ \t]*/',
			Util\COMMENT_REGEXP,
			/* RegExp */ '/[ \t]*/',
			')+)',
			/* RegExp */ '/(?=\n|$)/'
		);
		$content = str_replace( $emptyLinesRE, '$1$2', $content );

		$state->emitChunk( $content, $node );

		// Preserve separator source
		$state->appendSep( ( $trailingNL && $trailingNL[ 0 ] ) || '' );
	}
	public function before( $node, $otherNode ) {
		if ( $otherNode->nodeName === 'PRE'
&& DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html'
		) {
			return [ 'min' => 2 ];
		} else {
			return [ 'min' => 1 ];
		}
	}
	public function after( $node, $otherNode ) {
		if ( $otherNode->nodeName === 'PRE'
&& DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html'
		) {
			return [ 'min' => 2 ];
		} else {
			return [ 'min' => 1 ];
		}
	}
	public function firstChild() {
		return [];
	}
	public function lastChild() {
		return [];
	}
}

$module->exports = $PreHandler;
