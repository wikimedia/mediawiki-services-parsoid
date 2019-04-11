<?php

declare( strict_types = 1 );

namespace Parsoid\Config\Api;

use Parsoid\Config\PageConfig as IPageConfig;
use Parsoid\Config\PageContent;
use Parsoid\Tests\MockPageContent;

/**
 * PageConfig via MediaWiki's Action API
 *
 * Note this is intended for testing, not performance.
 */
class PageConfig extends IPageConfig {

	/** @var ApiHelper */
	private $api;

	/** @var string */
	private $title;

	/** @var array|null */
	private $page, $rev;

	/** @var PageContent|null */
	private $content;

	/**
	 * @param ApiHelper $api
	 * @param array $opts
	 */
	public function __construct( ApiHelper $api, array $opts ) {
		$this->api = $api;

		if ( !isset( $opts['title'] ) ) {
			throw new \InvalidArgumentException( '$opts[\'title\'] must be set' );
		}
		$this->title = $opts['title'];
	}

	private function loadData() {
		if ( $this->page !== null ) {
			return;
		}

		$this->page = $this->api->makeRequest( [
			'action' => 'query',
			'titles' => $this->title,
			'prop' => 'info|revisions',
			'rvprop' => 'ids|timestamp|user|userid|sha1|size|content',
			'rvslots' => '*',
			'rvlimit' => 1,
		] )['query']['pages'][0];

		$this->rev = $this->page['revisions'][0] ?? [];
		unset( $this->page['revisions'] );

		if ( $this->rev ) {
			$this->rev['timestamp'] = preg_replace( '/\D/', '', $this->rev['timestamp'] );
		}
	}

	public function hasLintableContentModel(): bool {
		$this->loadData();
		return ( $this->rev['slots']['main']['contentmodel'] ?? '' ) === 'wikitext';
	}

	/** @inheritDoc */
	public function getTitle(): string {
		$this->loadData();
		return $this->page['title']; // normalized
	}

	/** @inheritDoc */
	public function getNs(): int {
		$this->loadData();
		return $this->page['ns'];
	}

	/** @inheritDoc */
	public function getPageId(): int {
		$this->loadData();
		return $this->page['pageid'] ?? 0;
	}

	/** @inheritDoc */
	public function getPageLanguage(): string {
		$this->loadData();
		return $this->page['pagelanguage'];
	}

	/** @inheritDoc */
	public function getPageLanguageDir(): string {
		$this->loadData();
		return $this->page['pagelanguagedir'];
	}

	/** @inheritDoc */
	public function getRevisionId(): ?int {
		$this->loadData();
		return $this->rev['revid'] ?? null;
	}

	/** @inheritDoc */
	public function getParentRevisionId(): ?int {
		$this->loadData();
		return $this->rev['parentid'] ?? null;
	}

	/** @inheritDoc */
	public function getRevisionTimestamp(): ?string {
		$this->loadData();
		return $this->rev['timestamp'] ?? null;
	}

	/** @inheritDoc */
	public function getRevisionUser(): ?string {
		$this->loadData();
		return $this->rev['user'] ?? null;
	}

	/** @inheritDoc */
	public function getRevisionUserId(): ?int {
		$this->loadData();
		return $this->rev['userid'] ?? null;
	}

	/** @inheritDoc */
	public function getRevisionSha1(): ?string {
		$this->loadData();
		return $this->rev['sha1'] ?? null;
	}

	/** @inheritDoc */
	public function getRevisionSize(): ?int {
		$this->loadData();
		return $this->rev['size'] ?? null;
	}

	/** @inheritDoc */
	public function getRevisionContent(): ?PageContent {
		$this->loadData();
		if ( $this->rev && !$this->content ) {
			$this->content = new MockPageContent( $this->rev['slots'] );
		}
		return $this->content;
	}

}
