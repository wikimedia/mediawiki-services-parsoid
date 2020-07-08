<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use DOMElement;
use stdClass;
use Wikimedia\Parsoid\Ext\DOMUtils;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

class ReferencesData {

	/**
	 * @var int
	 */
	private $index;

	/**
	 * @var RefGroup[]
	 */
	private $refGroups;

	/**
	 * ReferencesData constructor.
	 */
	public function __construct() {
		$this->index = 0;
		$this->refGroups = [];
	}

	/**
	 * @param string $groupName
	 * @param bool $allocIfMissing
	 * @return RefGroup|null
	 */
	public function getRefGroup( string $groupName = '', bool $allocIfMissing = false ): ?RefGroup {
		if ( !isset( $this->refGroups[$groupName] ) && $allocIfMissing ) {
			$this->refGroups[$groupName] = new RefGroup( $groupName );
		}
		return $this->refGroups[$groupName] ?? null;
	}

	/**
	 * @param ?string $groupName
	 */
	public function removeRefGroup( ?string $groupName = null ): void {
		if ( $groupName !== null ) {
			// '' is a valid group (the default group)
			unset( $this->refGroups[$groupName] );
		}
	}

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $groupName
	 * @param string $refName
	 * @param string $follow
	 * @param string $contentId
	 * @param string $about
	 * @param bool $skipLinkback
	 * @param DOMElement $linkBack
	 * @return stdClass
	 */
	public function add(
		ParsoidExtensionAPI $extApi, string $groupName, string $refName, string $follow,
		string $contentId, string $about, bool $skipLinkback, DOMElement $linkBack
	): stdClass {
		$group = $this->getRefGroup( $groupName, true );
		// Looks like Cite.php doesn't try to fix ids that already have
		// a "_" in them. Ex: name="a b" and name="a_b" are considered
		// identical. Not sure if this is a feature or a bug.
		// It also considers entities equal to their encoding
		// (i.e. '&' === '&amp;'), which is done:
		//  in PHP: Sanitizer#decodeTagAttributes and
		//  in Parsoid: ExtensionHandler#normalizeExtOptions
		$refName = $extApi->sanitizeHTMLId( $refName );
		$hasRefName = strlen( $refName ) > 0;
		$hasFollow = strlen( $follow ) > 0;

		// Is this a follow ref that has been preceeded by a named ref which defined
		// content or did not define content, or a self closed named ref without content
		if ( !$hasRefName && $hasFollow && isset( $group->indexByName[$follow] ) ) {
			$ref = $group->indexByName[$follow];
			$contentSup = $extApi->getContentDOM( $contentId );
			$ownerDoc = $contentSup->ownerDocument;
			$span = $ownerDoc->createElement( 'span' );
			DOMUtils::addTypeOf( $span, 'mw:Cite/Follow' );
			$span->setAttribute( 'about', $about );
			$spaceNode = $ownerDoc->createTextNode( ' ' );
			$span->appendChild( $spaceNode );
			DOMUtils::migrateChildren( $contentSup, $span );

			// contentSup is now empty and can be used as a container for migrate children
			$contentSup->appendChild( $span );

			// If the named ref has defined content
			if ( $ref->contentId ) {
				$refContent = $extApi->getContentDOM( $ref->contentId );
				ParsoidExtensionAPI::migrateChildrenBetweenDocs( $contentSup, $refContent, false );
			} else {
				// Otherwise we have a follow that comes after named ref without content
				// So create a sup in a fragment, set that into the environment and migrate
				// the follow content into the fragment
				$ref->contentId = $contentId;
			}
			return $ref;
		}

		// Must check for error case where $hasRefName and $hasFollow are both present
		// which still needs to create the ref, but also flag it with an error due to
		// [ 'key' => 'cite_error_ref_too_many_keys' ]; as trapped in References.php
		// but which needs to preserve the extra key for round tripping

		if ( $hasRefName && isset( $group->indexByName[$refName] ) ) {
			$ref = $group->indexByName[$refName];
			if ( $ref->contentId && !$ref->hasMultiples ) {
				$ref->hasMultiples = true;
				// Use the non-pp version here since we've already stored attribs
				// before putting them in the map.
				$ref->cachedHtml = $extApi->getContentHTML( $ref->contentId );
			}
			$ref->nodes[] = $linkBack;
		} else {
			// The ids produced Cite.php have some particulars:
			// Simple refs get 'cite_ref-' + index
			// Refs with names get 'cite_ref-' + name + '_' + index + (backlink num || 0)
			// Notes (references) whose ref doesn't have a name are 'cite_note-' + index
			// Notes whose ref has a name are 'cite_note-' + name + '-' + index
			$n = $this->index;
			$refKey = strval( 1 + $n );
			$refIdBase = 'cite_ref-' . ( $hasRefName ? $refName . '_' . $refKey : $refKey );
			$noteId = 'cite_note-' . ( $hasRefName ? $refName . '-' . $refKey : $refKey );

			// bump index
			$this->index += 1;

			$ref = (object)[
				'about' => $about,
				'contentId' => null,
				'dir' => '',
				'group' => $group->name,
				'groupIndex' => count( $group->refs ) + 1,
				'index' => $n,
				'key' => $refIdBase,
				'id' => $hasRefName ? $refIdBase . '-0' : $refIdBase,
				'linkbacks' => [],
				'name' => $refName,
				'target' => $noteId,
				'hasMultiples' => false,
				// Just used for comparison when we have multiples
				'cachedHtml' => '',
				'nodes' => [],
			];
			$group->refs[] = $ref;
			if ( $hasRefName ) {
				$group->indexByName[$refName] = $ref;
				$ref->nodes[] = $linkBack;
			}
		}

		if ( !$skipLinkback ) {
			$ref->linkbacks[] = $ref->key . '-' . count( $ref->linkbacks );
		}

		return $ref;
	}

	/**
	 * @return RefGroup[]
	 */
	public function getRefGroups(): array {
		return $this->refGroups;
	}
}
