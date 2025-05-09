<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;

/**
 * OnlyInclude sadly forces synchronous template processing, as it needs to
 * hold onto all tokens in case an onlyinclude block is encountered later.
 * This can fortunately be worked around by caching the tokens after
 * onlyinclude processing (which is a good idea anyway).
 */
class OnlyInclude extends UniversalTokenHandler {
	/** @var array */
	private $accum = [];

	/** @var bool */
	private $inOnlyInclude = false;

	/** @var bool */
	private $foundOnlyInclude = false;

	/**
	 * @inheritDoc
	 */
	public function onAny( $token ): ?array {
		$enabled = $this->options['inTemplate'] &&
			$this->env->nativeTemplateExpansionEnabled();
		return ( $enabled ) ? $this->onAnyInclude( $token ) : null;
	}

	/**
	 * @param Token|array $token
	 * @return ?array<string|Token>
	 */
	private function onAnyInclude( $token ): ?array {
		if ( $token instanceof EOFTk ) {
			$this->inOnlyInclude = false;
			if ( count( $this->accum ) && !$this->foundOnlyInclude ) {
				$res = $this->accum;
				$res[] = $token;
				$this->accum = [];
				return $res;
			} else {
				$this->foundOnlyInclude = false;
				$this->accum = [];
				return null;
			}
		}

		if ( $token instanceof XMLTagTk && $token->getName() === 'onlyinclude' ) {
			// FIXME: This doesn't seem to consider self-closing tags
			// or close really
			if ( !$this->inOnlyInclude ) {
				$this->foundOnlyInclude = true;
				$this->inOnlyInclude = true;
			} else {
				$this->inOnlyInclude = false;
			}

			$tagName = 'mw:Includes/OnlyInclude';
			if ( $token instanceof EndTagTk ) {
				$tagName .= '/End';
			}

			$dp = new DataParsoid;
			$dp->tsr = $token->dataParsoid->tsr;
			$dp->src = $dp->tsr->substr(
				$this->manager->getFrame()->getSrcText()
			);

			// FIXME: Just drop these, we're inTemplate
			$meta = new SelfclosingTagTk(
				'meta', [ new KV( 'typeof', $tagName ) ], $dp
			);

			return [ $meta ];
		} else {
			if ( $this->inOnlyInclude ) {
				return null;
			} else {
				$this->accum[] = $token;
				return [];
			}
		}
	}
}
