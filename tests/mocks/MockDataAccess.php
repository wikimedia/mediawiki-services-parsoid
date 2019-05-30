<?php

namespace Parsoid\Tests;

use Parsoid\Config\DataAccess;
use Parsoid\Config\PageConfig;
use Parsoid\Config\PageContent;

class MockDataAccess implements DataAccess {
	public function __construct( array $opts ) {
		// no options yet
	}

	/** @inheritDoc */
	public function getRedlinkData( PageConfig $pageConfig, array $titles ): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function getFileInfo( PageConfig $pageConfig, array $files ): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function doPst( PageConfig $pageConfig, string $wikitext ): string {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function parseWikitext(
		PageConfig $pageConfig, string $wikitext, ?int $revid = null
	): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function preprocessWikitext(
		PageConfig $pageConfig, string $wikitext, ?int $revid = null
	): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function fetchPageContent(
		PageConfig $pageConfig, string $title, int $oldid = 0
	): ?PageContent {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function fetchTemplateData( PageConfig $pageConfig, string $title ): ?array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

}
