<?php

declare( strict_types = 1 );

namespace Parsoid\Tests\ApiEnv;

use Parsoid\Utils\PHPUtils;
use Parsoid\Config\DataAccess as IDataAccess;
use Parsoid\Config\PageContent;
use Parsoid\Tests\MockPageContent;

/**
 * DataAccess via MediaWiki's Action API
 *
 * Note this is intented for testing, not performance.
 */
class DataAccess implements IDataAccess {

	/** @var ApiHelper */
	private $api;

	/**
	 * @name Caching
	 * @todo Someone should librarize MediaWiki core's MapCacheLRU so we can
	 *  pull it in via composer and use it here.
	 * @{
	 */

	const MAX_CACHE_LEN = 100;

	/**
	 * @var array
	 */
	private $cache = [];

	/**
	 * Get from cache
	 * @param string $key
	 * @return mixed
	 */
	private function getCache( string $key ) {
		if ( isset( $this->cache[$key] ) ) {
			$ret = $this->cache[$key];
			// The LRU cache uses position in the array to indicate recency, so
			// move the accessed key to the end.
			unset( $this->cache[$key] );
			$this->cache[$key] = $ret;
			return $ret;
		}
		return null;
	}

	/**
	 * Set a value into cache
	 * @param string $key
	 * @param mixed $value Not null.
	 */
	private function setCache( string $key, $value ): void {
		if ( isset( $this->cache[$key] ) ) {
			// The LRU cache uses position in the array to indicate recency, so
			// remove the old entry so the new version goes at the end.
			unset( $this->cache[$key] );
		} elseif ( count( $this->cache ) >= self::MAX_CACHE_LEN ) {
			reset( $this->cache );
			$evictKey = key( $this->cache );
			unset( $this->cache[$evictKey] );
		}
		$this->cache[$key] = $value;
	}

	/**@}*/

	/**
	 * @param ApiHelper $api
	 * @param array $opts
	 */
	public function __construct( ApiHelper $api, array $opts ) {
		$this->api = $api;
	}

	/** @inheritDoc */
	public function getRedlinkData( array $titles ): array {
		if ( !$titles ) {
			return [];
		}

		$ret = [];
		foreach ( array_chunk( $titles, 50 ) as $batch ) {
			$data = $this->api->makeRequest( [
				'action' => 'query',
				'prop' => 'info|pageprops',
				'ppprop' => 'disambiguation',
				'titles' => implode( '|', $batch ),
			] )['query'];
			$norm = [];
			if ( isset( $data['normalized'] ) ) {
				foreach ( $data['normalized'] as $n ) {
					$from = $n['from'];
					if ( $n['fromencoded'] ) {
						$from = rawurldecode( $from );
					}
					$norm[$from] = $n['to'];
				}
			}
			$pages = [];
			foreach ( $data['pages'] as $p ) {
				$pages[$p['title']] = $p;
			}
			foreach ( $batch as $title ) {
				$ttitle = $title;
				while ( isset( $norm[$ttitle] ) ) {
					$ttitle = $norm[$ttitle];
				}
				$page = $pages[$ttitle] ?? [];
				$ret[$title] = [
					'missing' => $page['missing'] ?? false,
					'known' => !( $page['missing'] ?? false ) || ( $page['known'] ?? false ),
					'redirect' => $page['redirect'] ?? false,
					'disambiguation' => ( $page['pageprops']['disambiguation'] ?? false ) !== false,
				];
			}
		}

		return $ret;
	}

	/** @inheritDoc */
	public function getFileInfo( string $title, array $files ): array {
		$batches = [];
		foreach ( $files as $name => $dims ) {
			$batches[] = [
				'filename' => $name,
				'txopts' => $dims,
				'page' => $title,
			];
		}
		$data = $this->api->makeRequest( [
			'action' => 'parsoid-batch',
			'batch' => PHPUtils::jsonEncode( $batches ),
		] );

		$ret = array_fill_keys( array_keys( $files ), null );
		foreach ( $data['parsoid-batch'] as $i => $batch ) {
			$ret[$batches[$i]['filename']] = $batch;
		}

		return $ret;
	}

	/** @inheritDoc */
	public function doPst( string $title, string $wikitext ): string {
		$key = implode( ':', [ 'pst', md5( $title ) , md5( $wikitext ) ] );
		$ret = $this->getCache( $key );
		if ( $ret === null ) {
			$data = $this->api->makeRequest( [
				'action' => 'parse',
				'title' => $title,
				'text' => $wikitext,
				'contentmodel' => 'wikitext',
				'onlypst' => 1,
			] );
			$ret = $data['parse']['text'];
			$this->setCache( $key, $ret );
		}
		return $ret;
	}

	/** @inheritDoc */
	public function parseWikitext( string $title, string $wikitext, ?int $revid = null ): array {
		$key = implode( ':', [ 'parse', md5( $title ), md5( $wikitext ), $revid ] );
		$ret = $this->getCache( $key );
		if ( $ret === null ) {
			$params = [
				'action' => 'parse',
				'title' => $title,
				'text' => $wikitext,
				'contentmodel' => 'wikitext',
				'prop' => 'text|modules|jsconfigvars|categories',
				'disablelimitreport' => 1,
				'wrapoutputclass' => '',
			];
			if ( $revid !== null ) {
				$params['revid'] = $revid;
			}
			$data = $this->api->makeRequest( $params )['parse'];

			$cats = [];
			foreach ( $data['categories'] as $c ) {
				$cats[$c['category']] = $c['sortkey'];
			}

			$ret = [
				'html' => $data['text'],
				'modules' => $data['modules'],
				'modulescripts' => $data['modulescripts'],
				'modulestyles' => $data['modulestyles'],
				'categories' => $cats,
			];
			$this->setCache( $key, $ret );
		}
		return $ret;
	}

	/** @inheritDoc */
	public function preprocessWikitext( string $title, string $wikitext, ?int $revid = null ): array {
		$key = implode( ':', [ 'preprocess', md5( $title ), md5( $wikitext ), $revid ] );
		$ret = $this->getCache( $key );
		if ( $ret === null ) {
			$params = [
				'action' => 'expandtemplates',
				'title' => $title,
				'text' => $wikitext,
				'prop' => 'wikitext|categories|modules|jsconfigvars',
			];
			if ( $revid !== null ) {
				$params['revid'] = $revid;
			}
			$data = $this->api->makeRequest( $params )['expandtemplates'];

			$cats = [];
			foreach ( ( $data['categories'] ?? [] ) as $c ) {
				$cats[$c['category']] = $c['sortkey'];
			}

			$ret = [
				'wikitext' => $data['wikitext'],
				'modules' => $data['modules'],
				'modulescripts' => $data['modulescripts'],
				'modulestyles' => $data['modulestyles'],
				'categories' => $cats,
			];
			$this->setCache( $key, $ret );
		}
		return $ret;
	}

	/** @inheritDoc */
	public function fetchPageContent( string $title, int $oldid = 0 ): ?PageContent {
		$key = implode( ':', [ 'content', md5( $title ), $oldid ] );
		$ret = $this->getCache( $key );
		if ( $ret === null ) {
			$params = [
				'action' => 'query',
				'prop' => 'revisions',
				'rvprop' => 'content',
				'rvslots' => '*',
			];
			if ( $oldid !== 0 ) {
				$params['revids'] = $oldid;
			} else {
				$params['titles'] = $title;
				$params['rvlimit'] = 1;
			}

			$data = $this->api->makeRequest( $params );
			$ret = $data['query']['pages'][0]['revisions'][0]['slots'];
			$this->setCache( $key, $ret );
		}
		return new MockPageContent( $ret );
	}

	/** @inheritDoc */
	public function fetchTemplateData( string $title ): ?array {
		$key = implode( ':', [ 'templatedata', md5( $title ) ] );
		$ret = $this->getCache( $key );
		if ( $ret === null ) {
			$data = $this->api->makeRequest( [
				'action' => 'templatedata',
				'includeMissingTitles' => 1,
				'titles' => $title,
			] )['pages'];
			$ret = reset( $data );
			$this->setCache( $key, $ret );
		}
		return $ret;
	}

}
