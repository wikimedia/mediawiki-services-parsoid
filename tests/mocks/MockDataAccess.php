<?php

namespace Parsoid\Tests;

use Parsoid\Config\DataAccess;
use Parsoid\Config\PageContent;

class MockDataAccess implements DataAccess {

	/** @inheritDoc */
	public function getRedlinkData( array $titles ): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function getFileInfo( string $title, array $files ): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function doPst( string $title, string $wikitext ): string {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function parseWikitext( string $title, string $wikitext, ?int $revid = null ): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function preprocessWikitext( string $title, string $wikitext, ?int $revid = null ): array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function fetchPageContent( string $title, int $oldid = 0 ): ?PageContent {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

	/** @inheritDoc */
	public function fetchTemplateData( string $title ): ?array {
		throw new \BadMethodCallException( 'Not implemented yet' );
	}

}
