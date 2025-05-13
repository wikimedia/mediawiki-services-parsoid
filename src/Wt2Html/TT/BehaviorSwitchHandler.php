<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Tokens\CompoundTk;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\SelfclosingTagTk;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Tokens\XMLTagTk;
use Wikimedia\Parsoid\Wt2Html\TokenHandlerPipeline;

/**
 * Handler for behavior switches, like '__TOC__' and similar.
 */
class BehaviorSwitchHandler extends TokenHandler {

	public function __construct( TokenHandlerPipeline $manager, array $options ) {
		parent::__construct( $manager, $options );
	}

	private const OUTPUT_FLAG_FROM_BEHAVIOR_SWITCH = [
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
	 * @return array<Token>
	 */
	public function onBehaviorSwitch( Token $token ): array {
		$env = $this->env;
		$magicWord = $env->getSiteConfig()->getMagicWordForBehaviorSwitch( $token->attribs[0]->v );
		$env->setBehaviorSwitch( $magicWord, true );
		if ( isset( self::OUTPUT_FLAG_FROM_BEHAVIOR_SWITCH[$magicWord] ) ) {
			$env->getMetadata()->setOutputFlag(
				self::OUTPUT_FLAG_FROM_BEHAVIOR_SWITCH[$magicWord], true
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
		return [ $metaToken ];
	}

	/**
	 * @inheritDoc
	 */
	public function onTag( XMLTagTk $token ): ?array {
		return $token->getName() === 'behavior-switch' ? $this->onBehaviorSwitch( $token ) : null;
	}

	/**
	 * Process nested tokens and update the compound token.
	 *
	 * @inheritDoc
	 */
	public function onCompoundTk( CompoundTk $ctk, TokenHandler $tokensHandler ): ?array {
		$ctk->setNestedTokens( $tokensHandler->process( $ctk->getNestedTokens() ) );
		return null;
	}

}
