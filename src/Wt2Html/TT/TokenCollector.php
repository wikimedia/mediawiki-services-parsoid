<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\TT;

use Parsoid\Utils\TokenUtils;
use Parsoid\Tokens\Token;
use Parsoid\Tokens\EOFTk;
use Parsoid\Tokens\KV;
use Parsoid\Tokens\TagTk;
use Parsoid\Tokens\SelfclosingTagTk;
use Parsoid\Tokens\EndTagTk;
use Wikimedia\Assert\Assert;

/**
 * Small utility class that encapsulates the common 'collect all tokens
 * starting from a token of type x until token of type y or (optionally) the
 * end-of-input'. Only supported for synchronous in-order transformation
 * stages (SyncTokenTransformManager), as async out-of-order expansions
 * would wreak havoc with this kind of collector.
 */
abstract class TokenCollector extends TokenHandler {
	protected $onAnyEnabled;
	protected $scopeStack;

	/**
	 * TokenCollector constructor.
	 * @param object $manager
	 * @param array $options
	 */
	public function __construct( $manager, array $options ) {
		parent::__construct( $manager, $options );
		$this->onAnyEnabled = false;
		$this->scopeStack = [];
	}

	/**
	 * Token type to register for ('tag', 'text' etc)
	 * @return string
	 */
	abstract public function type(): string;

	/**
	 * (optional, only for token type 'tag'): tag name.
	 * @return string
	 */
	abstract public function name(): string;

	/**
	 * Match the 'end' tokens as closing tag as well (accept unclosed sections).
	 * @return bool
	 */
	abstract public function toEnd(): bool;

	/**
	 * FIXME: Document this
	 * @return bool
	 */
	abstract public function ackEnd(): bool;

	/**
	 * FIXME: Document this
	 * @param array $array
	 * @return array
	 */
	abstract public function transformation( array $array ): array;

	/**
	 * @param Token $token
	 * @return array|Token
	 */
	public function onTag( Token $token ) {
		return ( $token->getName() === $this::name() ) ? $this->onDelimiterToken( $token ) : $token;
	}

	/**
	 * @param EOFTk $token
	 * @return array|EOFTk
	 */
	public function onEnd( EOFTk $token ) {
		return ( $this->onAnyEnabled ) ? $this->onDelimiterToken( $token ) : $token;
	}

	/**
	 * @param Token|string $token
	 * @return array|Token
	 */
	public function onAny( $token ) {
		return $this->onAnyToken( $token );
	}

	/**
	 * Handle the delimiter token.
	 * XXX: Adjust to sync phase callback when that is modified!
	 * @param $token
	 * @return array
	 */
	private function onDelimiterToken( Token $token ) : array {
		$haveOpenTag = count( $this->scopeStack ) > 0;
		if ( $token instanceof TagTk ) {
			if ( count( $this->scopeStack ) === 0 ) {
				$this->onAnyEnabled = true;
				// Set up transforms
				$this->manager->env->log( 'debug', 'starting collection on ', $token );
			}

			// Push a new scope
			$newScope = [];
			$this->scopeStack[] = &$newScope;
			$newScope[] = $token;

			return [];
		} elseif ( $token instanceof SelfclosingTagTk ) {
			// We need to handle <ref /> for example, so call the handler.
			return $this->transformation( [ $token, $token ] );
		} elseif ( $haveOpenTag ) {
			// EOFTk or EndTagTk
			$this->manager->env->log( 'debug', 'finishing collection on ', $token );

			// Pop top scope and push token onto it
			$activeTokens = array_pop( $this->scopeStack );
			$activeTokens[] = $token;

			// clean up
			if ( count( $this->scopeStack ) === 0 || $token instanceof EOFTk ) {
				$this->onAnyEnabled = false;
			}

			if ( $token instanceof EndTagTk ) {
				// Transformation can be either sync or async, but receives all collected
				// tokens instead of a single token.
				return $this->transformation( $activeTokens );
				// XXX sync version: return tokens
			} else {
				// EOF -- collapse stack!
				$allToks = [];
				for ( $i = 0,  $n = count( $this->scopeStack );  $i < $n;  $i++ ) {
					$allToks = array_merge( $allToks, $this->scopeStack[ $i ] );
				}
				$allToks = array_merge( $allToks, $activeTokens );

				$res = $this->toEnd() ? $this->transformation( $allToks ) : [ 'tokens' => $allToks ];
				if ( isset( $res['tokens'] ) ) {
					if ( count( $res['tokens'] )
					// PORT-FIXME verify this actually is equivalent **** WARNING!!!
					// && $lastItem( $res->tokens )->constructor !== $EOFTk
						&& TokenUtils::getTokenType( end( $res['tokens'] ) ) !== 'EOFTk'
					) {
						$this->manager->env->log( 'error', $this::name(), 'handler dropped the EOFTk!' );

						// preserve the EOFTk
						$res['tokens'][] = $token;
					}
				}

				return $res;
			}
		} else {
			// EndTagTk should be the only one that can reach here.
			Assert::invariant( $token instanceof EndTagTk, 'Expected an end tag.' );
			if ( $this->ackEnd() ) {
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
	 * @param Token|string $token
	 * @return array
	 */
	private function onAnyToken( $token ) : array {
		// Simply collect anything ordinary in between
		// PORT-FIXME verify this actually is equivalent **** WARNING!!!
		// lastItem( $this->scopeStack )[] = $token;
		// end( $this->scopeStack )[] = $token; // end( ) does not return a reference as needed here.
		$arrayLen = count( $this->scopeStack );
		$this->scopeStack[ $arrayLen - 1 ][] = $token;
		return [];
	}

	/**
	 * This helper function will build a meta token in the right way for these tags.
	 * @param object $manager
	 * @param string $tokenName
	 * @param bool $isEnd
	 * @param array $tsr
	 * @param string $src
	 * @return SelfclosingTagTk
	 */
	public static function buildMetaToken( $manager, $tokenName, $isEnd, $tsr, $src )
		: SelfclosingTagTk {
		if ( $isEnd ) {
			$tokenName .= '/End';
		}

		$stringOrFalse = false;
		if ( $tsr ) {
			$pageSrc = $manager->env->getPageMainContent();
			$from = $tsr[ 0 ];
			$to = $tsr[ 1 ] - $from;
			$stringOrFalse = mb_substr( $pageSrc, $from, $to );
			if ( $stringOrFalse === false ) {
				$stringOrFalse = '';
			}
		}

		return new SelfclosingTagTk( 'meta',
			[ new KV( 'typeof', $tokenName ) ],
			$tsr ? (object)[ 'tsr' => $tsr, 'src' => $stringOrFalse ] : (object)[ 'src' => $src ]
		);
	}

	/**
	 * @param object $manager
	 * @param string $tokenName
	 * @param Token $startDelim
	 * @param Token $endDelim
	 * @return SelfclosingTagTk
	 */
	public static function buildStrippedMetaToken( $manager, $tokenName, $startDelim, $endDelim )
		: SelfclosingTagTk {
		$da = $startDelim->dataAttribs;
		$tsr0 = $da ? $da->tsr : null;
		$t0 = $tsr0 ? $tsr0[ 0 ] : null;
		$t1 = null;

		if ( $endDelim ) {
			$da = $endDelim ? $endDelim->dataAttribs : null;
			$tsr1 = $da ? $da->tsr : null;
			$t1 = $tsr1 ? $tsr1[ 1 ] : null;
		} else {
			$t1 = mb_strlen( $manager->env->getPageMainContent() );
		}

		return self::buildMetaToken( $manager, $tokenName, false, [ $t0, $t1 ], '' );
	}
}
