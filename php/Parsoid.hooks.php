<?php

/**
 * Hooks for events that should trigger Parsoid cache updates.
 */
class ParsoidHooks {

	/**
	 * Schedule an async update job in the job queue. The params passed here
	 * are empty. They are dynamically created in ParsoidCacheUpdateJob
	 * depending on title namespace etc.
	 *
	 * @param Title $title
	 * @param string $action (@TODO: unused)
	 */
	private static function updateTitle( Title $title, $action ) {
		JobQueueGroup::singleton()->push( new ParsoidCacheUpdateJob( $title, array() ) );
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
