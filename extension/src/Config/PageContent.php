<?php

namespace MWParsoid\Config;

use InvalidArgumentException;
use MediaWiki\Revision\RevisionRecord;

use Parsoid\Config\PageContent as IPageContent;

/**
 * PageContent implementation for MediaWiki
 *
 * @todo This belongs in MediaWiki, not Parsoid. We'll move it there when we
 *  get to the point of integrating the two.
 */
class PageContent implements IPageContent {

	/** @var RevisionRecord */
	private $rev;

	/**
	 * @param RevisionRecord $rev
	 */
	public function __construct( RevisionRecord $rev ) {
		$this->rev = $rev;
	}

	/** @inheritDoc */
	public function getRoles(): array {
		return $this->rev->getSlotRoles();
	}

	/** @inheritDoc */
	public function hasRole( string $role ): bool {
		return $this->rev->hasSlot( $role );
	}

	/**
	 * Throw if the revision doesn't have the named role
	 * @param string $role
	 * @throws InvalidArgumentException
	 */
	private function checkRole( string $role ): void {
		if ( !$this->rev->hasSlot( $role ) ) {
			throw new InvalidArgumentException( "PageContent does not have role '$role'" );
		}
	}

	/** @inheritDoc */
	public function getModel( string $role ): string {
		$this->checkRole( $role );
		return $this->rev->getContent( $role )->getModel();
	}

	/** @inheritDoc */
	public function getFormat( string $role ): string {
		$this->checkRole( $role );
		return $this->rev->getContent( $role )->getDefaultFormat();
	}

	/** @inheritDoc */
	public function getContent( string $role ): string {
		$this->checkRole( $role );
		return $this->rev->getContent( $role )->serialize();
	}

	/** @inheritDoc */
	public function getRedirectTarget(): ?string {
		$content = $this->rev->getContent( 'main' );
		$target = $content ? $content->getRedirectTarget() : null;
		return $target ? $target->getPrefixedDBkey() : null;
	}

}
