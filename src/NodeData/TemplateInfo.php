<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

class TemplateInfo implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * The target wikitext
	 */
	public ?string $targetWt = null;

	/**
	 * The parser function name
	 */
	public ?string $func = null;

	/**
	 * The URL of the target
	 */
	public ?string $href = null;

	/**
	 * Param infos indexed by key (ParamInfo->k)
	 * @var list<ParamInfo>
	 */
	public array $paramInfos = [];

	/**
	 * The type of template (template, templatearg, parserfunction).
	 * @note For backward-compatibility reasons, this property is
	 * not serialized/deserialized.
	 * @var 'template'|'templatearg'|'parserfunction'|null
	 */
	public ?string $type = null;

	/**
	 * The index into data-parsoid.pi
	 */
	public ?int $i = null;

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): TemplateInfo {
		$ti = new TemplateInfo;
		$ti->targetWt = $json['target']['wt'] ?? null;
		$ti->href = $json['target']['href'] ?? null;
		$ti->func = $json['target']['function'] ?? null;
		$ti->paramInfos = [];
		$params = (array)( $json['params'] ?? null );
		foreach ( $params as $k => $v ) {
			// Converting $params to an array can turn the keys into ints,
			// so we need to explicitly cast them back to string.
			$info = new ParamInfo( (string)$k );
			$info->valueWt = $v->wt ?? null;
			$info->html = $v->html ?? null;
			$info->keyWt = $v->key->wt ?? null;
			$ti->paramInfos[] = $info;
		}
		$ti->i = $json['i'] ?? null;
		return $ti;
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		static $hints = null;
		if ( $hints === null ) {
			$hints = [
				// The most deeply nested stdClass structure is "wt" inside
				// "key" inside a parameter:
				//     "params":{"1":{"key":{"wt":"..."}}}
				'params' => Hint::build(
					stdClass::class, Hint::ALLOW_OBJECT,
					Hint::STDCLASS, Hint::ALLOW_OBJECT,
					Hint::STDCLASS, Hint::ALLOW_OBJECT
				),
			];
		}
		return $hints[$keyname] ?? null;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		// This is a complicated serialization, but necessary for
		// backward compatibility with existing data-mw
		$target = [ 'wt' => $this->targetWt ];
		if ( $this->func !== null ) {
			$target['function'] = $this->func;
		}
		if ( $this->href !== null ) {
			$target['href'] = $this->href;
		}
		$params = [];
		foreach ( $this->paramInfos as $info ) {
			// Non-standard serialization of ParamInfo, alas.
			$param = [
				'wt' => $info->valueWt,
			];
			if ( $info->html !== null ) {
				$param['html'] = $info->html;
			}
			if ( $info->keyWt !== null ) {
				$param['key'] = (object)[
					'wt' => $info->keyWt,
				];
			}
			$params[$info->k] = (object)$param;
		}
		return [
			'target' => $target,
			'params' => (object)$params,
			'i' => $this->i,
		];
	}
}
