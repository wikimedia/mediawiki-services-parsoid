<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * @module
 */

namespace Parsoid;



use Parsoid\colors as colors;
use Parsoid\entities as entities;
use Parsoid\yargs as yargs;

$Diff = require( '../lib/utils/Diff.js' )::Diff;
$ContentUtils = require( '../lib/utils/ContentUtils.js' )::ContentUtils;
$DOMUtils = require( '../lib/utils/DOMUtils.js' )::DOMUtils;
$DOMDataUtils = require( '../lib/utils/DOMDataUtils.js' )::DOMDataUtils;
$ScriptUtils = require( '../tools/ScriptUtils.js' )::ScriptUtils;
$Util = require( '../lib/utils/Util.js' )::Util;
$WTUtils = require( '../lib/utils/WTUtils.js' )::WTUtils;
$DOMNormalizer = require( '../lib/html2wt/DOMNormalizer.js' )::DOMNormalizer;
$MockEnv = require( './MockEnv.js' )::MockEnv;

$TestUtils = [];

/**
 * Little helper function for encoding XML entities.
 *
 * @param {string} string
 * @return {string}
 */
TestUtils::encodeXml = function ( $string ) use ( &$entities ) {
	return entities::encodeXML( $string );
};

/**
 * Specialized normalization of the PHP parser & Parsoid output, to ignore
 * a few known-ok differences in parser test runs.
 *
 * This code is also used by the Parsoid round-trip testing code.
 *
 * If parsoidOnly is true-ish, we allow more markup through (like property
 * and typeof attributes), for better checking of parsoid-only test cases.
 *
 * @param {string} domBody
 * @param {Object} options
 * @param {boolean} [options.parsoidOnly=false]
 * @param {boolean} [options.preserveIEW=false]
 * @param {boolean} [options.scrubWikitext=false]
 * @param {boolean} [options.rtTestMode=false]
 * @return {string}
 */
TestUtils::normalizeOut = function ( $domBody, $options ) use ( &$MockEnv, &$DOMDataUtils, &$DOMNormalizer, &$DOMUtils, &$ContentUtils ) {
	if ( !$options ) {
		$options = [];
	}
	$parsoidOnly = $options->parsoidOnly;
	$preserveIEW = $options->preserveIEW;

	if ( $options->scrubWikitext ) {
		// Mock env obj
		//
		// FIXME: This is ugly.
		// (a) The normalizer shouldn't need the full env.
		//     Pass options and a logger instead?
		// (b) DOM diff code is using page-id for some reason.
		//     That feels like a carryover of 2013 era code.
		//     If possible, get rid of it and diff-mark dependency
		//     on the env object.
		$env = new MockEnv( [ 'scrubWikitext' => true ], null );
		if ( gettype( $domBody ) === 'string' ) {
			$domBody = $env->createDocument( $domBody )->body;
		}
		$mockState = [
			'env' => $env,
			'selserMode' => false,
			'rtTestMode' => $options->rtTestMode
		];
		DOMDataUtils::visitAndLoadDataAttribs( $domBody, [ 'markNew' => true ] );
		$domBody = ( new DOMNormalizer( $mockState )->normalize( $domBody ) );
		DOMDataUtils::visitAndStoreDataAttribs( $domBody );
	} else {
		if ( gettype( $domBody ) === 'string' ) {
			$domBody = DOMUtils::parseHTML( $domBody )->body;
		}
	}

	$stripTypeof = ( $parsoidOnly ) ?
	/* RegExp */ '/(?:^|mw:DisplaySpace\s+)mw:Placeholder$/' :
	/* RegExp */ '/^mw:(?:(?:DisplaySpace\s+mw:)?Placeholder|Nowiki|Transclusion|Entity)$/';
	$domBody = $this->unwrapSpansAndNormalizeIEW( $domBody, $stripTypeof, $parsoidOnly, $preserveIEW );
	$out = ContentUtils::toXML( $domBody, [ 'innerXML' => true ] );
	// NOTE that we use a slightly restricted regexp for "attribute"
	//  which works for the output of DOM serialization.  For example,
	//  we know that attribute values will be surrounded with double quotes,
	//  not unquoted or quoted with single quotes.  The serialization
	//  algorithm is given by:
	//  http://www.whatwg.org/specs/web-apps/current-work/multipage/the-end.html#serializing-html-fragments
	if ( !preg_match( "/[^<]*(<\\w+(\\s+[^\\0-\\cZ\\s\"'>\\/=]+(=\"[^\"]*\")?)*\\/?>[^<]*)*/", $out ) ) {
		throw new Error( 'normalizeOut input is not in standard serialized form' );
	}

	// Eliminate a source of indeterminacy from leaked strip markers
	$out = preg_replace( '/UNIQ-.*?-QINU/', '', $out );

	// And from the imagemap extension - the id attribute is not always around, it appears!
	$out = preg_replace( '/<map name="ImageMap_[^"]*"( id="ImageMap_[^"]*")?( data-parsoid="[^"]*")?>/', '<map>', $out );

	// Normalize COINS ids -- they aren't stable
	$out = preg_replace( "/\\s?id=['\"]coins_\\d+['\"]/i", '', $out );

	// Eliminate transience from priority hints (T216499)
	$out = preg_replace( '/\s?importance="high"/', '', $out );
	$out = preg_replace( '/\s?elementtiming="thumbnail-(high|top)"/', '', $out );

	if ( $parsoidOnly ) {
		// unnecessary attributes, we don't need to check these
		// style is in there because we should only check classes.
		$out = preg_replace( '/ (data-parsoid|prefix|about|rev|datatype|inlist|usemap|vocab|content|style)=\\\?"[^\"]*\\\?"/', '', $out );
		// single-quoted variant
		$out = preg_replace( "/ (data-parsoid|prefix|about|rev|datatype|inlist|usemap|vocab|content|style)=\\\\?'[^\\']*\\\\?'/", '', $out );
		// apos variant
		$out = preg_replace( '/ (data-parsoid|prefix|about|rev|datatype|inlist|usemap|vocab|content|style)=&apos;.*?&apos;/', '', $out );

		// strip self-closed <nowiki /> because we frequently test WTS
		// <nowiki> insertion by providing an html/parsoid section with the
		// <meta> tags stripped out, allowing the html2wt test to verify that
		// the <nowiki> is correctly added during WTS, while still allowing
		// the html2html and wt2html versions of the test to pass as a
		// sanity check.  If <meta>s were not stripped, these tests would all
		// have to be modified and split up.  Not worth it at this time.
		// (see commit 689b22431ad690302420d049b10e689de6b7d426)
		$out = preg_replace(
			'/<span typeof="mw:Nowiki"><\/span>/', '', $out )
		;

		return $out;
	}

	// Normalize headings by stripping out Parsoid-added ids so that we don't
	// have to add these ids to every parser test that uses headings.
	// We will test the id generation scheme separately via mocha tests.
	$out = preg_replace( '/(<h[1-6].*?) id="[^"]*"([^>]*>)/', '$1$2', $out );

	// strip meta/link elements
	$out = preg_replace(
		"/<\\/?(?:meta|link)(?: [^\\0-\\cZ\\s\"'>\\/=]+(?:=(?:\"[^\"]*\"|'[^']*'))?)*\\/?>/", '', $out )
	;
	// Ignore troublesome attributes.
	// Strip JSON attributes like data-mw and data-parsoid early so that
	// comment stripping in normalizeNewlines does not match unbalanced
	// comments in wikitext source.
	$out = preg_replace( '/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|usemap|vocab|content|class)="[^\"]*"/', '', $out );
	// single-quoted variant
	$out = preg_replace( "/ (data-mw|data-parsoid|resource|rel|prefix|about|rev|datatype|inlist|property|usemap|vocab|content|class)='[^\\']*'/", '', $out );
	// strip typeof last
	$out = preg_replace( '/ typeof="[^\"]*"/', '', $out );

	return preg_replace(









		'/(src="[^"]*?)\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^\/]+)\/[0-9]+px-[^"\/]+(?=")/', '$1$2', preg_replace(







			'/ href="[^"]*"/', Util::decodeURI, preg_replace(





				'/(href=")(?:\.?\.\/)+/', '$1', preg_replace(




					'/<span>\s*<\/span>/', '', preg_replace(



						'/(\s)<span>\s*<\/span>\s*/', '$1', preg_replace(


							'/<span[^>]+about="[^"]*"[^>]*>/', '', preg_replace(

								'/ id="mw((t\d+)|([\w-]{2,}))"/', '', $out
								// replace mwt ids
							)
						)
					)
				)
			)
			// replace unnecessary URL escaping
		)
		// strip thumbnail size prefixes
	);
};

/**
 * Normalize newlines in IEW to spaces instead.
 *
 * @param {Node} body
 *   The document `<body>` node to normalize.
 * @param {RegExp} [stripSpanTypeof]
 * @param {boolean} [parsoidOnly=false]
 * @param {boolean} [preserveIEW=false]
 * @return {Node}
 */
TestUtils::unwrapSpansAndNormalizeIEW = function ( $body, $stripSpanTypeof, $parsoidOnly, $preserveIEW ) use ( &$DOMUtils, &$WTUtils ) {
	$newlineAround = function ( $node ) {
		return $node && preg_match( '/^(BODY|CAPTION|DIV|DD|DT|LI|P|TABLE|TR|TD|TH|TBODY|DL|OL|UL|H[1-6])$/', $node->nodeName );
	};
	$unwrapSpan = null; // forward declare
	$cleanSpans = function ( $node ) use ( &$stripSpanTypeof, &$unwrapSpan ) {
		$child = null; $next = null;
		if ( !$stripSpanTypeof ) { return;  }
		for ( $child = $node->firstChild;  $child;  $child = $next ) {
			$next = $child->nextSibling;
			if ( $child->nodeName === 'SPAN'
&&					preg_match( $stripSpanTypeof, $child->getAttribute( 'typeof' ) || '' )
			) {
				$unwrapSpan( $node, $child );
			}
		}
	};
	$unwrapSpan = function ( $parent, $node ) use ( &$cleanSpans, &$DOMUtils ) {
		// first recurse to unwrap any spans in the immediate children.
		$cleanSpans( $node );
		// now unwrap this span.
		DOMUtils::migrateChildren( $node, $parent, $node );
		$parent->removeChild( $node );
	};
	$visit = function ( $node, $stripLeadingWS, $stripTrailingWS, $inPRE ) use ( &$preserveIEW, &$DOMUtils, &$cleanSpans, &$parsoidOnly, &$newlineAround, &$WTUtils, &$visit ) {
		$child = null; $next = null; $prev = null;
		if ( $node->nodeName === 'PRE' ) {
			// Preserve newlines in <pre> tags
			$inPRE = true;
		}
		if ( !$preserveIEW && DOMUtils::isText( $node ) ) {
			if ( !$inPRE ) {
				$node->data = preg_replace( '/\s+/', ' ', $node->data );
			}
			if ( $stripLeadingWS ) {
				$node->data = preg_replace( '/^\s+/', '', $node->data, 1 );
			}
			if ( $stripTrailingWS ) {
				$node->data = preg_replace( '/\s+$/', '', $node->data, 1 );
			}
		}
		// unwrap certain SPAN nodes
		$cleanSpans( $node );
		// now remove comment nodes
		if ( !$parsoidOnly ) {
			for ( $child = $node->firstChild;  $child;  $child = $next ) {
				$next = $child->nextSibling;
				if ( DOMUtils::isComment( $child ) ) {
					$node->removeChild( $child );
				}
			}
		}
		// reassemble text nodes split by a comment or span, if necessary
		$node->normalize();
		// now recurse.
		if ( $node->nodeName === 'PRE' ) {
			// hack, since PHP adds a newline before </pre>
			$stripLeadingWS = false;
			$stripTrailingWS = true;
		} elseif ( $node->nodeName === 'SPAN'
&&				preg_match( '/^mw[:]/', $node->getAttribute( 'typeof' ) || '' )
		) {

			// SPAN is transparent; pass the strip parameters down to kids
		} else {
			$stripLeadingWS = $stripTrailingWS = $newlineAround( $node );
		}
		$child = $node->firstChild;
		// Skip over the empty mw:FallbackId <span> and strip leading WS
		// on the other side of it.
		if ( preg_match( '/^H[1-6]$/', $node->nodeName )
&&				$child && WTUtils::isFallbackIdSpan( $child )
		) {
			$child = $child->nextSibling;
		}
		for ( ;  $child;  $child = $next ) {
			$next = $child->nextSibling;
			$visit( $child,
				$stripLeadingWS,
				$stripTrailingWS && !$child->nextSibling,
				$inPRE
			);
			$stripLeadingWS = false;
		}
		if ( $inPRE || $preserveIEW ) { return $node;  }
		// now add newlines around appropriate nodes.
		for ( $child = $node->firstChild;  $child;  $child = $next ) {
			$prev = $child->previousSibling;
			$next = $child->nextSibling;
			if ( $newlineAround( $child ) ) {
				if ( $prev && DOMUtils::isText( $prev ) ) {
					$prev->data = preg_replace( '/\s*$/', "\n", $prev->data, 1 );
				} else {
					$prev = $node->ownerDocument->createTextNode( "\n" );
					$node->insertBefore( $prev, $child );
				}
				if ( $next && DOMUtils::isText( $next ) ) {
					$next->data = preg_replace( '/^\s*/', "\n", $next->data, 1 );
				} else {
					$next = $node->ownerDocument->createTextNode( "\n" );
					$node->insertBefore( $next, $child->nextSibling );
				}
			}
		}
		return $node;
	};
	// clone body first, since we're going to destructively mutate it.
	return $visit( $body->cloneNode( true ), true, true, false );
};

/**
 * Strip some php output we aren't generating.
 */
TestUtils::normalizePhpOutput = function ( $html ) {
	return preg_replace(


		"/<a[^>]+class=\"mw-headline-anchor\"[^>]*>§<\\/a>/", '', preg_replace(

			'/<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span> *(<span class="mw-editsection"><span class="mw-editsection-bracket">\[<\/span>.*?<span class="mw-editsection-bracket">\]<\/span><\/span>)?/', '$1', $html
			// do not expect section editing for now
		)
	);
};

/**
 * Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 *
 * @param {string} source
 * @return {string}
 */
TestUtils::normalizeHTML = function ( $source ) use ( &$DOMUtils ) {
	try {
		$body = $this->unwrapSpansAndNormalizeIEW( DOMUtils::parseHTML( $source )->body );
		$html = preg_replace(



			'/<div[^>]+?id="toc"[^>]*>\s*<div id="toctitle"[^>]*>[\s\S]+?<\/div>[\s\S]+?<\/div>\s*/', '', ContentUtils::toXML( $body, [ 'innerXML' => true ] )
			// a few things we ignore for now..
			//  .replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
		);
		return preg_replace(



















			'/<span>\s*<\/span>/', '', preg_replace(


















				'/(\s)<span>\s*<\/span>\s*/', '$1', preg_replace(
















					'/ href="[^"]*"/', Util::decodeURI, preg_replace(














						'/href="#/', 'href="Main Page#', preg_replace(












							'/" +>/', '">', preg_replace(











								'/href="\/wiki\//', 'href="', preg_replace(










									'/<a +href/', '<a href', preg_replace(








										"/ \\((?:page does not exist|encara no existeix|bet ele jaratılmag'an|lonkásá  ezalí tɛ̂)\\)/", '', preg_replace(






											"/\\/index.php\\?title=([^']+?)&amp;action=edit&amp;redlink=1/", '/wiki/$1', preg_replace(




												'/ (class|rel|about|typeof)="[^"]*"/', '', preg_replace(


													'/<span>\s*<\/span>/', '', preg_replace(

														'/(\s)<span>\s*<\/span>\s*/', '$1', $this->normalizePhpOutput( $html )
														// remove empty span tags
													)
												)
												// general class and titles, typically on links
											)
											// strip red link markup, we do not check if a page exists yet
										)
										// strip red link title info
									)// eslint-disable-line
									// the expected html has some extra space in tags, strip it
								)
							)
						)
						// parsoid always add a page name to lonely fragments
					)
					// replace unnecessary URL escaping
				)
				// strip empty spans
			)
		);
	} catch ( Exception $e ) {
		$console->log( 'normalizeHTML failed on'
.				$source . ' with the following error: ' . $e
		);
		$console->trace();
		return $source;
	}
};

/**
 * Colorize given number if <> 0.
 *
 * @param {number} count
 * @param {string} color
 * @return {string} Colorized count
 */
$colorizeCount = function ( $count, $color ) {
	// We need a string to use colors methods
	$s = $count->toString();
	if ( $count === 0 || !$s[ $color ] ) {
		return $s;
	}
	return $s[ $color ] . '';
};

/**
 * @param {Array} modesRan
 * @param {Object} stats
 * @param {number} stats.failedTests Number of failed tests due to differences in output.
 * @param {number} stats.passedTests Number of tests passed without any special consideration.
 * @param {number} stats.passedTestsWhitelisted Number of tests passed by whitelisting.
 * @param {Object} stats.modes All of the stats (failedTests, passedTests, and passedTestsWhitelisted) per-mode.
 * @param {string} file
 * @param {number} loggedErrorCount
 * @param {RegExp|null} testFilter
 * @param {boolean} blacklistChanged
 * @return {number} The number of failures.
 */
$reportSummary = function ( $modesRan, $stats, $file, $loggedErrorCount, $testFilter, $blacklistChanged ) use ( &$colorizeCount ) {
	$curStr = null; $mode = null; $thisMode = null;
	$failTotalTests = $stats->failedTests;
	$happiness =
	$stats->passedTestsUnexpected === 0 && $stats->failedTestsUnexpected === 0;

	$filename = ( $file === null ) ? 'ALL TESTS' : $file;

	if ( $file === null ) { $console->log();  }
	$console->log( '==========================================================' );
	$console->log( 'SUMMARY:', ( $happiness ) ? $filename->green : $filename->red );
	if ( $console->time && $console->timeEnd && $file !== null ) {
		$console->timeEnd( 'Execution time' );
	}

	if ( $failTotalTests !== 0 ) {
		for ( $i = 0;  $i < count( $modesRan );  $i++ ) {
			$mode = $modesRan[ $i ];
			$curStr = $mode . ': ';
			$thisMode = $stats->modes[ $mode ];
			$curStr += $colorizeCount( $thisMode->passedTests + $thisMode->passedTestsWhitelisted, 'green' ) . ' passed (';
			$curStr += $colorizeCount( $thisMode->passedTestsUnexpected, 'red' ) . ' unexpected, ';
			$curStr += $colorizeCount( $thisMode->passedTestsWhitelisted, 'yellow' ) . ' whitelisted) / ';
			$curStr += $colorizeCount( $thisMode->failedTests, 'red' ) . ' failed (';
			$curStr += $colorizeCount( $thisMode->failedTestsUnexpected, 'red' ) . ' unexpected)';
			$console->log( $curStr );
		}

		$curStr = 'TOTAL' . ': ';
		$curStr += $colorizeCount( $stats->passedTests + $stats->passedTestsWhitelisted, 'green' ) . ' passed (';
		$curStr += $colorizeCount( $stats->passedTestsUnexpected, 'red' ) . ' unexpected, ';
		$curStr += $colorizeCount( $stats->passedTestsWhitelisted, 'yellow' ) . ' whitelisted) / ';
		$curStr += $colorizeCount( $stats->failedTests, 'red' ) . ' failed (';
		$curStr += $colorizeCount( $stats->failedTestsUnexpected, 'red' ) . ' unexpected)';
		$console->log( $curStr );

		if ( $file === null ) {
			$console->log( $colorizeCount( $stats->passedTests + $stats->passedTestsWhitelisted, 'green' )
.					' total passed tests (expected '
.					( $stats->passedTests + $stats->passedTestsWhitelisted - $stats->passedTestsUnexpected + $stats->failedTestsUnexpected )
.					'), '
.					$colorizeCount( $failTotalTests, 'red' ) . ' total failures (expected '
.					( $stats->failedTests - $stats->failedTestsUnexpected + $stats->passedTestsUnexpected )
.					')'
			);
		}
	} else {
		if ( $testFilter !== null ) {
			$console->log( 'Passed ' . ( $stats->passedTests + $stats->passedTestsWhitelisted )
.					' of ' . $stats->passedTests . ' tests matching ' . $testFilter
.					'... ' . 'ALL TESTS PASSED!'::green
			);
		} else {
			// Should not happen if it does: Champagne!
			$console->log( 'Passed ' . $stats->passedTests . ' of ' . $stats->passedTests
.					' tests... ' . 'ALL TESTS PASSED!'::green
			);
		}
	}

	// If we logged error messages, complain about it.
	$logMsg = 'No errors logged.'::green;
	if ( $loggedErrorCount > 0 ) {
		$logMsg = ( $loggedErrorCount . ' errors logged.' )->red;
	}
	if ( $file === null ) {
		if ( $loggedErrorCount > 0 ) {
			$logMsg = ( '' . $loggedErrorCount )->red;
		} else {
			$logMsg = ( '' . $loggedErrorCount )->green;
		}
		$logMsg += ' errors logged.';
	}
	$console->log( $logMsg );

	$failures =
	$stats->passedTestsUnexpected
+		$stats->failedTestsUnexpected
+		$loggedErrorCount;


	// If the blacklist changed, complain about it.
	if ( $blacklistChanged ) {
		$console->log( 'Blacklist changed!'::red );
	}

	if ( $file === null ) {
		if ( $failures === 0 ) {
			$console->log( '--> ' . 'NO UNEXPECTED RESULTS'::green . ' <--' );
			if ( $blacklistChanged ) {
				$console->log( 'Perhaps some tests were deleted or renamed.' );
				$console->log( 'Use `bin/parserTests.js --rewrite-blacklist` to update blacklist.' );
			}
		} else {
			$console->log( ( '--> ' . $failures . ' UNEXPECTED RESULTS. <--' )->red );
		}
	}

	return $failures;
};

$prettyPrintIOptions = function ( $iopts ) {
	if ( !$iopts ) { return '';  }
	$ppValue = function ( $v ) {
		if ( is_array( $v ) ) {
			return implode( ',', array_map( $v, $ppValue ) );
		}
		if ( gettype( $v ) !== 'string' ) {
			return json_encode( $v );
		}
		if ( preg_match( '/^\[\[[^\]]*\]\]$/', $v ) || preg_match( '/^[-\w]+$/', $v ) ) {
			return $v;
		}
		return json_encode( $v );
	};
	return implode(


		' ', array_map( Object::keys( $iopts ), function ( $k ) {
				if ( $iopts[ $k ] === '' ) { return $k;  }
				return $k . '=' . ppValue( $iopts[ $k ] );
			}
		)


	);
};

$printWhitelistEntry = function ( $title, $raw ) {
	$console->log( 'WHITELIST ENTRY:'::cyan . '' );
	$console->log( 'testWhiteList['
.			json_encode( $title ) . '] = '
.			json_encode( $raw ) . ";\n"
	);
};

/**
 * @param {Object} stats
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {string} title
 * @param {Object} actual
 * @param {Object} expected
 * @param {boolean} expectFail Whether this test was expected to fail (on blacklist).
 * @param {boolean} failureOnly Whether we should print only a failure message, or go on to print the diff.
 * @param {Object} bl BlackList.
 * @return {boolean} True if the failure was expected.
 */
$printFailure = function ( $stats, $item, $options, $mode, $title, $actual, $expected, $expectFail, $failureOnly, $bl ) use ( &$ScriptUtils, &$prettyPrintIOptions, &$printWhitelistEntry ) {
	$stats->failedTests++;
	$stats->modes[ $mode ]->failedTests++;
	$fail = [
		'title' => $title,
		'raw' => ( $actual ) ? $actual->raw : null,
		'expected' => ( $expected ) ? $expected->raw : null,
		'actualNormalized' => ( $actual ) ? $actual->normal : null
	];
	$stats->modes[ $mode ]->failList[] = $fail;

	$mstr = ( $item->options->langconv ) ? 'wt2html+langconv' : $mode;
	$extTitle = str_replace(
		"\n", ' ', ( $title + ( ( $mstr ) ? ( ' (' . $mstr . ')' ) : '' ) ) )
	;

	$blacklisted = false;
	if ( ScriptUtils::booleanOption( $options->blacklist ) && $expectFail ) {
		// compare with remembered output
		$normalizeAbout = function ( $s ) {return  preg_replace( "/(about=\\\\?[\"']#mwt)\\d+/", '$1', $s ); };
		if ( $normalizeAbout( $bl[ $title ][ $mode ] ) !== $normalizeAbout( $actual->raw ) ) {
			$blacklisted = true;
		} else {
			if ( !ScriptUtils::booleanOption( $options->quiet ) ) {
				$console->log( 'EXPECTED FAIL'::red . ': ' . $extTitle->yellow );
			}
			return true;
		}
	}

	$stats->failedTestsUnexpected++;
	$stats->modes[ $mode ]->failedTestsUnexpected++;
	$fail->unexpected = true;

	if ( !$failureOnly ) {
		$console->log( '=====================================================' );
	}

	$console->log( 'UNEXPECTED FAIL'::red::inverse . ': ' . $extTitle->yellow );

	if ( $blacklisted ) {
		$console->log( 'Blacklisted, but the output changed!'::red );
	}

	if ( $mode === 'selser' ) {
		if ( $item->hasOwnProperty( 'wt2wtPassed' ) && $item->wt2wtPassed ) {
			$console->log( 'Even worse, the non-selser wt2wt test passed!'::red );
		} elseif ( $actual && $item->hasOwnProperty( 'wt2wtResult' )
&&				$item->wt2wtResult !== $actual->raw
		) {
			$console->log( 'Even worse, the non-selser wt2wt test had a different result!'::red );
		}
	}

	if ( !$failureOnly ) {
		$console->log( implode( "\n", $item->comments ) );
		if ( $options ) {
			$console->log( 'OPTIONS'::cyan . ':' );
			$console->log( $prettyPrintIOptions( $item->options ) . "\n" );
		}
		$console->log( 'INPUT'::cyan . ':' );
		$console->log( $actual->input . "\n" );
		$console->log( $options->getActualExpected( $actual, $expected, $options->getDiff ) );
		if ( ScriptUtils::booleanOption( $options->printwhitelist ) ) {
			$printWhitelistEntry( $title, $actual->raw );
		}
	}

	return false;
};

/**
 * @param {Object} stats
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {string} title
 * @param {boolean} expectSuccess Whether this success was expected (or was this test blacklisted?).
 * @param {boolean} isWhitelist Whether this success was due to a whitelisting.
 * @return {boolean} True if the success was expected.
 */
$printSuccess = function ( $stats, $item, $options, $mode, $title, $expectSuccess, $isWhitelist ) use ( &$ScriptUtils ) {
	$quiet = ScriptUtils::booleanOption( $options->quiet );
	if ( $isWhitelist ) {
		$stats->passedTestsWhitelisted++;
		$stats->modes[ $mode ]->passedTestsWhitelisted++;
	} else {
		$stats->passedTests++;
		$stats->modes[ $mode ]->passedTests++;
	}
	$mstr = ( $item->options->langconv ) ? 'wt2html+langconv' : $mode;
	$extTitle = str_replace(
		"\n", ' ', ( $title + ( ( $mstr ) ? ( ' (' . $mstr . ')' ) : '' ) ) )
	;

	if ( ScriptUtils::booleanOption( $options->blacklist ) && !$expectSuccess ) {
		$stats->passedTestsUnexpected++;
		$stats->modes[ $mode ]->passedTestsUnexpected++;
		$console->log( 'UNEXPECTED PASS'::green::inverse
+				( ( $isWhitelist ) ? ' (whitelist)' : '' )
.				':' . $extTitle->yellow
		);
		return false;
	}
	if ( !$quiet ) {
		$outStr = 'EXPECTED PASS';

		if ( $isWhitelist ) {
			$outStr += ' (whitelist)';
		}

		$outStr = $outStr->green . ': ' . $extTitle->yellow;

		$console->log( $outStr );

		if ( $mode === 'selser' && $item->hasOwnProperty( 'wt2wtPassed' )
&&				!$item->wt2wtPassed
		) {
			$console->log( 'Even better, the non-selser wt2wt test failed!'::red );
		}
	}
	return true;
};

/**
 * Print the actual and expected outputs.
 *
 * @param {Object} actual
 * @param {string} actual.raw
 * @param {string} actual.normal
 * @param {Object} expected
 * @param {string} expected.raw
 * @param {string} expected.normal
 * @param {Function} getDiff Returns a string showing the diff(s) for the test.
 * @param {Object} getDiff.actual
 * @param {Object} getDiff.expected
 * @return {string}
 */
$getActualExpected = function ( $actual, $expected, $getDiff ) use ( &$colors ) {
	$mkVisible =
	function ( $s ) {return  preg_replace( '/\xA0/', "␣"->white, preg_replace( '/\n/', "↵\n"->white, $s ) ); };
	if ( colors::mode === 'none' ) {
		$mkVisible = function ( $s ) {return  $s; };
	}
	$returnStr = '';
	$returnStr += 'RAW EXPECTED'::cyan . ":\n";
	$returnStr += $expected->raw . "\n";

	$returnStr += 'RAW RENDERED'::cyan . ":\n";
	$returnStr += $actual->raw . "\n";

	$returnStr += 'NORMALIZED EXPECTED'::magenta . ":\n";
	$returnStr += $mkVisible( $expected->normal ) . "\n";

	$returnStr += 'NORMALIZED RENDERED'::magenta . ":\n";
	$returnStr += $mkVisible( $actual->normal ) . "\n";

	$returnStr += 'DIFF'::cyan . ":\n";
	$returnStr += $getDiff( $actual, $expected );

	return $returnStr;
};

/**
 * @param {Object} actual
 * @param {string} actual.normal
 * @param {Object} expected
 * @param {string} expected.normal
 * @return {string} Colorized diff
 */
$doDiff = function ( $actual, $expected ) use ( &$Diff, &$colors ) {
	// safe to always request color diff, because we set color mode='none'
	// if colors are turned off.
	$e = preg_replace( '/\xA0/', "␣", $expected->normal );
	$a = preg_replace( '/\xA0/', "␣", $actual->normal );
	return Diff::colorDiff( $e, $a, [
			'context' => 2,
			'noColor' => ( colors::mode === 'none' )
		]
	);
};

/**
 * @param {Function} reportFailure
 * @param {Function} reportSuccess
 * @param {Object} bl BlackList.
 * @param {Object} wl WhiteList.
 * @param {Object} stats
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Object} expected
 * @param {Object} actual
 * @param {Function} pre
 * @param {Function} post
 * @return {boolean} True if the result was as expected.
 */
function printResult( $reportFailure, $reportSuccess, $bl, $wl, $stats, $item, $options, $mode, $expected, $actual, $pre, $post ) {
	global $ScriptUtils;
	global $TestUtils;
	global $DOMUtils;
	$title = $item->title; // Title may be modified here, so pass it on.

	$quick = ScriptUtils::booleanOption( $options->quick );
	$parsoidOnly =
	( isset( $item[ 'html/parsoid' ] ) ) || ( $item->options->parsoid !== null );

	if ( $mode === 'selser' ) {
		$title += ' ' . ( ( $item->changes ) ? json_encode( $item->changes ) : 'manual' );
	}

	$whitelist = false;
	$tb = $bl[ $title ];
	$expectFail = ( $tb && $tb->hasOwnProperty( $mode ) );
	$fail = ( $expected->normal !== $actual->normal );
	// Return whether the test was as expected, independent of pass/fail
	$asExpected = null;

	if ( $fail
&&			ScriptUtils::booleanOption( $options->whitelist )
&&			isset( $wl[ $title ] )
&&			TestUtils::normalizeOut( DOMUtils::parseHTML( $wl[ $title ] )->body, [ 'parsoidOnly' => $parsoidOnly ] ) === $actual->normal
	) {
		$whitelist = true;
		$fail = false;
	}

	if ( $mode === 'wt2wt' ) {
		$item->wt2wtPassed = !$fail;
		$item->wt2wtResult = $actual->raw;
	}

	// don't report selser fails when nothing was changed or it's a dup
	if ( $mode === 'selser' && ( $item->changes === 0 || $item->duplicateChange ) ) {
		return true;
	}

	if ( gettype( $pre ) === 'function' ) {
		$pre( $stats, $mode, $title, $item->time );
	}

	if ( $fail ) {
		$asExpected = $reportFailure( $stats, $item, $options, $mode, $title, $actual, $expected, $expectFail, $quick, $bl );
	} else {
		$asExpected = $reportSuccess( $stats, $item, $options, $mode, $title, !$expectFail, $whitelist );
	}

	if ( gettype( $post ) === 'function' ) {
		$post( $stats, $mode );
	}

	return $asExpected;
}

$_reportOnce = false;
/**
 * Simple function for reporting the start of the tests.
 *
 * This method can be reimplemented in the options of the ParserTests object.
 */
$reportStartOfTests = function () use ( &$_reportOnce ) {
	if ( !$_reportOnce ) {
		$_reportOnce = true;
		$console->log( 'ParserTests running with node', $process->version );
		$console->log( 'Initialization complete. Now launching tests.' );
	}
};

/**
 * Get the actual and expected outputs encoded for XML output.
 *
 * @inheritdoc getActualExpected
 *
 * @return {string} The XML representation of the actual and expected outputs.
 */
$getActualExpectedXML = function ( $actual, $expected, $getDiff ) use ( &$TestUtils ) {
	$returnStr = '';

	$returnStr += "RAW EXPECTED:\n";
	$returnStr += TestUtils::encodeXml( $expected->raw ) . "\n\n";

	$returnStr += "RAW RENDERED:\n";
	$returnStr += TestUtils::encodeXml( $actual->raw ) . "\n\n";

	$returnStr += "NORMALIZED EXPECTED:\n";
	$returnStr += TestUtils::encodeXml( $expected->normal ) . "\n\n";

	$returnStr += "NORMALIZED RENDERED:\n";
	$returnStr += TestUtils::encodeXml( $actual->normal ) . "\n\n";

	$returnStr += "DIFF:\n";
	$returnStr += TestUtils::encodeXml( $getDiff( $actual, $expected, false ) );

	return $returnStr;
};

/**
 * Report the start of the tests output.
 *
 * @inheritdoc reportStart
 */
$reportStartXML = function () {};

/**
 * Report the end of the tests output.
 *
 * @inheritdoc reportSummary
 */
$reportSummaryXML = function ( $modesRan, $stats, $file, $loggedErrorCount, $testFilter, $blacklistChanged ) {
	if ( $file === null ) {
		/* Summary for all tests; not included in XML format output. */
		return;
	}
	$console->log( '<testsuites file="' . $file . '">' );
	for ( $i = 0;  $i < count( $modesRan );  $i++ ) {
		$mode = $modesRan[ $i ];
		$console->log( '<testsuite name="parserTests-' . $mode . '">' );
		$console->log( $stats->modes[ $mode ]->result );
		$console->log( '</testsuite>' );
	}
	$console->log( '</testsuites>' );
};

/**
 * Print a failure message for a test in XML.
 *
 * @inheritdoc printFailure
 */
$reportFailureXML = function ( $stats, $item, $options, $mode, $title, $actual, $expected, $expectFail, $failureOnly, $bl ) use ( &$ScriptUtils, &$getActualExpectedXML ) {
	$stats->failedTests++;
	$stats->modes[ $mode ]->failedTests++;
	$failEle = '';
	$blacklisted = false;
	if ( ScriptUtils::booleanOption( $options->blacklist ) && $expectFail ) {
		// compare with remembered output
		$blacklisted = ( $bl[ $title ][ $mode ] === $actual->raw );
	}
	if ( !$blacklisted ) {
		$failEle += "<failure type=\"parserTestsDifferenceInOutputFailure\">\n";
		$failEle += $getActualExpectedXML( $actual, $expected, $options->getDiff );
		$failEle += "\n</failure>";
		$stats->failedTestsUnexpected++;
		$stats->modes[ $mode ]->failedTestsUnexpected++;
		$stats->modes[ $mode ]->result += $failEle;
	}
};

/**
 * Print a success method for a test in XML.
 *
 * @inheritdoc printSuccess
 */
$reportSuccessXML = function ( $stats, $item, $options, $mode, $title, $expectSuccess, $isWhitelist ) {
	if ( $isWhitelist ) {
		$stats->passedTestsWhitelisted++;
		$stats->modes[ $mode ]->passedTestsWhitelisted++;
	} else {
		$stats->passedTests++;
		$stats->modes[ $mode ]->passedTests++;
	}
};

/**
 * Print the result of a test in XML.
 *
 * @inheritdoc printResult
 */
$reportResultXML = function () use ( &$TestUtils, &$reportFailureXML, &$reportSuccessXML ) {
	function pre( $stats, $mode, $title, $time ) use ( &$TestUtils ) {
		$testcaseEle = null;
		$testcaseEle = '<testcase name="' . TestUtils::encodeXml( $title ) . '" ';
		$testcaseEle += 'assertions="1" ';

		$timeTotal = null;
		if ( $time && $time->end && $time->start ) {
			$timeTotal = $time->end - $time->start;
			if ( !isNaN( $timeTotal ) ) {
				$testcaseEle += 'time="' . ( ( $time->end - $time->start ) / 1000.0 ) . '"';
			}
		}

		$testcaseEle += '>';
		$stats->modes[ $mode ]->result += $testcaseEle;
	}

	function post( $stats, $mode ) {
		$stats->modes[ $mode ]->result += '</testcase>';
	}

	$args = Array::from( $arguments );
	$args = [ $reportFailureXML, $reportSuccessXML ]->concat( $args, $pre, $post );
	call_user_func_array( 'printResult', $args );

	// In xml, test all cases always
	return true;
};

/**
 * Get the options from the command line.
 *
 * @return {Object}
 */
$getOpts = function () use ( &$ScriptUtils, &$yargs ) {
	$standardOpts = ScriptUtils::addStandardOptions( [
			'wt2html' => [
				'description' => 'Wikitext -> HTML(DOM)',
				'default' => false,
				'boolean' => true
			],
			'html2wt' => [
				'description' => 'HTML(DOM) -> Wikitext',
				'default' => false,
				'boolean' => true
			],
			'wt2wt' => [
				'description' => 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext',
				'default' => false,
				'boolean' => true
			],
			'html2html' => [
				'description' => 'Roundtrip testing: HTML(DOM) -> Wikitext -> HTML(DOM)',
				'default' => false,
				'boolean' => true
			],
			'selser' => [
				'description' => 'Roundtrip testing: Wikitext -> DOM(HTML) -> Wikitext (with selective serialization). '
.					'Set to "noauto" to just run the tests with manual selser changes.',
				'boolean' => false
			],
			'changetree' => [
				'description' => 'Changes to apply to parsed HTML to generate new HTML to be serialized (useful with selser)',
				'default' => null,
				'boolean' => false
			],
			'numchanges' => [
				'description' => 'Make multiple different changes to the DOM, run a selser test for each one.',
				'default' => 20,
				'boolean' => false
			],
			'cache' => [
				'description' => 'Get tests cases from cache file',
				'boolean' => true,
				'default' => false
			],
			'filter' => [
				'description' => 'Only run tests whose descriptions match given string'
			],
			'regex' => [
				'description' => 'Only run tests whose descriptions match given regex',
				'alias' => [ 'regexp', 're' ]
			],
			'run-disabled' => [
				'description' => 'Run disabled tests',
				'default' => false,
				'boolean' => true
			],
			'run-php' => [
				'description' => 'Run php-only tests',
				'default' => false,
				'boolean' => true
			],
			'maxtests' => [
				'description' => 'Maximum number of tests to run',
				'boolean' => false
			],
			'quick' => [
				'description' => 'Suppress diff output of failed tests',
				'boolean' => true,
				'default' => false
			],
			'quiet' => [
				'description' => 'Suppress notification of passed tests (shows only failed tests)',
				'boolean' => true,
				'default' => false
			],
			'whitelist' => [
				'description' => 'Compare against manually verified parser output from whitelist',
				'default' => true,
				'boolean' => true
			],
			'printwhitelist' => [
				'description' => 'Print out a whitelist entry for failing tests. Default false.',
				'default' => false,
				'boolean' => true
			],
			'blacklist' => [
				'description' => 'Compare against expected failures from blacklist',
				'default' => true,
				'boolean' => true
			],
			'rewrite-blacklist' => [
				'description' => 'Update parserTests-blacklist.js with failing tests.',
				'default' => false,
				'boolean' => true
			],
			'exit-zero' => [
				'description' => "Don't exit with nonzero status if failures are found.",
				'default' => false,
				'boolean' => true
			],
			'xml' => [
				'description' => 'Print output in JUnit XML format.',
				'default' => false,
				'boolean' => true
			],
			'exit-unexpected' => [
				'description' => 'Exit after the first unexpected result.',
				'default' => false,
				'boolean' => true
			],
			'update-tests' => [
				'description' => 'Update parserTests.txt with results from wt2html fails.'
			],
			'update-unexpected' => [
				'description' => 'Update parserTests.txt with results from wt2html unexpected fails.',
				'default' => false,
				'boolean' => true
			]
		], [
			// override defaults for standard options
			'fetchTemplates' => false,
			'usePHPPreProcessor' => false,
			'fetchConfig' => false
		]
	);

	return yargs::
	usage( 'Usage: $0 [options] [tests-file]' )->
	options( $standardOpts )->
	check( function ( $argv, $aliases ) {
			if ( $argv->filter === true ) {
				throw '--filter needs an argument';
			}
			if ( $argv->regex === true ) {
				throw '--regex needs an argument';
			}
			return true;
		}
	)->
	strict();
};

TestUtils::prepareOptions = function () use ( &$getOpts, &$ScriptUtils, &$reportResultXML, &$reportStartXML, &$reportSummaryXML, &$reportFailureXML, &$colors, &$printFailure, &$printSuccess, &$reportStartOfTests, &$reportSummary, &$doDiff, &$getActualExpected ) {
	$popts = $getOpts();
	$options = $popts->argv;

	if ( $options->help ) {
		$popts->showHelp();
		$console->log( 'Additional dump options specific to parserTests script:' );
		$console->log( "* dom:post-changes  : Dumps DOM after applying selser changetree\n" );
		$console->log( 'Examples' );
		$console->log( "\$ node parserTests --selser --filter '...' --dump dom:post-changes" );
		$console->log( "\$ node parserTests --selser --filter '...' --changetree '...' --dump dom:post-changes\n" );
		$process->exit( 0 );
	}

	ScriptUtils::setColorFlags( $options );

	if ( !( $options->wt2wt || $options->wt2html || $options->html2wt || $options->html2html || $options->selser ) ) {
		$options->wt2wt = true;
		$options->wt2html = true;
		$options->html2html = true;
		$options->html2wt = true;
		if ( ScriptUtils::booleanOption( $options[ 'rewrite-blacklist' ] ) ) {
			// turn on all modes by default for --rewrite-blacklist
			$options->selser = true;
			// sanity checking (T53448 asks to be able to use --filter here)
			if ( $options->filter || $options->regex || $options->maxtests || $options[ 'exit-unexpected' ] ) {
				$console->log( "\nERROR> can't combine --rewrite-blacklist with --filter, --maxtests or --exit-unexpected" );
				$process->exit( 1 );
			}
		}
	}

	if ( $options->xml ) {
		$options->reportResult = $reportResultXML;
		$options->reportStart = $reportStartXML;
		$options->reportSummary = $reportSummaryXML;
		$options->reportFailure = $reportFailureXML;
		colors::mode = 'none';
	}

	if ( gettype( $options->reportFailure ) !== 'function' ) {
		// default failure reporting is standard out,
		// see printFailure for documentation of the default.
		$options->reportFailure = $printFailure;
	}

	if ( gettype( $options->reportSuccess ) !== 'function' ) {
		// default success reporting is standard out,
		// see printSuccess for documentation of the default.
		$options->reportSuccess = $printSuccess;
	}

	if ( gettype( $options->reportStart ) !== 'function' ) {
		// default summary reporting is standard out,
		// see reportStart for documentation of the default.
		$options->reportStart = $reportStartOfTests;
	}

	if ( gettype( $options->reportSummary ) !== 'function' ) {
		// default summary reporting is standard out,
		// see reportSummary for documentation of the default.
		$options->reportSummary = $reportSummary;
	}

	if ( gettype( $options->reportResult ) !== 'function' ) {
		// default result reporting is standard out,
		// see printResult for documentation of the default.
		$options->reportResult = function ( ...$args ) use ( &$options ) {return  printResult( $options->reportFailure, $options->reportSuccess, ...$args ); };
	}

	if ( gettype( $options->getDiff ) !== 'function' ) {
		// this is the default for diff-getting, but it can be overridden
		// see doDiff for documentation of the default.
		$options->getDiff = $doDiff;
	}

	if ( gettype( $options->getActualExpected ) !== 'function' ) {
		// this is the default for getting the actual and expected
		// outputs, but it can be overridden
		// see getActualExpected for documentation of the default.
		$options->getActualExpected = $getActualExpected;
	}

	$options->modes = [];

	if ( $options->wt2html ) {
		$options->modes[] = 'wt2html';
	}
	if ( $options->wt2wt ) {
		$options->modes[] = 'wt2wt';
	}
	if ( $options->html2html ) {
		$options->modes[] = 'html2html';
	}
	if ( $options->html2wt ) {
		$options->modes[] = 'html2wt';
	}
	if ( $options->selser ) {
		$options->modes[] = 'selser';
	}

	return $options;
};

// Hard-code some interwiki prefixes, as is done
// in parserTest.inc:setupInterwikis()
TestUtils::iwl = [
	'local' => [
		'url' => 'http://doesnt.matter.org/$1',
		'localinterwiki' => ''
	],
	'wikipedia' => [
		'url' => 'http://en.wikipedia.org/wiki/$1'
	],
	'meatball' => [
		// this has been updated in the live wikis, but the parser tests
		// expect the old value (as set in parserTest.inc:setupInterwikis())
		'url' => 'http://www.usemod.com/cgi-bin/mb.pl?$1'
	],
	'memoryalpha' => [
		'url' => 'http://www.memory-alpha.org/en/index.php/$1'
	],
	'zh' => [
		'url' => 'http://zh.wikipedia.org/wiki/$1',
		'language' => "中文",
		'local' => ''
	],
	'es' => [
		'url' => 'http://es.wikipedia.org/wiki/$1',
		'language' => "español",
		'local' => ''
	],
	'fr' => [
		'url' => 'http://fr.wikipedia.org/wiki/$1',
		'language' => "français",
		'local' => ''
	],
	'ru' => [
		'url' => 'http://ru.wikipedia.org/wiki/$1',
		'language' => "русский",
		'local' => ''
	],
	'mi' => [
		'url' => 'http://mi.wikipedia.org/wiki/$1',
		// better for testing if one of the
		// localinterwiki prefixes is also a
		// language
		'language' => 'Test',
		'local' => '',
		'localinterwiki' => ''
	],
	'mul' => [
		'url' => 'http://wikisource.org/wiki/$1',
		'extralanglink' => '',
		'linktext' => 'Multilingual',
		'sitename' => 'WikiSource',
		'local' => ''
	],
	// not in PHP setupInterwikis(), but needed
	'en' => [
		'url' => 'http://en.wikipedia.org/wiki/$1',
		'language' => 'English',
		'local' => '',
		'protorel' => ''
	],
	'stats' => [
		'local' => '',
		'url' => 'https://stats.wikimedia.org/$1'
	],
	'gerrit' => [
		'local' => '',
		'url' => 'https://gerrit.wikimedia.org/$1'
	]
];

TestUtils::addNamespace = function ( $wikiConf, $name ) use ( &$Util ) {
	$nsid = $name->id;
	$old = $wikiConf->siteInfo->namespaces[ $nsid ];
	if ( $old ) { // Id may already be defined; if so, clear it.
		if ( $old === $name ) { return;  }// ParserTests does a lot redundantly.
		$wikiConf->namespaceIds->delete( Util::normalizeNamespaceName( $old[ '*' ] ) );
		$wikiConf->canonicalNamespaces[ Util::normalizeNamespaceName( ( $old->canonical ) ? $old->canonical : $old[ '*' ] ) ] = null;
	}
	$wikiConf->namespaceNames[ $nsid ] = $name[ '*' ];
	$wikiConf->namespaceIds->set( Util::normalizeNamespaceName( $name[ '*' ] ), Number( $nsid ) );
	$wikiConf->canonicalNamespaces[ Util::normalizeNamespaceName( ( $name->canonical ) ? $name->canonical : $name[ '*' ] ) ] = Number( $nsid );
	$wikiConf->namespacesWithSubpages[ $nsid ] = true;
	$wikiConf->siteInfo->namespaces[ $nsid ] = $name;
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->TestUtils = $TestUtils;
}
