<?php
declare( strict_types = 1 );

/**
 * Tool to get the Table of Contents (TOC) from a page in JSON format.
 */

namespace Wikimedia\Parsoid\Tools;

// @codeCoverageIgnoreStart
$IP = getenv( 'MW_INSTALL_PATH' );
if ( $IP === false ) {
	$IP = __DIR__ . '/../../..';
}
require_once "$IP/maintenance/Maintenance.php";
// @codeCoverageIgnoreEnd

use MediaWiki\Json\FormatJson;
use MediaWiki\Maintenance\MaintenanceFatalError;
use MediaWiki\Parser\ParserOptions;
use MediaWiki\Title\Title;

class GetTOC extends \MediaWiki\Maintenance\Maintenance {

	public function __construct() {
		parent::__construct();
		$this->addDescription(
			'Get the Table of Contents (TOC) from a page in JSON format. '
		);
		$this->addOption(
			'title',
			'The title of the page to get TOC from',
			true,
			true
		);
		$this->addOption(
			'parser',
			'Which parser to use: "parsoid" or "legacy" (default: parsoid)',
			false,
			true
		);
	}

	/**
	 * Get TOC data for a given title and parser type
	 *
	 * @param string $titleText The page title
	 * @param string $parserType Either 'parsoid' or 'legacy'
	 * @return array|null Array with TOC data or null on error
	 * @throws MaintenanceFatalError
	 */
	private function getTOCData( string $titleText, string $parserType ): ?array {
		$title = Title::newFromText( $titleText );
		if ( !$title || !$title->exists() ) {
			$this->fatalError( "Error: Page '$titleText' does not exist.\n" );
		}

		$parserOutputAccess = $this->getServiceContainer()->getParserOutputAccess();
		$pageStore = $this->getServiceContainer()->getPageStore();
		$page = $pageStore->getPageByReference( $title );

		if ( !$page ) {
			$this->fatalError( "Error: Could not load page '$titleText'" );
		}

		// Set up parser options based on the requested parser type
		$parserOptions = ParserOptions::newFromAnon();
		if ( $parserType === 'parsoid' ) {
			$parserOptions->setUseParsoid();
		}

		// Get parser output
		$status = $parserOutputAccess->getParserOutput(
			$page,
			$parserOptions
		);

		if ( !$status->isOK() ) {
			$this->fatalError( $status );
		}

		$parserOutput = $status->getValue();
		$tocData = $parserOutput->getTOCData();

		if ( !$tocData ) {
			return null;
		}

		// Return the TOCData as a JSON-serializable array
		return $tocData->jsonSerialize();
	}

	/**
	 * @throws MaintenanceFatalError
	 */
	public function execute(): void {
		$titleText = $this->getOption( 'title' );
		$parserType = $this->getOption( 'parser', 'parsoid' );

		// Validate parser type
		if ( !in_array( $parserType, [ 'parsoid', 'legacy' ] ) ) {
			$this->fatalError( "Error: Invalid parser type" );
		}

		// Get the TOC data
		$tocData = $this->getTOCData( $titleText, $parserType );
		$json = FormatJson::encode( $tocData, true );
		$this->output( $json );
	}
}

$maintClass = GetTOC::class;
require_once RUN_MAINTENANCE_IF_MAIN;
