<?php

namespace MWParsoid\Config;

use MediaWiki\Linker\LinkTarget;
use MediaWiki\Revision\RevisionStore;
use MediaWiki\Revision\SlotRecord;
use MediaWiki\Revision\SlotRoleRegistry;
use MediaWiki\User\UserIdentity;
use MWParsoid\Config\PageConfig as MWPageConfig;
use Parser;
use ParserOptions;
use Parsoid\Config\PageConfig;
use Title;
use User;

class PageConfigFactory {

	/** @var RevisionStore */
	private $revisionStore;

	/** @var Parser */
	private $parser;

	/** @var ParserOptions */
	private $parserOptions;

	/** @var SlotRoleRegistry */
	private $slotRoleRegistry;

	/**
	 * @param RevisionStore $revisionStore
	 * @param Parser $parser
	 * @param ParserOptions $parserOptions
	 * @param SlotRoleRegistry $slotRoleRegistry
	 */
	public function __construct(
		RevisionStore $revisionStore, Parser $parser, ParserOptions $parserOptions,
		SlotRoleRegistry $slotRoleRegistry
	) {
		$this->parser = $parser;
		$this->revisionStore = $revisionStore;
		$this->parserOptions = $parserOptions;
		$this->slotRoleRegistry = $slotRoleRegistry;
	}

	/**
	 * Create a new PageConfig.
	 * @param LinkTarget $title The page represented by the PageConfig.
	 * @param UserIdentity|null $user User who is doing rendering (for parsing options).
	 * @param int|null $revision The revision of the page.
	 * @return PageConfig
	 */
	public function create(
		LinkTarget $title, UserIdentity $user = null, int $revision = null
	): PageConfig {
		$title = Title::newFromLinkTarget( $title );
		$revision = $this->revisionStore->getRevisionById( $revision );
		$parserOptions = $user
			? ParserOptions::newFromUser( User::newFromIdentity( $user ) )
			: ParserOptions::newCanonical();
		$slotRoleHandler = $this->slotRoleRegistry->getRoleHandler( SlotRecord::MAIN );
		return new MWPageConfig( $this->parser, $parserOptions, $slotRoleHandler, $title, $revision );
	}

}
