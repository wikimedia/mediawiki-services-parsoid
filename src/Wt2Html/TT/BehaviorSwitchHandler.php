<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * Handler for behavior switches, like '__TOC__' and similar.
 */
class BehaviorSwitchHandler extends TokenHandler {

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	private static $OutputFlagFromBS = [
		// ParserOutputFlags::NO_GALLERY
		'nogallery' => 'mw-NoGallery',

		// ParserOutputFlags::NEW_SECTION
		'newsectionlink' => 'mw-NewSection',

		// ParserOutputFlags::HIDE_NEW_SECTION
		'nonewsectionlink' => 'mw-HideNewSection',

		// ParserOutputFlags::NO_SECTION_EDIT_LINKS
		'noeditsection' => 'no-section-edit-links',
	];

	/**
	 * Main handler.
	 * See {@link TokenHandlerPipeline#addTransform}'s transformation parameter.
	 *
	 * @param Token $token
	 * @return TokenHandlerResult
	 */
	public function onBehaviorSwitch( Token $token ): TokenHandlerResult {
		$env = $this->env;
		$magicWord = $env->getSiteConfig()->getMagicWordForBehaviorSwitch( $token->attribs[0]->v );
		$env->setBehaviorSwitch( $magicWord, true );
		if ( isset( self::$OutputFlagFromBS[$magicWord] ) ) {
			$env->getMetadata()->setOutputFlag(
				self::$OutputFlagFromBS[$magicWord], true
			);
		}
		if (
			$magicWord === 'hiddencat' &&
			$env->getPageConfig()->getLinkTarget()->getNamespace() === 14 // NS_CATEGORY
		) {
			$env->getDataAccess()->addTrackingCategory(
				$env->getPageConfig(),
				$env->getMetadata(),
				'hidden-category-category'
			);
		}
		$metaToken = new SelfclosingTagTk(
			'meta',
			[ new KV( 'property', 'mw:PageProp/' . $magicWord ) ],
			clone $token->dataParsoid
		);
		return new TokenHandlerResult( [ $metaToken ] );
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( Token $token ): ?TokenHandlerResult {
		return $token->getName() === 'behavior-switch' ? $this->onBehaviorSwitch( $token ) : null;
	}
}
