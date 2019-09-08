<?php

namespace Parsoid\Language;

use DOMNode;
use Parsoid\Utils\DOMPostOrder;
use Parsoid\Utils\DOMUtils;
use Wikimedia\LangConv\ReplacementMachine;

/**
 * Use a {@Link ReplacementMachine} to predict the best "source language" for every node in a DOM.
 * Appropriate for wikis which are written in a mix of variants.
 */
class MachineLanguageGuesser extends LanguageGuesser {
	const SHARED_KEY = '$shared$';

	/** @var array */
	private $nodeMap = [];

	/**
	 * MachineLanguageGuesser constructor.
	 * @param ReplacementMachine $machine
	 * @param DOMNode $root
	 * @param string $destCode
	 */
	public function __construct( ReplacementMachine $machine, DOMNode $root, $destCode ) {
		$codes = [];
		foreach ( $machine->getCodes() as $invertCode => $ignore ) {
			if ( $machine->isValidCodePair( $destCode, $invertCode ) ) {
				$codes[] = $invertCode;
			}
		}
		$countMap = [];
		$merge = function ( string $nodePath, array &$map ) use ( &$countMap, $codes ) {
			if ( !array_key_exists( $nodePath, $countMap ) ) {
				$countMap[$nodePath] = $map;
				$map[self::SHARED_KEY] = true;
				return;
			}
			$m = $countMap[$nodePath];
			if ( array_key_exists( self::SHARED_KEY, $m ) ) {
				// Clone the map (and mark the clone not-shared)
				$newm = array_filter( $m, function ( $k ) {
					return $k !== self::SHARED_KEY;
				} );
				$countMap[$nodePath] = &$newm;
			}
			foreach ( $codes as $c ) {
				$countMap[$nodePath][$c] += $map[$c];
			}
		};

		DOMPostOrder::traverse(
			$root, function ( DOMNode &$node ) use (
				$machine, $codes, $merge, $destCode, &$countMap
			) {
				// XXX look at `lang` attribute and use it to inform guess?
				$nodePath = $node->getNodePath();
				if ( DOMUtils::isText( $node ) ) {
					foreach ( $codes as $invertCode ) {
						$countMap[$nodePath][$invertCode] = $machine->countBrackets(
							$node->textContent,
							$destCode,
							$invertCode
						)->safe;
					}
				} elseif ( !$node->firstChild ) {
					foreach ( $codes as $invertCode ) {
						$countMap[$nodePath][$invertCode] = 0;
					}
				} else {
					// Accumulate counts from children
					for ( $child = $node->firstChild;
						  $child;
						  $child = $child->nextSibling
					) {
						$merge( $nodePath, $countMap[$child->getNodePath()] );
					}
				}
			} );

		foreach ( $countMap as $nodePath => $counts ) {
			$safe = [];
			foreach ( $codes as $code ) {
				$safe[$code] = $counts[$code];
			}
			arsort( $safe );
			$this->nodeMap[$nodePath] = array_keys( $safe )[0];
		}
	}

	/** @inheritDoc */
	public function guessLang( $node ) {
		return $this->nodeMap[$node->getNodePath()];
	}
}
