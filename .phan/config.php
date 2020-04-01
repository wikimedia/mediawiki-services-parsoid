<?php
// phpcs:disable Generic.Files.LineLength.TooLong

# In order to test in standalone mode, use --config-file=.phan/standalone.php
# In integrated mode ($STANDALONE is false), you should be sure MW_INSTALL_DIR
# is set in your environment and points to an up-to-date copy of mediawiki-core
$STANDALONE = isset( $GLOBALS['ParsoidPhanStandalone'] );

$cfg = require __DIR__ . '/../vendor/mediawiki/mediawiki-phan-config/src/config.php';

$cfg['target_php_version'] = '7.2';
if ( $STANDALONE ) {
	$cfg['directory_list'] = [
		# not the extension directory, it requires MW (ie, "not standalone")
		'src',
		'tests',
		'tools',
		'vendor',
		'.phan/stubs',
	];
} else {
	$cfg['directory_list'] = array_merge( $cfg['directory_list'], [
		# 'src' and '.phan/stubs' are already included by default
		'extension',
		'tests',
		'tools',
		# mediawiki-phan-config doesn't include core's parser test framework
		# by default:
		$IP . '/tests/parser',
		# don't use our vendor directory, use the one from core...
		# but we still need a few things from require-dev
		'vendor/wikimedia/alea',
	] );
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
	$cfg['exclude_analysis_directory_list'][] = $IP . '/tests/parser';
	$cfg['exclude_file_regex'] = '@/vendor/(wikimedia/parsoid|jakub-onderka/php-parallel-lint)/@';
}
error_log( $IP );
#error_log(var_export($cfg['directory_list'], TRUE));
#error_log(var_export($cfg['exclude_analysis_directory_list'], TRUE));

// By default mediawiki-phan-config ignores the 'use of deprecated <foo>' errors.
// $cfg['suppress_issue_types'][] = '<some phan issue>';

/**
 * Quick implementation of a recursive directory list.
 * @param string $dir The directory to list
 * @param ?array &$result Where to put the result
 */
function wfCollectPhpFiles( string $dir, ?array &$result = [] ) {
	foreach ( scandir( $dir ) as $f ) {
		if ( $f === '.' || $f === '..' ) {
			continue;
		}
		$fullName = $dir . DIRECTORY_SEPARATOR . $f;
		if ( is_dir( $fullName ) ) {
			wfCollectPhpFiles( $fullName, $result );
		} elseif ( is_file( $fullName ) && preg_match( '/\.php$/D', $fullName ) ) {
			$result[] = $fullName;
		}
	}
}

// Look for files with the "REMOVE THIS COMMENT AFTER PORTING" comment
// and exclude them.
$root = realpath( __DIR__ . DIRECTORY_SEPARATOR . '..' );
wfCollectPhpFiles( $root . DIRECTORY_SEPARATOR . 'src', $phpFiles );
wfCollectPhpFiles( $root . DIRECTORY_SEPARATOR . 'bin', $phpFiles );
wfCollectPhpFiles( $root . DIRECTORY_SEPARATOR . 'tests', $phpFiles );
wfCollectPhpFiles( $root . DIRECTORY_SEPARATOR . 'tools', $phpFiles );
foreach ( $phpFiles as $f ) {
	$c = file_get_contents( $f, false, null, 0, 1024 );
	if ( preg_match( '/REMOVE THIS COMMENT AFTER PORTING/', $c ) ) {
		// remove $root from $f and add to exclude file list
		$cfg['exclude_file_list'][] = substr( $f, strlen( $root ) + 1 );
	}
}

// Exclude peg-generated output
$cfg['exclude_file_list'][] = "src/Wt2Html/Grammar.php";
$cfg['exclude_file_list'][] = "tests/ParserTests/Grammar.php";

// FIXME: Temporary?
$cfg['suppress_issue_types'][] = 'PhanTypeArraySuspiciousNullable';
$cfg['suppress_issue_types'][] = 'PhanTypePossiblyInvalidDimOffset';

// These are too spammy for now. TODO enable
$cfg['null_casts_as_any_type'] = true;
$cfg['scalar_implicit_cast'] = true;

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
