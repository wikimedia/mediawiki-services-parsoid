<?php

namespace MWParsoid\Config;

use MediaWiki\Linker\LinkTarget;
use MediaWiki\Revision\MutableRevisionRecord;
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
use WikitextContent;

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
	 * @param int|null $revisionId The revision of the page.
	 * @param string|null $wikitextOverride Wikitext to use instead of the
	 *   contents of the specific $revision; used when $revision is null
	 *   (a new page) or when we are parsing a stashed text.
	 * @return PageConfig
	 */
	public function create(
		LinkTarget $title,
		UserIdentity $user = null,
		int $revisionId = null,
		string $wikitextOverride = null
	): PageConfig {
		$title = Title::newFromLinkTarget( $title );
		$revisionRecord = null;
		if ( $revisionId !== null ) {
			$revisionRecord = $this->revisionStore->getRevisionById(
				$revisionId
			);
		}
		if ( $wikitextOverride !== null || $revisionRecord === null ) {
			if ( $revisionRecord ) {
				// PORT-FIXME this is not really the right thing to do; need
				// a clone-like constructor for MutableRevisionRecord
				$revisionRecord = MutableRevisionRecord::newFromParentRevision(
					$revisionRecord
				);
			} else {
				$revisionRecord = new MutableRevisionRecord( $title );
			}
			$revisionRecord->setSlot(
				SlotRecord::newUnsaved(
					SlotRecord::MAIN,
					new WikitextContent( $wikitextOverride ?? '' )
				)
			);
		}
		$parserOptions = $user
			? ParserOptions::newFromUser( User::newFromIdentity( $user ) )
			: ParserOptions::newCanonical();
		$slotRoleHandler = $this->slotRoleRegistry->getRoleHandler( SlotRecord::MAIN );
		return new MWPageConfig(
			$this->parser,
			$parserOptions,
			$slotRoleHandler,
			$title,
			$revisionRecord
		);
	}

}
