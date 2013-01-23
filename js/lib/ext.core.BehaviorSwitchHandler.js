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
	var metaToken, magicWord = token.attribs[0].v,
		env = this.manager.env,
		switchType = magicWord.toLowerCase(),
		actualType = env.conf.wiki.magicWords[magicWord] ||
			env.conf.wiki.magicWords[switchType];

	env.setVariable( actualType, true );

	metaToken = new SelfclosingTagTk( 'meta',
		[ new KV( 'property', 'mw:PageProp/' + actualType ) ],
		Util.clone( token.dataAttribs ) );

	return { tokens: [ metaToken ] };
};

function BehaviorSwitchPreprocessor( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onBehaviorSwitch.bind( this ), 'BehaviorSwitchPreprocessor:onBehaviorSwitch',
		this.rank, 'tag', 'behavior-switch' );
}

BehaviorSwitchPreprocessor.prototype.rank = 0.05;

BehaviorSwitchPreprocessor.prototype.onBehaviorSwitch = function ( token, manager, cb ) {
	var metaToken, switchType, env = this.manager.env,
		magicWord = token.attribs[0].v;

	switchType = magicWord.toLowerCase();

	var actualType = env.conf.wiki.magicWords[magicWord] ||
		env.conf.wiki.magicWords[switchType];

	if ( actualType ) {
		token.dataAttribs.magicSrc = magicWord;
		return {
			tokens: [ token ]
		};
	} else {
		return {
			tokens: [ magicWord ]
		};
	}
};

if (typeof module === "object") {
	module.exports.BehaviorSwitchHandler = BehaviorSwitchHandler;
	module.exports.BehaviorSwitchPreprocessor = BehaviorSwitchPreprocessor;
}
