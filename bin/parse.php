<?php

/**
 * At present, this script is just used for testing the library and uses a
 * public MediaWiki API, which means it's expected to be slow.
 */

require_once __DIR__ . '/../tools/Maintenance.php';

use Parsoid\PageBundle;
use Parsoid\Parsoid;
use Parsoid\Selser;

use Parsoid\Config\Api\ApiHelper;
use Parsoid\Config\Api\DataAccess;
use Parsoid\Config\Api\PageConfig;
use Parsoid\Config\Api\SiteConfig;

// phpcs:ignore MediaWiki.Files.ClassMatchesFilename.WrongCase
class Parse extends \Parsoid\Tools\Maintenance {
	use \Parsoid\Tools\ExtendedOptsProcessor;

	public function __construct() {
		parent::__construct();
		$this->addDescription(
			"Omnibus script to convert between wikitext and HTML, and roundtrip wikitext or HTML. "
			. "Supports a number of options pertaining to pointing at a specific wiki "
			. "or enabling various features during these transformations.\n\n"
			. "If no options are provided, --wt2html is enabled by default.\n"
			. "See --help for detailed usage help." );
		$this->addOption( 'wt2html', 'Wikitext -> HTML' );
		$this->addOption( 'html2wt', 'HTML -> Wikitext' );
		$this->addOption( 'wt2wt', 'Wikitext -> Wikitext' );
		$this->addOption( 'html2html', 'HTML -> HTML' );
		$this->addOption( 'body_only',
						 'Just return the body, without any normalizations as in --normalize' );
		$this->addOption( 'selser',
						 'Use the selective serializer to go from HTML to Wikitext.' );
		$this->addOption( 'oldtextfile',
						 'File containing the old page text for a selective-serialization (see --selser)',
						 false, true );
		$this->addOption( 'oldhtmlfile',
						 'File containing the old HTML for a selective-serialization (see --selser)',
						 false, true );
		$this->addOption( 'inputfile', 'File containing input as an alternative to stdin', false, true );
		$this->setAllowUnregisteredOptions( false );
	}

	/**
	 * @param string $wt
	 * @param bool $body_only
	 * @return PageBundle
	 */
	public function wt2Html( string $wt, bool $body_only ): PageBundle {
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

		return $parsoid->wikitext2html( $pageConfig, [
			'body_only' => $body_only,
		] );
	}

	/**
	 * @param PageBundle $pb
	 * @param Selser|null $selser
	 * @return string
	 */
	public function html2Wt( PageBundle $pb, ?Selser $selser = null ): string {
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

		return $parsoid->html2wikitext( $pageConfig, $pb, [], $selser );
	}

	public function execute() {
		$this->maybeHelp();

		if ( $this->hasOption( 'inputfile' ) ) {
			$input = file_get_contents( $this->getOption( 'inputfile' ) );
			if ( $input === false ) {
				return;
			}
		} else {
			$input = file_get_contents( 'php://stdin' );
		}

		if ( $this->hasOption( 'html2wt' ) ) {
			$selser = null;
			if ( $this->hasOption( 'selser' ) ) {
				if ( !$this->hasOption( 'oldtextfile' ) ) {
					print "No oldtextfile provided.\n";
					$this->maybeHelp();
					return;
				}
				$oldText = file_get_contents( $this->getOption( 'oldtextfile' ) );
				if ( $oldText === false ) {
					return;
				}
				$oldHTML = null;
				if ( !$this->hasOption( 'oldhtmlfile' ) ) {
					$oldHTML = file_get_contents( $this->getOption( 'oldhtmlfile' ) );
					if ( $oldHTML === false ) {
						return;
					}
				}
				$selser = new Selser( $oldText, $oldHTML );
			}
			$pb = new PageBundle( $input );
			print $this->html2Wt( $pb, $selser );
		} elseif ( $this->hasOption( 'wt2wt' ) ) {
			$pb = $this->wt2Html( $input, false );
			print $this->html2Wt( $pb );
		} elseif ( $this->hasOption( 'html2html' ) ) {
			$pb = new PageBundle( $input );
			$wt = $this->html2Wt( $pb );
			$pb = $this->wt2Html( $wt, $this->hasOption( 'body_only' ) );
			print $pb->html;
		} else {
			// wt2html is the default
			$pb = $this->wt2Html( $input, $this->hasOption( 'body_only' ) );
			print $pb->html . "\n";
		}
	}
}

$maintClass = Parse::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
