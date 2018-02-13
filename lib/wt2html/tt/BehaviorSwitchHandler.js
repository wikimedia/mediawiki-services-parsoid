/** @module */

'use strict';

var Util = require('../../utils/Util.js').Util;
var TokenHandler = require('./TokenHandler.js');
var defines = require('../parser.defines.js');

// define some constructor shortcuts
var KV = defines.KV;
var SelfclosingTagTk = defines.SelfclosingTagTk;


/**
 * Handler for behavior switches, like '__TOC__' and similar.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 * @constructor
 */
class BehaviorSwitchHandler extends TokenHandler { }

BehaviorSwitchHandler.prototype.rank = 2.14;

BehaviorSwitchHandler.prototype.init = function() {
	this.manager.addTransform(this.onBehaviorSwitch.bind(this),
		'BehaviorSwitchHandler:onBehaviorSwitch', this.rank, 'tag',
		'behavior-switch');
};

/**
 * Main handler.
 * See {@link TokenTransformManager#addTransform}'s transformation parameter
 */
BehaviorSwitchHandler.prototype.onBehaviorSwitch = function(token, manager, cb) {
	var metaToken;
	var env = this.manager.env;
	var magicWord = env.conf.wiki.magicWordCanonicalName(token.attribs[0].v);

	env.setVariable(magicWord, true);

	metaToken = new SelfclosingTagTk('meta',
		[ new KV('property', 'mw:PageProp/' + magicWord) ],
		Util.clone(token.dataAttribs));

	return { tokens: [ metaToken ] };
};


if (typeof module === "object") {
	module.exports.BehaviorSwitchHandler = BehaviorSwitchHandler;
}
