<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * An atomic fragment represented as an HTML string with inline data
 * attributes, not necessarily balanced.
 */
class HtmlPFragment extends PFragment {

	public const TYPE_HINT = 'html';

	private string $value;

	private function __construct( string $html, ?DomSourceRange $srcOffsets = null ) {
		parent::__construct( $srcOffsets );
		$this->value = $html;
	}

	/**
	 * Create a new HtmlPFragment from the given HTML string and optional
	 * source string.
	 */
	public static function newFromHtmlString(
		string $html, ?DomSourceRange $srcOffsets
	): HtmlPFragment {
		return new self( $html, $srcOffsets );
	}

	/**
	 * Return a new HtmlPFragment corresponding to the given PFragment.
	 * If the fragment is not already an HtmlPFragment, this will convert
	 * it using PFragment::asHtmlString().
	 */
	public static function castFromPFragment(
		ParsoidExtensionAPI $ext, PFragment $fragment
	): HtmlPFragment {
		if ( $fragment instanceof HtmlPFragment ) {
			return $fragment;
		}
		return new self( $fragment->asHtmlString( $ext ), $fragment->srcOffsets );
	}

	/** @inheritDoc */
	public function isEmpty(): bool {
		return $this->value === '';
	}

	/** @inheritDoc */
	public function asHtmlString( ParsoidExtensionAPI $ext ): string {
		return $this->value;
	}

	/**
	 * Return a HtmlPFragment representing the concatenation of the
	 * given fragments, as (unbalanced) HTML strings.
	 */
	public static function concat( ParsoidExtensionAPI $ext, PFragment ...$fragments ): self {
		$result = [];
		$isFirst = true;
		$firstDSR = null;
		$lastDSR = null;
		foreach ( $fragments as $f ) {
			if ( !$f->isEmpty() ) {
				if ( $isFirst ) {
					$firstDSR = $f->getSrcOffsets();
					$isFirst = false;
				}
				$result[] = $f->asHtmlString( $ext );
				$lastDSR = $f->getSrcOffsets();
			}
		}
		return new self(
			implode( '', $result ),
			self::joinSourceRange( $firstDSR, $lastDSR )
		);
	}

	// JsonCodecable implementation

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [
			self::TYPE_HINT => $this->value,
		] + parent::toJsonArray();
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): self {
		$v = $json[self::TYPE_HINT];
		return new self( $v, $json['dsr'] ?? null );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === self::TYPE_HINT ) {
			return null; // string
		}
		return parent::jsonClassHintFor( $keyName );
	}
}
