<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;

/**
 * These handlers process wikitext tags that are not dependent
 * on line semantics. They can be processed independent of the
 * token stream for the most part.
 *
 * Ex: templates, extensions, links
 *
 * They only need to support onTag handlers.
 */
abstract class XMLTagBasedHandler extends TokenHandler {
	/**
	 * The handler may choose to process only specific kinds of XMLTagTk tokens.
	 * For example, a list handler may only process 'listitem' TagTk tokens.
	 *
	 * @param XMLTagTk $token tag to be processed
	 * @return ?array<string|Token>
	 *   - null indicates that the token was unmodified and the
	 *     token will be added to the output.
	 *   - an array indicates the token was transformed and the
	 *     tokens in the array will be added to the output.
	 */
	public function onTag( XMLTagTk $token ): ?array {
		return null;
	}

	/** @inheritDoc */
	public function process( array $tokens ): array {
		$accum = [];
		foreach ( $tokens as $token ) {
			$res = null;
			if ( $token instanceof XMLTagTk ) {
				$res = $this->onTag( $token );
			} elseif ( $token instanceof CompoundTk ) {
				$res = $this->onCompoundTk( $token, $this );
			}

			if ( $res === null ) {
				$accum[] = $token;
			} else {
				// Avoid array_merge() -- see https://w.wiki/3zvE
				foreach ( $res as $t ) {
					$accum[] = $t;
				}
			}
		}

		return $accum;
	}
}
