'use strict';

const References = require('./References.js');
const ReferencesData = require('./ReferencesData.js');

/**
 * wt -> html DOM PostProcessor
 *
 * @class
 */
class RefProcessor {
	run(body, env, options, atTopLevel) {
		if (atTopLevel) {
			var refsData = new ReferencesData(env);
			References._processRefs(env, refsData, body);
			References.insertMissingReferencesIntoDOM(refsData, body);
		}
	}
}

module.exports = RefProcessor;
