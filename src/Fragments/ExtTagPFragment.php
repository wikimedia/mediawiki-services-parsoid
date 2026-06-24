<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\TitleValue;

/**
 * An atomic fragment representing an extension tag encountered during
 * preprocessing. The arguments and body of the extension tag have all
 * potentially been preprocessed into wikitext and fragments, since they
 * may have contained strip markers as well.  We also return the frame
 * "title" at the point where the extension tag was encountered, so that
 * we can properly set up the frame for its eventual expansion.
 */
class ExtTagPFragment extends PFragment {
	public const TYPE_HINT = 'exttag';

	public function __construct(
		public string|PFragment $wt,
		public LinkTarget $title,
	) {
		parent::__construct( null );
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $extApi, bool $release = false ): DocumentFragment {
		$df = $extApi->wikitextToDOM(
			$this->wt,
			[
				'parseOpts' => [
					'expandTemplates' => false,
					'context' => 'inline',
				],
				'processInNewFrame' => true,
				'newFrameTitle' => $this->title,
			],
			true
		);
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
