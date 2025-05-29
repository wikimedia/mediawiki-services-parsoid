<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;

/**
 * An atomic fragment represented as a (prepared and loaded) DOM tree.
 */
class DomPFragment extends PFragment {

	public const TYPE_HINT = 'dom';

	private ?DocumentFragment $value;

	private function __construct( DocumentFragment $df, ?DomSourceRange $srcOffsets = null ) {
		parent::__construct( $srcOffsets );
		$this->value = $df;
	}

	/**
	 * Create a new DomPFragment from the given DocumentFragment and optional
	 * source string.
	 */
	public static function newFromDocumentFragment(
		DocumentFragment $df,
		?DomSourceRange $srcOffsets
	): DomPFragment {
		return new self( $df, $srcOffsets );
	}

	/**
	 * Return a DomPFragment corresponding to the given PFragment.
	 * If the fragment is not already a DomPFragment, this will convert
	 * it to a DocumentFragment using PFragment::asDom().
	 */
	public static function castFromPFragment(
		ParsoidExtensionAPI $ext,
		PFragment $fragment
	): DomPFragment {
		if ( $fragment instanceof DomPFragment ) {
			return $fragment;
		}
		return new self( $fragment->asDom( $ext ), $fragment->srcOffsets );
	}

	/** @inheritDoc */
	public function isEmpty(): bool {
		return !$this->value->hasChildNodes();
	}

	/**
	 * DomPFragments may become invalid when combined into other fragments.
	 */
	public function isValid(): bool {
		return $this->value !== null;
	}

	/**
	 * For ease of debugging, use ::markInvalid() to mark a DomPFragment
	 * that should not be (re)used.
	 */
	public function markInvalid(): void {
		$this->value = null;
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $extApi, bool $release = false ): DocumentFragment {
		Assert::invariant(
			$extApi->getTopLevelDoc() === $this->value->ownerDocument,
			"All fragments should belong to the Parsoid top level doc"
		);
		$df = $this->value;
		if ( $release ) {
			$this->markInvalid();
		} else {
			// Return a clone so that callers can't mutate this fragment!
			$df = DOMDataUtils::cloneDocumentFragment( $df );
		}
		return $df;
	}

	/** @inheritDoc */
	public function asHtmlString( ParsoidExtensionAPI $extApi ): string {
		Assert::invariant(
			$extApi->getTopLevelDoc() === $this->value->ownerDocument,
			"All fragments should belong to the Parsoid top level doc"
		);
		return $extApi->domToHtml( $this->value, true, false );
	}

	/**
	 * Return a DomPFragment representing the concatenation of the
	 * given fragments, as (balanced) DOM forests.  The children of
	 * all fragments will be siblings in the result.
	 *
	 * If $release is true, all $fragments arguments may become invalid.
	 * Otherwise, fragment contents will be cloned as necessary to avoid
	 * fragment invalidation.
	 */
	public static function concat( ParsoidExtensionAPI $ext, bool $release, PFragment ...$fragments ): self {
		$result = $ext->getTopLevelDoc()->createDocumentFragment();
		$isFirst = true;
		$firstDSR = null;
		$lastDSR = null;
		foreach ( $fragments as $f ) {
			if ( !$f->isEmpty() ) {
				if ( $isFirst ) {
					$firstDSR = $f->getSrcOffsets();
					$isFirst = false;
				}

				// The return value of ::asDom() is going to be moved
				// into $result, so this fragment may need to be released.
				DOMCompat::append( $result, $f->asDom( $ext, $release ) );

				$lastDSR = $f->getSrcOffsets();
			}
		}
		return new self(
			$result,
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
			return DocumentFragment::class;
		}
		return parent::jsonClassHintFor( $keyName );
	}
}
