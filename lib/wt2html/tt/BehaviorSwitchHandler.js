/** @module */

'use strict';

const { Util } = require('../../utils/Util.js');
const TokenHandler = require('./TokenHandler.js');
const { KV,SelfclosingTagTk } = require('../parser.defines.js');


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
		const env = this.manager.env;
		const magicWord = env.conf.wiki.magicWordCanonicalName(token.attribs[0].v);

		env.setVariable(magicWord, true);

		const metaToken = new SelfclosingTagTk(
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
