<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/*
 * Parsoid test runner
 *
 * This pulls all the parserTests.txt items and runs them through Parsoid.
 */

namespace Parsoid;




use Parsoid\cluster as cluster;
cluster::schedulingPolicy = cluster\SCHED_NONE;

$serviceWrapper = require( '../tests/serviceWrapper.js' );
$fs = require( 'pn/fs' );
$path = require( 'path' );
$Alea = require( 'alea' );
$ContentUtils = require( '../lib/utils/ContentUtils.js' )::ContentUtils;
$DOMUtils = require( '../lib/utils/DOMUtils.js' )::DOMUtils;
$TestUtils = require( '../tests/TestUtils.js' )::TestUtils;
$WTUtils = require( '../lib/utils/WTUtils.js' )::WTUtils;
$Promise = require( '../lib/utils/promise.js' );
$ParsoidLogger = require( '../lib/logger/ParsoidLogger.js' )::ParsoidLogger;
$PEG = require( 'wikipeg' );
$Util = require( '../lib/utils/Util.js' )::Util;
$ScriptUtils = require( '../tools/ScriptUtils.js' )::ScriptUtils;
$JSUtils = require( '../lib/utils/jsutils.js' )::JSUtils;
$ParsoidExtApi = require( '../lib/config/extapi.js' )->versionCheck( '^0.10.0' );

// Fetch up some of our wacky parser bits...
$MWParserEnvironment = require( '../lib/config/MWParserEnvironment.js' )::MWParserEnvironment;
$ParsoidConfig = require( '../lib/config/ParsoidConfig.js' )::ParsoidConfig;
// be careful to load our extension code with the correct parent module.
$ParserHook = ParsoidConfig::loadExtension(
	$path->resolve( $__dirname, '../tests/parserTestsParserHook.js' )
);

$exitUnexpected = new Error( 'unexpected failure' ); // unique marker value

/**
 * Main class for the test environment.
 *
 * @class
 */
function ParserTests( $testFilePath, $modes ) {
	global $path;
	global $Util;
	$parseFilePath = $path->parse( $testFilePath );
	$this->testFileName = $parseFilePath->base;
	$this->testFilePath = $testFilePath;

	// Name of file used to cache the parser tests cases
	$this->cacheFileName = $parseFilePath->name . '.cache';
	$this->cacheFilePath = $path->resolve( $parseFilePath->dir, $this->cacheFileName );

	$whiteListName = $parseFilePath->name . '-whitelist.js';
	$this->whiteListPath = $path->resolve( $parseFilePath->dir, $whiteListName );
	try {
		$this->testWhiteList = require( $this->whiteListPath )->testWhiteList;
		$console->warn( 'Using whitelist from ' . $this->whiteListPath );
	} catch ( Exception $e ) {
		$this->testWhiteList = [];
	}

	$blackListName = $parseFilePath->name . '-blacklist.js';
	$this->blackListPath = $path->resolve( $parseFilePath->dir, $blackListName );
	try {
		$this->testBlackList = require( $this->blackListPath )->testBlackList;
	} catch ( Exception $e ) {
		$console->warn( 'No blacklist found at ' . $this->blackListPath );
		$this->testBlackList = [];
	}

	$this->articles = [];
	$this->tests = new Set();

	// Test statistics
	$this->stats = [];
	$this->stats->passedTests = 0;
	$this->stats->passedTestsWhitelisted = 0;
	$this->stats->passedTestsUnexpected = 0;
	$this->stats->failedTests = 0;
	$this->stats->failedTestsUnexpected = 0;

	$newModes = [];
	for ( $i = 0;  $i < count( $modes );  $i++ ) {
		$newModes[ $modes[ $i ] ] = Util::clone( $this->stats );
		$newModes[ $modes[ $i ] ]->failList = [];
		$newModes[ $modes[ $i ] ]->result = ''; // XML reporter uses this.
	}
	$this->stats->modes = $newModes;
}

/**
 * Get an object holding our tests cases. Eventually from a cache file
 *
 * @method
 * @param {Object} argv
 * @return {Object}
 */
ParserTests::prototype::getTests = /* async */function ( $argv ) use ( &$fs, &$ScriptUtils ) {
	// Startup by loading .txt test file
	$testFile = /* await */ $fs->readFile( $this->testFilePath, 'utf8' );

	if ( !ScriptUtils::booleanOption( $argv->cache ) ) {
		// Cache not wanted, parse file and return object
		return $this->parseTestCase( $testFile );
	}

	// Track files imported / required
	// Track files imported / required
	$fileDependencies = [
		$this->testFilePath,
		$this->testParserFilePath
	];

	// Find out modification time of all files dependencies and then hash those
	// to make a unique value using sha1.
	// Find out modification time of all files dependencies and then hash those
	// to make a unique value using sha1.
	$mtimes = implode(



		'|', array_map( ( /* await */ Promise::all(
				array_map( $fileDependencies->sort(), function ( $file ) {
						return $fs->stat( $file );
					}
				)

			)
			), function ( $stat ) { return $stat->mtime;  }
		)
	);

	$sha1 = require( 'crypto' )->
	createHash( 'sha1' )->
	update( $mtimes )->
	digest( 'hex' );

	// Look for a cacheFile
	// Look for a cacheFile
	$cacheContent = null;
	$cacheFileDigest = null;
	try {
		$cacheContent = /* await */ $fs->readFile( $this->cacheFilePath, 'utf8' );
		// Fetch previous digest
		// Fetch previous digest
		$cacheFileDigest = preg_match( '/^CACHE: (\w+)\n/', $cacheContent )[ 1 ];
	} catch ( Exception $e4 ) {

		// cache file does not exist
	}// cache file does not exist


	if ( $cacheFileDigest === $sha1 ) {
		// cache file match our digest.
		// Return contained object after removing first line (CACHE: <sha1>)
		return json_decode( preg_replace( '/^.*\n/', '', $cacheContent, 1 ) );
	} else {
		// Write new file cache, content preprended with current digest
		$console->error( 'Cache file either not present or outdated' );
		$parse = $this->parseTestCase( $testFile );
		/* await */ $fs->writeFile( $this->cacheFilePath,
			'CACHE: ' . $sha1 . "\n" . json_encode( $parse ),
			'utf8'
		);
		// We can now return the parsed object
		// We can now return the parsed object
		return $parse;
	}
}





















































;

/**
 * Parse content of tests case file given as plaintext.
 *
 * @param {string} content
 * @return {Array}
 */
ParserTests::prototype::parseTestCase = function ( $content ) {
	return $this->testParser->parse( $content );
};

/**
 * Convert a DOM to Wikitext.
 *
 * @method
 * @param {Object} options
 * @param {string} mode
 * @param {Object} item
 * @param {Node} body
 * @return {Promise} a promise which will resolve to the wikitext
 */
ParserTests::prototype::convertHtml2Wt = /* async */function ( $options, $mode, $item, $body ) {
	try {
		$startsAtWikitext = $mode === 'wt2wt' || $mode === 'wt2html' || $mode === 'selser';
		if ( $startsAtWikitext ) {
			// FIXME: All tests share an env.
			// => we need to initialize this each time over here.
			$this->env->page->dom = $this->env->createDocument( $item->cachedBODYstr )->body;
		}
		if ( $mode === 'selser' ) {
			$this->env->setPageSrcInfo( $item->wikitext );
		} else {
			$this->env->setPageSrcInfo( null );
		}
		$handler = $this->env->getContentHandler();
		// yield and then return so our finally gets a chance to catch any
		// exceptions thrown.
		// yield and then return so our finally gets a chance to catch any
		// exceptions thrown.
		return ( /* await */ $handler->fromHTML( $this->env, $body, ( $mode === 'selser' ) ) );
	} finally {
		$this->env->setPageSrcInfo( null );
		$this->env->page->dom = null;
	}
}




















;

/**
 * For a selser test, check if a change we could make has already been
 * tested in this round.
 * Used for generating unique tests.
 *
 * @param {Array} allChanges Already-tried changes.
 * @param {Array} change Candidate change.
 * @return {boolean}
 */
ParserTests::prototype::isDuplicateChangeTree = function ( $allChanges, $change ) use ( &$JSUtils ) {
	if ( !is_array( $allChanges ) ) {
		return false;
	}

	$i = null;
	for ( $i = 0;  $i < count( $allChanges );  $i++ ) {
		if ( JSUtils::deepEquals( $allChanges[ $i ], $change ) ) {
			return true;
		}
	}
	return false;
};

// Random string used as selser comment content
$staticRandomString = 'ahseeyooxooZ8Oon0boh';

/**
 * Make changes to a DOM in order to run a selser test on it.
 *
 * @param {Object} item
 * @param {Node} body
 * @param {Array} changelist
 * @return {Node} The altered body.
 */
ParserTests::prototype::applyChanges = function ( $item, $body, $changelist ) use ( &$Alea, &$WTUtils, &$DOMUtils, &$ContentUtils, &$staticRandomString ) {

	// Seed the random-number generator based on the item title
	$random = new Alea( ( $item->seed || '' ) + ( $item->title || '' ) );

	// Keep the changes in the item object
	// to check for duplicates while building tasks
	$item->changes = $changelist;

	// Helper function for getting a random string
	function randomString() use ( &$random ) {
		return $random->uint32()->toString( 36 );
	}

	function insertNewNode( $n ) use ( &$WTUtils, &$DOMUtils ) {
		// Insert a text node, if not in a fosterable position.
		// If in foster position, enter a comment.
		// In either case, dom-diff should register a new node
		$str = randomString();
		$ownerDoc = $n->ownerDocument;
		$wrapperName = null;
		$newNode = null;

		// Don't separate legacy IDs from their H? node.
		if ( WTUtils::isFallbackIdSpan( $n ) ) {
			$n = $n->nextSibling || $n->parentNode;
		}

		// For these container nodes, it would be buggy
		// to insert text nodes as children
		switch ( $n->parentNode->nodeName ) {
			case 'OL':

			case 'UL':
			$wrapperName = 'LI'; break;
			case 'DL':
			$wrapperName = 'DD'; break;
			case 'TR':
			$prev = $n->previousElementSibling;
			if ( $prev ) {
				// TH or TD
				$wrapperName = $prev->nodeName;
			} else {
				$next = $n->nextElementSibling;
				if ( $next ) {
					// TH or TD
					$wrapperName = $next->nodeName;
				} else {
					$wrapperName = 'TD';
				}
			}
			break;
			case 'BODY':
			$wrapperName = 'P'; break;
			default:
			if ( WTUtils::isBlockNodeWithVisibleWT( $n ) ) {
				$wrapperName = 'P';
			}
			break;
		}

		if ( DOMUtils::isFosterablePosition( $n ) && $n->parentNode->nodeName !== 'TR' ) {
			$newNode = $ownerDoc->createComment( $str );
		} elseif ( $wrapperName ) {
			$newNode = $ownerDoc->createElement( $wrapperName );
			$newNode->appendChild( $ownerDoc->createTextNode( $str ) );
		} else {
			$newNode = $ownerDoc->createTextNode( $str );
		}

		$n->parentNode->insertBefore( $newNode, $n );
	}

	$removeNode = function ( $n ) {
		$n->parentNode->removeChild( $n );
	};

	$applyChangesInternal = function ( $node, $changes ) use ( &$applyChangesInternal, &$DOMUtils, &$removeNode ) {
		if ( !$node ) {
			// FIXME: Generate change assignments dynamically
			$this->env->log( 'error', 'no node in applyChangesInternal, ',
				'HTML structure likely changed'
			);
			return;
		}

		// Clone the array since it could be modified below
		$nodes = Array::from( $node->childNodes );

		for ( $i = 0;  $i < count( $changes );  $i++ ) {
			$child = $nodes[ $i ];
			$change = $changes[ $i ];

			if ( is_array( $change ) ) {
				$applyChangesInternal( $child, $change );
			} else {
				switch ( $change ) {
					// No change
					case 0:
					break;

					// Change node wrapper
					// (sufficient to insert a random attr)

					case 1:
					if ( DOMUtils::isElt( $child ) ) {
						$child->setAttribute( 'data-foobar', randomString() );
					} else {
						$this->env->log( 'error', 'Buggy changetree. changetype 1 (modify attribute) cannot be applied on text/comment nodes.' );
					}
					break;

					// Insert new node before child

					case 2:
					insertNewNode( $child );
					break;

					// Delete tree rooted at child

					case 3:
					$removeNode( $child );
					break;

					// Change tree rooted at child

					case 4:
					insertNewNode( $child );
					$removeNode( $child );
					break;
				}

			}
		}
	};

	if ( $this->env->conf->parsoid->dumpFlags
&&			$this->env->conf->parsoid->dumpFlags->has( 'dom:post-changes' )
	) {
		ContentUtils::dumpDOM( $body, 'Original DOM' );
	}

	if ( $item->changes === 5 ) {
		// Hack so that we can work on the parent node rather than just the
		// children: Append a comment with known content. This is later
		// stripped from the output, and the result is compared to the
		// original wikitext rather than the non-selser wt2wt result.
		$body->appendChild( $body->ownerDocument->createComment( $staticRandomString ) );
	} elseif ( $item->changes !== 0 ) {
		$applyChangesInternal( $body, $item->changes );
	}

	if ( $this->env->conf->parsoid->dumpFlags
&&			$this->env->conf->parsoid->dumpFlags->has( 'dom:post-changes' )
	) {
		$console->warn( 'Change tree : ' . json_encode( $item->changes ) );
		ContentUtils::dumpDOM( $body, 'Edited DOM' );
	}

	return $body;
};

/**
 * Generate a change object for a document, so we can apply it during a selser test.
 *
 * @param {Object} options
 * @param {Object} item
 * @param {Node} body
 * @return {Object} The body and change tree.
 * @return {Node} [return.body] The altered body.
 * @return {Array} [return.changeTree] The list of changes.
 */
ParserTests::prototype::generateChanges = function ( $options, $item, $body ) use ( &$Alea, &$DOMUtils, &$WTUtils ) {
	$random = new Alea( ( $item->seed || '' ) + ( $item->title || '' ) );

	/**
	 * If no node in the DOM subtree rooted at 'node' is editable in the VE,
	 * this function should return false.
	 *
	 * Currently true for template and extension content, and for entities.
	 */
	function domSubtreeIsEditable( $env, $node ) use ( &$DOMUtils, &$WTUtils ) {
		return !DOMUtils::isElt( $node )
||			( !WTUtils::isEncapsulationWrapper( $node )
&&				$node->getAttribute( 'typeof' ) !== 'mw:Entity'
&&				// Deleting these div wrappers is tantamount to removing the
				// reference tag encaption wrappers, which results in errors.
				!preg_match( '/\bmw-references-wrap\b/', $node->getAttribute( 'class' ) ) );
	}

	/**
	 * Even if a DOM subtree might be editable in the VE,
	 * certain nodes in the DOM might not be directly editable.
	 *
	 * Currently, this restriction is only applied to DOMs generated for images.
	 * Possibly, there are other candidates.
	 */
	function nodeIsUneditable( $node ) use ( &$DOMUtils ) {
		// Text and comment nodes are always editable
		if ( !DOMUtils::isElt( $node ) ) {
			return false;
		}

		// - Meta tag providing info about tpl-affected attrs is uneditable.
		//
		//   SSS FIXME: This is not very useful right now because sometimes,
		//   these meta-tags are not siblings with the element that it applies to.
		//   So, you can still end up deleting the meta-tag (by deleting its parent)
		//   and losing this property.  See example below.  The best fix for this is
		//   to hoist all these kind of meta tags into <head>, start, or end of doc.
		//   Then, we don't even have to check for editability of these nodes here.
		//
		//   Ex:
		//   ...
		//   <td><meta about="#mwt2" property="mw:objectAttrVal#style" ...>..</td>
		//   <td about="#mwt2" typeof="mw:ExpandedAttrs/Transclusion" ...>..</td>
		//   ...
		if ( preg_match( ( '/\bmw:objectAttr/' ), $node->getAttribute( 'property' ) ) ) {
			return true;
		}

		// - Image wrapper is an uneditable image elt.
		// - Any node nested in an image elt that is not a fig-caption
		//   is an uneditable image elt.
		// - Entity spans are uneditable as well
		return preg_match( ( '/\bmw:(Image|Video|Audio|Entity)\b/' ), $node->getAttribute( 'typeof' ) )
||
			$node->nodeName !== 'FIGCAPTION'
&&				$node->parentNode
&&				$node->parentNode->nodeName !== 'BODY'
&&				nodeIsUneditable( $node->parentNode )
		;
	}

	$hasChangeMarkers = function ( $list ) use ( &$hasChangeMarkers ) {
		// If all recorded changes are 0, then nothing has been modified
		return $list->some( function ( $c ) use ( &$hasChangeMarkers ) {
				return ( is_array( $c ) ) ? $hasChangeMarkers( $c ) : ( $c > 0 );
			}
		);
	};

	$genChangesInternal = function ( $node ) use ( &$random, &$genChangesInternal, &$hasChangeMarkers ) {
		// Seed the random-number generator based on the item title
		$changelist = [];
		$children = $node->childNodes;
		$n = count( $children );

		for ( $i = 0;  $i < $n;  $i++ ) {
			$child = $children[ $i ];
			$changeType = 0;

			if ( domSubtreeIsEditable( $this->env, $child ) ) {
				if ( nodeIsUneditable( $child ) || $random() < 0.5 ) {
					// This call to random is a hack to preserve the current
					// determined state of our blacklist entries after a
					// refactor.
					$random->uint32();
					$changeType = $genChangesInternal( $child );
				} else {
					if ( !$child->setAttribute ) {
						// Text or comment node -- valid changes: 2, 3, 4
						// since we cannot set attributes on these
						$changeType = floor( random() * 3 ) + 2;
					} else {
						$changeType = floor( random() * 4 ) + 1;
					}
				}
			}

			$changelist[] = $changeType;
		}

		return ( $hasChangeMarkers( $changelist ) ) ? $changelist : 0;
	};

	$changeTree = null;
	$numAttempts = 0;
	do {
		$numAttempts++;
		$changeTree = $genChangesInternal( $body );
	} while (
		$numAttempts < 1000
&&			( count( $changeTree ) === 0 || $this->isDuplicateChangeTree( $item->selserChangeTrees, $changeTree ) )
	);

	if ( $numAttempts === 1000 ) {
		// couldn't generate a change ... marking as such
		$item->duplicateChange = true;
	}

	return [ 'body' => $body, 'changeTree' => $changeTree ];
};

/**
 * Apply manually-specified changes, which are provided in a pseudo-jQuery
 * format.
 *
 * @param {Node} body
 * @param {Array} changes
 * @return {Node} The changed body.
 */
ParserTests::prototype::applyManualChanges = function ( $body, $changes ) use ( &$DOMUtils ) {
	$err = null;
	// changes are specified using jquery methods.
	//  [x,y,z...] becomes $(x)[y](z....)
	// that is, ['fig', 'attr', 'width', '120'] is interpreted as
	//   $('fig').attr('width', '120')
	// See http://api.jquery.com/ for documentation of these methods.
	// "contents" as second argument calls the jquery .contents() method
	// on the results of the selector in the first argument, which is
	// a good way to get at the text and comment nodes
	$jquery = [
		'after' => function ( $html ) use ( &$DOMUtils ) {
			$div = null; $tbl = null;
			if ( $this->parentNode->nodeName === 'TBODY' ) {
				$tbl = $this->ownerDocument->createElement( 'table' );
				$tbl->innerHTML = $html;
				// <tbody> is implicitly added when inner html is set to <tr>..</tr>
				DOMUtils::migrateChildren( $tbl->firstChild, $this->parentNode, $this->nextSibling );
			} elseif ( $this->parentNode->nodeName === 'TR' ) {
				$tbl = $this->ownerDocument->createElement( 'table' );
				$tbl->innerHTML = '<tbody><tr></tr></tbody>';
				$tbl->firstChild->firstChild->innerHTML = $html;
				DOMUtils::migrateChildren( $tbl->firstChild->firstChild, $this->parentNode, $this->nextSibling );
			} else {
				$div = $this->ownerDocument->createElement( 'div' );
				$div->innerHTML = $html;
				DOMUtils::migrateChildren( $div, $this->parentNode, $this->nextSibling );
			}
		},
		'attr' => function ( $name, $val ) {
			$this->setAttribute( $name, $val );
		},
		'before' => function ( $html ) use ( &$DOMUtils ) {
			$div = null; $tbl = null;
			if ( $this->parentNode->nodeName === 'TBODY' ) {
				$tbl = $this->ownerDocument->createElement( 'table' );
				$tbl->innerHTML = $html;
				// <tbody> is implicitly added when inner html is set to <tr>..</tr>
				DOMUtils::migrateChildren( $tbl->firstChild, $this->parentNode, $this );
			} elseif ( $this->parentNode->nodeName === 'TR' ) {
				$tbl = $this->ownerDocument->createElement( 'table' );
				$tbl->innerHTML = '<tbody><tr></tr></tbody>';
				$tbl->firstChild->firstChild->innerHTML = $html;
				DOMUtils::migrateChildren( $tbl->firstChild->firstChild, $this->parentNode, $this );
			} else {
				$div = $this->ownerDocument->createElement( 'div' );
				$div->innerHTML = $html;
				DOMUtils::migrateChildren( $div, $this->parentNode, $this );
			}
		},
		'removeAttr' => function ( $name ) {
			$this->removeAttribute( $name );
		},
		'removeClass' => function ( $c ) {
			$this->classList->remove( $c );
		},
		'addClass' => function ( $c ) {
			$this->classList->add( $c );
		},
		'text' => function ( $t ) {
			$this->textContent = $t;
		},
		'html' => function ( $h ) {
			$this->innerHTML = $h;
		},
		'remove' => function ( $optSelector ) use ( &$DOMUtils ) {
			// jquery lets us specify an optional selector to further
			// restrict the removed elements.
			// text nodes don't have the "querySelectorAll" method, so
			// just include them by default (jquery excludes them, which
			// is less useful)
			$what = ( !$optSelector ) ? [ $this ] :
			( !DOMUtils::isElt( $this ) ) ? [ $this ]/* text node hack! */ :
			$this->querySelectorAll( $optSelector );
			Array::from( $what )->forEach( function ( $node ) {
					if ( $node->parentNode ) { $node->parentNode->removeChild( $node );  }
				}
			);
		},
		'empty' => function () {
			while ( $this->firstChild ) {
				$this->removeChild( $this->firstChild );
			}
		},
		'wrap' => function ( $w ) {
			$frag = $this->ownerDocument->createElement( 'div' );
			$frag->innerHTML = $w;
			$first = $frag->firstChild;
			$this->parentNode->replaceChild( $first, $this );
			while ( $first->firstChild ) {
				$first = $first->firstChild;
			}
			$first->appendChild( $this );
		}
	];

	$changes->forEach( function ( $change ) use ( &$err, &$body, &$jquery ) {
			if ( $err ) { return;  }
			if ( count( $change ) < 2 ) {
				$err = new Error( 'bad change: ' . $change );
				return;
			}
			// use document.querySelectorAll as a poor man's $(...)
			$els = $body->querySelectorAll( $change[ 0 ] );
			if ( !count( $els ) ) {
				$err = new Error( $change[ 0 ] . ' did not match any elements: ' . $body->outerHTML );
				return;
			}
			if ( $change[ 1 ] === 'contents' ) {
				$change = array_slice( $change, 1 );
				$els = array_reduce( Array::from( $els ), function ( $acc, $el ) {
						call_user_func_array( [ $acc, 'push' ], $el->childNodes );
						return $acc;
					}, []
				)


				;
			}
			$fun = $jquery[ $change[ 1 ] ];
			if ( !$fun ) {
				$err = new Error( 'bad mutator function: ' . $change[ 1 ] );
				return;
			}
			Array::from( $els )->forEach( function ( $el ) {
					call_user_func_array( 'fun', array_slice( $change, 2 ) );
				}
			);
		}
	);
	if ( $err ) {
		$console->log( $err->toString()->red );
		throw $err;
	}
	return $body;
};

/**
 * Convert a wikitext string to an HTML Node.
 *
 * @method
 * @param {string} mode
 * @param {string} wikitext
 * @return {Promise} a promise returning the body Node.
 */
ParserTests::prototype::convertWt2Html = /* async */function ( $mode, $wikitext ) {
	$env = $this->env;
	$env->setPageSrcInfo( $wikitext );
	$doc = /* await */ $env->getContentHandler()->toHTML( $env );
	return $doc->body;
}




;

/**
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @return {Promise} a promise that is fulfilled when the test is complete
 */
ParserTests::prototype::prepareTest = /* async */function ( $item, $options, $mode ) use ( &$TestUtils, &$ContentUtils ) {
	if ( !( isset( $item[ 'title' ] ) ) ) {
		throw new Error( 'Missing title from test case.' );
	}

	$item->time = [];

	// These changes are for environment options that change between runs of
	// different **modes**.  See `processTest` for changes per test.
	// These changes are for environment options that change between runs of
	// different **modes**.  See `processTest` for changes per test.
	if ( $item->options ) {
		// Reset uid so that blacklist output doesn't depend on which modes
		// are being run before comparison.
		$this->env->initUID();

		// Page language matches "wiki language" (which is set by
		// the item 'language' option).
		// Page language matches "wiki language" (which is set by
		// the item 'language' option).
		$this->env->page->pagelanguage = $this->env->conf->wiki->lang;
		$this->env->page->pagelanguagedir = ( $this->env->conf->wiki->rtl ) ? 'rtl' : 'ltr';
		if ( $item->options->langconv ) {
			$this->env->wtVariantLanguage = $item->options->sourceVariant || null;
			$this->env->htmlVariantLanguage = $item->options->variant || null;
		} else {
			// variant conversion is disabled by default
			$this->env->wtVariantLanguage = null;
			$this->env->htmlVariantLanguage = null;
		}
	}

	// Some useful booleans
	// Some useful booleans
	$startsAtHtml = $mode === 'html2html' || $mode === 'html2wt';
	$endsAtWikitext = $mode === 'wt2wt' || $mode === 'selser' || $mode === 'html2wt';
	$endsAtHtml = $mode === 'wt2html' || $mode === 'html2html';

	$parsoidOnly =
	( isset( $item[ 'html/parsoid' ] ) )
||		( $item->options->parsoid !== null && !$item->options->parsoid->normalizePhp );
	$item->time->start = time();
	$body = null; $wt = null;

	// Source preparation
	// Source preparation
	if ( $startsAtHtml ) {
		$html = $item->html;
		if ( !$parsoidOnly ) {
			// Strip some php output that has no wikitext representation
			// (like .mw-editsection) and won't html2html roundtrip and
			// therefore causes false failures.
			$html = TestUtils::normalizePhpOutput( $html );
		}
		$body = $this->env->createDocument( $html )->body;
		$wt = /* await */ $this->convertHtml2Wt( $options, $mode, $item, $body );
	} else { // startsAtWikitext
		// Always serialize DOM to string and reparse before passing to wt2wt
		if ( $item->cachedBODYstr === null ) {
			$body = /* await */ $this->convertWt2Html( $mode, $item->wikitext );
			// Caching stage 1 - save the result of the first two stages
			// so we can maybe skip them later

			// Cache parsed HTML
			// Caching stage 1 - save the result of the first two stages
			// so we can maybe skip them later

			// Cache parsed HTML
			$item->cachedBODYstr = ContentUtils::toXML( $body );

			// - In wt2html mode, pass through original DOM
			//   so that it is serialized just once.
			// - In wt2wt and selser modes, pass through serialized and
			//   reparsed DOM so that fostering/normalization effects
			//   are reproduced.
			// - In wt2html mode, pass through original DOM
			//   so that it is serialized just once.
			// - In wt2wt and selser modes, pass through serialized and
			//   reparsed DOM so that fostering/normalization effects
			//   are reproduced.
			if ( $mode === 'wt2html' ) {

				// body = body; // no-op
			} else { // body = body; // no-op

				$body = $this->env->createDocument( $item->cachedBODYstr )->body;
			}
		} else {
			$body = $this->env->createDocument( $item->cachedBODYstr )->body;
		}
	}

	// Generate and make changes for the selser test mode
	// Generate and make changes for the selser test mode
	if ( $mode === 'selser' ) {
		if ( ( $options->selser === 'noauto' || $item->changetree === 'manual' )
&&				$item->options->parsoid && $item->options->parsoid->changes
		) {
			// Ensure that we have this set here in case it hasn't been
			// set in buildTasks because the 'selser=noauto' option was passed.
			$item->changetree = 'manual';
			$body = $this->applyManualChanges( $body, $item->options->parsoid->changes );
		} else {
			$changeTree = ( $options->changetree ) ? json_decode( $options->changetree ) : $item->changetree;
			$r = null;
			if ( $changeTree ) {
				$r = [ 'body' => $body, 'changeTree' => $changeTree ];
			} else {
				$r = $this->generateChanges( $options, $item, $body );
			}
			$body = $this->applyChanges( $item, $r->body, $r->changeTree );
		}
		// Save the modified DOM so we can re-test it later
		// Always serialize to string and reparse before passing to selser/wt2wt
		// Save the modified DOM so we can re-test it later
		// Always serialize to string and reparse before passing to selser/wt2wt
		$item->changedHTMLStr = ContentUtils::toXML( $body );
		$body = $this->env->createDocument( $item->changedHTMLStr )->body;
	} elseif ( $mode === 'wt2wt' ) {
		// handle a 'changes' option if present.
		if ( $item->options->parsoid && $item->options->parsoid->changes ) {
			$body = $this->applyManualChanges( $body, $item->options->parsoid->changes );
		}
	}

	// Roundtrip stage
	// Roundtrip stage
	if ( $mode === 'wt2wt' || $mode === 'selser' ) {
		$wt = /* await */ $this->convertHtml2Wt( $options, $mode, $item, $body );
	} elseif ( $mode === 'html2html' ) {
		$body = /* await */ $this->convertWt2Html( $mode, $wt );
	}

	// Processing stage
	// Processing stage
	if ( $endsAtWikitext ) {
		/* await */ $this->processSerializedWT( $item, $options, $mode, $wt );
	} elseif ( $endsAtHtml ) {
		$this->processParsedHTML( $item, $options, $mode, $body );
	}
}




















































































































;

/**
 * Check the given HTML result against the expected result, and throw an
 * exception if necessary.
 *
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {Node} body
 */
ParserTests::prototype::processParsedHTML = function ( $item, $options, $mode, $body ) use ( &$exitUnexpected ) {
	$item->time->end = time();
	// Check the result vs. the expected result.
	$checkPassed = $this->checkHTML( $item, $body, $options, $mode );

	// Only throw an error if --exit-unexpected was set and there was an error
	// Otherwise, continue running tests
	if ( $options[ 'exit-unexpected' ] && !$checkPassed ) {
		throw $exitUnexpected;
	}
};

/**
 * Check the given wikitext result against the expected result, and throw an
 * exception if necessary.
 *
 * @method
 * @param {Object} item
 * @param {Object} options
 * @param {string} mode
 * @param {string} wikitext
 * @return {Promise} a promise that will be fulfilled when the result
 *   has been checked.
 */
ParserTests::prototype::processSerializedWT = /* async */function ( $item, $options, $mode, $wikitext ) use ( &$exitUnexpected ) {
	$item->time->end = time();

	if ( $mode === 'selser' && $options->selser !== 'noauto' ) {
		if ( $item->changetree === 5 ) {
			$item->resultWT = $item->wikitext;
		} else {
			$body = $this->env->createDocument( $item->changedHTMLStr )->body;
			$item->resultWT = /* await */ $this->convertHtml2Wt( $options, 'wt2wt', $item, $body );
		}
	}

	// Check the result vs. the expected result.
	// Check the result vs. the expected result.
	$checkPassed = $this->checkWikitext( $item, $wikitext, $options, $mode );

	// Only throw an error if --exit-unexpected was set and there was an error
	// Otherwise, continue running tests
	// Only throw an error if --exit-unexpected was set and there was an error
	// Otherwise, continue running tests
	if ( $options[ 'exit-unexpected' ] && !$checkPassed ) {
		throw $exitUnexpected;
	}
}



















;

/**
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests::prototype::checkHTML = function ( $item, $out, $options, $mode ) use ( &$TestUtils, &$ContentUtils ) {
	$normalizedOut = null; $normalizedExpected = null;
	$parsoidOnly =
	( isset( $item[ 'html/parsoid' ] ) ) || ( isset( $item[ 'html/parsoid+langconv' ] ) )
||		( $item->options->parsoid !== null && !$item->options->parsoid->normalizePhp );

	$normOpts = [
		'parsoidOnly' => $parsoidOnly,
		'preserveIEW' => $item->options->parsoid && $item->options->parsoid->preserveIEW,
		'scrubWikitext' => $item->options->parsoid && $item->options->parsoid->scrubWikitext
	];

	$normalizedOut = TestUtils::normalizeOut( $out, $normOpts );
	$out = ContentUtils::toXML( $out, [ 'innerXML' => true ] );

	if ( $item->cachedNormalizedHTML === null ) {
		if ( $parsoidOnly ) {
			$normalizedExpected = TestUtils::normalizeOut( $item->html, $normOpts );
		} else {
			$normalizedExpected = TestUtils::normalizeHTML( $item->html );
		}
		$item->cachedNormalizedHTML = $normalizedExpected;
	} else {
		$normalizedExpected = $item->cachedNormalizedHTML;
	}

	$input = ( $mode === 'html2html' ) ? $item->html : $item->wikitext;
	$expected = [ 'normal' => $normalizedExpected, 'raw' => $item->html ];
	$actual = [ 'normal' => $normalizedOut, 'raw' => $out, 'input' => $input ];

	return $options->reportResult( $this->testBlackList, $this->testWhiteList, $this->stats, $item, $options, $mode, $expected, $actual );
};

/**
 * @param {Object} item
 * @param {string} out
 * @param {Object} options
 */
ParserTests::prototype::checkWikitext = function ( $item, $out, $options, $mode ) {
	$itemWikitext = $item->wikitext;
	$out = str_replace( new RegExp( '<!--' . $staticRandomString . '-->', 'g' ), '', $out );
	if ( $mode === 'selser' && $item->resultWT !== null
&&			$item->changes !== 5 && $item->changetree !== 'manual'
	) {
		$itemWikitext = $item->resultWT;
	} elseif ( ( $mode === 'wt2wt' || ( $mode === 'selser' && $item->changetree === 'manual' ) )
&&			$item->options->parsoid && $item->options->parsoid->changes
	) {
		$itemWikitext = $item[ 'wikitext/edited' ];
	}

	$toWikiText = $mode === 'html2wt' || $mode === 'wt2wt' || $mode === 'selser';
	// FIXME: normalization not in place yet
	$normalizedExpected = ( $toWikiText ) ? preg_replace( '/\n+$/', '', $itemWikitext, 1 ) : $itemWikitext;

	// FIXME: normalization not in place yet
	$normalizedOut = ( $toWikiText ) ? preg_replace( '/\n+$/', '', $out, 1 ) : $out;

	$input = ( $mode === 'selser' ) ? $item->changedHTMLStr :
	( $mode === 'html2wt' ) ? $item->html : $itemWikitext;
	$expected = [ 'normal' => $normalizedExpected, 'raw' => $itemWikitext ];
	$actual = [ 'normal' => $normalizedOut, 'raw' => $out, 'input' => $input ];

	return $options->reportResult( $this->testBlackList, $this->testWhiteList, $this->stats, $item, $options, $mode, $expected, $actual );
};

/**
 * @method
 * @param {Object} [options]
 * @param {string} [mockAPIServerURL]
 * @return {Promise}
 */
ParserTests::prototype::main = /* async */function ( $options, $mockAPIServerURL ) use ( &$ScriptUtils, &$JSUtils, &$path, &$PEG, &$fs, &$ParserHook, &$ParsoidConfig, &$MWParserEnvironment, &$ParsoidLogger ) {
	$this->runDisabled = ScriptUtils::booleanOption( $options[ 'run-disabled' ] );
	$this->runPHP = ScriptUtils::booleanOption( $options[ 'run-php' ] );

	// test case filtering
	// test case filtering
	$this->testFilter = null; // null is the 'default' by definition
	// null is the 'default' by definition
	if ( $options->filter || $options->regex ) {
		// NOTE: filter.toString() is required because a number-only arg
		// shows up as a numeric type rather than a string.
		// Ex: parserTests.js --filter 53221
		$pattern = $options->regex || JSUtils::escapeRegExp( $options->filter->toString() );
		$this->testFilter = new RegExp( $pattern );
	}

	$this->testParserFilePath = implode( $__dirname, $path );
	$this->testParser = PEG::buildParser( /* await */ $fs->readFile( $this->testParserFilePath, 'utf8' ) );

	$this->cases = /* await */ $this->getTests( $options );

	if ( $options->maxtests ) {
		$n = Number( $options->maxtests );
		$console->warn( 'maxtests:' . $n );
		if ( $n > 0 ) {
			count( $this->cases ) = $n;
		}
	}

	// Default to using batch API, but allow setTemplatingAndProcessingFlags
	// to override it from command-line options.
	// Default to using batch API, but allow setTemplatingAndProcessingFlags
	// to override it from command-line options.
	$parsoidOptions = [ 'useBatchAPI' => true ];

	ScriptUtils::setDebuggingFlags( $parsoidOptions, $options );
	ScriptUtils::setTemplatingAndProcessingFlags( $parsoidOptions, $options );

	$setup = function ( $parsoidConfig ) use ( &$ParserHook, &$mockAPIServerURL ) {
		// Init early so we can overwrite it here.
		$parsoidConfig->loadWMF = false;
		$parsoidConfig->loadWMFApiMap();

		// Needed for bidi-char-scrubbing html2wt tests.
		// Needed for bidi-char-scrubbing html2wt tests.
		$parsoidConfig->scrubBidiChars = true;

		$extensions = $parsoidConfig->defaultNativeExtensions->concat( $ParserHook );

		$uri = array_slice( $mockAPIServerURL, 0, -strlen( '/api.php' )/*CHECK THIS*/ );

		// Send all requests to the mock API server.
		// Send all requests to the mock API server.
		Array::from( $parsoidConfig->mwApiMap->values() )->forEach( function ( $apiConf ) use ( &$parsoidConfig, &$uri, &$extensions ) {
				$parsoidConfig->removeMwApi( $apiConf );
				$parsoidConfig->setMwApi( [
						'prefix' => $apiConf->prefix,
						'domain' => $apiConf->domain,
						'uri' => "{$uri}/{$apiConf->prefix}/api.php",
						'extensions' => $extensions
					]
				);
			}
		);

		// This isn't part of the sitematrix but the
		// "Check noCommafy in formatNum" test depends on it.
		// This isn't part of the sitematrix but the
		// "Check noCommafy in formatNum" test depends on it.
		$parsoidConfig->removeMwApi( [ 'domain' => 'be-tarask.wikipedia.org' ] );
		$bePrefix = 'be-taraskwiki';
		$parsoidConfig->setMwApi( [
				'prefix' => $bePrefix,
				'domain' => 'be-tarask.wikipedia.org',
				'uri' => "{$uri}/{$bePrefix}/api.php",
				'extensions' => $extensions
			]
		);

		// Enable sampling to assert it's working while testing.
		// Enable sampling to assert it's working while testing.
		$parsoidConfig->loggerSampling = [
			[ /* RegExp */ '/^warn(\/|$)/', 100 ]
		];

		$parsoidConfig->timeouts->mwApi->connect = 10000;
	};

	$pc = new ParsoidConfig( [ 'setup' => $setup ], $parsoidOptions );

	$logLevels = null;
	if ( ScriptUtils::booleanOption( $options->quiet ) ) {
		$logLevels = [ 'fatal', 'error' ];
	}

	// Create a new parser environment
	// Create a new parser environment
	$env = /* await */ MWParserEnvironment::getParserEnv( $pc, [
			'prefix' => 'enwiki',
			'logLevels' => $logLevels
		]
	);
	$this->env = $env;

	// A hint to enable some slow paths only while testing
	// A hint to enable some slow paths only while testing
	$env->immutable = true;

	// Save default logger so we can be reset it after temporarily
	// switching to the suppressLogger to suppress expected error
	// messages.
	// Save default logger so we can be reset it after temporarily
	// switching to the suppressLogger to suppress expected error
	// messages.
	$this->defaultLogger = $env->logger;
	$this->suppressLogger = new ParsoidLogger( $env );
	$this->suppressLogger->registerLoggingBackends( [ 'fatal' ], $pc );

	// Override env's `setLogger` to record if we see `fatal` or `error`
	// while running parser tests.  (Keep it clean, folks!  Use
	// "suppressError" option on the test if error is expected.)
	// Override env's `setLogger` to record if we see `fatal` or `error`
	// while running parser tests.  (Keep it clean, folks!  Use
	// "suppressError" option on the test if error is expected.)
	$this->loggedErrorCount = 0;
	$env->setLogger = ( ( function ( $parserTests, $superSetLogger ) {
		return function ( $_logger ) use ( &$parserTests ) {
			call_user_func( 'superSetLogger', $_logger );
			$this->log = function ( $level ) use ( &$_logger, &$parserTests ) {
				if ( $_logger !== $parserTests->suppressLogger
&&						preg_match( '/^(fatal|error)\b/', $level )
				) {
					$parserTests->loggedErrorCount++;
				}
				return call_user_func_array( [ $_logger, 'log' ], $arguments );
			};
		};
	} ) );
	$undefined = $undefined( $this, $env->setLogger );

	if ( $console->time && $console->timeEnd ) {
		$console->time( 'Execution time' );
	}
	$options->reportStart();
	$this->env->pageCache = $this->articles;
	$this->comments = [];
	return $this->processCase( 0, $options, false );
}



























































































































;

/**
 * FIXME: clean up this mess!
 * - generate all changes at once (generateChanges should return a tree
 *   really) rather than going to all these lengths of interleaving change
 *   generation with tests
 * - set up the changes in item directly rather than juggling around with
 *   indexes etc
 * - indicate whether to compare to wt2wt or the original input
 * - maybe make a full selser test one method that uses others rather than the
 *   current chain of methods that sometimes do something for selser
 *
 * @method
 * @return {Promise}
 */
ParserTests::prototype::buildTasks = /* async */function ( $item, $targetModes, $options ) use ( &$Util ) {
	for ( $i = 0;  $i < count( $targetModes );  $i++ ) {
		if ( $targetModes[ $i ] === 'selser' && $options->numchanges
&&				$options->selser !== 'noauto' && !$options->changetree
		) {

			// Prepend manual changes, if present, but not if 'selser' isn't
			// in the explicit modes option.
			if ( $item->options->parsoid && $item->options->parsoid->changes ) {
				$newitem = Util::clone( $item );
				// Mutating the item here is necessary to output 'manual' in
				// the test's title and to differentiate it for blacklist.
				// It can only get here in two cases:
				// * When there's no changetree specified in the command line,
				//   buildTasks creates the items by cloning the original one,
				//   so there should be no problem setting it.
				//   In fact, it will override the existing 'manual' value
				//   (lines 1765 and 1767).
				// * When a changetree is specified in the command line and
				//   it's 'manual', there shouldn't be a problem setting the
				//   value here as no other items will be processed.
				// Still, protect against changing a different copy of the item.
				// Mutating the item here is necessary to output 'manual' in
				// the test's title and to differentiate it for blacklist.
				// It can only get here in two cases:
				// * When there's no changetree specified in the command line,
				//   buildTasks creates the items by cloning the original one,
				//   so there should be no problem setting it.
				//   In fact, it will override the existing 'manual' value
				//   (lines 1765 and 1767).
				// * When a changetree is specified in the command line and
				//   it's 'manual', there shouldn't be a problem setting the
				//   value here as no other items will be processed.
				// Still, protect against changing a different copy of the item.
				Assert::invariant(
					$newitem->changetree === 'manual'
||						$newitem->changetree === null
				);
				$newitem->changetree = 'manual';
				/* await */ $this->prepareTest( $newitem, $options, 'selser' );
			}
			// And if that's all we want, next one.
			// And if that's all we want, next one.
			if ( $item->options->parsoid && $item->options->parsoid->selser === 'noauto' ) {
				continue;
			}

			$item->selserChangeTrees = new Array( $options->numchanges );

			// Prepend a selser test that appends a comment to the root node
			// Prepend a selser test that appends a comment to the root node
			$newitem = Util::clone( $item );
			$newitem->changetree = 5;
			/* await */ $this->prepareTest( $newitem, $options, 'selser' );

			for ( $j = 0;  $j < count( $item->selserChangeTrees );  $j++ ) {
				$modeIndex = $i;
				$changesIndex = $j;
				$newitem = Util::clone( $item );
				// Make sure we aren't reusing the one from manual changes
				// Make sure we aren't reusing the one from manual changes
				Assert::invariant( $newitem->changetree === null );
				$newitem->seed = $changesIndex . '';
				/* await */ $this->prepareTest( $newitem, $options, $targetModes[ $modeIndex ] );
				if ( $this->isDuplicateChangeTree( $item->selserChangeTrees, $newitem->changes ) ) {
					// Once we get a duplicate change tree, we can no longer
					// generate and run new tests.  So, be done now!
					break;
				} else {
					$item->selserChangeTrees[ $changesIndex ] = $newitem->changes;
				}
			}
		} else {
			if ( $targetModes[ $i ] === 'selser' && $options->selser === 'noauto' ) {
				// Manual changes were requested on the command line,
				// check that the item does have them.
				if ( $item->options->parsoid && $item->options->parsoid->changes ) {
					// If it does, we need to clone the item so that previous
					// results don't clobber this one.
					/* await */ $this->prepareTest( Util::clone( $item ), $options, $targetModes[ $i ] );
				} else {
					// If it doesn't have manual changes, just skip it.
					continue;
				}
			} else {
				// The order here is important, in that cloning `item` should
				// happen before `item` is used in `prepareTest()`, since
				// we cache some properties (`cachedBODYstr`,
				// `cachedNormalizedHTML`) that should be cleared before use
				// in `newitem`.
				if ( $targetModes[ $i ] === 'wt2html' && isset( $item[ 'html/parsoid+langconv' ] ) ) {
					$newitem = Util::clone( $item );
					$newitem->options->langconv = true;
					$newitem->html = $item[ 'html/parsoid+langconv' ];
					/* await */ $this->prepareTest( $newitem, $options, $targetModes[ $i ] );
				}
				// A non-selser task, we can reuse the item.
				// A non-selser task, we can reuse the item.
				/* await */ $this->prepareTest( $item, $options, $targetModes[ $i ] );
			}
		}
	}
}




















































































;

/**
 * @method
 * @return {Promise}
 */
ParserTests::prototype::processCase = /* async */function ( $i, $options, $earlyExit ) use ( &$exitUnexpected, &$ScriptUtils, &$fs, &$path, &$JSUtils ) {
	if ( $i < count( $this->cases ) && !$earlyExit ) {
		$item = $this->cases[ $i ];
		$err = null;
		try {
			/* await */ $this->processItem( $item, $options );
		} catch ( Exception $e ) {
			$err = $e;
		}
		// There are two types of errors that reach here.  The first is just
		// a notification that a test failed.  We use the error propagation
		// mechanism to get back to this point to print the summary.  The
		// second type is an actual exception that we should hard fail on.
		// exitUnexpected is a sentinel for the first type.
		// There are two types of errors that reach here.  The first is just
		// a notification that a test failed.  We use the error propagation
		// mechanism to get back to this point to print the summary.  The
		// second type is an actual exception that we should hard fail on.
		// exitUnexpected is a sentinel for the first type.
		if ( $err && $err !== $exitUnexpected ) {
			throw $err;
		} else {
			$earlyExit = $options[ 'exit-unexpected' ] && ( $err === $exitUnexpected );
		}
		// FIXME: now that we're no longer using node-style callbacks,
		// there's no reason we need to use recursion for this loop.
		// FIXME: now that we're no longer using node-style callbacks,
		// there's no reason we need to use recursion for this loop.
		return $this->processCase( $i + 1, $options, $earlyExit );
	} else {
		// Sanity check in case any tests were removed but we didn't update
		// the blacklist
		$blacklistChanged = false;
		$allModes = $options->wt2html && $options->wt2wt && $options->html2wt
&&			$options->html2html && $options->selser
&&			!( $options->filter || $options->regex || $options->maxtests );

		// update the blacklist, if requested
		// update the blacklist, if requested
		if ( $allModes || ScriptUtils::booleanOption( $options[ 'rewrite-blacklist' ] ) ) {
			$old = null; $oldExists = null;
			if ( /* await */ $fs->exists( $this->blackListPath ) ) {
				$old = /* await */ $fs->readFile( $this->blackListPath, 'utf8' );
				$oldExists = true;
			} else {
				// Use the preamble from one we know about ...
				$defaultBlPath = implode( $__dirname, $path );
				$old = /* await */ $fs->readFile( $defaultBlPath, 'utf8' );
				$oldExists = false;
			}
			$shell = preg_split( '/^.*DO NOT REMOVE THIS LINE.*$/m', $old );
			$contents = $shell[ 0 ];
			$contents += '// ### DO NOT REMOVE THIS LINE ### ';
			$contents += "(start of automatically-generated section)\n";
			$options->modes->forEach( function ( $mode ) {
					$contents += "\n// Blacklist for " . $mode . "\n";
					$this->stats->modes[ $mode ]->failList->forEach( function ( $fail ) {
							$contents += 'add(' . json_encode( $mode ) . ', '
.								json_encode( $fail->title );
							$contents += ', ' . json_encode( $fail->raw );
							$contents += ");\n";
						}
					);
					$contents += "\n";
				}
			);
			$contents += '// ### DO NOT REMOVE THIS LINE ### ';
			$contents += '(end of automatically-generated section)';
			$contents += $shell[ 2 ];
			if ( ScriptUtils::booleanOption( $options[ 'rewrite-blacklist' ] ) ) {
				/* await */ $fs->writeFile( $this->blackListPath, $contents, 'utf8' );
			} elseif ( $allModes && $oldExists ) {
				$blacklistChanged = ( $contents !== $old );
			}
		}

		// Write updated tests from failed ones
		// Write updated tests from failed ones
		if ( $options[ 'update-tests' ]
||				ScriptUtils::booleanOption( $options[ 'update-unexpected' ] )
		) {
			$updateFormat = ( $options[ 'update-tests' ] === 'raw' ) ?
			'raw' : 'actualNormalized';
			$parserTests = /* await */ $fs->readFile( $this->testFilePath, 'utf8' );
			$this->stats->modes->wt2html->failList->forEach( function ( $fail ) use ( &$options, &$JSUtils ) {
					if ( $options[ 'update-tests' ] || $fail->unexpected ) {
						$exp = new RegExp( '(' . '!!\s*test\s*'
.								JSUtils::escapeRegExp( $fail->title ) . '(?:(?!!!\s*end)[\s\S])*'
.								')(' . JSUtils::escapeRegExp( $fail->expected ) . ')', 'm'
						);
						$parserTests = str_replace( $exp, '$1'
.								preg_replace( '/\$/', '$$$$', $fail[ $updateFormat ] ), $parserTests )
						;
					}
				}
			);
			/* await */ $fs->writeFile( $this->testFilePath, $parserTests, 'utf8' );
		}

		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		$failures = $options->reportSummary(
			$options->modes, $this->stats, $this->testFileName,
			$this->loggedErrorCount, $this->testFilter, $blacklistChanged
		);

		// we're done!
		// exit status 1 == uncaught exception
		// we're done!
		// exit status 1 == uncaught exception
		$exitCode = ( $failures || $blacklistChanged ) ? 2 : 0;
		if ( ScriptUtils::booleanOption( $options[ 'exit-zero' ] ) ) {
			$exitCode = 0;
		}

		return [
			'exitCode' => $exitCode,
			'stats' => Object::assign( [
					'failures' => $failures,
					'loggedErrorCount' => $this->loggedErrorCount
				], $this->stats
			),
			'file' => $this->testFileName,
			'blacklistChanged' => $blacklistChanged
		];
	}
}













































































































;

/**
 * @method
 */
ParserTests::prototype::processItem = /* async */function ( $item, $options ) { // eslint-disable-line require-yield
	if ( gettype( $item ) !== 'object' ) {
		// this is a comment line in the file, ignore it.
		return;
	}

	if ( !$item->options ) { $item->options = [];  }

	// backwards-compatibility aliases for section names.
	// backwards-compatibility aliases for section names.
	if ( isset( $item[ 'input' ] ) ) { $item->wikitext = $item->input; unset( $item->input );  }
	if ( isset( $item[ 'result' ] ) ) { $item->html = $item->result; unset( $item->result );  }

	// html/* and html/parsoid should be treated as html.
	// html/* and html/parsoid should be treated as html.
	[ 'html/*', 'html/*+tidy', 'html+tidy', 'html/parsoid' ]->forEach( function ( $alt ) use ( &$item ) {
			if ( isset( $item[ $alt ] ) ) {
				$item->html = $item[ $alt ];
			}
		}
	);

	// ensure that test is not skipped if it has a wikitext/edited section
	// ensure that test is not skipped if it has a wikitext/edited section
	if ( isset( $item[ 'wikitext/edited' ] ) ) { $item->html = true;  }

	// Reset the cached results for the new case.
	// All test modes happen in a single run of processCase.
	// Reset the cached results for the new case.
	// All test modes happen in a single run of processCase.
	$item->cachedBODYstr = null;
	$item->cachedNormalizedHTML = null;

	// Also reset the logger, since we might have changed it to support
	// the `suppressErrors` option.
	// Also reset the logger, since we might have changed it to support
	// the `suppressErrors` option.
	$this->env->setLogger( $this->defaultLogger );
	// Similarly for parsing resource limits.
	// Similarly for parsing resource limits.
	$this->env->setResourceLimits();

	switch ( $item->type ) {
		case 'article':
		$this->comments = [];
		return $this->processArticle( $item );
		case 'test':
		return $this->processTest( $item, $options );
		case 'comment':
		$this->comments[] = $item->comment;
		return;
		case 'hooks':
		$this->comments = [];
		$this->env->log( 'warn', 'parserTests: Unhandled extension hook', json_encode( $item ) );
		return;
		case 'functionhooks':
		$this->comments = [];
		$this->env->log( 'warn', 'parserTests: Unhandled functionhook', json_encode( $item ) );
		return;
		default:
		$this->comments = [];
		return;
	}
}





















































;

/**
 * Process an article test case (ie the text of an article we need for a test).
 *
 * @param {Object} item
 * @param {string} item.title
 * @param {string} item.text
 */
ParserTests::prototype::processArticle = function ( $item ) {
	$key = $this->env->normalizedTitleKey( $item->title, false, true );
	if ( $this->articles->hasOwnProperty( $key ) ) {
		throw new Error( 'Duplicate article: ' . $item->title );
	} else {
		$this->articles[ $key ] = $item->text;
	}
};

/**
 * @method
 */
ParserTests::prototype::processTest = /* async */function ( $item, $options ) use ( &$TestUtils, &$Util, &$MWParserEnvironment, &$Promise, &$ParsoidExtApi ) {
	$targetModes = $options->modes;
	if ( $this->tests->has( $item->title ) ) {
		throw new Error( 'Duplicate titles: ' . $item->title );
	} else {
		$this->tests->add( $item->title );
	}
	if ( !( isset( $item[ 'wikitext' ] ) && isset( $item[ 'html' ] ) )
||			( isset( $item->options[ 'disabled' ] ) && !$this->runDisabled )
||			( isset( $item->options[ 'php' ] )
&&				!( isset( $item[ 'html/parsoid' ] ) || $this->runPHP ) )
||			( $this->testFilter && $item->title->search( $this->testFilter ) === -1 )
	) {
		// Skip test whose title does not match --filter
		// or which is disabled or php-only
		$this->comments = [];
		return;
	}
	// Add comments to following test.
	// Add comments to following test.
	$item->comments = $item->comments || $this->comments;
	$this->comments = [];
	$suppressErrors = $item->options->parsoid && $item->options->parsoid->suppressErrors;
	if ( $suppressErrors ) {
		$this->env->setLogger( $this->suppressLogger );
	}
	if ( $item->options->parsoid && $item->options->parsoid->modes ) {
		// Avoid filtering out the selser test
		if ( $options->selser
&&				array_search( 'selser', $item->options->parsoid->modes ) < 0
&&				array_search( 'wt2wt', $item->options->parsoid->modes ) >= 0
		) {
			$item->options->parsoid->modes[] = 'selser';
		}

		$targetModes = $targetModes->filter( function ( $mode ) {
				return array_search( $mode, $item->options->parsoid->modes ) >= 0;
			}
		);
	}
	if ( !count( $targetModes ) ) {
		return;
	}
	// Honor language option in parserTests.txt
	// Honor language option in parserTests.txt
	$prefix = $item->options->language || 'enwiki';
	if ( !preg_match( '/wiki/', $prefix ) ) {
		// Convert to our enwiki.. format
		$prefix += 'wiki';
	}
	/* await */ $this->env->switchToConfig( $prefix, true );

	// adjust config to match that used for PHP tests
	// see core/tests/parser/parserTest.inc:setupGlobals() for
	// full set of config normalizations done.
	// adjust config to match that used for PHP tests
	// see core/tests/parser/parserTest.inc:setupGlobals() for
	// full set of config normalizations done.
	$wikiConf = $this->env->conf->wiki;
	$wikiConf->fakeTimestamp = 123;
	$wikiConf->timezoneOffset = 0; // force utc for parsertests
	// force utc for parsertests
	$wikiConf->server = 'http://example.org';
	$wikiConf->scriptpath = '/';
	$wikiConf->script = '/index.php';
	$wikiConf->articlePath = '/wiki/$1';
	$wikiConf->baseURI = $wikiConf->server + preg_replace( '/\$1/', '', $wikiConf->articlePath, 1 );
	$wikiConf->interwikiMap->clear();
	$iwl = TestUtils::iwl;
	Object::keys( $iwl )->forEach( function ( $key ) use ( &$iwl, &$wikiConf ) {
			$iwl[ $key ]->prefix = $key;
			$wikiConf->interwikiMap->set( $key, [] );
			Object::keys( $iwl[ $key ] )->forEach( function ( $f ) use ( &$wikiConf, &$key, &$iwl ) {
					$wikiConf->interwikiMap->get( $key )[ $f ] = $iwl[ $key ][ $f ];
				}
			);
		}
	);
	// Cannot modify namespaces otherwise since baseConfig is deep frozen.
	// Cannot modify namespaces otherwise since baseConfig is deep frozen.
	$wikiConf->siteInfo->namespaces = Util::clone( $wikiConf->siteInfo->namespaces, true );
	// Add 'MemoryAlpha' namespace (T53680)
	// Add 'MemoryAlpha' namespace (T53680)
	TestUtils::addNamespace( $wikiConf, [
			'id' => 100,
			'case' => 'first-letter',
			'canonical' => 'MemoryAlpha',
			'*' => 'MemoryAlpha'
		]
	);
	// Testing
	// Testing
	if ( $wikiConf->iwp === 'enwiki' ) {
		TestUtils::addNamespace( $wikiConf, [
				'id' => 4,
				'case' => 'first-letter',
				'subpages' => '',
				'canonical' => 'Project',
				'*' => 'Base MW'
			]
		);
		TestUtils::addNamespace( $wikiConf, [
				'id' => 5,
				'case' => 'first-letter',
				'subpages' => '',
				'canonical' => 'Project talk',
				'*' => 'Base MW talk'
			]
		);
	}
	// Update $wgInterwikiMagic flag
	// default (undefined) setting is true
	// Update $wgInterwikiMagic flag
	// default (undefined) setting is true
	$this->env->conf->wiki->interwikimagic =
	$item->options->wginterwikimagic === null
||		preg_match( '/^(1|true|)$/', $item->options->wginterwikimagic );

	if ( $item->options ) {
		Assert::invariant( $item->options->extensions === null );

		$this->env->conf->wiki->namespacesWithSubpages[ 0 ] = false;

		// Since we are reusing the 'env' object, set it to the default
		// so that relative link prefix is back to "./"
		// Since we are reusing the 'env' object, set it to the default
		// so that relative link prefix is back to "./"
		$this->env->initializeForPageName( $this->env->conf->wiki->mainpage );

		if ( $item->options->subpage !== null ) {
			$this->env->conf->wiki->namespacesWithSubpages[ 0 ] = true;
		}

		if ( $item->options->title !== null
&&				!is_array( $item->options->title )
		) {
			// This sets the page name as well as the relative link prefix
			// for the rest of the parse.  Do this redundantly with the above
			// so that we start from the wiki.mainpage when resolving
			// absolute subpages.
			$this->env->initializeForPageName( $item->options->title );
		} else {
			$this->env->initializeForPageName( 'Parser test' );
		}

		$this->env->conf->wiki->allowExternalImages = [ '' ]; // all allowed
		// all allowed
		if ( $item->options->wgallowexternalimages !== null
&&				!preg_match( '/^(1|true|)$/', $item->options->wgallowexternalimages )
		) {
			$this->env->conf->wiki->allowExternalImages = null;
		}

		// Process test-specific options
		// Process test-specific options
		$defaults = [
			'scrubWikitext' => MWParserEnvironment::prototype::scrubWikitext,
			'wrapSections' => false
		]; // override for parser tests

		$env = $this->env;
		Object::keys( $defaults )->forEach( function ( $opt ) use ( &$env, &$item, &$defaults ) {
				$env[ $opt ] = ( $item->options->parsoid && $item->options->parsoid->hasOwnProperty( $opt ) ) ?
				$item->options->parsoid[ $opt ] : $defaults[ $opt ];
			}
		);

		$this->env->conf->wiki->responsiveReferences =
		( $item->options->parsoid && $item->options->parsoid->responsiveReferences )
||			// The default for parserTests
			[ 'enabled' => false, 'threshold' => 10 ];

		// Emulate PHP parser's tag hook to tunnel content past the sanitizer
		// Emulate PHP parser's tag hook to tunnel content past the sanitizer
		if ( $item->options->styletag ) {
			$this->env->conf->wiki->registerExtension( function () use ( &$Promise, &$ParsoidExtApi ) {
					$this->config = [
						'tags' => [
							[
								'name' => 'style',
								'toDOM' => Promise::method( function ( $state, $content, $args ) use ( &$ParsoidExtApi ) {
										$doc = $state->env->createDocument();
										$style = $doc->createElement( 'style' );
										$style->innerHTML = $content;
										ParsoidExtApi\Sanitizer::applySanitizedArgs( $state->env, $style, $args );
										$doc->body->appendChild( $style );
										return $doc;
									}
								)
							]
						]
					];
				}
			);
		}

		if ( $item->options->wgrawhtml === '1' ) {
			$this->env->conf->wiki->registerExtension( function () use ( &$Promise ) {
					$this->config = [
						'tags' => [
							[
								'name' => 'html',
								'toDOM' => Promise::method( function ( $state, $content, $args ) {
										return $state->env->createDocument( $content );
									}
								)
							]
						]
					];
				}
			);
		}
	}

	/* await */ $this->buildTasks( $item, $targetModes, $options );
}























































































































































































;

// Start the mock api server and kick off parser tests
/* async */function () use ( &$TestUtils, &$serviceWrapper, &$path ) {
	$options = TestUtils::prepareOptions();
	$ret = /* await */ $serviceWrapper->runServices( [ 'skipParsoid' => true ] );
	$runner = $ret->runner;
	$mockURL = $ret->mockURL;
	$testFilePaths = null;
	if ( $options->_[ 0 ] ) {
		$testFilePaths = [ $path->resolve( $process->cwd(), $options->_[ 0 ] ) ];
	} else {
		$testDir = implode( $__dirname, $path );
		$testFilesPath = implode( $testDir, $path );
		$testFiles = require( $testFilesPath );
		$testFilePaths = array_map( Object::keys( $testFiles ), function ( $f ) {
				return implode( $testDir, $path );
			}
		)

		;
	}
	$stats = [
		'passedTests' => 0,
		'passedTestsWhitelisted' => 0,
		'passedTestsUnexpected' => 0,
		'failedTests' => 0,
		'failedTestsUnexpected' => 0,
		'loggedErrorCount' => 0,
		'failures' => 0
	];
	$blacklistChanged = false;
	$exitCode = 0;
	for ( $i = 0;  $i < count( $testFilePaths );  $i++ ) {
		$testFilePath = $testFilePaths[ $i ];
		$ptests = new ParserTests( $testFilePath, $options->modes );
		$result = /* await */ $ptests->main( $options, $mockURL );
		Object::keys( $stats )->forEach( function ( $k ) use ( &$stats, &$result ) {
				$stats[ $k ] += $result->stats[ $k ]; // Sum all stats
			}
		); // Sum all stats

		$blacklistChanged = $blacklistChanged || $result->blacklistChanged;
		$exitCode = $exitCode || $result->exitCode;
		if ( $exitCode !== 0 && $options[ 'exit-unexpected' ] ) { break;  }
	}
	$options->reportSummary( [], $stats, null, $stats->loggedErrorCount, null, $blacklistChanged );
	/* await */ $runner->stop();
	$process->exit( $exitCode );
}








































()->done();
