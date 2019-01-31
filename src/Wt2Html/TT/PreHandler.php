<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\TokenUtils as TokenUtils;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\WTUtils as WTUtils;
use Parsoid\TagTk as TagTk;
use Parsoid\EndTagTk as EndTagTk;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;
use Parsoid\NlTk as NlTk;
use Parsoid\EOFTk as EOFTk;
use Parsoid\CommentTk as CommentTk;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class PreHandler extends TokenHandler {
	// FSM states
	public static function STATE_SOL() {
 return 1;
 }
	public static function STATE_PRE() {
 return 2;
 }
	public static function STATE_PRE_COLLECT() {
 return 3;
 }
	public static function STATE_MULTILINE_PRE() {
 return 4;
 }
	public static function STATE_IGNORE() {
 return 5;
 }

	// debug string output of FSM states
	public static function STATE_STR() {
		return [
			1 => 'sol        ',
			2 => 'pre        ',
			3 => 'pre_collect',
			4 => 'multiline  ',
			5 => 'ignore     '
		];
	}

	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->resetState();
	}

	// FIXME: Needed because of shared pipelines in parser tests
	public function resetState() {
		if ( $this->options->inlineContext || $this->options->inPHPBlock ) {
			$this->disabled = true;
		} else {
			$this->disabled = false;
			$this->reset( true );
		}
	}

	public function reset( $enableAnyHandler ) {
		$this->state = PreHandler\STATE_SOL();
		$this->lastNlTk = null;
		// Initialize to zero to deal with indent-pre
		// on the very first line where there is no
		// preceding newline to initialize this.
		$this->preTSR = 0;
		$this->tokens = [];
		$this->preCollectCurrentLine = [];
		$this->preWSToken = null;
		$this->multiLinePreWSToken = null;
		$this->solTransparentTokens = [];
		if ( $enableAnyHandler ) {
			$this->onAnyEnabled = true;
		}
	}

	public function moveToIgnoreState() {
		$this->onAnyEnabled = false;
		$this->state = PreHandler\STATE_IGNORE();
	}

	public function popLastNL( $ret ) {
		if ( $this->lastNlTk ) {
			$ret[] = $this->lastNlTk;
			$this->lastNlTk = null;
		}
	}

	public function resetPreCollectCurrentLine() {
		if ( count( $this->preCollectCurrentLine ) > 0 ) {
			$this->tokens = $this->tokens->concat( $this->preCollectCurrentLine );
			$this->preCollectCurrentLine = [];
			// Since the multi-line pre materialized, the multilinee-pre-ws token
			// should be discarded so that it is not emitted after <pre>..</pre>
			// is generated (see processPre).
			$this->multiLinePreWSToken = null;
		}
	}

	public function encounteredBlockWhileCollecting( $token ) {
		$env = $this->manager->env;
		$ret = [];
		$mlp = null;

		// we remove any possible multiline ws token here and save it because
		// otherwise the propressPre below would add it in the wrong place
		if ( $this->multiLinePreWSToken ) {
			$mlp = $this->multiLinePreWSToken;
			$this->multiLinePreWSToken = null;
		}

		if ( count( $this->tokens ) > 0 ) {
			$i = count( $this->tokens ) - 1;
			while ( $i > 0 && TokenUtils::isSolTransparent( $env, $this->tokens[ $i ] ) ) { $i--;
   }
			$solToks = array_splice( $this->tokens, ( $i ) );
			$this->lastNlTk = array_shift( $solToks );
			Assert::invariant( $this->lastNlTk && $this->lastNlTk->constructor === NlTk::class );
			$ret = $this->processPre( null )->concat( $solToks );
		}

		if ( $this->preWSToken || $mlp ) {
			$ret[] = $this->preWSToken || $mlp;
			$this->preWSToken = null;
		}

		$this->resetPreCollectCurrentLine();
		$ret = $ret->concat( $this->getResultAndReset( $token ) );
		return $ret;
	}

	public function getResultAndReset( $token ) {
		$this->popLastNL( $this->tokens );

		$ret = $this->tokens;
		if ( $this->preWSToken ) {
			$ret[] = $this->preWSToken;
			$this->preWSToken = null;
		}
		if ( count( $this->solTransparentTokens ) > 0 ) {
			$ret = $ret->concat( $this->solTransparentTokens );
			$this->solTransparentTokens = [];
		}
		$ret[] = $token;
		$this->tokens = [];
		$this->multiLinePreWSToken = null;

		return $ret;
	}

	public function processPre( $token ) {
		$ret = [];

		// pre only if we have tokens to enclose
		if ( count( $this->tokens ) > 0 ) {
			$da = null;
			if ( $this->preTSR !== -1 ) {
				$da = [ 'tsr' => [ $this->preTSR, $this->preTSR + 1 ] ];
			}
			$ret = [ new TagTk( 'pre', [], $da ) ]->concat( $this->tokens, new EndTagTk( 'pre' ) );
		}

		// emit multiline-pre WS token
		if ( $this->multiLinePreWSToken ) {
			$ret[] = $this->multiLinePreWSToken;
			$this->multiLinePreWSToken = null;
		}
		$this->popLastNL( $ret );

		// sol-transparent toks
		$ret = $ret->concat( $this->solTransparentTokens );

		// push the the current token
		if ( $token !== null ) {
			$ret[] = $token;
		}

		// reset!
		$this->solTransparentTokens = [];
		$this->tokens = [];

		return $ret;
	}

	public function onNewline( $token ) {
		$env = $this->manager->env;

		function initPreTSR( $nltk ) {
			$da = $nltk->dataAttribs;
			// tsr[1] can never be zero, so safe to use da.tsr[1] to check for null/undefined
			return ( $da && $da->tsr && $da->tsr[ 1 ] ) ? $da->tsr[ 1 ] : -1;
		}

		$env->log( 'trace/pre', $this->manager->pipelineId, 'NL    |',
			PreHandler\STATE_STR()[ $this->state ], '|', function () { return json_encode( $token );
   }
		);

		// Whenever we move into SOL-state, init preTSR to
		// the newline's tsr[1].  This will later be  used
		// to assign 'tsr' values to the <pre> token.

		$ret = [];
		// See TokenHandler's documentation for the onAny handler
		// for what this flag is about.
		$skipOnAny = false;
		switch ( $this->state ) {
			case PreHandler\STATE_SOL():
			$ret = $this->getResultAndReset( $token );
			$skipOnAny = true;
			$this->preTSR = initPreTSR( $token );
			break;

			case PreHandler\STATE_PRE():
			$ret = $this->getResultAndReset( $token );
			$skipOnAny = true;
			$this->preTSR = initPreTSR( $token );
			$this->state = PreHandler\STATE_SOL();
			break;

			case PreHandler\STATE_PRE_COLLECT():
			$this->resetPreCollectCurrentLine();
			$this->lastNlTk = $token;
			$this->state = PreHandler\STATE_MULTILINE_PRE();
			break;

			case PreHandler\STATE_MULTILINE_PRE():
			$this->preWSToken = null;
			$this->multiLinePreWSToken = null;
			$ret = $this->processPre( $token );
			$skipOnAny = true;
			$this->preTSR = initPreTSR( $token );
			$this->state = PreHandler\STATE_SOL();
			break;

			case PreHandler\STATE_IGNORE():
			$ret = [ $token ];
			$skipOnAny = true;
			$this->reset( true );
			$this->preTSR = initPreTSR( $token );
			break;
		}

		$env->log( 'debug/pre', $this->manager->pipelineId, 'saved :', $this->tokens );
		$env->log( 'debug/pre', $this->manager->pipelineId, '---->  ',
			function () { return json_encode( $ret );
   }
		);

		return [ 'tokens' => $ret, 'skipOnAny' => $skipOnAny ];
	}

	public function onEnd( $token ) {
		if ( !$this->onAnyEnabled ) {
			return $token;
		}

		$this->manager->env->log( 'trace/pre', $this->manager->pipelineId, 'eof   |',
			PreHandler\STATE_STR()[ $this->state ], '|', function () { return json_encode( $token );
   }
		);

		$ret = [];
		$skipOnAny = false;
		switch ( $this->state ) {
			case PreHandler\STATE_SOL():

			case PreHandler\STATE_PRE():
			$ret = $this->getResultAndReset( $token );
			$skipOnAny = true;
			break;

			case PreHandler\STATE_PRE_COLLECT():

			case PreHandler\STATE_MULTILINE_PRE():
			$this->preWSToken = null;
			$this->multiLinePreWSToken = null;
			$this->resetPreCollectCurrentLine();
			$ret = $this->processPre( $token );
			$skipOnAny = true;
			break;
		}

		// reset for next use of this pipeline!
		$this->reset( true );

		$this->manager->env->log( 'debug/pre', $this->manager->pipelineId, 'saved :', $this->tokens );
		$this->manager->env->log( 'debug/pre', $this->manager->pipelineId, '---->  ',
			function () { return json_encode( $ret );
   }
		);

		return [ 'tokens' => $ret, 'skipOnAny' => $skipOnAny ];
	}

	public function onSyncTTMEnd( $token ) {
		if ( $this->state !== PreHandler\STATE_IGNORE() ) {
			$this->manager->env->log( 'error', 'Not IGNORE! Cannot get here:',
				$this->state, ';', json_encode( $token )
			);
			$this->reset( false );
			return [ 'tokens' => [ $token ] ];
		}

		$this->reset( true );
		return [ 'tokens' => [ $token ] ];
	}

	public function getUpdatedPreTSR( $tsr, $token ) {
		$tc = $token->constructor;
		if ( $tc === CommentTk::class ) {
			// comment length has 7 added for "<!--" and "-->" deliminters
			// (see WTUtils.decodedCommentLength() -- but that takes a node not a token)
			$tsr = ( $token->dataAttribs->tsr ) ? $token->dataAttribs->tsr[ 1 ] : ( ( $tsr === -1 ) ? -1 : count( WTUtils::decodeComment( $token->value ) ) + 7 + $tsr );
		} elseif ( $tc === SelfclosingTagTk::class ) {
			// meta-tag (cannot compute)
			$tsr = -1;
		} elseif ( $tsr !== -1 ) {
			// string
			$tsr += count( $token );
		}
		return $tsr;
	}

	public function onAny( $token ) {
		$env = $this->manager->env;

		$env->log( 'trace/pre', $this->manager->pipelineId, 'any   |', $this->state, ':',
			PreHandler\STATE_STR()[ $this->state ], '|', function () { return json_encode( $token );
   }
		);

		if ( $this->state === PreHandler\STATE_IGNORE() ) {
			$env->log( 'error', function () {
					return '!ERROR! IGNORE! Cannot get here: ' . json_encode( $token );
			}
			);
			return $token;
		}

		$skipOnAny = false;
		$ret = [];
		$tc = $token->constructor;
		if ( $tc === EOFTk::class ) {
			switch ( $this->state ) {
				case PreHandler\STATE_SOL():

				case PreHandler\STATE_PRE():
				$ret = $this->getResultAndReset( $token );
				$skipOnAny = true;
				break;

				case PreHandler\STATE_PRE_COLLECT():

				case PreHandler\STATE_MULTILINE_PRE():
				$this->preWSToken = null;
				$this->multiLinePreWSToken = null;
				$this->resetPreCollectCurrentLine();
				$ret = $this->processPre( $token );
				$skipOnAny = true;
				break;
			}

			// reset for next use of this pipeline!
			$this->reset( false );
		} else {
			switch ( $this->state ) {
				case PreHandler\STATE_SOL():
				if ( ( $tc === $String ) && preg_match( '/^ /', $token ) ) {
					$ret = $this->tokens;
					$this->tokens = [];
					$this->preWSToken = $token[ 0 ];
					$this->state = PreHandler\STATE_PRE();
					if ( !preg_match( '/^ $/', $token ) ) {
						// Treat everything after the first space
						// as a new token
						$this->onAny( array_slice( $token, 1 ) );
					}
				} elseif ( TokenUtils::isSolTransparent( $env, $token ) ) {
					// continue watching ...
					// update pre-tsr since we haven't transitioned to PRE yet
					$this->preTSR = $this->getUpdatedPreTSR( $this->preTSR, $token );
					$this->tokens[] = $token;
				} else {
					$ret = $this->getResultAndReset( $token );
					$skipOnAny = true;
					$this->moveToIgnoreState();
				}
				break;

				case PreHandler\STATE_PRE():
				if ( TokenUtils::isSolTransparent( $env, $token ) ) { // continue watching
					$this->solTransparentTokens[] = $token;
				} elseif ( TokenUtils::isTableTag( $token )
|| ( TokenUtils::isHTMLTag( $token ) && TokenUtils::isBlockTag( $token->name ) )
				) {
					$ret = $this->getResultAndReset( $token );
					$skipOnAny = true;
					$this->moveToIgnoreState();
				} else {
					$this->preCollectCurrentLine = $this->solTransparentTokens->concat( $token );
					$this->solTransparentTokens = [];
					$this->state = PreHandler\STATE_PRE_COLLECT();
				}
				break;

				case PreHandler\STATE_PRE_COLLECT():
				if ( $token->name && TokenUtils::isBlockTag( $token->name ) ) {
					$ret = $this->encounteredBlockWhileCollecting( $token );
					$skipOnAny = true;
					$this->moveToIgnoreState();
				} else {
					// nothing to do .. keep collecting!
					$this->preCollectCurrentLine[] = $token;
				}
				break;

				case PreHandler\STATE_MULTILINE_PRE():
				if ( ( $tc === $String ) && preg_match( '/^ /', $token ) ) {
					$this->popLastNL( $this->tokens );
					$this->state = PreHandler\STATE_PRE_COLLECT();
					$this->preWSToken = null;

					// Pop buffered sol-transparent tokens
					$this->tokens = $this->tokens->concat( $this->solTransparentTokens );
					$this->solTransparentTokens = [];

					// check if token is single-space or more
					$this->multiLinePreWSToken = $token[ 0 ];
					if ( !preg_match( '/^ $/', $token ) ) {
						// Treat everything after the first space as a new token
						$this->onAny( array_slice( $token, 1 ) );
					}
				} elseif ( TokenUtils::isSolTransparent( $env, $token ) ) { // continue watching
					$this->solTransparentTokens[] = $token;
				} else {
					$ret = $this->processPre( $token );
					$skipOnAny = true;
					$this->moveToIgnoreState();
				}
				break;
			}
		}

		$env->log( 'debug/pre', $this->manager->pipelineId, 'saved :', $this->tokens );
		$env->log( 'debug/pre', $this->manager->pipelineId, '---->  ',
			function () { return json_encode( $ret );
   }
		);

		return [ 'tokens' => $ret, 'skipOnAny' => $skipOnAny ];
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->PreHandler = $PreHandler;
}
