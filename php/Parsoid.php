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
	 * Register hook handlers.
	 * This function must NOT depend on any config vars.
	 *
	 * @return void
	 */
	public static function setUnconditionalHooks() {
		global $wgHooks, $wgAutoloadClasses, $wgJobClasses;

		$dir = __DIR__;

		# Set up class autoloading
		$wgAutoloadClasses['ParsoidHooks'] = "$dir/Parsoid.hooks.php";
		$wgAutoloadClasses['ParsoidCacheUpdateJob'] = "$dir/ParsoidCacheUpdateJob.php";
		$wgAutoloadClasses['CurlMultiClient'] = "$dir/CurlMultiClient.php";

		# Add the ParsoidCacheUpdateJob to the job classes so it can be de-serialized
		$wgJobClasses['ParsoidCacheUpdateJob'] = 'ParsoidCacheUpdateJob';

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
ParsoidSetup::setUnconditionalHooks();
