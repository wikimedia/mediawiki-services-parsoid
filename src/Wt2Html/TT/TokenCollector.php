<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\TokenHandler as TokenHandler;

$lastItem = require '../../utils/jsutils.js'::JSUtils::lastItem;
$temp0 = require '../../tokens/TokenTypes.js';
$TagTk = $temp0::TagTk;
$EndTagTk = $temp0::EndTagTk;
$SelfclosingTagTk = $temp0::SelfclosingTagTk;
$EOFTk = $temp0::EOFTk;

/**
 * Small utility class that encapsulates the common 'collect all tokens
 * starting from a token of type x until token of type y or (optionally) the
 * end-of-input'. Only supported for synchronous in-order transformation
 * stages (SyncTokenTransformManager), as async out-of-order expansions
 * would wreak havoc with this kind of collector.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class TokenCollector extends TokenHandler {
	public function __construct( $manager, $options ) {
		parent::__construct( $manager, $options );
		$this->onAnyEnabled = false;
		$this->scopeStack = [];
	}
	public $onAnyEnabled;
	public $scopeStack;

	public function onTag( $token ) {
		return ( $token->name === $this::NAME() ) ? $this->_onDelimiterToken( $token ) : $token;
	}

	public function onEnd( $token ) {
		return ( $this->onAnyEnabled ) ? $this->_onDelimiterToken( $token ) : $token;
	}

	public function onAny( $token ) {
		return $this->_onAnyToken( $token );
	}

	// Token type to register for ('tag', 'text' etc)
	public function TYPE() {
 throw new Error( 'Not implemented' );
 }
	// (optional, only for token type 'tag'): tag name.
	public function NAME() {
 throw new Error( 'Not implemented' );
 }
	// Match the 'end' tokens as closing tag as well (accept unclosed sections).
	public function TOEND() {
 throw new Error( 'Not implemented' );
 }
	// FIXME: Document this!?
	public function ACKEND() {
 throw new Error( 'Not implemented' );
 }

	// Transform function
	public function transformation() {
		Assert::invariant( false, 'Transformation not implemented!' );
	}

	/**
	 * Handle the delimiter token.
	 * XXX: Adjust to sync phase callback when that is modified!
	 * @private
	 */
	public function _onDelimiterToken( $token ) {
		$haveOpenTag = count( $this->scopeStack ) > 0;
		$tc = $token->constructor;
		if ( $tc === $TagTk ) {
			if ( count( $this->scopeStack ) === 0 ) {
				$this->onAnyEnabled = true;
				// Set up transforms
				$this->manager->env->log( 'debug', 'starting collection on ', $token );
			}

			// Push a new scope
			$newScope = [];
			$this->scopeStack[] = $newScope;
			$newScope[] = $token;

			return [];
		} elseif ( $tc === $SelfclosingTagTk ) {
			// We need to handle <ref /> for example, so call the handler.
			return $this->transformation( [ $token, $token ] );
		} elseif ( $haveOpenTag ) {
			// EOFTk or EndTagTk
			$this->manager->env->log( 'debug', 'finishing collection on ', $token );

			// Pop top scope and push token onto it
			$activeTokens = array_pop( $this->scopeStack );
			$activeTokens[] = $token;

			// clean up
			if ( count( $this->scopeStack ) === 0 || $token->constructor === $EOFTk ) {
				$this->onAnyEnabled = false;
			}

			if ( $tc === $EndTagTk ) {
				// Transformation can be either sync or async, but receives all collected
				// tokens instead of a single token.
				return $this->transformation( $activeTokens );
				// XXX sync version: return tokens
			} else {
				// EOF -- collapse stack!
				$allToks = [];
				for ( $i = 0,  $n = count( $this->scopeStack );  $i < $n;  $i++ ) {
					$allToks = $allToks->concat( $this->scopeStack[ $i ] );
				}
				$allToks = $allToks->concat( $activeTokens );

				$res = ( $this::TOEND() ) ? $this->transformation( $allToks ) : [ 'tokens' => $allToks ];
				if ( $res->tokens && count( $res->tokens )
&& $lastItem( $res->tokens )->constructor !== $EOFTk
				) {
					$this->manager->env->log( 'error', $this::NAME(), 'handler dropped the EOFTk!' );

					// preserve the EOFTk
					$res->tokens[] = $token;
				}

				return $res;
			}
		} else {
			// EndTagTk should be the only one that can reach here.
			Assert::invariant( $token->constructor === $EndTagTk, 'Expected an end tag.' );
			if ( $this::ACKEND() ) {
				return $this->transformation( [ $token ] );
			} else {
				// An unbalanced end tag. Ignore it.
				return [ 'tokens' => [ $token ] ];
			}
		}
	}

	/**
	 * Handle 'any' token in between delimiter tokens. Activated when
	 * encountering the delimiter token, and collects all tokens until the end
	 * token is reached.
	 * @private
	 */
	public function _onAnyToken( $token ) {
		// Simply collect anything ordinary in between
		lastItem( $this->scopeStack )[] = $token;
		return [];
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->TokenCollector = $TokenCollector;
}
