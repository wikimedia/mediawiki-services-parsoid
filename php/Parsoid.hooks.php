<?php

/**
 * Hooks for events that should trigger Parsoid cache updates.
 */
class ParsoidHooks {

	/**
	 * Get the job parameters for a given title, job type and table name.
	 *
	 * @param Title $title
	 * @param string $type the job type (OnEdit or OnDependencyChange)
	 * @param string $table (optional for OnDependencyChange, templatelinks or
	 * imagelinks)
	 * @return Array
	 */
	private static function getJobParams( Title $title, $type, $table = null ) {
		$params = array( 'type' => $type );
		if ( $type == 'OnDependencyChange' ) {
			$params['table'] = $table;
			$params['recursive'] = true;
			return $params + Job::newRootJobParams(
				"ParsoidCacheUpdateJob{$type}:{$title->getPrefixedText()}");
		} else {
			return $params;
		}
	}


	/**
	 * Schedule an async update job in the job queue. The params passed here
	 * are empty. They are dynamically created in ParsoidCacheUpdateJob
	 * depending on title namespace etc.
	 *
	 * @param Title $title
	 * @param string $action (@TODO: unused)
	 */
	private static function updateTitle( Title $title, $action ) {
		global $wgParsoidSkipRatio;
		if ( $wgParsoidSkipRatio != 0
			&& ( rand() / getrandmax() ) < $wgParsoidSkipRatio )
		{
			// skip this update
			return;
		}

		if ( $title->getNamespace() == NS_FILE ) {
			// File. For now we assume the actual image or file has
			// changed, not just the description page.
			$params = self::getJobParams( $title, 'OnDependencyChange', 'imagelinks' );
			$job = new ParsoidCacheUpdateJob( $title, $params );
			JobQueueGroup::singleton()->push( $job );
			JobQueueGroup::singleton()->deduplicateRootJob( $job );
		} else {
			// Push one job for the page itself
			$params = self::getJobParams( $title, 'OnEdit' );
			JobQueueGroup::singleton()->push( new ParsoidCacheUpdateJob( $title, $params ) );

			// and one for pages transcluding this page.
			$params = self::getJobParams( $title, 'OnDependencyChange', 'templatelinks' );
			$job = new ParsoidCacheUpdateJob( $title, $params );
			JobQueueGroup::singleton()->push( $job );
			JobQueueGroup::singleton()->deduplicateRootJob( $job );
		}
	}

	/**
	 * Callback for regular article edits
	 *
	 * @param $article WikiPage the modified wiki page object
	 * @param $editInfo
	 * @param bool $changed
	 * @return bool
	 */
	public static function onArticleEditUpdates( $article, $editInfo, $changed ) {
		if ( $changed ) {
			self::updateTitle( $article->getTitle(), 'edit' );
		}
		return true;
	}

	/**
	 * Callback for article deletions
	 *
	 * @param $article WikiPage the modified wiki page object
	 * @param $user User the deleting user
	 * @param string $reason
	 * @param int $id the page id
	 * @return bool
	 */
	public static function onArticleDeleteComplete( $article, User $user, $reason, $id ) {
		self::updateTitle( $article->getTitle(), 'delete' );
		return true;
	}

	/**
	 * Callback for article undeletion. See specials/SpecialUndelete.php.
	 */
	public static function onArticleUndelete( Title $title, $created, $comment ) {
		self::updateTitle( $title, 'edit' );
		return true;
	}

	/**
	 * Callback for article revision changes. See
	 * revisiondelete/RevisionDelete.php.
	 */
	public static function onArticleRevisionVisibilitySet( Title $title ) {
		# We treat all visibility update as deletions for now. That is safe,
		# as it will always clear the cache. VE requests might be slow after a
		# restore, but they will return the correct result.
		self::updateTitle( $title, 'delete' );
		return true;
	}

	/**
	 * Title move callback. See Title.php.
	 */
	public static function onTitleMoveComplete(
		Title $title, Title $newtitle, User $user, $oldid, $newid
	) {
		# Simply update both old and new title. ParsoidCacheUpdateJob will
		# do the right thing for both. @FIXME: this passes extra parameters
		self::updateTitle( $title, 'delete', $oldid );
		self::updateTitle( $newtitle, 'edit', $newid );
		return true;
	}

	/**
	 * File upload hook. See filerepo/file/LocalFile.php.
	 *
	 * XXX gwicke: This tracks file uploads including re-uploads of a new
	 * version of an image. These will implicitly also trigger null edits on
	 * the associated WikiPage (which normally exists), which then triggers
	 * the onArticleEditUpdates hook. Maybe we should thus drop this hook and
	 * simply assume that all edits to the WikiPage also change the image
	 * data.  Those edits tend to happen not long after an upload, at which
	 * point the image is likely not used in many pages.
	 */
	public static function onFileUpload( File $file ) {
		self::updateTitle( $file->getTitle(), 'file' );
		return true;
	}
}
