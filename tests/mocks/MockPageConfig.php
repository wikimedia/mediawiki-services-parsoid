<?php

namespace Parsoid\Tests;

use Parsoid\Config\PageConfig;
use Parsoid\Config\PageContent;

class MockPageConfig extends PageConfig {

	/** @var PageContent|null */
	private $content;

	/**
	 * Construct a mock environment object for use in tests
	 * @param array $opts
	 * @param PageContent|null $content
	 */
	public function __construct( array $opts, ?PageContent $content ) {
		$this->content = $content;
	}

	public function hasLintableContentModel(): bool {
		return true;
	}

	/** @inheritDoc */
	public function getTitle(): string {
		return 'TestPage';
	}

	/** @inheritDoc */
	public function getNs(): int {
		return 0;
	}

	/** @inheritDoc */
	public function getPageId(): int {
		return 1;
	}

	/** @inheritDoc */
	public function getPageLanguage(): string {
		return 'en';
	}

	/** @inheritDoc */
	public function getPageLanguageDir(): string {
		return 'rtl';
	}

	/** @inheritDoc */
	public function getRevisionId(): ?int {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getParentRevisionId(): ?int {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getRevisionTimestamp(): ?string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getRevisionUser(): ?string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getRevisionUserId(): ?int {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getRevisionSha1(): ?string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getRevisionSize(): ?int {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function getRevisionContent(): ?PageContent {
		return $this->content;
	}

}
