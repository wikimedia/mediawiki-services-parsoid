"use strict";

/**
 */

var Util = require('./mediawiki.Util.js').Util;

function BehaviorSwitchHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onBehaviorSwitch.bind( this ), "BehaviorSwitchHandler:onBehaviorSwitch", this.rank, 'tag', 'behavior-switch' );
}

BehaviorSwitchHandler.prototype.rank = 2.14;

BehaviorSwitchHandler.prototype.onBehaviorSwitch = function ( token, manager, cb ) {
	var metaToken, switchType, env = this.manager.env,
		magicWord = token.attribs[0].v;

	env.setVariable( magicWord, true );

	switchType = magicWord.toLowerCase();

	metaToken = new SelfclosingTagTk( 'meta',
		[ new KV( 'property', 'mw:PageProp/' + switchType ) ],
		Util.clone( token.dataAttribs ) );

	return { tokens: [ metaToken ] };
};


if (typeof module === "object") {
	module.exports.BehaviorSwitchHandler = BehaviorSwitchHandler;
}
