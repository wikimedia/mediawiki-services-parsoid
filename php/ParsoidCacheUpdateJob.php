<?php

/**
 * HTML cache refreshing and -invalidation job for the Parsoid varnish caches.
 * See
 * http://www.mediawiki.org/wiki/Parsoid/Minimal_performance_strategy_for_July_release
 * @TODO: This is mostly a copy of the HTMLCacheUpdate code. Eventually extend
 * some generic backlink job base class in core
 */
class ParsoidCacheUpdateJob extends Job {
	/** @var BacklinkCache */
	protected $blCache;

	protected $rowsPerJob;

	/**
	 * Construct a job
	 * @param $title Title: the title linked to
	 * @param array $params job parameters (table, start and end page_ids)
	 * @param $id Integer: job id
	 */
	function __construct( $title, $params, $id = 0 ) {
		wfDebug( "ParsoidCacheUpdateJob.__construct " . $title . "\n" );
		global $wgParsoidCacheUpdateTitlesPerJob;

		// Map old jobs to new 'OnEdit' jobs
		if ( ! isset( $params['type'] ) ) {
			$params['type'] = 'OnEdit';
		}
		parent::__construct( 'ParsoidCacheUpdateJob' . $params['type'],
			$title, $params, $id );

		$this->rowsPerJob = $wgParsoidCacheUpdateTitlesPerJob;

		$this->blCache = $title->getBacklinkCache();

		if ( $params['type'] == 'OnEdit' ) {
			// Simple duplicate removal for single-title jobs. Other jobs are
			// deduplicated with root job parameters.
			$this->removeDuplicates = true;
		}
	}

	public function run() {
		if ( isset( $this->params['table'] ) ) {
			if ( isset( $this->params['start'] ) && isset( $this->params['end'] ) ) {
				# This is a child job working on a sub-range of a large number of
				# titles.
				return $this->doPartialUpdate();
			} else  {
				# Update all pages depending on this resource (transclusion or
				# file)
				return $this->doFullUpdate();
			}
		} else {
			# Refresh the Parsoid cache for the page itself
			return $this->invalidateTitle( $this->title );
		}
	}

	/**
	 * Update all of the backlinks
	 */
	protected function doFullUpdate() {
		global $wgParsoidMaxBacklinksInvalidate;

		# Get an estimate of the number of rows from the BacklinkCache
		$max = max( $this->rowsPerJob * 2, $wgParsoidMaxBacklinksInvalidate ) + 1;
		$numRows = $this->blCache->getNumLinks( $this->params['table'], $max );
		if ( $wgParsoidMaxBacklinksInvalidate !== false
			&& $numRows > $wgParsoidMaxBacklinksInvalidate ) {
			wfDebug( "Skipped HTML cache invalidation of {$this->title->getPrefixedText()}." );
			return true;
		}

		if ( $numRows > $this->rowsPerJob * 2 ) {
			# Do fast cached partition
			$this->insertPartitionJobs();
		} else {
			# Get the links from the DB
			$titleArray = $this->blCache->getLinks( $this->params['table'] );
			# Check if the row count estimate was correct
			if ( $titleArray->count() > $this->rowsPerJob * 2 ) {
				# Not correct, do accurate partition
				wfDebug( __METHOD__ . ": row count estimate was incorrect, repartitioning\n" );
				$this->insertJobsFromTitles( $titleArray );
			} else {
				return $this->invalidateTitles( $titleArray ); // just do the query
			}
		}

		return true;
	}

	/**
	 * Update some of the backlinks, defined by a page ID range
	 */
	protected function doPartialUpdate() {
		$titleArray = $this->blCache->getLinks(
			$this->params['table'], $this->params['start'], $this->params['end'] );
		if ( $titleArray->count() <= $this->rowsPerJob * 2 ) {
			# This partition is small enough, do the update
			return $this->invalidateTitles( $titleArray );
		} else {
			# Partitioning was excessively inaccurate. Divide the job further.
			# This can occur when a large number of links are added in a short
			# period of time, say by updating a heavily-used template.
			$this->insertJobsFromTitles( $titleArray );
			return true;
		}
	}

	/**
	 * Partition the current range given by $this->params['start'] and $this->params['end'],
	 * using a pre-calculated title array which gives the links in that range.
	 * Queue the resulting jobs.
	 *
	 * @param $titleArray array
	 * @param $rootJobParams array
	 * @return void
	 */
	protected function insertJobsFromTitles( $titleArray, $rootJobParams = array() ) {
		// Carry over any "root job" information
		$rootJobParams = $this->getRootJobParams();
		# We make subpartitions in the sense that the start of the first job
		# will be the start of the parent partition, and the end of the last
		# job will be the end of the parent partition.
		$jobs = array();
		$start = $this->params['start']; # start of the current job
		$numTitles = 0;
		foreach ( $titleArray as $title ) {
			$id = $title->getArticleID();
			# $numTitles is now the number of titles in the current job not
			# including the current ID
			if ( $numTitles >= $this->rowsPerJob ) {
				# Add a job up to but not including the current ID
				$jobs[] = new ParsoidCacheUpdateJob( $this->title,
					array(
						'table' => $this->params['table'],
						'start' => $start,
						'end' => $id - 1,
						'type' => 'OnDependencyChange'
					) + $rootJobParams // carry over information for de-duplication
				);
				$start = $id;
				$numTitles = 0;
			}
			$numTitles++;
		}
		# Last job
		$jobs[] = new ParsoidCacheUpdateJob( $this->title,
			array(
				'table' => $this->params['table'],
				'start' => $start,
				'end' => $this->params['end'],
				'type' => 'OnDependencyChange'
			) + $rootJobParams // carry over information for de-duplication
		);
		wfDebug( __METHOD__ . ": repartitioning into " . count( $jobs ) . " jobs\n" );

		if ( count( $jobs ) < 2 ) {
			# I don't think this is possible at present, but handling this case
			# makes the code a bit more robust against future code updates and
			# avoids a potential infinite loop of repartitioning
			wfDebug( __METHOD__ . ": repartitioning failed!\n" );
			$this->invalidateTitles( $titleArray );
		} else {
			JobQueueGroup::singleton()->push( $jobs );
		}
	}


	/**
	 * @param $rootJobParams array
	 * @return void
	 */
	protected function insertPartitionJobs( $rootJobParams = array() ) {
		// Carry over any "root job" information
		$rootJobParams = $this->getRootJobParams();

		$batches = $this->blCache->partition( $this->params['table'], $this->rowsPerJob );
		if ( !count( $batches ) ) {
			return; // no jobs to insert
		}

		$jobs = array();
		foreach ( $batches as $batch ) {
			list( $start, $end ) = $batch;
			$jobs[] = new ParsoidCacheUpdateJob( $this->title,
				array(
					'table' => $this->params['table'],
					'start' => $start,
					'end' => $end,
					'type' => 'OnDependencyChange'
				) + $rootJobParams // carry over information for de-duplication
			);
		}

		JobQueueGroup::singleton()->push( $jobs );
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
	protected function invalidateTitle( $title ) {
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
		};
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
		};
		$options = CurlMultiClient::getDefaultOptions();
		$options[CURLOPT_CUSTOMREQUEST] = "PURGE";
		$this->checkCurlResults( CurlMultiClient::request( $requests, $options ) );
		return $this->getLastError() == null;
	}


	/**
	 * Invalidate an array (or iterator) of Title objects, right now. Send
	 * headers that signal Parsoid which of transclusions or extensions need
	 * to be updated.
	 * @param $titleArray array
	 */
	protected function invalidateTitles( $titleArray ) {
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
			foreach ( $titleArray as $title ) {
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

		/*
		  # PURGE
		  # Not needed with implicit updates (see above)
		  # Build an array of purge requests
		  $requests = array();
		  foreach ( $wgParsoidCacheServers as $server ) {
		  foreach ( $titleArray as $title ) {
		  $url = $this->getParsoidURL( $title, $server, false );

		  $requests[] = array(
		  'url' => $url
		  );
		  }
		  }

		  $options = CurlMultiClient::getDefaultOptions();
		  $options[CURLOPT_CUSTOMREQUEST] = "PURGE";
		  // Now send off all those purge requests
		  CurlMultiClient::request( $requests, $options );

		  wfDebug('ParsoidCacheUpdateJob::invalidateTitles purge: ' .
		  serialize($requests) . "\n" );
		 */
	}

}
