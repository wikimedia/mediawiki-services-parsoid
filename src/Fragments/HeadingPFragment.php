<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Title;
use Wikimedia\Parsoid\Utils\TitleValue;

/**
 * An atomic fragment representing a wikitext heading return by the legacy
 * preprocessor.  It provides the context title of page the heading
 * originated on and the index of the heading on the page
 */
class HeadingPFragment extends PFragment {

	public const TYPE_HINT = 'heading';

	public function __construct(
		public string|PFragment $wt,
		public LinkTarget $title,
		public int $index
	) {
		parent::__construct( null );
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $extApi, bool $release = false ): DocumentFragment {
		$df = $extApi->wikitextToDOM(
			$this->wt,
			[ 'parseOpts' => [ 'expandTemplates' => false ] ],
			true
		);
		if ( DOMUtils::isHeading( $df->firstChild ) ) {
			DOMDataUtils::getDataParsoid( $df->firstChild )->getTemp()->headingData = [
				Title::newFromLinkTarget( $this->title, $extApi->getSiteConfig() ),
				$this->index
			];
		}
		return $df;
	}

	// JsonCodecable implementation

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [
			self::TYPE_HINT => [
				'wt' => $this->wt,
				'title' => [
					$this->title->getNamespace(),
					$this->title->getDBkey(),
					$this->title->getFragment(),
					$this->title->getInterwiki(),
				],
				'index' => $this->index,
			]
		] + parent::toJsonArray();
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): self {
		$v = $json[self::TYPE_HINT];
		return new self(
			$v['wt'],
			TitleValue::tryNew(
				$v['title'][0], $v['title'][1], $v['title'][2], $v['title'][3],
			),
			$v['index'],
		);
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === self::TYPE_HINT ) {
			return Hint::build( PFragment::class, Hint::INHERITED, Hint::LIST );
		}
		return parent::jsonClassHintFor( $keyName );
	}
}
