<?php

namespace Parsoid\Tests;

use Parsoid\Config\PageContent;

class MockPageContent implements PageContent {

	/** @var array */
	private $data = [];

	/**
	 * @param array $data Page content data. Keys are roles, values are arrays or strings.
	 *  A string value is considered as an array [ 'content' => $value ]. Array keys are:
	 *   - content: (string) The slot's content.
	 *   - contentmodel: (string, default 'wikitext') The slot's content model.
	 *   - contentformat: (string, default 'text/x-wiki') The slot's content format.
	 */
	public function __construct( array $data ) {
		foreach ( $data as $role => $v ) {
			$this->data[$role] = is_string( $v ) ? [ 'content' => $v ] : $v;
		}
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
		return $this->data[$role]['content'];
	}

}
