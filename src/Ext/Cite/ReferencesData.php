<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Cite;

use Parsoid\Config\Env;
use Parsoid\Utils\ContentUtils;
use Parsoid\Wt2Html\TT\Sanitizer;
use stdClass;

class ReferencesData {

	/**
	 * @var Env
	 */
	private $env;

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
	 * @param Env $env
	 */
	public function __construct( Env $env ) {
		$this->index = 0;
		$this->env = $env;
		$this->refGroups = [];
	}

	/**
	 * @param string $val
	 * @return bool|string
	 */
	public function makeValidIdAttr( string $val ) {
		// Looks like Cite.php doesn't try to fix ids that already have
		// a "_" in them. Ex: name="a b" and name="a_b" are considered
		// identical. Not sure if this is a feature or a bug.
		// It also considers entities equal to their encoding
		// (i.e. '&' === '&amp;'), which is done:
		//  in PHP: Sanitizer#decodeTagAttributes and
		//  in Parsoid: ExtensionHandler#normalizeExtOptions
		return Sanitizer::escapeIdForAttribute( $val );
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
	 * @param string|null $groupName
	 */
	public function removeRefGroup( ?string $groupName = null ): void {
		if ( $groupName !== null ) {
			// '' is a valid group (the default group)
			unset( $this->refGroups[$groupName] );
		}
	}

	/**
	 * @param Env $env
	 * @param string $groupName
	 * @param string $refName
	 * @param string $about
	 * @param bool $skipLinkback
	 * @return stdClass
	 */
	public function add(
		Env $env, string $groupName, string $refName, string $about, bool $skipLinkback
	): stdClass {
		$group = $this->getRefGroup( $groupName, true );
		$refName = $this->makeValidIdAttr( $refName );
		$hasRefName = strlen( $refName ) > 0;

		if ( $hasRefName && isset( $group->indexByName[$refName] ) ) {
			$ref = $group->indexByName[$refName];
			if ( $ref->content && !$ref->hasMultiples ) {
				$ref->hasMultiples = true;
				// Use the non-pp version here since we've already stored attribs
				// before putting them in the map.
				$ref->cachedHtml = ContentUtils::toXML(
					$env->getFragment( $ref->content )[0],
					[ 'innerXML' => true ]
				);
			}
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
				'content' => null,
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
				'cachedHtml' => ''
			];
			$group->refs[] = $ref;
			if ( $refName ) {
				$group->indexByName[$refName] = $ref;
			}
		}

		if ( !$skipLinkback ) {
			$ref->linkbacks[] = $ref->key . '-' . count( $ref->linkbacks );
		}
		return $ref;
	}

	/**
	 * @return Env
	 */
	public function getEnv(): Env {
		return $this->env;
	}

	/**
	 * @return RefGroup[]
	 */
	public function getRefGroups(): array {
		return $this->refGroups;
	}
}
