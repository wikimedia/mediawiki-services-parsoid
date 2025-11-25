<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\Assert\Assert;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Utils\Utils;

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
	 * Template arguments as an ordered list
	 * @var list<ParamInfo>
	 */
	public array $paramInfos = [];

	/**
	 * The type of template (template, templatearg, parserfunction).
	 * @note For backward-compatibility reasons, this property is
	 * not serialized/deserialized.
	 * @var 'template'|'templatearg'|'parserfunction'|'old-parserfunction'|null
	 * @see https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec/Parser_Functions
	 */
	public ?string $type = null;

	/**
	 * The index into data-parsoid.pi
	 */
	public ?int $i = null;

	public function __clone() {
		foreach ( $this->paramInfos as &$pi ) {
			$pi = clone $pi;
		}
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): TemplateInfo {
		$ti = new TemplateInfo;
		$ti->targetWt = $json['target']['wt'] ?? null;
		$ti->href = $json['target']['href'] ?? null;
		$ti->paramInfos = [];
		$params = (array)( $json['params'] ?? null );
		$oldPF = false;

		if ( isset( $json['target']['key'] ) ) {
			$ti->func = $json['target']['key'];
		} elseif ( isset( $json['target']['function'] ) ) {
			$ti->func = $json['target']['function'];
			$oldPF = true;
		}

		$count = 1;
		$paramList = [];
		foreach ( $params as $k => $v ) {
			// Converting $params to an array can turn the keys into ints,
			// so we need to explicitly cast them back to string.
			// We also insert `=` prefixes on duplicate keys; strip those
			// out.
			$k = preg_replace( '/^=\d+=/', '', (string)$k );
			$info = new ParamInfo( $k );
			$info->valueWt = $v->wt ?? null;
			$info->html = $v->html ?? null;
			$info->keyWt = $v->key->wt ?? null;
			// Somewhat complicated defaults here for conciseness:
			// If the key is a numeric string, the order defaults to the
			// numeric value and 'eq' defaults to true.
			// Order defaults to 'JSON order' (aka $count) but this isn't
			// guaranteed so we should always emit an 'order' parameter for
			// non-numeric keys.
			$info->named = $v->eq ?? !$info->isNumericKey();
			$order = $v->order ?? ( $info->isNumericKey() ? (int)$k : $count );
			$count++;
			$paramList[] = [ $order, $info ];
		}
		// Regardless of JSON order (which is not guaranteed), ensure that our
		// params are sorted consistently with 'order'
		usort( $paramList, static function ( $a, $b ) {
			[ $orderA, $infoA ] = $a;
			[ $orderB, $infoB ] = $b;
			return $orderA - $orderB;
		} );
		// Strip out the order, we don't need it after sorting.
		$ti->paramInfos = array_map( static fn ( $entry )=>$entry[1], $paramList );
		$ti->i = $json['i'] ?? null;
		// BACKWARD COMPATIBILITY: for 'old' parser function serialization
		// split first arg from function name.
		if ( $oldPF && str_contains( $ti->targetWt, ':' ) ) {
			// For old PF we're guaranteed that parameters are all positional
			// (T204307/T400080)
			[ $name, $arg0 ] = explode( ':', $ti->targetWt, 2 );
			$ti->targetWt = $name;
			$param0 = new ParamInfo( "1", null );
			$param0->valueWt = $arg0;
			array_unshift( $ti->paramInfos, $param0 );
			// BACKWARD COMPATIBILITY: T410826 if there are named parameters
			// here, convert them to numeric.
			foreach ( $ti->paramInfos as $param ) {
				if ( $param->named ) {
					if ( $param->srcOffsets !== null ) {
						$param->srcOffsets = $param->srcOffsets->span()->expandTsrV();
					}
					$param->valueWt = ( $param->keyWt ?? $param->k ) . '=' . ( $param->valueWt ?? '' );
					$param->named = false;
					$param->keyWt = null;
				}
			}
			// Renumber all params (again, all positional with $keyWt=null)
			self::renumberParamInfos( $ti->paramInfos );
		}
		return $ti;
	}

	/** @param list<ParamInfo> $paramInfos */
	private static function renumberParamInfos( array $paramInfos ): void {
		// All args should be positional.  MUTATES PARAMS.
		$count = 1;
		foreach ( $paramInfos as $param ) {
			Assert::invariant( $param->keyWt === null && !$param->named,
							  "Parameter $count should be positional!" );
			if ( $param->srcOffsets ) {
				Assert::invariant( $param->srcOffsets->key->length() === 0,
								  "Key should be synthetic" );
			}
			$param->k = (string)( $count++ );
		}
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
		// https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec/Parser_Functions
		// and T404772 has more details.

		$paramInfoList = $this->paramInfos;
		$target = [ 'wt' => $this->targetWt ];
		if ( $this->func !== null ) {
			if ( $this->type === 'parserfunction' ) {
				$target['key'] = $this->func;
			} else {
				// $this->type === 'old-parserfunction'
				$target['function'] = $this->func;
				// For back-compat, attach the first parser function argument
				// to the key.
				if ( count( $paramInfoList ) > 0 ) {
					$paramInfoList = Utils::cloneArray( $paramInfoList );
					$firstArg = array_shift( $paramInfoList );
					$target['wt'] .= ':' . $firstArg->valueWt;
					// All args are positional for old-parserfunction
					self::renumberParamInfos( $paramInfoList );
				}
			}
		}
		if ( $this->href !== null ) {
			$target['href'] = $this->href;
		}
		$params = [];
		foreach ( $paramInfoList as $idx => $info ) {
			// Non-standard serialization of ParamInfo, alas. (T404772)
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
			$key = $info->k;
			if ( $this->type === 'parserfunction' ) {
				// Add 'eq' and 'order' keys, but use defaults to avoid
				// need to explicitly encode these in the common cases.
				$isNumeric = $info->isNumericKey();
				$defaultEq = !$isNumeric;
				if ( $defaultEq !== $info->named ) {
					$param['eq'] = $info->named;
				}
				$defaultOrder = $isNumeric ? (int)$info->k : null;
				$order = $idx + 1;
				if ( $defaultOrder !== $order ) {
					$param['order'] = $order;
				}
				// For duplicate keys, insert leading `=` to disambiguate.
				// (key can never legitimately contain leading =)
				if ( isset( $params[$key] ) ) {
					$key = "=" . count( $params ) . "=$key";
				}
			}
			$params[$key] = (object)$param;
		}

		return [
			'target' => $target,
			'params' => (object)$params,
			'i' => $this->i,
		];
	}
}
