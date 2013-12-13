"use strict";

var Util = require('./mediawiki.Util.js').Util,
    defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var KV = defines.KV,
    SelfclosingTagTk = defines.SelfclosingTagTk;

/**
 * @class
 *
 * Handler for behavior switches, like '__TOC__' and similar.
 *
 * @constructor
 * @param {Object} manager
 * @param {Object} options
 */
function BehaviorSwitchHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onBehaviorSwitch.bind( this ), "BehaviorSwitchHandler:onBehaviorSwitch", this.rank, 'tag', 'behavior-switch' );
}

// Indicates where in the pipeline this handler should be run.
BehaviorSwitchHandler.prototype.rank = 2.14;

/**
 * Main handler.
 * See {@link TokenTransformManager#addTransform}'s transformation parameter
 */
BehaviorSwitchHandler.prototype.onBehaviorSwitch = function ( token, manager, cb ) {
	var metaToken,
		env = this.manager.env,
		magicWord = env.conf.wiki.magicWordCanonicalName(token.attribs[0].v);

	env.setVariable( magicWord, true );

	metaToken = new SelfclosingTagTk( 'meta',
		[ new KV( 'property', 'mw:PageProp/' + magicWord ) ],
		Util.clone( token.dataAttribs ) );

	return { tokens: [ metaToken ] };
};

/**
 * @class
 *
 * Pre-process behavior switches, check to see that they're valid magic words.
 *
 * @constructor
 * @param {Object} manager
 * @param {Object} options
 */
function BehaviorSwitchPreprocessor( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onBehaviorSwitch.bind( this ), 'BehaviorSwitchPreprocessor:onBehaviorSwitch',
		this.rank, 'tag', 'behavior-switch' );
}

// Specifies where in the pipeline this stage should run.
BehaviorSwitchPreprocessor.prototype.rank = 0.05;

/**
 * See {@link TokenTransformManager#addTransform}'s transformation parameter
 */
BehaviorSwitchPreprocessor.prototype.onBehaviorSwitch = function ( token, manager, cb ) {
	var magicWord = token.attribs[0].v;
	if ( this.manager.env.conf.wiki.isMagicWord(magicWord) ) {
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
