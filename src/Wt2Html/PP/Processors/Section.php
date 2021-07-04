<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;

class Section {
	/** @var int */
	private $level;

	/**
	 * Useful during debugging, unrelated to data-mw-section-id
	 * @var int
	 */
	private $debugId;

	/** @var Element */
	public $container;

	/**
	 * @param int $level
	 * @param int $debugId
	 * @param Document $ownerDoc
	 */
	public function __construct( int $level, int $debugId, Document $ownerDoc ) {
		$this->level = $level;
		$this->debugId = $debugId;
		$this->container = $ownerDoc->createElement( 'section' );
	}

	/**
	 * @param int $id
	 */
	public function setId( int $id ): void {
		$this->container->setAttribute( 'data-mw-section-id', (string)$id );
		// $this->container->setAttribute( 'data-debug-id', (string)$this->debugId );
	}

	/**
	 * @param string $aboutId
	 */
	public function setAboutId( string $aboutId ): void {
		$this->container->setAttribute( 'about', $aboutId );
	}

	/**
	 * @param Node $node
	 */
	public function addNode( Node $node ): void {
		$this->container->appendChild( $node );
	}

	/**
	 * @param Section $section
	 */
	public function addSection( Section $section ): void {
		// error_log( "Appending to " . $this->debugId . '\n' );
		$this->container->appendChild( $section->container );
	}

	/**
	 * Does this section have a nesting level of $level?
	 * @param int $level
	 * @return bool
	 */
	public function hasNestedLevel( int $level ): bool {
		return $level > $this->level;
	}
}
