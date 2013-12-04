<?php

/**
 * HTML cache refreshing and -invalidation job for the Parsoid varnish caches.
 *
 * This job comes in a few variants:
 *   - a) Recursive jobs to purge caches for backlink pages for a given title.
 *        They have have (type:OnDependencyChange,recursive:true,table:<table>) set.
 *   - b) Jobs to purge caches for a set of titles (the job title is ignored).
 *	      They have have (type:OnDependencyChange,pages:(<page ID>:(<namespace>,<title>),...) set.
 *   - c) Jobs to purge caches for a single page (the job title)
 *        They have (type:OnEdit) set.
 *
 * See
 * http://www.mediawiki.org/wiki/Parsoid/Minimal_performance_strategy_for_July_release
 */
class ParsoidCacheUpdateJob extends Job {
	function __construct( $title, $params, $id = 0 ) {
		// Map old jobs to new 'OnEdit' jobs
		if ( !isset( $params['type'] ) ) {
			$params['type'] = 'OnEdit'; // b/c
		}
		parent::__construct( 'ParsoidCacheUpdateJob' . $params['type'], $title, $params, $id );

		if ( $params['type'] == 'OnEdit' ) {
			// Simple duplicate removal for single-title jobs. Other jobs are
			// deduplicated with root job parameters.
			$this->removeDuplicates = true;
		}
	}

	function run() {
		global $wgParsoidCacheUpdateTitlesPerJob, $wgUpdateRowsPerJob, $wgMaxBacklinksInvalidate;

		if ( $this->params['type'] === 'OnEdit' ) {
			$this->invalidateTitle( $this->title );
		} elseif ( $this->params['type'] === 'OnDependencyChange' ) {
			static $expected = array( 'recursive', 'pages' ); // new jobs have one of these

			$oldRangeJob = false;
			if ( !array_intersect( array_keys( $this->params ), $expected ) ) {
				// B/C for older job params formats that lack these fields:
				// a) base jobs with just ("table") and b) range jobs with ("table","start","end")
				if ( isset( $this->params['start'] ) && isset( $this->params['end'] ) ) {
					$oldRangeJob = true;
				} else {
					$this->params['recursive'] = true; // base job
				}
			}

			// Job to purge all (or a range of) backlink pages for a page
			if ( !empty( $this->params['recursive'] ) ) {
				// @TODO: try to use delayed jobs if possible?
				if ( !isset( $this->params['range'] ) && $wgMaxBacklinksInvalidate !== false ) {
					$numRows = $this->title->getBacklinkCache()->getNumLinks(
						$this->params['table'], $wgMaxBacklinksInvalidate );
					if ( $numRows > $wgMaxBacklinksInvalidate ) {
						return true;
					}
				}
				// Convert this into some title-batch jobs and possibly a
				// recursive ParsoidCacheUpdateJob job for the rest of the backlinks
				$jobs = BacklinkJobUtils::partitionBacklinkJob(
					$this,
					$wgUpdateRowsPerJob,
					$wgParsoidCacheUpdateTitlesPerJob, // jobs-per-title
					// Carry over information for de-duplication
					array(
						'params' => $this->getRootJobParams() + array(
							'table' => $this->params['table'], 'type' => 'OnDependencyChange' )
					)
				);
				JobQueueGroup::singleton()->push( $jobs );
			// Job to purge pages for for a set of titles
			} elseif ( isset( $this->params['pages'] ) ) {
				$this->invalidateTitles( $this->params['pages'] );
			// B/C for job to purge a range of backlink pages for a given page
			} elseif ( $oldRangeJob ) {
				$titleArray = $this->title->getBacklinkCache()->getLinks(
					$this->params['table'], $this->params['start'], $this->params['end'] );

				$pages = array(); // same format BacklinkJobUtils uses
				foreach ( $titleArray as $tl ) {
					$pages[$tl->getArticleId()] = array( $tl->getNamespace(), $tl->getDbKey() );
				}

				$jobs = array();
				foreach ( array_chunk( $wgParsoidCacheUpdateTitlesPerJob, $pages ) as $pageChunk ) {
					$jobs[] = new ParsoidCacheUpdateJob( $this->title,
						array(
							'type'  => 'OnDependencyChange',
							'table' => $this->table,
							'pages' => $pageChunk
						) + $this->getRootJobParams() // carry over information for de-duplication
					);
				}
				JobQueueGroup::singleton()->push( $jobs );
			}
		}

		return true;
	}

	/**
	 * Construct a cache server URL
	 *
	 * @param $title Title
	 * @param string $server the server name
	 * @param bool $prev use previous revision id if true
	 * @return string an absolute URL for the article on the given server
	 */
	protected function getParsoidURL( Title $title, $server, $prev = false ) {
		global $wgParsoidWikiPrefix;

		$oldid = $prev ?
			$title->getPreviousRevisionID( $title->getLatestRevID() ) :
			$title->getLatestRevID();

		// Construct Parsoid web service URL
		return $server . '/' . $wgParsoidWikiPrefix . '/' .
			wfUrlencode( $title->getPrefixedDBkey() ) . '?oldid=' . $oldid;
	}

	/**
	 * Check an array of CurlMultiClient results for errors, and setLastError
	 * if there are any.
	 * @param $results CurlMultiClient result array
	 */
	protected function checkCurlResults( $results ) {
		foreach( $results as $k => $result ) {
			if ($results[$k]['error'] != null) {
				$this->setLastError($results[$k]['error']);
				return false;
			}
		}
		return true;
	}

	/**
	 * Invalidate a single title object after an edit. Send headers that let
	 * Parsoid reuse transclusion and extension expansions.
	 * @param $title Title
	 */
	protected function invalidateTitle( Title $title ) {
		global $wgParsoidCacheServers;

		# First request the new version
		$parsoidInfo = array();
		$parsoidInfo['cacheID'] = $title->getPreviousRevisionID( $title->getLatestRevID() );
		$parsoidInfo['changedTitle'] = $this->title->getPrefixedDBkey();

		$requests = array();
		foreach ( $wgParsoidCacheServers as $server ) {
			$requests[] = array(
				'url'     => $this->getParsoidURL( $title, $server ),
				'headers' => array(
					'X-Parsoid: ' . json_encode( $parsoidInfo ),
					// Force implicit cache refresh similar to
					// https://www.varnish-cache.org/trac/wiki/VCLExampleEnableForceRefresh
					'Cache-control: no-cache'
				)
			);
		}
		wfDebug( "ParsoidCacheUpdateJob::invalidateTitle: " . serialize( $requests ) . "\n" );
		$this->checkCurlResults( CurlMultiClient::request( $requests ) );

		# And now purge the previous revision so that we make efficient use of
		# the Varnish cache space without relying on LRU. Since the URL
		# differs we can't use implicit refresh.
		$requests = array();
		foreach ( $wgParsoidCacheServers as $server ) {
			// @TODO: this triggers a getPreviousRevisionID() query per server
			$requests[] = array(
				'url' => $this->getParsoidURL( $title, $server, true )
			);
		}
		$options = CurlMultiClient::getDefaultOptions();
		$options[CURLOPT_CUSTOMREQUEST] = "PURGE";
		$this->checkCurlResults( CurlMultiClient::request( $requests, $options ) );
		return $this->getLastError() == null;
	}


	/**
	 * Invalidate an array (or iterator) of Title objects, right now. Send
	 * headers that signal Parsoid which of transclusions or extensions need
	 * to be updated.
	 * @param $pages array (page ID => (namespace, DB key)) mapping
	 */
	protected function invalidateTitles( array $pages ) {
		global $wgParsoidCacheServers, $wgLanguageCode;

		if ( !isset( $wgParsoidCacheServers ) ) {
			$wgParsoidCacheServers = array( 'localhost' );
		}

		# Re-render
		$parsoidInfo = array();

		# Pass some useful info to Parsoid
		$parsoidInfo['changedTitle'] = $this->title->getPrefixedDBkey();
		$parsoidInfo['mode'] = $this->params['table'] == 'templatelinks' ?
			'templates' : 'files';

		# Build an array of update requests
		$requests = array();
		foreach ( $wgParsoidCacheServers as $server ) {
			foreach ( $pages as $id => $nsDbKey ) {
				$title = Title::makeTitle( $nsDbKey[0], $nsDbKey[1] );
				# TODO, but low prio: if getLatestRevID returns 0, only purge title (deletion).
				# Low prio because VE would normally refuse to load the page
				# anyway, and no private info is exposed.
				$url = $this->getParsoidURL( $title, $server );

				$parsoidInfo['cacheID'] = $title->getLatestRevID();

				$requests[] = array(
					'url'     => $url,
					'headers' => array(
						'X-Parsoid: ' . json_encode( $parsoidInfo ),
						// Force implicit cache refresh similar to
						// https://www.varnish-cache.org/trac/wiki/VCLExampleEnableForceRefresh
						'Cache-control: no-cache'
					)
				);
			}
		}

		// Now send off all those update requests
		$this->checkCurlResults( CurlMultiClient::request( $requests ) );

		wfDebug( 'ParsoidCacheUpdateJob::invalidateTitles update: ' .
			serialize( $requests ) . "\n" );

		return $this->getLastError() == null;
	}
}
