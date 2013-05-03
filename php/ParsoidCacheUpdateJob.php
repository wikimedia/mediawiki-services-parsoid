<?php
/**
 * HTML cache refreshing and -invalidation job for the Parsoid varnish caches.
 * See
 * http://www.mediawiki.org/wiki/Parsoid/Minimal_performance_strategy_for_July_release
 */
class ParsoidCacheUpdateJob extends HTMLCacheUpdateJob {
	/**
	 * Construct a job
	 * @param $title Title: the title linked to
	 * @param array $params job parameters (table, start and end page_ids)
	 * @param $id Integer: job id
	 */
	function __construct( $title, $params, $id = 0 ) {
		wfDebug("ParsoidCacheUpdateJob.__construct\n");
		global $wgUpdateRowsPerJob;

		Job::__construct( 'ParsoidCacheUpdateJob', $title, $params, $id );

		# $this->rowsPerJob = $wgUpdateRowsPerJob;
		# Parsoid re-parses will be slow, so set the number of titles per job
		# to 10 for now.
		$this->rowsPerJob = 10;

		$this->blCache = $title->getBacklinkCache();
	}

	public function run() {
		if ( isset( $this->params['start'] ) && isset( $this->params['end'] ) ) {
			# This is a child job working on a sub-range of a large number of
			# titles.
			return $this->doPartialUpdate();
		} else {
			# The root job.
			if ( $this->title->getNamespace() == NS_FILE ) {
				# File. For now we assume the actual image or file has
				# changed, not just the description page.
				$this->params['table'] = 'imagelinks';
				$this->doFullUpdate();
			} else {
				# Not a file: Refresh the Parsoid cache for the page itself
				$this->invalidateTitle( $this->title );
				# and refresh expansions in pages transcluding this page.
				$this->params['table'] = 'templatelinks';
				$this->doFullUpdate();
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
	protected function getParsoidURL( $title, $server, $prev = false ) {
		global $wgLanguageCode;

		$oldid = $prev ? $title->getPreviousRevisionID($title->getLatestRevID())
								: $title->getLatestRevID();

		return 'http://' . $server . '/' . $wgLanguageCode . '/' .
			$title->getPrefixedDBkey() . '?oldid=' . $oldid;
	}


	/**
	 * Invalidate a single title object
	 * @param $title Title
	 */
	protected function invalidateTitle( $title ) {
		global $wgParsoidCacheServers;
		if( !isset( $wgParsoidCacheServers ) ) {
			$wgParsoidCacheServers = array( 'localhost' );
		}

		# First request the new version
		$parsoidInfo = array();
		$parsoidInfo['prevID'] = $title->getPreviousRevisionID($title->getLatestRevID());
		$parsoidInfo['changedTitle'] = $this->title->getPrefixedDBkey();

		$requests = array ();
		foreach ( $wgParsoidCacheServers as $server ) {
			$requests[] = array(
				'url' => $this->getParsoidURL( $title, $server ),
				'headers' => array(
					'X-Parsoid: ' . json_encode( $parsoidInfo ),
					// Force implicit cache refresh similar to
					// https://www.varnish-cache.org/trac/wiki/VCLExampleEnableForceRefresh
					'Cache-control: no-cache'
				)
			);
		};
		wfDebug("ParsoidCacheUpdateJob::invalidateTitle: " .
			serialize($requests) . "\n");
		CurlMultiClient::request( $requests );

		# And now purge the previous revision
		$requests = array ();
		foreach ( $wgParsoidCacheServers as $server ) {
			$requests[] = array(
				'url' => $this->getParsoidURL( $title, $server, true )
			);
		};
		$options = CurlMultiClient::getDefaultOptions();
		$options[CURLOPT_CUSTOMREQUEST] = "PURGE";
		CurlMultiClient::request( $requests, $options );
	}

	/**
	 * Invalidate an array (or iterator) of Title objects, right now
	 * @param $titleArray array
	 */
	protected function invalidateTitles( $titleArray ) {
		global $wgParsoidCacheServers, $wgLanguageCode;
		if( !isset( $wgParsoidCacheServers ) ) {
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

				$parsoidInfo['prevID'] = $title->getPreviousRevisionID($title->getLatestRevID());

				$requests[] = array(
					'url' => $url,
					'headers' => array(
						'X-Parsoid: ' . json_encode( $parsoidInfo )
					)
				);
			}
		}

		// Now send off all those update requests
		CurlMultiClient::request( $requests );

		wfDebug('ParsoidCacheUpdateJob::invalidateTitles update: ' .
			serialize($requests) . "\n" );

		# PURGE
		# Build an array of purge requests
		$requests = array();
		foreach ( $wgParsoidCacheServers as $server ) {
			foreach ( $titleArray as $title ) {
				$url = $this->getParsoidURL( $title, $server, true );

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
	}
}
