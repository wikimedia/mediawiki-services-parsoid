<?php

namespace Parsoid\Tokens;

/**
 * Catch-all class for all token types.
 */
abstract class Token {
	/** @var string Type identifier of this token.
	 * All subclasses should assign this a non-null value. */
	protected $type;

	/** @var array Attributes of this token
	 * This is represented an array of KV objects
	 * TODO: Expand on this.
	 */
	protected $attribs = [];

	/** @var array Data attributes for this token
	 * This is represented an associative key-value array
	 * TODO: Expand on this.
	 */
	protected $dataAttribs = [];

	/**
	 * Returns a string key for this token
	 * @return string
	 */
	public function getType() {
		return $this->type;
	}

	/**
	 * Generic set attribute method.
	 *
	 * @param string $name
	 *    Always a string when used this way.
	 *    The more complex form (where the key is a non-string) are found when
	 *    KV objects are constructed in the tokenizer.
	 * @param object $value
	 */
	public function addAttribute( $name, $value ) {
		$this->attribs[] = new KV( $name, $value );
	}

	/**
	 * Generic set attribute method with support for change detection.
	 * Set a value and preserve the original wikitext that produced it.
	 *
	 * @param string $name
	 * @param object $value
	 * @param object $origValue
	 */
	public function addNormalizedAttribute( $name, $value, $origValue ) {
		$this->addAttribute( $name, $value );
		$this->setShadowInfo( $name, $value, $origValue );
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param string $name
	 * @return object
	 */
	public function getAttribute( $name ) {
		return KV::lookup( $this->attribs, $name );
	}

	/**
	 * Set an unshadowed attribute.
	 *
	 * @param string $name
	 * @param object $value
	 */
	public function setAttribute( $name, $value ) {
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
	 * @param object $value
	 * @param object $origValue
	 */
	public function setShadowInfo( $name, $value, $origValue ) {
		// Don't shadow if value is the same or the orig is null
		if ( $value !== $origValue && $origValue !== null ) {
			if ( !isset( $this->dataAttribs['a'] ) ) {
				$this->dataAttribs['a'] = [];
			}
			$this->dataAttribs['a'][$name] = $value;
			if ( !isset( $this->dataAttribs['sa'] ) ) {
				$this->dataAttribs['sa'] = [];
			}
			$this->dataAttribs['sa'][$name] = $origValue;
		}
	}

	// PORT-FIXME: Need another pair of eyes to verify this
	/**
	 * Attribute info accessor for the wikitext serializer. Performs change
	 * detection and uses unnormalized attribute values if set. Expects the
	 * context to be set to a token.
	 *
	 * @param string $name
	 * @return object Information about the shadow info attached to this attribute.
	 */
	public function getAttributeShadowInfo( $name ) {
		$curVal = $this->getAttribute( $name );

		// Not the case, continue regular round-trip information.
		if ( !array_key_exists( 'a', $this->dataAttribs ) ||
			!array_key_exists( $name, $this->dataAttribs['a'] )
		) {
			return [
				"value" => $curVal,
				// Mark as modified if a new element
				"modified" => (array)$this->dataAttribs !== [],
				"fromsrc" => false
			];
		} elseif ( $this->dataAttribs['a'][$name] !== $curVal ) {
			return [
				"value" => $curVal,
				"modified" => true,
				"fromsrc" => false
			];
		} elseif ( !array_key_exists( 'sa', $this->dataAttribs ) ||
			!array_key_exists( $name, $this->dataAttribs['sa'] )
		) {
			return [
				"value" => $curVal,
				"modified" => false,
				"fromsrc" => false
			];
		} else {
			return [
				"value" => $this->dataAttribs['sa'][$name],
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
	public function removeAttribute( $name ) {
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
	public function addSpaceSeparatedAttribute( $name, $value ) {
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
	 * @param MockEnv $env
	 * @return string
	 */
	public function getWTSource( $env ) {
		$tsr = $this->dataAttribs['tsr'] ?? null;
		if ( !is_array( $tsr ) ) {
			throw new InvalidTokenException( 'Expected token to have tsr info.' );
		}
		return substr( $env->page->src, $tsr[0], $tsr[1] );
	}
}
