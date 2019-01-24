<?php
/** @module */

namespace Parsoid\Wt2html\TT;

/**
 * @class
 */
class TokenHandler {
	/**
	 * @param TokenTransformManager $manager The manager for this stage of the parse.
	 * @param Object $options Any options for the expander.
	 */
	public function __construct( $manager, $options ) {
		$this->manager = $manager;
		$this->env = $manager->env;
		$this->options = [ $options ];
		$this->atTopLevel = false;

		// This is set if the token handler is disabled for the entire pipeline.
		$this->switchedOff = false;

		// This is set/reset by the token handlers at various points
		// in the token stream based on what is encountered.
		// This only enables/disables the onAny handler.
		$this->active = true;
	}

	/**
	 * This handler is called for EOF tokens only
	 * @param token $token EOF token to be processed
	 * @return object
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	public function onEnd( $token ) {
		return $token;
	}

	/**
	 * This handler is called for newline tokens only
	 * @param token $token Newline token to be processed
	 * @return object
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	public function onNewline( $token ) {
		return $token;
	}

	/**
	 * This handler is called for tokens that are not EOFTk or NLTk tokens.
	 * The handler may choose to process only specific kinds of tokens.
	 * For example, a list handler may only process 'listitem' TagTk tokens.
	 *
	 * @param token $token Token to be processed
	 * @return object
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 *    if 'skip' is set, onAny handler is skipped
	 */
	public function onTag( $token ) {
		return $token;
	}

	/**
	 * This handler is called for *all* tokens in the token stream except if
	 * (a) The more specific handlers above modified the token
	 * (b) the more specific handlers (onTag, onEnd, onNewline) have set
	 *     the skip flag in their return values.
	 * (c) this handlers 'active' flag is set to false (can be set by any
	 *     of the handlers).
	 *
	 * @param token $token Token to be processed
	 * @return object
	 *    return value can be one of 'token'
	 *    or { tokens: [..] }
	 *    or { tokens: [..], skip: .. }
	 */
	public function onAny( $token ) {
		return $token;
	}

	/**
	 * Resets the state based on parameter
	 *
	 * @param object $opts Any options for the expander.
	 */
	public function resetState( $opts ) {
		$this->atTopLevel = $opts && $opts->toplevel;
	}
}
