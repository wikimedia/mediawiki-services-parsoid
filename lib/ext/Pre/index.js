/**
 * The `<pre>` extension tag shadows the html pre tag, but has different
 * semantics.  It treats anything inside it as plaintext.
 * @module ext/Pre
 */

'use strict';

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.9.0');

var Util = ParsoidExtApi.Util;
var defines = ParsoidExtApi.defines;

var KV = defines.KV;
var TagTk = defines.TagTk;
var EndTagTk = defines.EndTagTk;

var tokenHandler = function(manager, pipelineOpts, extToken, cb) {
	var argDict = Util.getExtArgInfo(extToken).dict;
	var tsr = extToken.dataAttribs.tsr;
	var tagWidths = extToken.dataAttribs.tagWidths;

	if (!tagWidths[1]) {
		argDict.body = undefined;  // Serialize to self-closing.
	}

	var attribs = [
		new KV('typeof', 'mw:Extension/' + argDict.name),
		new KV('about', manager.env.newAboutId()),
		new KV('data-mw', JSON.stringify(argDict)),
	];

	// FIXME: filter the above
	attribs = attribs.concat(Object.keys(argDict.attrs).map(function(key) {
		return new KV(key, argDict.attrs[key]);
	}));

	var start = new TagTk('pre', attribs, {
		tsr: [tsr[0], tsr[0] + tagWidths[0]],
		src: extToken.dataAttribs.src,
		stx: 'html',
		tmp: { nativeExt: true },
	});
	var end = new EndTagTk('pre', null, {
		tsr: [tsr[1] - tagWidths[1], tsr[1]],
		stx: 'html',
	});

	var txt = argDict.body && argDict.body.extsrc || '';

	// Support nowikis in pre.  Do this before stripping newlines, see test,
	// "<pre> with <nowiki> inside (compatibility with 1.6 and earlier)"
	txt = txt.replace(/<nowiki\s*>([^]*?)<\/nowiki\s*>/g, '$1');

	// Strip leading newline to match php parser.  This is probably because
	// it doesn't do xml serialization accounting for `newlineStrippingElements`
	// Of course, this leads to indistinguishability between n=0 and n=1
	// newlines, but that only seems to affect parserTests output.  Rendering
	// is the same, and the newline is preserved for rt in the `extSrc`.
	txt = txt.replace(/^\n/, '');

	// `extSrc` will take care of rt'ing these
	txt = Util.decodeEntities(txt);

	cb({ tokens: [start, txt, end] });
};

module.exports = function() {
	this.config = {
		tags: [
			{
				name: 'pre',
				tokenHandler: tokenHandler,
			},
		],
	};
};
