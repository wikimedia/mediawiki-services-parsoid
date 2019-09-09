<?php
$cfg = require __DIR__ . '/../vendor/mediawiki/mediawiki-phan-config/src/config.php';

$cfg['target_php_version'] = '7.2';
$cfg['directory_list'] = [
	'src',
	'tests',
	'vendor',
	'tools',
	'.phan/stubs',
];
$cfg['exclude_file_regex'] = '@^vendor/(' . implode( '|', [
	'jakub-onderka/php-parallel-lint',
	'mediawiki/mediawiki-codesniffer',
	'phan/phan',
	'phpunit/php-code-coverage',
	'squizlabs/php_codesniffer',
] ) . ')/@';
// Should probably analyze tests eventually, but let's reduce our workload
// for initial adoption:
$cfg['exclude_analysis_directory_list'] = [ 'vendor/', 'tests/spec/', 'tests/phpunit/', 'tools/' ];

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

return $cfg;
