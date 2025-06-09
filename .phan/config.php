<?php
// phpcs:disable Generic.Files.LineLength.TooLong

# In order to test in standalone mode, use --config-file=.phan/standalone.php
# In integrated mode ($STANDALONE is false), you should be sure MW_INSTALL_DIR
# is set in your environment and points to an up-to-date copy of mediawiki-core
$STANDALONE = isset( $GLOBALS['ParsoidPhanStandalone'] );

$root = realpath( __DIR__ . DIRECTORY_SEPARATOR . '..' );
$hasLangConv = is_dir( "{$root}/vendor/wikimedia/langconv" );

if ( $STANDALONE ) {
	$cfg = require __DIR__ . '/../vendor/mediawiki/mediawiki-phan-config/src/config-library.php';

	$cfg['directory_list'] = [
		# not the extension directory, it requires MW (ie, "not standalone")
		'src',
		'tests',
		'tools',
		'vendor',
		'.phan/stubs',
	];
	$cfg['suppress_issue_types'][] = 'PhanAccessMethodInternal';
} else {
	$cfg = require __DIR__ . '/../vendor/mediawiki/mediawiki-phan-config/src/config.php';

	$cfg['directory_list'] = array_merge( $cfg['directory_list'], [
		# 'src' and '.phan/stubs' are already included by default
		'extension',
		'tests',
		'tools',
		# mediawiki-phan-config doesn't include core's parser test framework
		# by default:
		$IP . '/tests/parser',
		# We're not including our vendor directory here because
		# mediawiki-phan-config sets us up to use the one from core. *However*:
		# 1. we still need a few things from our require-dev
		'vendor/wikimedia/alea',
		# 2. use our version of some shared libraries because otherwise it
		# can become impossible to get phan to pass in both standalone and
		# integrated modes: during a library upgrade an issue needing
		# suppression w/ (say) our newer version of the library would
		# cause phan to fail with 'unnecessary suppression' when run w/ the
		# older version in core (T267074).
		'vendor/wikimedia/object-factory',
		'vendor/wikimedia/idle-dom',
	] );

	if ( $hasLangConv ) {
		# prefer our local wikimedia/langconv
		$cfg['directory_list'][] = 'vendor/wikimedia/langconv';
	} elseif ( is_dir( "{$VP}/vendor/wikimedia/langconv" ) ) {
		$hasLangConv = true;
	}
}

$cfg['minimum_target_php_version'] = '8.1';

// If the optional wikimedia/langconv package isn't installed, ignore files
// which require it.
if ( !$hasLangConv ) {
	$cfg['exclude_analysis_directory_list'][] = 'src/Language/';
}

$cfg['enable_class_alias_support'] = true; // should be on by default: T224704

/**
 * Quick implementation of a recursive directory list.
 * @param string $dir The directory to list
 * @param ?array &$result Where to put the result
 */
function wfCollectPhpFiles( string $dir, ?array &$result = [] ) {
	if ( !is_dir( $dir ) ) {
		return;
	}
	foreach ( scandir( $dir ) as $f ) {
		if ( $f === '.' || $f === '..' ) {
			continue;
		}
		$fullName = $dir . DIRECTORY_SEPARATOR . $f;
		wfCollectPhpFiles( $fullName, $result );
		if ( is_file( $fullName ) && preg_match( '/\.php$/D', $fullName ) ) {
			$result[] = $fullName;
		}
	}
}

// Should probably analyze tests eventually, but let's reduce our workload
// for initial adoption:
$cfg['exclude_analysis_directory_list'] = array_merge(
	$cfg['exclude_analysis_directory_list'],
	[ 'vendor/', 'tests/spec/', 'tests/phpunit/', 'tools/' ]
);
if ( $STANDALONE ) {
	// Analyze RTTestSettings only in the context of core code (ie, !STANDALONE)
	$cfg['exclude_file_list'][] = 'tests/RTTestSettings.php';
} else {
	$cfg['exclude_analysis_directory_list'][] = 'extension/tests/';
	$cfg['exclude_analysis_directory_list'][] = $IP . '/tests/parser';
	// When running in integrated mode, don't (re)check src, just check
	// the stuff in extension/
	$cfg['exclude_analysis_directory_list'][] = 'src';

	foreach ( [
		'wikimedia/parsoid',
		'php-parallel-lint/php-parallel-lint',
		# These are libraries we have in common w/ core which we always want
		# to use the parsoid version of (see above, T267074):
		'wikimedia/object-factory',
		'wikimedia/idle-dom',
	] as $d ) {
		wfCollectPhpFiles( "{$VP}/vendor/{$d}", $cfg['exclude_file_list'] );
	}
	// Prefer our local copy of langconv
	if ( is_dir( "{$root}/vendor/wikimedia/langconv" ) ) {
		wfCollectPhpFiles( "{$VP}/vendor/wikimedia/langconv", $cfg['exclude_file_list'] );
	}
}
wfCollectPhpFiles( "vendor/composer/composer", $cfg['exclude_file_list'] );
wfCollectPhpFiles( "vendor/php-parallel-lint/php-parallel-lint", $cfg['exclude_file_list'] );

// Exclude src/DOM in favour of .phan/stubs/DomImpl.php
wfCollectPhpFiles( 'src/DOM', $cfg['exclude_file_list'] );

// By default mediawiki-phan-config ignores the 'use of deprecated <foo>' errors.
// Re-enable these errors.
$cfg['suppress_issue_types'] = array_filter( $cfg['suppress_issue_types'], static function ( $issue ) {
	return !str_starts_with( $issue, 'PhanDeprecated' );
} );

// Add your own customizations here if needed.
// $cfg['suppress_issue_types'][] = '<some phan issue>';

// Exclude peg-generated output
$cfg['exclude_file_list'][] = "src/Wt2Html/Grammar.php";
$cfg['exclude_file_list'][] = "src/ParserTests/Grammar.php";

// FIXME: Temporary?
$cfg['suppress_issue_types'][] = 'PhanTypeArraySuspiciousNullable';
$cfg['suppress_issue_types'][] = 'PhanTypePossiblyInvalidDimOffset';
$cfg['suppress_issue_types'][] = 'MediaWikiNoEmptyIfDefined';

// This is too spammy for now. TODO enable
$cfg['null_casts_as_any_type'] = true;

// Bundled plugins, generated from,
// `ls -p1 vendor/phan/phan/.phan/plugins/ |grep -Ev "(/|README)" |sed -e s/\.php// |xargs printf "\t\'%s\',\n"`
$cfg['plugins'] = array_merge( $cfg['plugins'], [
	'AlwaysReturnPlugin',
	// 'DemoPlugin',
	'DollarDollarPlugin',
	'DuplicateArrayKeyPlugin',
	// 'DuplicateExpressionPlugin',  // Already set in "mediawiki-phan-config"
	'EmptyMethodAndFunctionPlugin',
	'EmptyStatementListPlugin',
	'FFIAnalysisPlugin',
	// 'HasPHPDocPlugin',
	'InlineHTMLPlugin',
	// 'InvalidVariableIssetPlugin',
	'InvokePHPNativeSyntaxCheckPlugin',
	'LoopVariableReusePlugin',
	// 'NoAssertPlugin', // Already handled by mediawiki-codesniffer
	// 'NonBoolBranchPlugin',
	// 'NonBoolInLogicalArithPlugin',
	// 'NotFullyQualifiedUsagePlugin',
	// 'NumericalComparisonPlugin',
	// 'PHPDocRedundantPlugin',
	// 'PHPDocToRealTypesPlugin',
	'PHPUnitAssertionPlugin',
	'PHPUnitNotDeadCodePlugin',
	// 'PhanSelfCheckPlugin', // This is only useful for developing Phan plugins
	// 'PossiblyStaticMethodPlugin',
	'PreferNamespaceUsePlugin',
	// 'PregRegexCheckerPlugin',  // Already set in "mediawiki-phan-config"
	'PrintfCheckerPlugin',
	'SleepCheckerPlugin',
	'StrictComparisonPlugin',
	// 'SuspiciousParamOrderPlugin',
	// 'UnknownElementTypePlugin',
	'UnreachableCodePlugin',
	// 'UnusedSuppressionPlugin',  // Already set in "mediawiki-phan-config"
	'UseReturnValuePlugin',
	// 'WhitespacePlugin',
] );

return $cfg;
