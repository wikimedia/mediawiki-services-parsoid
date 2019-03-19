<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Simple noinclude / onlyinclude implementation. Strips all tokens in
 * noinclude sections.
 * @module
 */

namespace Parsoid;

use Parsoid\TokenHandler as TokenHandler;
use Parsoid\TokenCollector as TokenCollector;
use Parsoid\KV as KV;
use Parsoid\TagTk as TagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\EOFTk as EOFTk;

/**
 * This helper function will build a meta token in the right way for these
 * tags.
 */
$buildMetaToken = function ( $manager, $tokenName, $isEnd, $tsr, $src ) use ( &$SelfclosingTagTk, &$KV ) {
	if ( $isEnd ) {
		$tokenName += '/End';
	}

	return new SelfclosingTagTk( 'meta',
		[ new KV( 'typeof', $tokenName ) ],
		( $tsr ) ? [ 'tsr' => $tsr, 'src' => substr( $manager->env->page->src, $tsr[ 0 ], $tsr[ 1 ]/*CHECK THIS*/ ) ] : [ 'src' => $src ]
	);
};

$buildStrippedMetaToken = function ( $manager, $tokenName, $startDelim, $endDelim ) use ( &$buildMetaToken ) {
	$da = $startDelim->dataAttribs;
	$tsr0 = ( $da ) ? $da->tsr : null;
	$t0 = ( $tsr0 ) ? $tsr0[ 0 ] : null;
	$t1 = null;

	if ( $endDelim ) {
		$da = ( $endDelim ) ? $endDelim->dataAttribs : null;
		$tsr1 = ( $da ) ? $da->tsr : null;
		$t1 = ( $tsr1 ) ? $tsr1[ 1 ] : null;
	} else {
		$t1 = count( $manager->env->page->src );
	}

	return $buildMetaToken( $manager, $tokenName, false, [ $t0, $t1 ] );
};

/**
 * OnlyInclude sadly forces synchronous template processing, as it needs to
 * hold onto all tokens in case an onlyinclude block is encountered later.
 * This can fortunately be worked around by caching the tokens after
 * onlyinclude processing (which is a good idea anyway).
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class OnlyInclude extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		if ( $this->options->isInclude ) {
			$this->accum = [];
			$this->inOnlyInclude = false;
			$this->foundOnlyInclude = false;
		}
	}
	public $accum;
	public $inOnlyInclude;
	public $foundOnlyInclude;

	public function onAny( $token ) {
		return ( $this->options->isInclude ) ? $this->onAnyInclude( $token ) : $token;
	}

	public function onTag( $token ) {
		return ( !$this->options->isInclude && $token->name === 'onlyinclude' ) ? $this->onOnlyInclude( $token ) : $token;
	}

	public function onOnlyInclude( $token ) {
		$tsr = $token->dataAttribs->tsr;
		$src = ( !$this->options->inTemplate ) ? $token->getWTSource( $this->manager->env ) : null;
		$attribs = [
			new KV( 'typeof', 'mw:Includes/OnlyInclude' . ( ( $token instanceof EndTagTk::class ) ? '/End' : '' ) )
		];
		$meta = new SelfclosingTagTk( 'meta', $attribs, [ 'tsr' => $tsr, 'src' => $src ] );
		return [ 'tokens' => [ $meta ] ];
	}

	public function onAnyInclude( $token ) {
		$tagName = null;
$isTag = null;
$meta = null;

		if ( $token->constructor === EOFTk::class ) {
			$this->inOnlyInclude = false;
			if ( count( $this->accum ) && !$this->foundOnlyInclude ) {
				$res = $this->accum;
				$res[] = $token;
				$this->accum = [];
				return [ 'tokens' => $res ];
			} else {
				$this->foundOnlyInclude = false;
				$this->accum = [];
				return [ 'tokens' => [ $token ] ];
			}
		}

		$isTag = $token->constructor === TagTk::class
|| $token->constructor === EndTagTk::class
|| $token->constructor === SelfclosingTagTk::class;

		if ( $isTag ) {
			switch ( $token->name ) {
				case 'onlyinclude':
				$tagName = 'mw:Includes/OnlyInclude';
				break;
				case 'includeonly':
				$tagName = 'mw:Includes/IncludeOnly';
				break;
				case 'noinclude':
				$tagName = 'mw:Includes/NoInclude';
			}
		}

		$mgr = $this->manager;
		$curriedBuildMetaToken = function ( $isEnd, $tsr, $src ) use ( &$buildMetaToken, &$mgr, &$tagName ) {
			return $buildMetaToken( $mgr, $tagName, $isEnd, $tsr, $src );
		};

		if ( $isTag && $token->name === 'onlyinclude' ) {
			if ( !$this->inOnlyInclude ) {
				$this->foundOnlyInclude = true;
				$this->inOnlyInclude = true;
				// wrap collected tokens into meta tag for round-tripping
				$meta = $curriedBuildMetaToken( $token->constructor === EndTagTk::class, ( $token->dataAttribs || [] )->tsr );
				return $meta;
			} else {
				$this->inOnlyInclude = false;
				$meta = $curriedBuildMetaToken( $token->constructor === EndTagTk::class, ( $token->dataAttribs || [] )->tsr );
			}
			return [ 'tokens' => [ $meta ] ];
		} else {
			if ( $this->inOnlyInclude ) {
				return [ 'tokens' => [ $token ] ];
			} else {
				$this->accum[] = $token;
				return [];
			}
		}
	}
}

/**
 * @class
 * @extends module:wt2html/tt/TokenCollector~TokenCollector
 */
class NoInclude extends TokenCollector {
	public function TYPE() {
 return 'tag';
 }
	public function NAME() {
 return 'noinclude';
 }
	public function TOEND() {
 return true;
 }// Match the end-of-input if </noinclude> is missing.
	public function ACKEND() {
 return true;
 }

	public function transformation( $collection ) {
		$start = array_shift( $collection );

		// A stray end tag.
		if ( $start->constructor === EndTagTk::class ) {
			$meta = $buildMetaToken( $this->manager, 'mw:Includes/NoInclude', true,
				( $start->dataAttribs || [] )->tsr
			);
			return [ 'tokens' => [ $meta ] ];
		}

		// Handle self-closing tag case specially!
		if ( $start->constructor === SelfclosingTagTk::class ) {
			return ( $this->options->isInclude ) ?
			[ 'tokens' => [] ] :
			[ 'tokens' => [ $buildMetaToken( $this->manager, 'mw:Includes/NoInclude', false, ( $start->dataAttribs || [] )->tsr ) ] ];
		}

		$tokens = [];
		$end = array_pop( $collection );
		$eof = $end->constructor === EOFTk::class;

		if ( !$this->options->isInclude ) {
			// Content is preserved
			// Add meta tags for open and close
			$manager = $this->manager;
			$curriedBuildMetaToken = function ( $isEnd, $tsr, $src ) use ( &$buildMetaToken, &$manager ) {
				return $buildMetaToken( $manager, 'mw:Includes/NoInclude', $isEnd, $tsr, $src );
			};
			$startTSR = $start && $start->dataAttribs && $start->dataAttribs->tsr;
			$endTSR = $end && $end->dataAttribs && $end->dataAttribs->tsr;
			$tokens[] = curriedBuildMetaToken( false, $startTSR );
			$tokens = $tokens->concat( $collection );
			if ( $end && !$eof ) {
				$tokens[] = curriedBuildMetaToken( true, $endTSR );
			}
		} elseif ( !$this->options->inTemplate ) {
			// Content is stripped
			$tokens[] = buildStrippedMetaToken( $this->manager,
				'mw:Includes/NoInclude', $start, $end
			);
		}

		// Preserve EOF
		if ( $eof ) {
			$tokens[] = $end;
		}

		return [ 'tokens' => $tokens ];
	}
}

/**
 * @class
 * @extends module:wt2html/tt/TokenCollector~TokenCollector
 */
class IncludeOnly extends TokenCollector {
	public function TYPE() {
 return 'tag';
 }
	public function NAME() {
 return 'includeonly';
 }
	public function TOEND() {
 return true;
 }// Match the end-of-input if </includeonly> is missing.
	public function ACKEND() {
 return false;
 }

	public function transformation( $collection ) {
		$start = array_shift( $collection );

		// Handle self-closing tag case specially!
		if ( $start->constructor === SelfclosingTagTk::class ) {
			$token = $buildMetaToken( $this->manager, 'mw:Includes/IncludeOnly', false, ( $start->dataAttribs || [] )->tsr );
			if ( $start->dataAttribs->src ) {
				$datamw = json_encode( [ 'src' => $start->dataAttribs->src ] );
				$token->addAttribute( 'data-mw', $datamw );
			}
			return ( $this->options->isInclude ) ?
			[ 'tokens' => [] ] :
			[ 'tokens' => [ $token ] ];
		}

		$tokens = [];
		$end = array_pop( $collection );
		$eof = $end->constructor === EOFTk::class;

		if ( $this->options->isInclude ) {
			// Just pass through the full collection including delimiters
			$tokens = $tokens->concat( $collection );
		} elseif ( !$this->options->inTemplate ) {
			// Content is stripped
			// Add meta tags for open and close for roundtripping.
			//
			// We can make do entirely with a single meta-tag since
			// there is no real content.  However, we add a dummy end meta-tag
			// so that all <*include*> meta tags show up in open/close pairs
			// and can be handled similarly by downstream handlers.
			$name = 'mw:Includes/IncludeOnly';
			$tokens[] = buildStrippedMetaToken( $this->manager, $name, $start, ( $eof ) ? null : $end );

			if ( $start->dataAttribs->src ) {
				$dataMw = json_encode( [ 'src' => $start->dataAttribs->src ] );
				$tokens[ 0 ]->addAttribute( 'data-mw', $dataMw );
			}

			if ( $end && !$eof ) {
				// This token is just a placeholder for RT purposes. Since the
				// stripped token (above) got the entire tsr value, we are artificially
				// setting the tsr on this node to zero-width to ensure that
				// DSR computation comes out correct.
				$tsr = ( $end->dataAttribs || [ 'tsr' => [ null, null ] ] )->tsr;
				$tokens[] = buildMetaToken( $this->manager, $name, true, [ $tsr[ 1 ], $tsr[ 1 ] ], '' );
			}
		}

		// Preserve EOF
		if ( $eof ) {
			$tokens[] = $end;
		}

		return [ 'tokens' => $tokens ];
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->NoInclude = $NoInclude;
	$module->exports->IncludeOnly = $IncludeOnly;
	$module->exports->OnlyInclude = $OnlyInclude;
}
