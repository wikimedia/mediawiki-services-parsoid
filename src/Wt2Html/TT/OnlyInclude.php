<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\EndTagTk;
use Wikimedia\Parsoid\Tokens\EOFTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * OnlyInclude needs to buffer tokens in case an onlyinclude block is encountered later.
 */
class OnlyInclude extends UniversalTokenHandler {
	private array $accum = [];
	private bool $inOnlyInclude = false;
	private bool $foundOnlyInclude = false;
	private bool $enabled = true;

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->resetState( $options );
	}

	/**
	 * Resets any internal state for this token handler.
	 *
	 * @param array $options
	 */
	public function resetState( array $options ): void {
		parent::resetState( $options );
		$this->inOnlyInclude = false;
		$this->foundOnlyInclude = false;
		$this->enabled = $this->options['inTemplate'] &&
			$this->env->nativeTemplateExpansionEnabled();
	}

	/** @inheritDoc */
	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		return $this->enabled ? $this->onAnyInclude( $ctk ) : null;
	}

	/** @inheritDoc */
	public function onAny( $token ): ?array {
		return $this->enabled ? $this->onAnyInclude( $token ) : null;
	}

	/**
	 * @param Token|string $token
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
