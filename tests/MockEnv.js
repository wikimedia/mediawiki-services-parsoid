'use strict';

class MockEnv {
	constructor(argv, pageSrc) {
		// Hack in bswPagePropRegexp to support Util.js function "isBehaviorSwitch: function(... "
		const bswRegexpSource = "\\/(?:NOGLOBAL|DISAMBIG|NOCOLLABORATIONHUBTOC|nocollaborationhubtoc|NOTOC|notoc|NOGALLERY|nogallery|FORCETOC|forcetoc|TOC|toc|NOEDITSECTION|noeditsection|NOTITLECONVERT|notitleconvert|NOTC|notc|NOCONTENTCONVERT|nocontentconvert|NOCC|nocc|NEWSECTIONLINK|NONEWSECTIONLINK|HIDDENCAT|INDEX|NOINDEX|STATICREDIRECT)";
		this.page = {
			src: pageSrc || "testing testing testing testing",
		};
		this.conf = {
			wiki: {
				bswPagePropRegexp: new RegExp(
					'(?:^|\\s)mw:PageProp/' + bswRegexpSource + '(?=$|\\s)'
				),
			},
			parsoid: {
				rtTestMode: false,
			},
		};
		this.log = argv.log ? this._log : this._emptyLog;
	}

	_emptyLog() {}

	_log() {
		let output = arguments[0];
		for (let i = 1; i < arguments.length; i++) {
			if (typeof arguments[i] === 'function') {
				output = output + ' ' + arguments[i]();
			} else {
				output = output + ' ' + arguments[i];
			}
		}
		console.log(output);
	}
}

if (typeof module === "object") {
	module.exports.MockEnv = MockEnv;
}
