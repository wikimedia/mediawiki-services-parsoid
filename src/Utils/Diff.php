<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Diff tools.
 * @module
 */

namespace Parsoid;

use Parsoid\simpleDiff as simpleDiff;

$Util = require './Util.js'::Util;

/** @namespace */
$Diff = [];

/** @func */
Diff::convertDiffToOffsetPairs = function ( $diff, $srcLengths, $outLengths ) {
	$currentPair = null;
	$pairs = [];
	$srcOff = 0;
	$outOff = 0;
	$srcIndex = 0;
	$outIndex = 0;
	$diff->forEach( function ( $change ) use ( &$pairs, &$outLengths, &$outIndex, &$srcLengths, &$srcIndex, &$currentPair, &$srcOff, &$outOff ) {
			$pushPair = function ( $pair, $start ) use ( &$pairs ) {
				if ( !$pair->added ) {
					$pair->added = [ 'start' => $start, 'end' => $start ];
				} elseif ( !$pair->removed ) {
					$pair->removed = [ 'start' => $start, 'end' => $start ];
				}
				$pairs[] = [ $pair->removed, $pair->added ];
				$currentPair = [];
			};

			// Use original line lengths;
			$srcLen = 0;
			$outLen = 0;
			$change[ 1 ]->forEach( function () use ( &$change, &$outLengths, &$outIndex, &$srcLengths, &$srcIndex ) {
					if ( $change[ 0 ] === '+' ) {
						$outLen += $outLengths[ $outIndex ];
						$outIndex++;
					} elseif ( $change[ 0 ] === '-' ) {
						$srcLen += $srcLengths[ $srcIndex ];
						$srcIndex++;
					} else {
						$srcLen += $srcLengths[ $srcIndex ];
						$outLen += $outLengths[ $outIndex ];
						$srcIndex++;
						$outIndex++;
					}
			}
			);

			if ( !$currentPair ) {
				$currentPair = [];
			}

			if ( $change[ 0 ] === '+' ) {
				if ( $currentPair->added ) {
					$pushPair( $currentPair, $srcOff ); // srcOff used for adding pair.removed
				}

				$currentPair->added = [ 'start' => $outOff ];
				$outOff += $outLen;
				$currentPair->added->end = $outOff;

				if ( $currentPair->removed ) {
					$pushPair( $currentPair );
				}
			} elseif ( $change[ 0 ] === '-' ) {
				if ( $currentPair->removed ) {
					$pushPair( $currentPair, $outOff ); // outOff used for adding pair.added
				}

				$currentPair->removed = [ 'start' => $srcOff ];
				$srcOff += $srcLen;
				$currentPair->removed->end = $srcOff;

				if ( $currentPair->added ) {
					$pushPair( $currentPair );
				}
			} else {
				if ( $currentPair->added || $currentPair->removed ) {
					$pushPair( $currentPair, ( $currentPair->added ) ? $srcOff : $outOff );
				}

				$srcOff += $srcLen;
				$outOff += $outLen;
			}
	}
	);
	return $pairs;
};

/** @func */
Diff::convertChangesToXML = function ( $changes ) {
	$result = [];
	for ( $i = 0;  $i < count( $changes );  $i++ ) {
		$change = $changes[ $i ];
		if ( $change[ 0 ] === '+' ) {
			$result[] = '<ins>';
		} elseif ( $change[ 0 ] === '-' ) {
			$result[] = '<del>';
		}

		$result[] = Util::escapeHtml( implode( '', $change[ 1 ] ) );

		if ( $change[ 0 ] === '+' ) {
			$result[] = '</ins>';
		} elseif ( $change[ 0 ] === '-' ) {
			$result[] = '</del>';
		}
	}
	return implode( '', $result );
};

$diffTokens = function ( $oldString, $newString, $tokenize ) use ( &$simpleDiff ) {
	if ( $oldString === $newString ) {
		return [ [ '=', [ $newString ] ] ];
	} else {
		return simpleDiff::diff( $tokenize( $oldString ), $tokenize( $newString ) );
	}
};

/** @func */
Diff::diffWords = function ( $oldString, $newString ) use ( &$diffTokens ) {
	// This is a complicated regexp, but it improves on the naive \b by:
	// * keeping tag-like things (<pre>, <a, </a>, etc) together
	// * keeping possessives and contractions (don't, etc) together
	// * ensuring that newlines always stay separate, so we don't
	//   have diff chunks that contain multiple newlines
	//   (ie, "remove \n\n" followed by "add \n", instead of
	//   "keep \n", "remove \n")
	$wordTokenize =
	function ( $value ) {return preg_split( "/((?:<\\/?)?\\w+(?:'\\w+|>)?|\\s(?:(?!\\n)\\s)*)/", $value )->filter(
			// For efficiency, filter out zero-length strings from token list
			// UGLY HACK: simplediff trips if one of tokenized words is
			// 'constructor'. Since this failure breaks parserTests.js runs,
			// work around that by hiding that diff for now.
			function ( $s ) {return $s !== '' && $s !== 'constructor';
   }
		);
	};
	return $diffTokens( $oldString, $newString, $wordTokenize );
};

/** @func */
Diff::diffLines = function ( $oldString, $newString ) use ( &$diffTokens ) {
	$lineTokenize = function ( $value ) {
		return array_map( preg_split( '/^/m', $value ), function ( $line ) {
				return preg_replace( '/\r$/D', "\n", $line );
		}
		);
	};
	return $diffTokens( $oldString, $newString, $lineTokenize );
};

/** @func */
Diff::colorDiff = function ( $a, $b, $options ) use ( &$Util, &$Diff ) {
	$context = $options && $options->context;
	$diffs = 0;
	$buf = '';
	$before = '';
	$visibleWs = function ( $s ) {return preg_replace( '/[ \xA0]/', "␣", $s );
 };
	$funcs = ( $options && $options->html ) ? [
		'+' => function ( $s ) use ( &$Util, &$visibleWs ) {return '<font color="green">' . Util::escapeHtml( $visibleWs( $s ) ) . '</font>';
  },
		'-' => function ( $s ) use ( &$Util, &$visibleWs ) {return '<font color="red">' . Util::escapeHtml( $visibleWs( $s ) ) . '</font>';
  },
		'=' => function ( $s ) use ( &$Util ) {return Util::escapeHtml( $s );
  }
	] : ( $options && $options->noColor ) ? [
		'+' => function ( $s ) {return '{+' . $s . '+}';
  },
		'-' => function ( $s ) {return '{-' . $s . '-}';
  },
		'=' => function ( $s ) {return $s;
  }
	] : [
		// add '' to workaround color bug; make spaces visible
		'+' => function ( $s ) use ( &$visibleWs ) {return $visibleWs( $s )->green . '';
  },
		'-' => function ( $s ) use ( &$visibleWs ) {return $visibleWs( $s )->red . '';
  },
		'=' => function ( $s ) {return $s;
  }
	];
	$NL = ( $options && $options->html ) ? "<br/>\n" : "\n";
	$DIFFSEP = ( $options && $options->separator ) || $NL;
	$visibleNL = "↵";
	foreach ( Diff::diffWords( $a, $b ) as $change => $___ ) {
		$op = $change[ 0 ];
		$value = implode( '', $change[ 1 ] );
		if ( $op !== '=' ) {
			$diffs++;
			$buf += $before;
			$before = '';
			$buf += implode(

				$NL, array_map( explode( "\n", $value ), function ( $s, $i, $arr ) {
						if ( $i !== ( count( $arr ) - 1 ) ) { $s += $visibleNL;
			   }
						return ( $s ) ? $funcs[ $op ]( $s ) : $s;
				}
				)

			);
		} else {
			if ( $context ) {
				$lines = explode( "\n", $value );
				if ( count( $lines ) > 2 * ( $context + 1 ) ) {
					$first = implode( $NL, array_slice( $lines, 0, $context + 1/*CHECK THIS*/ ) );
					$last = implode( $NL, array_slice( $lines, count( $lines ) - $context - 1 ) );
					if ( $diffs > 0 ) {
						$buf += $first + $NL;
					}
					$before = ( ( $diffs > 0 ) ? $DIFFSEP : '' ) + $last;
					continue;
				}
			}
			$buf += $value;
		}
	}
	if ( $options && $options->diffCount ) {
		return [ 'count' => $diffs, 'output' => $buf ];
	}
	return ( $diffs > 0 ) ? $buf : '';
};

/**
 * This is essentially lifted from jsDiff@1.4.0, but using our diff and
 * without the header and no newline warning.
 * @private
 */
$createPatch = function ( $diff ) {
	$ret = [];

	$diff[] = [ 'value' => '', 'lines' => [] ]; // Append an empty value to make cleanup easier

	// Formats a given set of lines for printing as context lines in a patch
	function contextLines( $lines ) {
		return array_map( $lines, function ( $entry ) { return ' ' . $entry;
  } );
	}

	$oldRangeStart = 0;
	$newRangeStart = 0;
	$curRange = [];
	$oldLine = 1;
	$newLine = 1;

	for ( $i = 0;  $i < count( $diff );  $i++ ) {
		$current = $diff[ $i ];
		$lines = $current->lines || explode( "\n", preg_replace( '/\n$/D', '', $current->value, 1 ) );
		$current->lines = $lines;

		if ( $current->added || $current->removed ) {
			// If we have previous context, start with that
			if ( !$oldRangeStart ) {
				$prev = $diff[ $i - 1 ];
				$oldRangeStart = $oldLine;
				$newRangeStart = $newLine;

				if ( $prev ) {
					$curRange = contextLines( array_slice( $prev->lines, -4 ) );
					$oldRangeStart -= count( $curRange );
					$newRangeStart -= count( $curRange );
				}
			}

			// Output our changes
			call_user_func_array( [ $curRange, 'push' ], array_map( $lines, function ( $entry ) {
						return ( ( $current->added ) ? '+' : '-' ) + $entry;
			}
				)

			);

			// Track the updated file position
			if ( $current->added ) {
				$newLine += count( $lines );
			} else {
				$oldLine += count( $lines );
			}
		} else {
			// Identical context lines. Track line changes
			if ( $oldRangeStart ) {
				// Close out any changes that have been output (or join overlapping)
				if ( count( $lines ) <= 8 && $i < count( $diff ) - 2 ) {
					// Overlapping
					call_user_func_array( [ $curRange, 'push' ], contextLines( $lines ) );
				} else {
					// end the range and output
					$contextSize = min( count( $lines ), 4 );
					$ret[] =
					'@@ -' . $oldRangeStart . ',' . ( $oldLine - $oldRangeStart + $contextSize )
. ' +' . $newRangeStart . ',' . ( $newLine - $newRangeStart + $contextSize )
. ' @@';
					call_user_func_array( [ $ret, 'push' ], $curRange );
					call_user_func_array( [ $ret, 'push' ], contextLines( array_slice( $lines, 0, $contextSize/*CHECK THIS*/ ) ) );

					$oldRangeStart = 0;
					$newRangeStart = 0;
					$curRange = [];
				}
			}
			$oldLine += count( $lines );
			$newLine += count( $lines );
		}
	}

	return implode( "\n", $ret ) . "\n";
};

/** @func */
Diff::patchDiff = function ( $a, $b ) use ( &$createPatch ) {
	// Essentially lifted from jsDiff@1.4.0's PatchDiff.tokenize
	$patchTokenize = function ( $value ) {
		$ret = [];
		$linesAndNewlines = preg_split( '/(\n|\r\n)/', $value );
		// Ignore the final empty token that occurs if the string ends with a new line
		if ( !$linesAndNewlines[ count( $linesAndNewlines ) - 1 ] ) {
			array_pop( $linesAndNewlines );
		}
		// Merge the content and line separators into single tokens
		for ( $i = 0;  $i < count( $linesAndNewlines );  $i++ ) {
			$line = $linesAndNewlines[ $i ];
			if ( $i % 2 ) {
				$ret[ count( $ret ) - 1 ] += $line;
			} else {
				$ret[] = $line;
			}
		}
		return $ret;
	};
	$diffs = 0;
	$diff = array_map( diffTokens( $a, $b, $patchTokenize ),
		function ( $change ) {
			$value = implode( '', $change[ 1 ] );
			switch ( $change[ 0 ] ) {
				case '+':
				$diffs++;
				return [ 'value' => $value, 'added' => true ];
				case '-':
				$diffs++;
				return [ 'value' => $value, 'removed' => true ];
				default:
				return [ 'value' => $value ];
			}
		}
	);
	if ( !$diffs ) { return null;
 }
	return $createPatch( $diff );
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->Diff = $Diff;
}
