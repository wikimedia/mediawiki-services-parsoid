<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use stdClass;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

class ReferencesData {

	/**
	 * @var int
	 */
	private $index = 0;

	/**
	 * @var RefGroup[]
	 */
	private $refGroups = [];

	/** @var array */
	public $embeddedErrors = [];

	/** @var array */
	private $inEmbeddedContent = [];

	/** @var string */
	public $referencesGroup = '';

	/**
	 * @return bool
	 */
	public function inReferencesContent(): bool {
		return $this->inEmbeddedContent( 'references' );
	}

	/**
	 * @param ?string $needle
	 * @return bool
	 */
	public function inEmbeddedContent( ?string $needle = null ): bool {
		if ( $needle ) {
			return in_array( $needle, $this->inEmbeddedContent, true );
		} else {
			return count( $this->inEmbeddedContent ) > 0;
		}
	}

	/**
	 * @param string $needle
	 */
	public function pushEmbeddedContentFlag( string $needle = 'embed' ) {
		array_unshift( $this->inEmbeddedContent, $needle );
	}

	public function popEmbeddedContentFlag() {
		array_shift( $this->inEmbeddedContent );
	}

	/**
	 * @param string $groupName
	 * @param bool $allocIfMissing
	 * @return ?RefGroup
	 */
	public function getRefGroup(
		string $groupName, bool $allocIfMissing = false
	): ?RefGroup {
		if ( !isset( $this->refGroups[$groupName] ) && $allocIfMissing ) {
			$this->refGroups[$groupName] = new RefGroup( $groupName );
		}
		return $this->refGroups[$groupName] ?? null;
	}

	/**
	 * @param string $groupName
	 */
	public function removeRefGroup( string $groupName ): void {
		// '' is a valid group (the default group)
		unset( $this->refGroups[$groupName] );
	}

	/**
	 * Normalizes and sanitizes a reference key
	 *
	 * @param string $key
	 * @return string
	 */
	private function normalizeKey( string $key ): string {
		$ret = Sanitizer::escapeIdForAttribute( $key );
		$ret = preg_replace( '/__+/', '_', $ret );
		// FIXME: The extension to the legacy parser does the following too,
		// but Parsoid hasn't ported it yet and needs investigation of
		// whether it's still relevant in the Parsoid context.
		// $ret = Sanitizer::safeEncodeAttribute( $ret );
		return $ret;
	}

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $groupName
	 * @param string $refName
	 * @return stdClass
	 */
	public function add(
		ParsoidExtensionAPI $extApi, string $groupName, string $refName
	): stdClass {
		$group = $this->getRefGroup( $groupName, true );
		$hasRefName = strlen( $refName ) > 0;

		// The ids produced Cite.php have some particulars:
		// Simple refs get 'cite_ref-' + index
		// Refs with names get 'cite_ref-' + name + '_' + index + (backlink num || 0)
		// Notes (references) whose ref doesn't have a name are 'cite_note-' + index
		// Notes whose ref has a name are 'cite_note-' + name + '-' + index
		$n = $this->index;
		$refKey = strval( 1 + $n );

		$refNameSanitized = $this->normalizeKey( $refName );

		$refIdBase = 'cite_ref-' . ( $hasRefName ? $refNameSanitized . '_' . $refKey : $refKey );
		$noteId = 'cite_note-' . ( $hasRefName ? $refNameSanitized . '-' . $refKey : $refKey );

		// bump index
		$this->index += 1;

		$ref = (object)[
			// Pointer to the contents of the ref, accessible with the
			// $extApi->getContentDOM(), to be used when serializing the
			// references group.  It gets set when extracting the ref from a
			// node and not $missingContent.  Note that that might not
			// be the first one for named refs.  Also, for named refs, it's
			// used to detect multiple conflicting definitions.
			'contentId' => null,
			// Just used for comparison when we have multiples
			'cachedHtml' => null,
			'dir' => '',
			'group' => $group->name,
			'groupIndex' => count( $group->refs ) + 1,
			'index' => $n,
			'key' => $refIdBase,
			'id' => $hasRefName ? $refIdBase . '-0' : $refIdBase,
			'linkbacks' => [],
			'name' => $refName,
			'target' => $noteId,
			'nodes' => [],
			'embeddedNodes' => [],
		];

		$group->refs[] = $ref;

		if ( $hasRefName ) {
			$group->indexByName[$refName] = $ref;
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
