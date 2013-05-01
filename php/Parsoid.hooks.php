<?php

/**
 * Hooks for events that should trigger Parsoid cache updates.
 */
class ParsoidHooks {
	/**
	 * Schedule an async update job in the job queue. The params passed here
	 * are empty. They are dynamically created in ParsoidCacheUpdateJob
	 * depending on title namespace etc.
	 */
	private static function updateTitle ( $title, $action ) {
		$jobs = array();
		$jobs[] = new ParsoidCacheUpdateJob( $title, array() );
		Job::batchInsert( $jobs );
	}

	/**
	 * Callback for regular article edits
	 *
	 * @param $article WikiPage the modified wiki page object
	 * @param $editInfo
	 * @param bool $changed
	 * @return bool
	 */
	public static function onArticleEditUpdates ( &$article, &$editInfo, $changed ) {
		if ( $changed ) {
			ParsoidHooks::updateTitle( $article->getTitle(), 'edit' );
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
	public static function onArticleDeleteComplete ( &$article, User &$user, $reason, $id )
	{
		ParsoidHooks::updateTitle( $article->getTitle(), 'delete' );
		return true;
	}

	/**
	 * Callback for article undeletion. See specials/SpecialUndelete.php.
	 */
	public static function onArticleUndelete ( $title, $created, $comment ) {
		ParsoidHooks::updateTitle( $title, 'edit' );
		return true;
	}

	/**
	 * Callback for article revision changes. See
	 * revisiondelete/RevisionDelete.php.
	 */
	public static function onArticleRevisionVisibilitySet ( &$title ) {
		# We treat all visibility update as deletions for now. That is safe,
		# as it will always clear the cache. VE requests might be slow after a
		# restore, but they will return the correct result.
		ParsoidHooks::updateTitle( $title, 'delete' );
		return true;
	}

	/**
	 * Title move callback. See Title.php.
	 */
	public static function onTitleMoveComplete ( Title &$title, Title &$newtitle,
			User &$user, $oldid, $newid )
	{
		# Simply update both old and new title. ParsoidCacheUpdateJob will
		# do the right thing for both.
		ParsoidHooks::updateTitle( $title, $oldid, 'delete' );
		ParsoidHooks::updateTitle( $newtitle, $newid, 'edit' );
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
	public static function onFileUpload ( $file ) {
		$title = $file->getTitle();
		ParsoidHooks::updateTitle( $title, 'file' );
		return true;
	}

}
