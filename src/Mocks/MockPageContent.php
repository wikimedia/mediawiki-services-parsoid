<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Mocks;

use Wikimedia\Parsoid\Config\PageContent;
use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\Utils\TitleValue;

class MockPageContent extends PageContent {

	private LinkTarget $title;
	private ?int $revid;

	/**
	 * Alas, this is public because parserTests is reaching in and altering
	 * the main content when various modes are run.
	 *
	 * @var array
	 */
	public $data = [];

	/**
	 * @param array $data Page content data. Keys are roles, values are arrays or strings.
	 *  A string value is considered as an array [ 'content' => $value ]. Array keys are:
	 *   - content: (string) The slot's content.
	 *   - contentmodel: (string, default 'wikitext') The slot's content model.
	 *   - contentformat: (string, default 'text/x-wiki') The slot's content format.
	 *   - redirect: (string, optional) The redirect target (same format as PageConfig::getTitle),
	 *     if this content is a redirect.
	 */
	public function __construct( array $data, ?LinkTarget $title = null, ?int $revid = null ) {
		$this->title = $title ?? TitleValue::tryNew( 0, 'TestPage' );
		foreach ( $data as $role => $v ) {
			$this->data[$role] = is_string( $v ) ? [ 'content' => $v ] : $v;
		}
		$this->revid = $revid;
	}

	/** @inheritDoc */
	public function getLinkTarget(): LinkTarget {
		return $this->title;
	}

	/** @inheritDoc */
	public function getRevisionId(): ?int {
		return $this->revid;
	}

	/** @inheritDoc */
	public function getRoles(): array {
		return array_keys( $this->data );
	}

	/** @inheritDoc */
	public function hasRole( string $role ): bool {
		return isset( $this->data[$role] );
	}

	private function checkRole( string $role ): void {
		if ( !isset( $this->data[$role] ) ) {
			throw new \InvalidArgumentException( "Unknown role \"$role\"" );
		}
	}

	/** @inheritDoc */
	public function getModel( string $role ): string {
		$this->checkRole( $role );
		return $this->data[$role]['contentmodel'] ?? 'wikitext';
	}

	/** @inheritDoc */
	public function getFormat( string $role ): string {
		$this->checkRole( $role );
		return $this->data[$role]['contentformat'] ?? 'text/x-wiki';
	}

	/** @inheritDoc */
	public function getContent( string $role ): string {
		$this->checkRole( $role );
		if ( !isset( $this->data[$role]['content'] ) ) {
			throw new \InvalidArgumentException( 'Unknown role or missing content failure' );
		}
		return $this->data[$role]['content'];
	}

}
