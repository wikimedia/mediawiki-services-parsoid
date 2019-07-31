<?php
declare( strict_types = 1 );

namespace Parsoid\Tests\ParserTests;

use DOMDocument;
use DOMElement;
use DOMNode;
use Error;
use Exception;

use Parsoid\Config\Env;
use Parsoid\Config\Api\DataAccess;
use Parsoid\Tests\MockPageConfig;
use Parsoid\Tests\MockPageContent;
use Parsoid\Selser;
use Parsoid\Tools\ScriptUtils;
use Parsoid\Tools\TestUtils;
use Parsoid\Utils\ContentUtils;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Util;
use Parsoid\Utils\WTUtils;

use Psr\Log\LoggerInterface;

use Wikimedia\Alea\Alea;
use Wikimedia\Assert\Assert;

/**
 * Test runner for parser tests
 */
class TestRunner {
	// Hard-code some interwiki prefixes, as is done
	// in parserTest.inc:setupInterwikis()
	const PARSER_TESTS_IWPS = [
		[
			'prefix' => 'local',
			'url' => 'http://doesnt.matter.org/$1',
			'localinterwiki' => true
		],
		[
			'prefix' => 'wikipedia',
			'url' => 'http://en.wikipedia.org/wiki/$1'
		],
		[
			'prefix' => 'meatball',
			// this has been updated in the live wikis, but the parser tests
			// expect the old value (as set in parserTest.inc:setupInterwikis())
			'url' => 'http://www.usemod.com/cgi-bin/mb.pl?$1'
		],
		[
			'prefix' => 'memoryalpha',
			'url' => 'http://www.memory-alpha.org/en/index.php/$1'
		],
		[
			'prefix' => 'zh',
			'url' => 'http://zh.wikipedia.org/wiki/$1',
			'language' => "中文",
			'local' => true
		],
		[
			'prefix' => 'es',
			'url' => 'http://es.wikipedia.org/wiki/$1',
			'language' => "español",
			'local' => true
		],
		[
			'prefix' => 'fr',
			'url' => 'http://fr.wikipedia.org/wiki/$1',
			'language' => "français",
			'local' => true
		],
		[
			'prefix' => 'ru',
			'url' => 'http://ru.wikipedia.org/wiki/$1',
			'language' => "русский",
			'local' => true
		],
		[
			'prefix' => 'mi',
			'url' => 'http://mi.wikipedia.org/wiki/$1',
			// better for testing if one of the
			// localinterwiki prefixes is also a language
			'language' => 'Test',
			'local' => true,
			'localinterwiki' => true
		],
		[
			'prefix' => 'mul',
			'url' => 'http://wikisource.org/wiki/$1',
			'extralanglink' => true,
			'linktext' => 'Multilingual',
			'sitename' => 'WikiSource',
			'local' => true
		],
		// not in PHP setupInterwikis(), but needed
		[
			'prefix' => 'en',
			'url' => 'http://en.wikipedia.org/wiki/$1',
			'language' => 'English',
			'local' => true,
			'protorel' => true
		],
		[
			'prefix' => 'stats',
			'local' => true,
			'url' => 'https://stats.wikimedia.org/$1'
		],
		[
			'prefix' => 'gerrit',
			'local' => true,
			'url' => 'https://gerrit.wikimedia.org/$1'
		]
	];

	private static $exitUnexpected = null;

	/** @var boolean */
	private $runDisabled;

	/** @var boolean */
	private $runPHP;

	/** @var string */
	private $testFileName;

	/** @var string */
	private $testFilePath;

	/** @var string */
	private $blackListPath;

	/** @var array */
	private $testBlackList;

	/** @var array<string,string> */
	private $testTitles;

	/** @var array<string,Article> */
	private $articles;

	/** @var array<string,string> */
	private $articleTexts;

	/** @var LoggerInterface */
	private $suppressLogger;

	/** @var LoggerInterface */
	private $defaultLogger;

	/**
	 * Sets one of 'regex' or 'string' properties
	 * - $testFilter['raw'] is the value of the filter
	 * - if $testFilter['regex'] is true, $testFilter['raw'] is used as a regex filter.
	 * - If $testFilter['string'] is true, $testFilter['raw'] is used as a plain string filter.
	 * @var array
	 */
	private $testFilter;

	/** @var Test[] */
	private $testCases;

	/** @var Stats */
	private $stats;

	/** @var MockApiHelper */
	private $mockApi;

	/** @var SiteConfig */
	private $siteConfig;

	/** @var DataAccess */
	private $dataAccess;

	/**
	 * Global cross-test env object use for things like logging,
	 * initial title processing while reading te parserTests file.
	 *
	 * Every test constructs its own private $env object.
	 *
	 * @var Env
	 */
	private $dummyEnv;

	/**
	 * Options needed to construct the per-test private $env object
	 * @var array
	 */
	private $envOptions;

	/**
	 * @param string $testFilePath
	 * @param string[] $modes
	 */
	public function __construct( string $testFilePath, array $modes ) {
		if ( !self::$exitUnexpected ) {
			self::$exitUnexpected = new Error( 'unexpected failure' ); // unique marker value
		}

		$this->testFilePath = $testFilePath;

		$testFilePathInfo = pathinfo( $testFilePath );
		$this->testFileName = $testFilePathInfo['basename'];

		$blackListName = $testFilePathInfo['filename'] . '-php-blacklist.json';
		$this->blackListPath = $testFilePathInfo['dirname'] . '/' . $blackListName;
		try {
			$blackListData = file_get_contents( $this->blackListPath );
			$this->testBlackList = PHPUtils::jsonDecode( $blackListData )['testBlackList'] ?? [];
			error_log( 'Loaded blacklist from ' . $this->blackListPath .
				". Found " . count( $this->testBlackList ) . " entries!" );
		} catch ( Exception $e ) {
			error_log( 'No blacklist found at ' . $this->blackListPath );
			$this->testBlackList = [];
		}

		$this->articles = [];
		$this->articleTexts = [];
		$this->testTitles = [];

		$newModes = [];
		foreach ( $modes as $mode ) {
			$newModes[$mode] = new Stats();
			$newModes[$mode]->failList = [];
			$newModes[$mode]->result = ''; // XML reporter uses this.
		}

		$this->stats = new Stats();
		$this->stats->modes = $newModes;

		$this->mockApi = new MockApiHelper();
		$this->siteConfig = new SiteConfig( $this->mockApi, [] );
		$this->dataAccess = new DataAccess( $this->mockApi, [] );
		$this->dummyEnv = new Env(
			$this->siteConfig,
			// Unused; needed to satisfy Env signature requirements
			new MockPageConfig( [], new MockPageContent( [ 'main' => '' ] ) ),
			// Unused; needed to satisfy Env signature requirements
			$this->dataAccess
		);

		// Init interwiki map to parser tests info.
		// This suppresses interwiki info from cached configs.
		$this->siteConfig->setupInterwikiMap( self::PARSER_TESTS_IWPS );
	}

	private function newEnv( Test $test, string $wikitext ): Env {
		$env = new Env(
			$this->siteConfig,
			$test->getPageConfig( $this->dummyEnv, $this->siteConfig, $wikitext ),
			$this->dataAccess,
			$this->envOptions
		);
		$env->pageCache = $this->articleTexts;
		// $this->mockApi->setArticleCache( $this->articles );
		// Set parsing resource limits.
		// $env->setResourceLimits();

		return $env;
	}

	private function newDoc( string $html ): DOMDocument {
		return $this->dummyEnv->createDocument( $html );
	}

	/**
	 * Parser the test file and set up articles and test cases
	 */
	private function buildTests(): void {
		// Startup by loading .txt test file
		$content = file_get_contents( $this->testFilePath );
		$rawTestItems = ( new Grammar() )->parse( $content );
		$this->testCases = [];
		foreach ( $rawTestItems as $item ) {
			if ( $item['type'] === 'article' ) {
				$art = new Article( $item );
				$key = $this->dummyEnv->normalizedTitleKey( $art->title, false, true );
				if ( isset( $this->articles[$key] ) ) {
					throw new Error( 'Duplicate article: ' . $item['title'] );
				} else {
					$this->articles[$key] = $art;
					$this->articleTexts[$key] = $art->text;
				}
			} elseif ( $item['type'] === 'test' ) {
				$test = new Test( $item );
				$this->testCases[] = $test;
				if ( isset( $this->testTitles[$test->title] ) ) {
					throw new Error( 'Duplicate titles: ' . $test->title );
				} else {
					$this->testTitles[$test->title] = true;
				}
			}
			/* Ignore the rest */
		}
	}

	/**
	 * For a selser test, check if a change we could make has already been
	 * tested in this round.
	 * Used for generating unique tests.
	 *
	 * @param array $allChanges Already-tried changes.
	 * @param array $change Candidate change.
	 * @return bool
	 */
	private function isDuplicateChangeTree( array $allChanges, array $change ): bool {
		foreach ( $allChanges as $c ) {
			if ( $c == $change ) {
				return true;
			}
		}
		return false;
	}

	// Random string used as selser comment content
	const STATIC_RANDOM_STRING = 'ahseeyooxooZ8Oon0boh';

	/**
	 * Make changes to a DOM in order to run a selser test on it.
	 *
	 * @param Test $test
	 * @param DOMElement $body
	 * @param array $changelist
	 * @return DOMNode The altered body.
	 */
	private function applyChanges( Test $test, DOMElement $body, array $changelist ): DOMNode {
		// Seed the random-number generator based on the test title
		$alea = new Alea( ( $test->seed ?? '' ) . ( $test->title ?? '' ) );

		// Keep the changes in the test object
		// to check for duplicates while building tasks
		$test->changes = $changelist;

		// Helper function for getting a random string
		$randomString = function () use ( &$alea ) {
			return (string)base_convert( $alea->uint32(), 10, 36 );
		};

		$insertNewNode = function ( DOMNode $n ) use ( $randomString ) {
			// Insert a text node, if not in a fosterable position.
			// If in foster position, enter a comment.
			// In either case, dom-diff should register a new node
			$str = $randomString();
			$ownerDoc = $n->ownerDocument;
			$wrapperName = null;
			$newNode = null;

			// Don't separate legacy IDs from their H? node.
			if ( WTUtils::isFallbackIdSpan( $n ) ) {
				$n = $n->nextSibling ?? $n->parentNode;
			}

			// For these container nodes, it would be buggy
			// to insert text nodes as children
			switch ( $n->parentNode->nodeName ) {
				case 'ol':
				case 'ul':
					$wrapperName = 'li';
					break;
				case 'dl':
					$wrapperName = 'dd';
					break;
				case 'tr':
					$prev = DOMCompat::getPreviousElementSibling( $n );
					if ( $prev ) {
						// TH or TD
						$wrapperName = $prev->nodeName;
					} else {
						$next = DOMCompat::getNextElementSibling( $n );
						if ( $next ) {
							// TH or TD
							$wrapperName = $next->nodeName;
						} else {
							$wrapperName = 'td';
						}
					}
					break;
				case 'body':
					$wrapperName = 'p';
					break;
				default:
					if ( WTUtils::isBlockNodeWithVisibleWT( $n ) ) {
						$wrapperName = 'p';
					}
					break;
			}

			if ( DOMUtils::isFosterablePosition( $n ) && $n->parentNode->nodeName !== 'tr' ) {
				$newNode = $ownerDoc->createComment( $str );
			} elseif ( $wrapperName ) {
				$newNode = $ownerDoc->createElement( $wrapperName );
				$newNode->appendChild( $ownerDoc->createTextNode( $str ) );
			} else {
				$newNode = $ownerDoc->createTextNode( $str );
			}

			$n->parentNode->insertBefore( $newNode, $n );
		};

		$removeNode = function ( $n ) {
			$n->parentNode->removeChild( $n );
		};

		$applyChangesInternal = function ( $node, $changes ) use (
			&$applyChangesInternal, $removeNode, $insertNewNode, $randomString
		) {
			if ( !$node ) {
				// FIXME: Generate change assignments dynamically
				$this->dummyEnv->log( 'error', 'no node in applyChangesInternal, ',
					'HTML structure likely changed'
				);
				return;
			}

			if ( $node->childNodes === null ) {
				if ( count( $changes ) > 0 ) {
					throw new Error( "Error: cannot applies changes to node without any children!" );
				}
				return;
			}

			// Clone array since we are mutating the children in the changes loop below
			$nodes = iterator_to_array( $node->childNodes );
			$nodeArray = [];
			foreach ( $nodes as $n ) {
				$nodeArray[] = $n;
			}
			foreach ( $changes as $i => $change ) {
				$child = $nodeArray[$i];

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
								$child->setAttribute( 'data-foobar', $randomString() );
							} else {
								$this->dummyEnv->log( 'error',
									'Buggy changetree. changetype 1 (modify attribute)' .
									' cannot be applied on text/comment nodes.' );
							}
							break;

						// Insert new node before child
						case 2:
							$insertNewNode( $child );
							break;

						// Delete tree rooted at child
						case 3:
							$removeNode( $child );
							break;

						// Change tree rooted at child
						case 4:
							$insertNewNode( $child );
							$removeNode( $child );
							break;
					}

				}
			}
		};

		if ( isset( $this->dummyEnv->dumpFlags['dom:post-changes'] ) ) {
			ContentUtils::dumpDOM( $body, 'Original DOM' );
		}

		if ( $test->changes === [ 5 ] ) {
			// Hack so that we can work on the parent node rather than just the
			// children: Append a comment with known content. This is later
			// stripped from the output, and the result is compared to the
			// original wikitext rather than the non-selser wt2wt result.
			$body->appendChild( $body->ownerDocument->createComment( self::STATIC_RANDOM_STRING ) );
		} elseif ( $test->changes !== [] ) {
			$applyChangesInternal( $body, $test->changes );
		}

		if ( isset( $this->dummyEnv->dumpFlags['dom:post-changes'] ) ) {
			error_log( 'Change tree : ' . json_encode( $test->changes ) . "\n" );
			ContentUtils::dumpDOM( $body, 'Edited DOM' );
		}

		return $body;
	}

	/**
	 * Generate a change object for a document, so we can apply it during a selser test.
	 *
	 * @param array $options
	 * @param Test $test
	 * @param DOMElement $body
	 * @return array $The body and change tree.
	 *  - body DOMElement The altered body.
	 *  - changetree array The list of changes.
	 */
	private function generateChanges( array $options, Test $test, DOMElement $body ) {
		$alea = new Alea( ( $test->seed ?? '' ) . ( $test->title ?? '' ) );

		/**
		 * If no node in the DOM subtree rooted at 'node' is editable in the VE,
		 * this function should return false.
		 *
		 * Currently true for template and extension content, and for entities.
		 */
		$domSubtreeIsEditable = function ( DOMNode $node ) {
			return !( $node instanceof DOMElement ) ||
				( !WTUtils::isEncapsulationWrapper( $node ) &&
					// Deleting these div wrappers is tantamount to removing the
					$node->getAttribute( 'typeof' ) !== 'mw:Entity' &&
					// reference tag encaption wrappers, which results in errors.
					!preg_match( '/\bmw-references-wrap\b/', $node->getAttribute( 'class' ) ?? '' )
				);
		};

		/**
		 * Even if a DOM subtree might be editable in the VE,
		 * certain nodes in the DOM might not be directly editable.
		 *
		 * Currently, this restriction is only applied to DOMs generated for images.
		 * Possibly, there are other candidates.
		 */
		$nodeIsUneditable = function ( DOMNode $node ) use ( &$nodeIsUneditable ) {
			// Text and comment nodes are always editable
			if ( !( $node instanceof DOMElement ) ) {
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
			if ( preg_match( ( '/\bmw:objectAttr/' ), $node->getAttribute( 'property' ) ?? '' ) ) {
				return true;
			}

			// - Image wrapper is an uneditable image elt.
			// - Any node nested in an image elt that is not a fig-caption
			//   is an uneditable image elt.
			// - Entity spans are uneditable as well
			$typeOf = $node->getAttribute( 'typeof' ) ?? '';
			return preg_match( ( '/\bmw:(Image|Video|Audio|Entity)\b/' ), $typeOf ) || (
				$node->nodeName !== 'figcaption' &&
				$node->parentNode &&
				$node->parentNode->nodeName !== 'body' &&
				$nodeIsUneditable( $node->parentNode )
			);
		};

		$hasChangeMarkers = function ( $list ) use ( &$hasChangeMarkers ) {
			// If all recorded changes are 0, then nothing has been modified
			foreach ( $list as $c ) {
				if ( ( is_array( $c ) && $hasChangeMarkers( $c ) ) ||
					( !is_array( $c ) && $c > 0 )
				) {
					return true;
				}
			}
			return false;
		};

		$genChangesInternal = function ( $node ) use (
			&$genChangesInternal, &$hasChangeMarkers,
			$domSubtreeIsEditable, $nodeIsUneditable, $alea
		): array {
			// Seed the random-number generator based on the item title
			$changelist = [];
			$children = $node->childNodes ? iterator_to_array( $node->childNodes ) : [];
			foreach ( $children as $child ) {
				$changeType = 0;

				if ( $domSubtreeIsEditable( $child ) ) {
					if ( $nodeIsUneditable( $child ) || $alea->random() < 0.5 ) {
						// This call to random is a hack to preserve the current
						// determined state of our blacklist entries after a
						// refactor.
						$alea->uint32();
						$changeType = $genChangesInternal( $child );
					} else {
						if ( !DOMUtils::isElt( $child ) ) {
							// Text or comment node -- valid changes: 2, 3, 4
							// since we cannot set attributes on these
							$changeType = floor( $alea->random() * 3 ) + 2;
						} else {
							$changeType = floor( $alea->random() * 4 ) + 1;
						}
					}
				}

				$changelist[] = $changeType;
			}

			return $hasChangeMarkers( $changelist ) ? $changelist : [];
		};

		$changetree = null;
		$numAttempts = 0;
		do {
			$numAttempts++;
			$changetree = $genChangesInternal( $body );
		} while (
			$numAttempts < 1000 &&
			( count( $changetree ) === 0 ||
				$this->isDuplicateChangeTree( $test->selserChangeTrees, $changetree ) )
		);

		if ( $numAttempts === 1000 ) {
			// couldn't generate a change ... marking as such
			$test->duplicateChange = true;
		}

		return [ 'body' => $body, 'changetree' => $changetree ];
	}

	/**
	 * Apply manually-specified changes, which are provided in a pseudo-jQuery
	 * format.
	 *
	 * @param DOMElement $body
	 * @param array $changes
	 * @return DOMElement The changed body.
	 */
	private function applyManualChanges( DOMElement $body, array $changes ): DOMElement {
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
			'after' => function ( DOMNode $node, string $html ) {
				$div = null;
				$tbl = null;
				if ( $node->parentNode->nodeName === 'tbody' ) {
					$tbl = $node->ownerDocument->createElement( 'table' );
					DOMCompat::setInnerHTML( $tbl, $html );
					// <tbody> is implicitly added when inner html is set to <tr>..</tr>
					DOMUtils::migrateChildren( $tbl->firstChild, $node->parentNode, $node->nextSibling );
				} elseif ( $node->parentNode->nodeName === 'tr' ) {
					$tbl = $node->ownerDocument->createElement( 'table' );
					DOMCompat::setInnerHTML( $tbl, '<tbody><tr></tr></tbody>' );
					$tr = $tbl->firstChild->firstChild;
					'@phan-var \DOMElement $tr'; // @var \DOMElement $tr
					DOMCompat::setInnerHTML( $tr, $html );
					DOMUtils::migrateChildren( $tbl->firstChild->firstChild,
						$node->parentNode, $node->nextSibling );
				} else {
					$div = $node->ownerDocument->createElement( 'div' );
					DOMCompat::setInnerHTML( $div, $html );
					DOMUtils::migrateChildren( $div, $node->parentNode, $node->nextSibling );
				}
			},
			'attr' => function ( DOMNode $node, string $name, string $val ) {
				'@phan-var \DOMElement $node'; // @var \DOMElement $node
				$node->setAttribute( $name, $val );
			},
			'before' => function ( DOMNode $node, string $html ) {
				$div = null;
				$tbl = null;
				if ( $node->parentNode->nodeName === 'tbody' ) {
					$tbl = $node->ownerDocument->createElement( 'table' );
					DOMCompat::setInnerHTML( $tbl, $html );
					// <tbody> is implicitly added when inner html is set to <tr>..</tr>
					DOMUtils::migrateChildren( $tbl->firstChild, $node->parentNode, $node );
				} elseif ( $node->parentNode->nodeName === 'tr' ) {
					$tbl = $node->ownerDocument->createElement( 'table' );
					DOMCompat::setInnerHTML( $tbl, '<tbody><tr></tr></tbody>' );
					$tr = $tbl->firstChild->firstChild;
					'@phan-var \DOMElement $tr'; // @var \DOMElement $tr
					DOMCompat::setInnerHTML( $tr, $html );
					DOMUtils::migrateChildren( $tbl->firstChild->firstChild, $node->parentNode, $node );
				} else {
					$div = $node->ownerDocument->createElement( 'div' );
					DOMCompat::setInnerHTML( $div, $html );
					DOMUtils::migrateChildren( $div, $node->parentNode, $node );
				}
			},
			'removeAttr' => function ( DOMNode $node, string $name ) {
				'@phan-var \DOMElement $node'; // @var \DOMElement $node
				$node->removeAttribute( $name );
			},
			'removeClass' => function ( DOMNode $node, string $c ) {
				'@phan-var \DOMElement $node'; // @var \DOMElement $node
				DOMCompat::getClassList( $node )->remove( $c );
			},
			'addClass' => function ( DOMNode $node, string $c ) {
				'@phan-var \DOMElement $node'; // @var \DOMElement $node
				DOMCompat::getClassList( $node )->add( $c );
			},
			'text' => function ( DOMNode $node, string $t ) {
				$node->textContent = $t;
			},
			'html' => function ( DOMNode $node, string $h ) {
				'@phan-var \DOMElement $node'; // @var \DOMElement $node
				DOMCompat::setInnerHTML( $node, $h );
			},
			'remove' => function ( DOMNode $node, string $optSelector = null ) {
				// jquery lets us specify an optional selector to further
				// restrict the removed elements.
				// text nodes don't have the "querySelectorAll" method, so
				// just include them by default (jquery excludes them, which
				// is less useful)
				if ( !$optSelector ) {
					$what = [ $node ];
				} elseif ( !( $node instanceof DOMElement ) ) {
					$what = [ $node ];/* text node hack! */
				} else {
					'@phan-var \DOMElement $node'; // @var \DOMElement $node
					$what = DOMCompat::querySelectorAll( $node, $optSelector );
				}
				foreach ( $what as $node ) {
					if ( $node->parentNode ) {
						$node->parentNode->removeChild( $node );
					}
				}
			},
			'empty' => function ( DOMNode $node ) {
				while ( $node->firstChild ) {
					$node->removeChild( $node->firstChild );
				}
			},
			'wrap' => function ( DOMNode $node, string $w ) {
				$frag = $node->ownerDocument->createElement( 'div' );
				DOMCompat::setInnerHTML( $frag, $w );
				$first = $frag->firstChild;
				$node->parentNode->replaceChild( $first, $node );
				while ( $first->firstChild ) {
					$first = $first->firstChild;
				}
				$first->appendChild( $node );
			}
		];

		foreach ( $changes as $change ) {
			if ( $err ) {
				continue;
			}
			if ( count( $change ) < 2 ) {
				$err = new Error( 'bad change: ' . $change );
				continue;
			}
			// use document.querySelectorAll as a poor man's $(...)
			$els = DOMCompat::querySelectorAll( $body, $change[0] );
			if ( !count( $els ) ) {
				$err = new Error( $change[0] .
					' did not match any elements: ' . DOMCompat::getOuterHTML( $body ) );
				continue;
			}
			if ( $change[1] === 'contents' ) {
				$change = array_slice( $change, 1 );
				$acc = [];
				foreach ( $els as $el ) {
					$acc = array_merge( $acc, iterator_to_array( $el->childNodes ) );
				}
				$els = $acc;
			}
			/* @phan-suppress-next-line PhanTypeArraySuspiciousNullable */
			$fn = $jquery[$change[1]] ?? null;
			if ( !$fn ) {
				/* @phan-suppress-next-line PhanTypeArraySuspiciousNullable */
				$err = new Error( 'bad mutator function: ' . $change[1] );
				continue;
			}
			foreach ( $els as $el ) {
				call_user_func_array( $fn, array_merge( [ $el ], array_slice( $change, 2 ) ) );
			}
		}

		if ( $err ) {
			print TestUtils::colorString( (string)$err, "red" ) . "\n";
			throw $err;
		}
		return $body;
	}

	/**
	 * Convert a wikitext string to an HTML Node
	 *
	 * @param Test $test
	 * @param string $mode
	 * @param string $wikitext
	 * @return DOMElement
	 */
	private function convertWt2Html( Test $test, string $mode, string $wikitext ) {
		$env = $this->newEnv( $test, $wikitext );
		$handler = $env->getContentHandler();
		$doc = $handler->toHTML( $env );
		return DOMCompat::getBody( $doc );
	}

	/**
	 * Convert a DOM to Wikitext.
	 *
	 * @param Test $test
	 * @param array $options
	 * @param string $mode
	 * @param DOMElement $body
	 * @return string
	 */
	private function convertHtml2Wt(
		Test $test, array $options, string $mode, DOMElement $body
	): string {
		$env = $this->newEnv( $test, $test->wikitext ?? '' );
		$selserData = null;
		$startsAtWikitext = $mode === 'wt2wt' || $mode === 'wt2html' || $mode === 'selser';
		if ( $mode === 'selser' ) {
			if ( $startsAtWikitext ) {
				$selserData = new Selser( $test->wikitext, $test->cachedBODYstr );
			}
		}
		$handler = $env->getContentHandler();
		return $handler->fromHTML( $env, $body->ownerDocument, $selserData );
	}

	/**
	 * Run test in the requested mode
	 * @param Test $test
	 * @param string $mode
	 * @param array $options
	 */
	private function runTestInMode( Test $test, string $mode, array $options ): void {
		$test->time = [];

		// These changes are for environment options that change between runs of
		// different modes. See `processTest` for changes per test.
		if ( $test->options ) {
			// Page language matches "wiki language" (which is set by
			// the item 'language' option).
			if ( isset( $test->options['langconv'] ) ) {
				$this->envOptions['wtVariantLanguage'] = $test->options['sourceVariant'] ?? null;
				$this->envOptions['htmlVariantLanguage'] = $test->options['variant'] ?? null;
			} else {
				// variant conversion is disabled by default
				$this->envOptions['wtVariantLanguage'] = null;
				$this->envOptions['htmlVariantLanguage'] = null;
			}
		}

		// Some useful booleans
		$startsAtHtml = $mode === 'html2html' || $mode === 'html2wt';
		$endsAtWikitext = $mode === 'wt2wt' || $mode === 'selser' || $mode === 'html2wt';
		$endsAtHtml = $mode === 'wt2html' || $mode === 'html2html';

		$parsoidOnly = isset( $test->altHtmlSections['html/parsoid'] ) ||
			( !empty( $test->options['parsoid'] ) &&
			!isset( $test->options['parsoid']['normalizePhp'] ) );
		$test->time['start'] = microtime( true );
		$body = null;
		$wt = null;

		// Source preparation
		if ( $startsAtHtml ) {
			$html = $test->html;
			if ( !$parsoidOnly ) {
				// Strip some php output that has no wikitext representation
				// (like .mw-editsection) and won't html2html roundtrip and
				// therefore causes false failures.
				$html = TestUtils::normalizePhpOutput( $html );
			}
			$body = DOMCompat::getBody( $this->newDoc( $html ) );
			$wt = $this->convertHtml2Wt( $test, $options, $mode, $body );
		} else { // startsAtWikitext
			// Always serialize DOM to string and reparse before passing to wt2wt
			if ( $test->cachedBODYstr === null ) {
				$body = $this->convertWt2Html( $test, $mode, $test->wikitext );
				// Caching stage 1 - save the result of the first two stages
				// so we can maybe skip them later

				// Cache parsed HTML
				$test->cachedBODYstr = ContentUtils::toXML( $body );

				// - In wt2html mode, pass through original DOM
				//   so that it is serialized just once.
				// - In wt2wt and selser modes, pass through serialized and
				//   reparsed DOM so that fostering/normalization effects
				//   are reproduced.
				if ( $mode === 'wt2html' ) {
					// no-op
				} else {
					$body = DOMCompat::getBody( $this->newDoc( $test->cachedBODYstr ) );
				}
			} else {
				$body = DOMCompat::getBody( $this->newDoc( $test->cachedBODYstr ) );
			}
		}

		// Generate and make changes for the selser test mode
		if ( $mode === 'selser' ) {
			if ( ( $options['selser'] === 'noauto' || $test->changetree === [ 'manual' ] ) &&
				isset( $test->options['parsoid']['changes'] )
			) {
				// Ensure that we have this set here in case it hasn't been
				// set in buildTasks because the 'selser=noauto' option was passed.
				$test->changetree = [ 'manual' ];
				$body = $this->applyManualChanges( $body, $test->options['parsoid']['changes'] );
			} else {
				$changetree = isset( $options['changetree'] ) ?
					json_decode( $options['changetree'] ) : $test->changetree;
				if ( $changetree ) {
					$r = [ 'body' => $body, 'changetree' => $changetree ];
				} else {
					$r = $this->generateChanges( $options, $test, $body );
				}
				$body = $this->applyChanges( $test, $r['body'], $r['changetree'] );
			}
			// Save the modified DOM so we can re-test it later
			// Always serialize to string and reparse before passing to selser/wt2wt
			$test->changedHTMLStr = ContentUtils::toXML( $body );
			$body = DOMCompat::getBody( $this->newDoc( $test->changedHTMLStr ) );
		} elseif ( $mode === 'wt2wt' ) {
			// handle a 'changes' option if present.
			if ( isset( $test->options['parsoid']['changes'] ) ) {
				$body = $this->applyManualChanges( $body, $test->options['parsoid']['changes'] );
			}
		}

		// Roundtrip stage
		if ( $mode === 'wt2wt' || $mode === 'selser' ) {
			$wt = $this->convertHtml2Wt( $test, $options, $mode, $body );
		} elseif ( $mode === 'html2html' ) {
			$body = $this->convertWt2Html( $test, $mode, $wt );
		}

		// Processing stage
		if ( $endsAtWikitext ) {
			$this->processSerializedWT( $test, $options, $mode, $wt );
		} elseif ( $endsAtHtml ) {
			$this->processParsedHTML( $test, $options, $mode, $body );
		}
	}

	/**
	 * Run test in the requested mode
	 * @param Test $test
	 * @param string $mode
	 * @param array $options
	 */
	private function runTest( Test $test, string $mode, array $options ): void {
		try {
			$this->runTestInMode( $test, $mode, $options );
		} catch ( Exception | Error $e ) {
			$cls = get_class( $e );
			error_log( "$cls from line {$e->getLine()} of {$e->getFile()}: {$e->getMessage()}" );
			error_log( $e->getTraceAsString() . "\n" );
		}
	}

	/**
	 * Check the given HTML result against the expected result, and throw an
	 * exception if necessary.
	 *
	 * @param Test $test
	 * @param array $options
	 * @param string $mode
	 * @param DOMElement $body
	 */
	private function processParsedHTML(
		Test $test, array $options, string $mode, DOMElement $body
	): void {
		$test->time['end'] = microtime( true );
		// Check the result vs. the expected result.
		$checkPassed = $this->checkHTML( $test, $body, $options, $mode );

		// Only throw an error if --exit-unexpected was set and there was an error
		// Otherwise, continue running tests
		if ( $options['exit-unexpected'] && !$checkPassed ) {
			throw self::$exitUnexpected;
		}
	}

	/**
	 * Check the given wikitext result against the expected result, and throw an
	 * exception if necessary.
	 *
	 * @param Test $test
	 * @param array $options
	 * @param string $mode
	 * @param string $wikitext
	 */
	private function processSerializedWT(
		Test $test, array $options, string $mode, string $wikitext
	): void {
		$test->time['end'] = microtime( true );

		if ( $mode === 'selser' && $options['selser'] !== 'noauto' ) {
			if ( $test->changetree === [ 5 ] ) {
				$test->resultWT = $test->wikitext;
			} else {
				$body = DOMCompat::getBody( $this->newDoc( $test->changedHTMLStr ) );
				$test->resultWT = $this->convertHtml2Wt( $test, $options, 'wt2wt', $body );
			}
		}

		// Check the result vs. the expected result.
		$checkPassed = $this->checkWikitext( $test, $wikitext, $options, $mode );

		// Only throw an error if --exit-unexpected was set and there was an error
		// Otherwise, continue running tests
		if ( $options['exit-unexpected'] && !$checkPassed ) {
			throw self::$exitUnexpected;
		}
	}

	/**
	 * @param Test $test
	 * @param DOMElement $out
	 * @param array $options
	 * @param string $mode
	 */
	private function checkHTML( Test $test, DOMElement $out, array $options, string $mode ) {
		$normalizedOut = null;
		$normalizedExpected = null;
		$parsoidOnly = isset( $test->altHtmlSections['html/parsoid'] ) ||
			( isset( $test->altHtmlSections['html/parsoid+langconv'] ) ) ||
			( isset( $test->options['parsoid'] ) && !isset( $test->options['parsoid']['normalizePhp'] ) );

		$normOpts = [
			'parsoidOnly' => $parsoidOnly,
			'preserveIEW' => isset( $test->options['parsoid']['preserveIEW'] ),
			'scrubWikitext' => isset( $test->options['parsoid']['scrubWikitext'] )
		];

		$normalizedOut = TestUtils::normalizeOut( $out, $normOpts );
		$out = ContentUtils::toXML( $out, [ 'innerXML' => true ] );

		if ( $test->cachedNormalizedHTML === null ) {
			if ( $parsoidOnly ) {
				$normalizedExpected = TestUtils::normalizeOut( $test->html, $normOpts );
			} else {
				$normalizedExpected = TestUtils::normalizeHTML( $test->html );
			}
			$test->cachedNormalizedHTML = $normalizedExpected;
		} else {
			$normalizedExpected = $test->cachedNormalizedHTML;
		}

		$input = ( $mode === 'html2html' ) ? $test->html : $test->wikitext;
		$expected = [ 'normal' => $normalizedExpected, 'raw' => $test->html ];
		$actual = [ 'normal' => $normalizedOut, 'raw' => $out, 'input' => $input ];

		return $options['reportResult']( $this->testBlackList,
			$this->stats, $test, $options, $mode, $expected, $actual );
	}

	/**
	 * @param Test $test
	 * @param string $out
	 * @param array $options
	 * @param string $mode
	 */
	private function checkWikitext( Test $test, string $out, array $options, string $mode ) {
		$testWikitext = $test->wikitext;
		$out = preg_replace( '/<!--' . self::STATIC_RANDOM_STRING . '-->/', '', $out );
		if ( $mode === 'selser' && $test->resultWT !== null &&
			$test->changes !== [ 5 ] && $test->changetree !== [ 'manual' ]
		) {
			$testWikitext = $test->resultWT;
		} elseif ( ( $mode === 'wt2wt' ||
				( $mode === 'selser' && $test->changetree === [ 'manual' ] )
			) && isset( $test->options['parsoid']['changes'] )
		) {
			$testWikitext = $test->altWtSections['wikitext/edited'];
		}

		$toWikiText = $mode === 'html2wt' || $mode === 'wt2wt' || $mode === 'selser';
		// FIXME: normalization not in place yet
		$normalizedExpected = $toWikiText ?
			preg_replace( '/\n+$/', '', $testWikitext, 1 ) : $testWikitext;

		// FIXME: normalization not in place yet
		$normalizedOut = ( $toWikiText ) ? preg_replace( '/\n+$/', '', $out, 1 ) : $out;

		$input = $mode === 'selser' ? $test->changedHTMLStr :
			( $mode === 'html2wt' ? $test->html : $testWikitext );
		$expected = [ 'normal' => $normalizedExpected, 'raw' => $testWikitext ];
		$actual = [ 'normal' => $normalizedOut, 'raw' => $out, 'input' => $input ];

		return $options['reportResult']( $this->testBlackList,
			$this->stats, $test, $options, $mode, $expected, $actual );
	}

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
	 */
	private function buildTasks( Test $test, array $targetModes, array $options ) {
		if ( !$test->title ) {
			throw new Error( 'Missing title from test case.' );
		}

		foreach ( $targetModes as $targetMode ) {
			if ( $targetMode === 'selser' && $options['numchanges'] &&
				$options['selser'] !== 'noauto' && !isset( $options['changetree'] )
			) {
				// Prepend manual changes, if present, but not if 'selser' isn't
				// in the explicit modes option.
				if ( isset( $test->options['parsoid']['changes'] ) ) {
					$newitem = Util::clone( $test );
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
						$newitem->changetree === [ 'manual' ] || $newitem->changetree === null,
						'Expecting manual changetree OR no changetree'
					);
					$newitem->changetree = [ 'manual' ];
					$this->runTest( $newitem, 'selser', $options );
				}
				// And if that's all we want, next one.
				if ( ( $test->options['parsoid']['selser'] ?? '' ) === 'noauto' ) {
					continue;
				}

				$test->selserChangeTrees = [];

				// Prepend a selser test that appends a comment to the root node
				$newitem = Util::clone( $test );
				$newitem->changetree = [ 5 ];
				$this->runTest( $newitem, 'selser', $options );

				for ( $j = 0; $j < $options['numchanges']; $j++ ) {
					$newitem = Util::clone( $test );
					// Make sure we aren't reusing the one from manual changes
					Assert::invariant( $newitem->changetree === null, "Expected changetree to be null" );
					$newitem->seed = $j . '';
					$this->runTest( $newitem, $targetMode, $options );
					if ( $this->isDuplicateChangeTree( $test->selserChangeTrees, $newitem->changes ) ) {
						// Once we get a duplicate change tree, we can no longer
						// generate and run new tests.  So, be done now!
						break;
					} else {
						$test->selserChangeTrees[$j] = $newitem->changes;
					}
				}
			} else {
				if ( $targetMode === 'selser' && $options['selser'] === 'noauto' ) {
					// Manual changes were requested on the command line,
					// check that the item does have them.
					if ( isset( $test->options['parsoid']['changes'] ) ) {
						// If it does, we need to clone the item so that previous
						// results don't clobber this one.
						$this->runTest( Util::clone( $test ), $targetMode, $options );
					} else {
						// If it doesn't have manual changes, just skip it.
						continue;
					}
				} else {
					// The order here is important, in that cloning `item` should
					// happen before `item` is used in `runTest()`, since
					// we cache some properties (`cachedBODYstr`,
					// `cachedNormalizedHTML`) that should be cleared before use
					// in `newitem`.
					if ( $targetMode === 'wt2html' &&
						isset( $test->altHtmlSections['html/parsoid+langconv' ] )
					) {
						$newitem = Util::clone( $test );
						$newitem->options['langconv'] = true;
						$newitem->html = $test->altHtmlSections['html/parsoid+langconv'];
						$this->runTest( $newitem, $targetMode, $options );
					}
					// A non-selser task, we can reuse the item.
					$this->runTest( $test, $targetMode, $options );
				}
			}
		}
	}

	private function updateBlacklist( array $options ): array {
		// Sanity check in case any tests were removed but we didn't update
		// the blacklist
		$blacklistChanged = false;
		$allModes = $options['wt2html'] && $options['wt2wt'] &&
			$options['html2wt'] && $options['html2html'] &&
			isset( $options['selser'] ) &&
			!( isset( $options['filter'] ) || isset( $options['regex'] ) ||
				isset( $options['maxtests'] ) );

		// update the blacklist, if requested
		if ( $allModes || ScriptUtils::booleanOption( $options['rewrite-blacklist'] ?? null ) ) {
			$old = null;
			$oldExists = null;
			if ( file_exists( $this->blackListPath ) ) {
				$old = file_get_contents( $this->blackListPath );
				$oldExists = true;
			} else {
				// Use the preamble from one we know about ...
				$defaultBlPath = __DIR__ . "/../tests/parserTests-php-blacklist.js";
				$old = file_get_contents( $defaultBlPath );
				$oldExists = false;
			}
			$shell = preg_split( '/^.*DO NOT REMOVE THIS LINE.*$/m', $old );
			$contents = $shell[0];
			$contents .= '// ### DO NOT REMOVE THIS LINE ### ';
			$contents .= "(start of automatically-generated section)\n";
			foreach ( $options['modes'] as $mode ) {
				$contents .= "\n// Blacklist for " . $mode . "\n";
				foreach ( $this->stats->modes[$mode]->failList as $fail ) {
					$contents .= 'add(' . json_encode( $mode ) . ', ' . json_encode( $fail['title'] );
					$contents .= ', ' . json_encode( $fail['raw'] );
					$contents .= ");\n";
				}
				$contents .= "\n";
			}
			$contents .= '// ### DO NOT REMOVE THIS LINE ### ';
			$contents .= '(end of automatically-generated section)';
			$contents .= $shell[2];
			if ( ScriptUtils::booleanOption( $options['rewrite-blacklist'] ?? null ) ) {
				file_put_contents( $this->blackListPath, $contents );
			} elseif ( $allModes && $oldExists ) {
				$blacklistChanged = $contents !== $old;
			}
		}

		// Write updated tests from failed ones
		if ( isset( $options['update-tests'] ) ||
			ScriptUtils::booleanOption( $options['update-unexpected'] ?? null )
		) {
			/**
			 * PORT-FIXME
			 *
			$updateFormat = $options[ 'update-tests' ] === 'raw' ? 'raw' : 'actualNormalized';
			$fileContent = file_get_contents( $this->testFilePath, 'utf8' );
			foreach ( $this->stats->modes['wt2html']->failList as $fail ) {
				if ( isset( $options['update-tests'] ) || $fail->unexpected ) {
					$exp = '/(' . '!!\s*test\s*'
.							. JSUtils::escapeRegExp( $fail->title ) . '(?:(?!!!\s*end)[\s\S])*'
.							. ')(' . JSUtils::escapeRegExp( $fail->expected ) . ')/m';
					$fileContent = preg_replace( $exp,
						'$1' . preg_replace( '/\$/', '$$$$', $fail[ $updateFormat ] ), $fileContent );
				}
			}
			file_put_contents( $this->testFilePath, $fileContent );
			*
			**/

			error_log( "update-tests not yet supported\n" );
			die( -1 );
		}

		// print out the summary
		// note: these stats won't necessarily be useful if someone
		// reimplements the reporting methods, since that's where we
		// increment the stats.
		$failures = $options['reportSummary'](
			$options['modes'], $this->stats, $this->testFileName,
			$this->testFilter, $blacklistChanged
		);

		// we're done!
		// exit status 1 == uncaught exception
		$exitCode = $failures ?? $blacklistChanged ? 2 : 0;
		if ( ScriptUtils::booleanOption( $options['exit-zero'] ?? null ) ) {
			$exitCode = 0;
		}

		return [
			'exitCode' => $exitCode,
			'stats' => $this->stats,
			'file' => $this->testFileName,
			'blacklistChanged' => $blacklistChanged
		];
	}

	private function processTest( Test $test, array $options ) {
		if ( !$test->options ) {
			$test->options = [];
		}

		// html/* and html/parsoid should be treated as html.
		foreach ( [ 'html/*', 'html/*+tidy', 'html+tidy', 'html/parsoid' ] as $alt ) {
			if ( isset( $test->altHtmlSections[$alt] ) ) {
				$test->html = $test->altHtmlSections[$alt];
			}
		}

		// ensure that test is not skipped if it has a wikitext/edited section
		$haveHtml = $test->html !== null;
		if ( isset( $test->altWtSections['wikitext/edited'] ) ) {
			$haveHtml = true;
		}

		// Reset the cached results for the new case.
		// All test modes happen in a single run of processCase.
		$test->cachedBODYstr = null;
		$test->cachedNormalizedHTML = null;

		$targetModes = $options['modes'];
		if ( !$test->wikitext || !$haveHtml
			|| ( isset( $test->options['disabled'] ) && !$this->runDisabled )
			|| ( isset( $test->options['php'] )
				&& !( isset( $test->altHtmlSections['html/parsoid'] ) || $this->runPHP ) )
			|| !$test->matchesFilter( $this->testFilter )
		) {
			// Skip test whose title does not match --filter
			// or which is disabled or php-only
			return;
		}

		// Set logger
		$suppressErrors = !empty( $test->options['parsoid']['suppressErrors'] );
		$this->siteConfig->setLogger( $suppressErrors ? $this->suppressLogger : $this->defaultLogger );

		$testModes = $test->options['parsoid']['modes'] ?? null;
		if ( $testModes ) {
			// Avoid filtering out the selser test
			if ( isset( $options['selser'] ) &&
				array_search( 'selser', $testModes ) === false &&
				array_search( 'wt2wt', $testModes ) !== false
			) {
				$testModes[] = 'selser';
			}

			$targetModes = array_filter( $targetModes, function ( $mode ) use ( $testModes ) {
				return array_search( $mode, $testModes ) !== false;
			} );
		}

		if ( !count( $targetModes ) ) {
			// No matching target modes
			return;
		}

		// Honor language option in parserTests.txt
		$prefix = $test->options['language'] ?? 'enwiki';
		if ( !preg_match( '/wiki/', $prefix ) ) {
			// Convert to our enwiki.. format
			$prefix .= 'wiki';
		}

		// Switch to requested wiki
		$this->mockApi->setApiPrefix( $prefix );
		$this->siteConfig->reset();

		// adjust config to match that used for PHP tests
		// see core/tests/parser/parserTest.inc:setupGlobals() for
		// full set of config normalizations done.
		$this->siteConfig->setServerData( [
			'server'      => 'http://example.org',
			'scriptpath'  => '/',
			'script'      => '/index.php',
			'articlepath' => '/wiki/$1',
			'baseURI'     => 'http://example.org/wiki/'
		] );

		// Add 'MemoryAlpha' namespace (T53680)
		$this->siteConfig->updateNamespace( [
			'id' => 100,
			'case' => 'first-letter',
			'subpages' => false,
			'canonical' => 'MemoryAlpha',
			'name' => 'MemoryAlpha',
		] );

		// Testing
		if ( $this->siteConfig->iwp() === 'enwiki' ) {
			$this->siteConfig->updateNamespace( [
				'id' => 4,
				'case' => 'first-letter',
				'subpages' => true,
				'canonical' => 'Project',
				'name' => 'Base MW'
			] );
			$this->siteConfig->updateNamespace( [
				'id' => 5,
				'case' => 'first-letter',
				'subpages' => true,
				'canonical' => 'Project talk',
				'name' => 'Base MW talk'
			] );
		}

		// Update $wgInterwikiMagic flag
		// default (undefined) setting is true
		$iwmVal = $test->options['wginterwikimagic'] ?? null;
		if ( !$iwmVal ) {
			$this->siteConfig->setInterwikiMagic( true );
		} else {
			$this->siteConfig->setInterwikiMagic( $iwmVal === 1 || $iwmVal === true );
		}

		// Defaults
		$this->siteConfig->responsiveReferences = SiteConfig::RESPONSIVE_REFERENCES_DEFAULT;
		$this->siteConfig->disableSubpagesForNS( 0 );

		if ( $test->options ) {
			Assert::invariant( !isset( $test->options['extensions'] ),
				'Cannot configure extensions in tests' );

			$this->siteConfig->disableSubpagesForNS( 0 );
			if ( isset( $test->options['subpage'] ) ) {
				$this->siteConfig->enableSubpagesForNS( 0 );
			}

			$allowedPrefixes = [ '' ]; // all allowed
			if ( isset( $test->options['wgallowexternalimages'] ) &&
				!preg_match( '/^(1|true|)$/', $test->options['wgallowexternalimages'] )
			) {
				$allowedPrefixes = [];
			}
			$this->siteConfig->allowedExternalImagePrefixes = $allowedPrefixes;

			// Process test-specific options
			$defaults = [
				'scrubWikitext' => $this->dummyEnv->shouldScrubWikitext(),
				'wrapSections' => false
			]; // override for parser tests
			foreach ( $defaults as $opt => $defaultVal ) {
				$this->envOptions[$opt] = $test->options['parsoid'][$opt] ?? $defaultVal;
			}

			$this->siteConfig->responsiveReferences =
				$test->options['parsoid']['responsiveReferences'] ?? $this->siteConfig->responsiveReferences;

			// Emulate PHP parser's tag hook to tunnel content past the sanitizer
			if ( isset( $test->options['styletag'] ) ) {
				$this->siteConfig->registerParserTestExtension( new StyleTag() );
			}

			if ( ( $test->options['wgrawhtml'] ?? null ) === '1' ) {
				$this->siteConfig->registerParserTestExtension( new RawHTML() );
			}
		}

		$this->buildTasks( $test, $targetModes, $options );
	}

	/**
	 * Run parser tests for the file with the provided options
	 *
	 * @param array $options
	 * @return array
	 */
	public function run( array $options ) {
		$this->runDisabled = ScriptUtils::booleanOption( $options['run-disabled'] ?? null );
		$this->runPHP = ScriptUtils::booleanOption( $options['run-php'] ?? null );

		// Test case filtering
		$this->testFilter = null;
		if ( isset( $options['filter'] ) || isset( $options['regex'] ) ) {
			$this->testFilter = [
				'raw' => $options['regex'] ?? $options['filter'],
				'regex' => isset( $options['regex'] ),
				'string' => isset( $options['filter'] )
			];
		}

		$this->buildTests();

		if ( isset( $options['maxtests'] ) ) {
			$n = $options['maxtests'];
			error_log( 'maxtests:' . $n );
			if ( $n > 0 ) {
				// Trim test cases to the desired amount
				$this->testCases = array_slice( $this->testCases, 0, $n );
			}
		}

		// Register parser tests parser hook
		$this->siteConfig->registerParserTestExtension( new ParserHook() );

		// Needed for bidi-char-scrubbing html2wt tests.
		$this->envOptions = [
			'offline' => true,
			'wrapSections' => false,
			// Needed for bidi-char-scrubbing html2wt tests.
			'scrubBidiChars' => true
		];
		ScriptUtils::setDebuggingFlags( $this->envOptions, $options );
		ScriptUtils::setTemplatingAndProcessingFlags( $this->envOptions, $options );

		$logLevels = null;
		if ( ScriptUtils::booleanOption( $options['quiet'] ?? null ) ) {
			$logLevels = [ 'fatal', 'error' ];
		}

		// Save default logger so we can be reset it after temporarily
		// switching to the suppressLogger to suppress expected error
		// messages.
		$this->defaultLogger = $this->siteConfig->getLogger();

		/**
		 * PORT-FIXME
		// Enable sampling to assert it's working while testing.
		$parsoidConfig->loggerSampling = [ [ '/^warn(\/|$)/', 100 ] ];
		$this->suppressLogger = new ParsoidLogger( $env );
		$this->suppressLogger->registerLoggingBackends( [ 'fatal' ], $pc );

		// Override env's `setLogger` to record if we see `fatal` or `error`
		// while running parser tests.  (Keep it clean, folks!  Use
		// "suppressError" option on the test if error is expected.)
		$env->setLogger = ( ( function ( $parserTests, $superSetLogger ) {
			return function ( $_logger ) use ( &$parserTests ) {
				call_user_func( 'superSetLogger', $_logger );
				$this->log = function ( $level ) use ( &$_logger, &$parserTests ) {
					if ( $_logger !== $parserTests->suppressLogger &&
						preg_match( '/^(fatal|error)\b/', $level )
					) {
						$parserTests->stats->loggedErrorCount++;
					}
					return call_user_func_array( [ $_logger, 'log' ], $arguments );
				};
			};
		} ) );
		**/

		$this->suppressLogger = null; // PORT-FIXME

		/*
		if ( $console->time && $console->timeEnd ) {
			$console->time( 'Execution time' );
		}
		*/

		$options['reportStart']();

		// Run tests
		foreach ( $this->testCases as $test ) {
			try {
				$this->processTest( $test, $options );
			} catch ( Exception $e ) {
				$err = $e;
				if ( $options['exit-unexpected'] && $err === self::$exitUnexpected ) {
					break;
				}
			}
		}

		// Update blacklist
		return $this->updateBlacklist( $options );
	}
}
