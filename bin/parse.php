<?php

/**
 * At present, this script is just used for testing the library and uses a
 * public MediaWiki API, which means it's expected to be slow.
 */

require_once __DIR__ . '/../vendor/autoload.php';

use Parsoid\PageBundle;
use Parsoid\Parsoid;
use Parsoid\Selser;

use Parsoid\Config\Api\ApiHelper;
use Parsoid\Config\Api\DataAccess;
use Parsoid\Config\Api\PageConfig;
use Parsoid\Config\Api\SiteConfig;

$cliOpts = getopt( '', [
	'wt2html',
	'html2wt',
	'body_only',
	'selser',
	'oldtextfile:',
	'oldhtmlfile:',
] );

function wfWt2Html( $wt, $body_only ) {
	$opts = [
		"apiEndpoint" => "https://en.wikipedia.org/w/api.php",
		"title" => "Api",
		"pageContent" => $wt,
	];

	$api = new ApiHelper( $opts );

	$siteConfig = new SiteConfig( $api, $opts );
	$dataAccess = new DataAccess( $api, $opts );

	$parsoid = new Parsoid( $siteConfig, $dataAccess );

	$pageConfig = new PageConfig( $api, $opts );

	$pb = $parsoid->wikitext2html( $pageConfig, [
		'body_only' => $body_only,
	] );

	print $pb->html;
}

function wfHtml2Wt( $html, $selser ) {
	$opts = [
		"apiEndpoint" => "https://en.wikipedia.org/w/api.php",
		"title" => "Api",
	];

	// PORT-FIXME: Think about when is the right time for this to be set.
	if ( $selser ) {
		$opts["pageContent"] = $selser->oldText;
	}

	$api = new ApiHelper( $opts );

	$siteConfig = new SiteConfig( $api, $opts );
	$dataAccess = new DataAccess( $api, $opts );

	$parsoid = new Parsoid( $siteConfig, $dataAccess );

	$pageConfig = new PageConfig( $api, $opts );

	$pb = new PageBundle( $html );

	$wt = $parsoid->html2wikitext( $pageConfig, $pb, [], $selser );

	print $wt;
}

$input = file_get_contents( 'php://stdin' );

if ( isset( $cliOpts['wt2html'] ) ) {
	wfWt2Html( $input, isset( $cliOpts['body_only'] ) );
} elseif ( isset( $cliOpts['html2wt'] ) ) {
	$selser = null;
	if ( isset( $cliOpts['selser'] ) ) {
		if ( empty( $cliOpts['oldtextfile'] ) ) {
			print "No oldtextfile provided.\n";
			return;
		}
		$oldText = file_get_contents( $cliOpts['oldtextfile'] );
		if ( $oldText === false ) {
			return;
		}
		$oldHTML = null;
		if ( isset( $cliOpts['oldhtmlfile'] ) ) {
			$oldHTML = file_get_contents( $cliOpts['oldhtmlfile'] );
			if ( $oldHTML === false ) {
				return;
			}
		}
		$selser = new Selser( $oldText, $oldHTML );
	}
	wfHtml2Wt( $input, $selser );
} else {
	print "No direction provided.\n";
}
