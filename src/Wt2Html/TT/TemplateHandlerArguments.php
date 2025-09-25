<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Ext\Arguments;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Wt2Html\Frame;

/**
 * An implementation of the Arguments interface used by TemplateHandler
 * to invoke PFragmentHandlers.
 *
 * @unstable This will change with named-argument support (T390344)
 */
class TemplateHandlerArguments implements Arguments {
	/** @var PFragment[] */
	private array $args = [];

	/**
	 * @param Env $env
	 * @param Frame $frame
	 * @param KV[] $args
	 */
	public function __construct( Env $env, Frame $frame, array $args ) {
		// Each argument maps to a PFragment, which the PFragment handler
		// can expand (or not!).  But wikitext expansion can't break
		// argument boundaries.
		foreach ( $args as $arg ) {
			$range = $arg->srcOffsets->span();
			$this->args[] = WikitextPFragment::newFromWt(
				$range->substr( $frame->getSource() ),
				DomSourceRange::fromTsr( $range )
			);
		}
	}

	/** @inheritDoc */
	public function getOrderedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array {
		return array_map(
			static function ( $k, $v ) use ( $extApi, $expandAndTrim ) {
				$shouldExpand = is_array( $expandAndTrim ) ?
					( $expandAndTrim[$k] ?? true ) :
					$expandAndTrim;
				if ( $shouldExpand ) {
					return $v->expand( $extApi )->trim();
				}
				return $v;
			},
			array_keys( $this->args ),
			array_values( $this->args )
		);
	}

	/** @inheritDoc */
	public function getNamedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array {
		/* NOT IMPLEMENTED YET: T390344 */
		return [];
	}
}
