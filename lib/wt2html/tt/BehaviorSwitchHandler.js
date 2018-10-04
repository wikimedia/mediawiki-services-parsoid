/** @module */

'use strict';

var { Util } = require('../../utils/Util.js');
var TokenHandler = require('./TokenHandler.js');
var { KV,SelfclosingTagTk } = require('../parser.defines.js');


/**
 * Handler for behavior switches, like '__TOC__' and similar.
 *
 * @class
 * @extends module:wt2html/tt/TokenHandler
 * @constructor
 */
class BehaviorSwitchHandler extends TokenHandler {

	static rank() { return 2.14; }

	init() {
		this.manager.addTransform(
			(token, manager, cb) => this.onBehaviorSwitch(token, manager, cb),
			'BehaviorSwitchHandler:onBehaviorSwitch',
			BehaviorSwitchHandler.rank(),
			'tag',
			'behavior-switch'
		);
	}

	/**
	 * Main handler.
	 * See {@link TokenTransformManager#addTransform}'s transformation parameter.
	 */
	onBehaviorSwitch(token, manager, cb) {
		var metaToken;
		var env = this.manager.env;
		var magicWord = env.conf.wiki.magicWordCanonicalName(token.attribs[0].v);

		env.setVariable(magicWord, true);

		metaToken = new SelfclosingTagTk(
			'meta',
			[ new KV('property', 'mw:PageProp/' + magicWord) ],
			Util.clone(token.dataAttribs)
		);

		return { tokens: [ metaToken ] };
	}
}


if (typeof module === "object") {
	module.exports.BehaviorSwitchHandler = BehaviorSwitchHandler;
}
