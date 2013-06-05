<?php

/**
 * Basic cache invalidation for Parsoid
 */
if ( !defined( 'MEDIAWIKI' ) ) {
	echo "Parsoid extension\n";
	exit( 1 );
}

/**
 * Class containing basic setup functions.
 */
class ParsoidSetup {

	/**
	 * Set up Parsoid.
	 *
	 * @return void
	 */
	public static function setup() {
		global $wgAutoloadClasses, $wgJobClasses,
			$wgExtensionCredits, $wgExtensionMessagesFiles;

		$dir = __DIR__;

		# Set up class autoloading
		$wgAutoloadClasses['ParsoidHooks'] = "$dir/Parsoid.hooks.php";
		$wgAutoloadClasses['ParsoidCacheUpdateJob'] = "$dir/ParsoidCacheUpdateJob.php";
		$wgAutoloadClasses['CurlMultiClient'] = "$dir/CurlMultiClient.php";

		# Add the ParsoidCacheUpdateJob to the job classes so it can be de-serialized
		$wgJobClasses['ParsoidCacheUpdateJob'] = 'ParsoidCacheUpdateJob';

		$wgExtensionCredits['other'][] = array(
			'path' => __FILE__,
			'name' => 'Parsoid',
			'author' => array(
				'Gabriel Wicke',
				'Subramanya Sastry',
				'Mark Holmquist',
				'Adam Wight',
				'C. Scott Ananian'
			),
			'version' => '0.1.0',
			'url' => 'https://www.mediawiki.org/wiki/Parsoid',
			'descriptionmsg' => 'parsoid-desc',
		);

		# Register localizations.
		$wgExtensionMessagesFiles['Parsoid'] = $dir . '/Parsoid.i18n.php';

		# Set up a default configuration
		self::setupDefaultConfig();

		# Now register our hooks.
		self::registerHooks();
	}


	/**
	 * Set up default config values. Override after requiring the extension.
	 *
	 * @return void
	 */
	protected static function setupDefaultConfig() {
		global $wgParsoidCacheServers, $wgParsoidSkipRatio;

		/**
		 * An array of Varnish caches in front of Parsoid to keep up to date.
		 *
		 * Formats:
		 * 'http://localhost'
		 * 'http://localhost:80'
		 * 'https://127.0.0.1:8080'
		 */
		$wgParsoidCacheServers = array( 'http://localhost' );

		/**
		 * The portion of update requests to skip for basic load shedding. A
		 * float between 0 (none are skipped) and 1 (all are skipped).
		 */
		$wgParsoidSkipRatio = 0.0;
	}


	/**
	 * Register hook handlers.
	 *
	 * @return void
	 */
	protected static function registerHooks() {
		global $wgHooks;

		# Article edit/create
		$wgHooks['ArticleEditUpdates'][] = 'ParsoidHooks::onArticleEditUpdates';
		# Article delete/restore
		$wgHooks['ArticleDeleteComplete'][] = 'ParsoidHooks::onArticleDelete';
		$wgHooks['ArticleUndelete'][] = 'ParsoidHooks::onArticleUndelete';
		# Revision delete/restore
		$wgHooks['ArticleRevisionVisibilitySet'][] = 'ParsoidHooks::onRevisionDelete';
		# Article move
		$wgHooks['TitleMoveComplete'][] = 'ParsoidHooks::onTitleMoveComplete';
		# File upload
		$wgHooks['FileUpload'][] = 'ParsoidHooks::onFileUpload';
	}

}

# Load hooks that are always set
ParsoidSetup::setup();
