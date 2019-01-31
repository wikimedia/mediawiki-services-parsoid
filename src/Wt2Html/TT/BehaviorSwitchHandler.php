<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\Util as Util;
use Parsoid\TokenHandler as TokenHandler;
use Parsoid\KV as KV;
use Parsoid\SelfclosingTagTk as SelfclosingTagTk;

/**
 * Handler for behavior switches, like '__TOC__' and similar.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class BehaviorSwitchHandler extends TokenHandler {
	/**
	 * Main handler.
	 * See {@link TokenTransformManager#addTransform}'s transformation parameter.
	 */
	public function onBehaviorSwitch( $token ) {
		$env = $this->manager->env;
		$magicWord = $env->conf->wiki->magicWordCanonicalName( $token->attribs[ 0 ]->v );

		$env->setVariable( $magicWord, true );

		$metaToken = new SelfclosingTagTk(
			'meta',
			[ new KV( 'property', 'mw:PageProp/' . $magicWord ) ],
			Util::clone( $token->dataAttribs )
		);

		return [ 'tokens' => [ $metaToken ] ];
	}

	public function onTag( $token ) {
		return ( $token->name === 'behavior-switch' ) ? $this->onBehaviorSwitch( $token ) : $token;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->BehaviorSwitchHandler = $BehaviorSwitchHandler;
}
