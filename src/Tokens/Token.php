<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

use Parsoid\Config\Env;

/**
 * Catch-all class for all token types.
 */
abstract class Token implements \JsonSerializable {
	/**
	 * @inheritDoc
	 */
	abstract public function jsonSerialize();

	/**
	 * Get a name for the token.
	 * Derived classes can override this.
	 * @return string
	 */
	public function getName(): string {
		return $this->getType();
	}

	/**
	 * Returns a string key for this token
	 * @return string
	 */
	public function getType(): string {
		return ( new \ReflectionClass( $this ) )->getShortName();
	}

	/**
	 * Generic set attribute method.
	 *
	 * @param string $name
	 *    Always a string when used this way.
	 *    The more complex form (where the key is a non-string) are found when
	 *    KV objects are constructed in the tokenizer.
	 * @param mixed $value
	 */
	public function addAttribute( string $name, $value ): void {
		$this->attribs[] = new KV( $name, $value );
	}

	/**
	 * Generic set attribute method with support for change detection.
	 * Set a value and preserve the original wikitext that produced it.
	 *
	 * @param string $name
	 * @param mixed $value
	 * @param mixed $origValue
	 */
	public function addNormalizedAttribute( string $name, $value, $origValue ): void {
		$this->addAttribute( $name, $value );
		$this->setShadowInfo( $name, $value, $origValue );
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param string $name
	 * @return mixed
	 */
	public function getAttribute( string $name ) {
		return KV::lookup( $this->attribs, $name );
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param string $name
	 * @return bool
	 */
	public function hasAttribute( string $name ): bool {
		return KV::lookupKV( $this->attribs, $name ) !== null;
	}

	/**
	 * Set an unshadowed attribute.
	 *
	 * @param string $name
	 * @param mixed $value
	 */
	public function setAttribute( string $name, $value ): void {
		// First look for the attribute and change the last match if found.
		for ( $i = count( $this->attribs ) - 1; $i >= 0; $i-- ) {
			$kv = $this->attribs[$i];
			$k = $kv->k;
			if ( is_string( $k ) && mb_strtolower( $k ) === $name ) {
				$kv->v = $value;
				$this->attribs[$i] = $kv;
				return;
			}
		}
		// Nothing found, just add the attribute
		$this->addAttribute( $name, $value );
	}

	// PORT-FIXME: Need another pair of eyes to verify this
	/**
	 * Store the original value of an attribute in a token's dataAttribs.
	 *
	 * @param string $name
	 * @param mixed $value
	 * @param mixed $origValue
	 */
	public function setShadowInfo( string $name, $value, $origValue ): void {
		// Don't shadow if value is the same or the orig is null
		if ( $value !== $origValue && $origValue !== null ) {
			if ( !isset( $this->dataAttribs->a ) ) {
				$this->dataAttribs->a = [];
			}
			$this->dataAttribs->a[$name] = $value;
			if ( !isset( $this->dataAttribs->sa ) ) {
				$this->dataAttribs->sa = [];
			}
			$this->dataAttribs->sa[$name] = $origValue;
		}
	}

	// PORT-FIXME: Need another pair of eyes to verify this
	/**
	 * Attribute info accessor for the wikitext serializer. Performs change
	 * detection and uses unnormalized attribute values if set. Expects the
	 * context to be set to a token.
	 *
	 * @param string $name
	 * @return array Information about the shadow info attached to this attribute.
	 */
	public function getAttributeShadowInfo( string $name ): array {
		$curVal = $this->getAttribute( $name );

		// Not the case, continue regular round-trip information.
		if ( !property_exists( $this->dataAttribs, 'a' ) ||
			!array_key_exists( $name, $this->dataAttribs->a )
		) {
			return [
				"value" => $curVal,
				// Mark as modified if a new element
				"modified" => $this->dataAttribs !== [],
				"fromsrc" => false
			];
		} elseif ( $this->dataAttribs->a[$name] !== $curVal ) {
			return [
				"value" => $curVal,
				"modified" => true,
				"fromsrc" => false
			];
		} elseif ( !property_exists( $this->dataAttribs, 'sa' ) ||
			!array_key_exists( $name, $this->dataAttribs->sa )
		) {
			return [
				"value" => $curVal,
				"modified" => false,
				"fromsrc" => false
			];
		} else {
			return [
				"value" => $this->dataAttribs->sa[$name],
				"modified" => false,
				"fromsrc" => true
			];
		}
	}

	/**
	 * Completely remove all attributes with this name.
	 *
	 * @param string $name
	 */
	public function removeAttribute( string $name ): void {
		$out = [];
		$attribs = $this->attribs;
		// FIXME: Could use array_filter
		for ( $i = 0, $l = count( $attribs ); $i < $l; $i++ ) {
			$kv = $attribs[$i];
			if ( mb_strtolower( $kv->k ) !== $name ) {
				$out[] = $kv;
			}
		}
		$this->attribs = $out;
	}

	/**
	 * Add a space-separated property value.
	 * These are Parsoid-added attributes, not something present in source.
	 * So, only a regular ASCII space characters will be used here.
	 *
	 * @param string $name The attribute name
	 * @param string $value The value to add to the attribute
	 */
	public function addSpaceSeparatedAttribute( string $name, string $value ): void {
		$curVal = $this->getAttribute( $this->attribs );
		if ( $curVal !== null ) {
			if ( preg_match( '/(?:^|\s)' . preg_quote( $value, '/' ) . '(?:\s|$)/', $curVal->v ) ) {
				// value is already included, nothing to do.
				return;
			}

			// Value was not yet included in the existing attribute, just add
			// it separated with a space
			$this->setAttribute( $curVal->k, $curVal->v . ' ' . $value );
		} else {
			// the attribute did not exist at all, just add it
			$this->addAttribute( $name, $value );
		}
	}

	/**
	 * Get the wikitext source of a token.
	 *
	 * @param Env $env
	 * @return string
	 */
	public function getWTSource( Env $env ): string {
		$tsr = $this->dataAttribs->tsr ?? null;
		if ( !is_array( $tsr ) ) {
			throw new InvalidTokenException( 'Expected token to have tsr info.' );
		}
		return substr( $env->getPageMainContent(), $tsr[0], $tsr[1] );
	}

	/**
	 * Create key value set from an array
	 *
	 * @param array $a
	 * @return array
	 */
	private static function kvsFromArray( array $a ): array {
		$kvs = [];
		foreach ( $a as $e ) {
			$kvs[] = new KV(
				$e["k"],
				$e["v"],
				$e["srcOffsets"] ?? null,
				$e["ksrc"] ?? null,
				$e["vsrc"] ?? null
			);
		};
		return $kvs;
	}

	/**
	 * @param mixed $a
	 */
	private static function rebuildNestedTokens( $a ): void {
		foreach ( $a as &$v ) {
			$v = self::getToken( $v );
		}
		unset( $v ); // Future-proof protection
	}

	/**
	 * Get a token from some a JSON string
	 *
	 * @param mixed $jsTk
	 * @return mixed
	 */
	public static function getToken( $jsTk ) {
		if ( !$jsTk ) {
			return $jsTk;
		}

		if ( is_array( $jsTk ) && isset( $jsTk['type'] ) ) {
			$da = isset( $jsTk['dataAttribs'] ) ? (object)$jsTk['dataAttribs'] : null;
			if ( $da ) {
				if ( isset( $da->tmp ) ) {
					$da->tmp = (object)$da->tmp;
				}
			}
			switch ( $jsTk['type'] ) {
				case "SelfclosingTagTk":
					$token = new SelfclosingTagTk( $jsTk['name'], self::kvsFromArray( $jsTk['attribs'] ), $da );
					break;
				case "TagTk":
					$token = new TagTk( $jsTk['name'], self::kvsFromArray( $jsTk['attribs'] ), $da );
					break;
				case "EndTagTk":
					$token = new EndTagTk( $jsTk['name'], self::kvsFromArray( $jsTk['attribs'] ), $da );
					break;
				case "NlTk":
					$token = new NlTk( $jsTk['dataAttribs']['tsr'] ?? null, $da );
					break;
				case "EOFTk":
					$token = new EOFTk();
					break;
				case "CommentTk":
					$token = new CommentTk( $jsTk["value"], $da );
					break;
				default:
					// Looks like data-parsoid can have a 'type' property in some cases
					// We can change that usage and then throw an exception here
					$token = &$jsTk;
			}
		} elseif ( is_array( $jsTk ) ) {
			$token = &$jsTk;
		} else {
			$token = $jsTk;
		}

		if ( is_array( $token ) ) {
			self::rebuildNestedTokens( $token );
		} else {
			if ( !empty( $token->attribs ) ) {
				self::rebuildNestedTokens( $token->attribs );
			}
			if ( !empty( $token->dataAttribs ) ) {
				self::rebuildNestedTokens( $token->dataAttribs );
			}
		}

		return $token;
	}
}
