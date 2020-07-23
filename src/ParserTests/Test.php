<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

/**
 * Represents a parser test
 */
class Test extends Item {
	/* --- These are test properties from the test file --- */

	/** @var ?string This is the test name, not page title for the test */
	public $testName = null;

	/** @var array */
	public $options = [];

	/** @var ?string */
	public $config = null;

	/** @var array */
	public $sections = [];

	/** @var array Known failures for this test, indexed by testing mode. */
	public $knownFailures = [];

	/* --- These next are computed based on an ordered list of preferred
	*      section keys --- */

	/** @var ?string */
	public $wikitext = null;

	/** @var ?string */
	public $parsoidHtml = null;

	/** @var ?string */
	public $legacyHtml = null;

	/* --- The rest below are computed by Parsoid while running tests -- */

	/** @var string */
	private $pageName;

	/** @var int */
	private $pageNs;

	/** @var array */
	public $changes = [];

	/** @var array */
	public $selserChangeTrees = [];

	/** @var array */
	public $changetree = null;

	/** @var bool */
	public $duplicateChange = false;

	/** @var string */
	public $seed = null;

	/** @var string */
	public $resultWT = null;

	/** @var bool */
	public $wt2wtPassed = null;

	/** @var string */
	public $wt2wtResult = null;

	/** @var string */
	public $selser = null;

	/** @var string */
	public $changedHTMLStr = null;

	/** @var string */
	public $cachedBODYstr = null;

	/** @var string */
	public $cachedNormalizedHTML = null;

	/** @var array */
	public $time = [];

	private const DIRECT_KEYS = [
		'type',
		'filename',
		'lineNumStart',
		'lineNumEnd',
		'testName',
		'options',
		'config',
	];
	private const WIKITEXT_KEYS = [
		'wikitext',
		# deprecated
		'input',
	];
	private const LEGACY_HTML_KEYS = [
		'html/php', 'html/*', 'html',
		# deprecated
		'result',
		'html/php+tidy',
		'html/*+tidy',
		'html+tidy',
	];
	private const PARSOID_HTML_KEYS = [
		'html/parsoid', 'html/*', 'html',
		# deprecated
		'result',
		'html/*+tidy',
		'html+tidy',
	];
	private const WARN_DEPRECATED_KEYS = [
		'input',
		'result',
		# Don't hard-deprecate +tidy or +untidy quite yet, too noisy.
		#'html/php+tidy',
		#'html/*+tidy',
		#'html+tidy',
		#'html/php+untidy',
		#'html+untidy',
	];

	/**
	 * @param array $testProperties key-value mapping of properties
	 * @param array $knownFailures Known failures for this test, indexed by testing mode
	 * @param ?string $comment Optional comment describing the test
	 * @param ?callable $warnFunc Optional callback used to emit
	 *   deprecation warnings.
	 */
	public function __construct(
		array $testProperties,
		array $knownFailures = [],
		?string $comment = null,
		?callable $warnFunc = null
	) {
		parent::__construct( $testProperties, $comment );
		$this->knownFailures = $knownFailures;

		foreach ( $testProperties as $key => $value ) {
			if ( in_array( $key, self::DIRECT_KEYS, true ) ) {
				$this->$key = $value;
			} else {
				if ( isset( $this->sections[$key] ) ) {
					$this->error( "Duplicate test section", $key );
				}
				$this->sections[$key] = $value;
			}
		}

		# Priority order for wikitext, legacyHtml, and parsoidHtml properties
		$cats = [
			'wikitext' => self::WIKITEXT_KEYS,
			'legacyHtml' => self::LEGACY_HTML_KEYS,
			'parsoidHtml' => self::PARSOID_HTML_KEYS,
		];
		foreach ( $cats as $prop => $keys ) {
			foreach ( $keys as $key ) {
				if ( isset( $this->sections[$key] ) ) {
					$this->$prop = $this->sections[$key];
					break;
				}
			}
		}

		# Deprecation warnings
		if ( $warnFunc ) {
			foreach ( self::WARN_DEPRECATED_KEYS as $key ) {
				if ( isset( $this->sections[$key] ) ) {
					$warnFunc( $this->errorMsg(
						"Parser test section $key is deprecated"
					) );
				}
			}
		}
	}

	/**
	 * @param array $testFilter Test Filter as set in TestRunner
	 * @return bool if test matches the filter
	 */
	public function matchesFilter( $testFilter ): bool {
		if ( !$testFilter ) {
			return true; // Trivial match
		}

		if ( !empty( $testFilter['regex'] ) ) {
			$regex = isset( $testFilter['raw'] ) ?
				   ( '/' . $testFilter['raw'] . '/' ) :
				   $testFilter['regex'];
			return (bool)preg_match( $regex, $this->testName );
		}

		if ( !empty( $testFilter['string'] ) ) {
			return strpos( $this->testName, $testFilter['raw'] ) !== false;
		}

		return true; // Trivial match because of a bad test filter
	}

	/**
	 * @return string
	 */
	public function pageName(): string {
		if ( !$this->pageName ) {
			$this->pageName = $this->options['title'] ?? 'Parser test';
			if ( is_array( $this->pageName ) ) {
				$this->pageName = 'Parser test';
			}
		}

		return $this->pageName;
	}

}
