<?php

namespace Parsoid\Config;

/**
 * Page-level configuration interface for Parsoid
 */
abstract class PageConfig {

	/**
	 * Whether the page has a lintable content model
	 * @return bool
	 */
	abstract public function hasLintableContentModel();

	/**
	 * The page's title, as a string.
	 * @return string With namespace, spaces not underscores
	 */
	abstract public function getTitle();

	/**
	 * The page's namespace ID
	 * @return int
	 */
	abstract public function getNs();

	/**
	 * The page's ID, if any
	 * @return int 0 if the page doesn't exist
	 */
	abstract public function getPageId();

	/**
	 * The page's language code
	 * @return string
	 */
	abstract public function getPageLanguage();

	/**
	 * The page's language direction
	 * @return string 'ltr' or 'rtl'
	 */
	abstract public function getPageLanguageDir();

	/**
	 * The revision's ID, if any
	 * @return int|null
	 */
	abstract public function getRevisionId();

	/**
	 * The revision's parent ID, if any
	 * @return int|null
	 */
	abstract public function getParentRevisionId();

	/**
	 * The revision's timestamp, if any
	 * @return string "YYYYMMDDHHIISS" format
	 */
	abstract public function getRevisionTimestamp();

	/**
	 * The revision's author's user name, if any
	 * @return string|null
	 */
	abstract public function getRevisionUser();

	/**
	 * The revision's author's user ID, if any
	 * @return int|null 0 if the user is not registered
	 */
	abstract public function getRevisionUserId();

	/**
	 * The revision's SHA1 checksum, if any
	 * @return string|null Hex encoded
	 */
	abstract public function getRevisionSha1();

	/**
	 * The revision's length, if known
	 * @return int|null Bytes
	 */
	abstract public function getRevisionSize();

	/**
	 * The slot roles present in the revision
	 * @return string[]
	 */
	abstract public function getRevisionSlotRoles();

	/**
	 * The revision's slot's content
	 * @param string $role
	 * @return array|null If an array, has the following fields:
	 *  - model: Content model
	 *  - format: Content format
	 *  - text: Content text
	 */
	abstract public function getRevisionContent( $role );

}
