/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 * @module
 */

'use strict';

var defines = require('../parser.defines.js');
var PegTokenizer = require('../tokenizer.js').PegTokenizer;
var WikitextConstants = require('../../config/WikitextConstants.js').WikitextConstants;
var Sanitizer = require('./Sanitizer.js').Sanitizer;
var Util = require('../../utils/Util.js').Util;
var TokenHandler = require('./TokenHandler.js');
var DU = require('../../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../../utils/jsutils.js').JSUtils;
var Promise = require('../../utils/promise.js');

// define some constructor shortcuts
var KV = defines.KV;
var EOFTk = defines.EOFTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;
var lastItem = JSUtils.lastItem;


/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 * @constructor
 */
class WikiLinkHandler extends TokenHandler { }

WikiLinkHandler.prototype.rank = 1.15; // after AttributeExpander

WikiLinkHandler.prototype.init = function() {
	// Handle redirects first (since they used to emit additional link tokens)
	this.manager.addTransformP(this, this.onRedirect,
		'WikiLinkHandler:onRedirect', this.rank, 'tag', 'mw:redirect');

	// Now handle regular wikilinks.
	this.manager.addTransformP(this, this.onWikiLink,
		'WikiLinkHandler:onWikiLink', this.rank + 0.001, 'tag', 'wikilink');

	// Create a new peg parser for image options.
	if (!this.urlParser) {
		// Actually the regular tokenizer, but we'll call it with the
		// url rule only.
		WikiLinkHandler.prototype.urlParser = new PegTokenizer(this.env);
	}
};

var hrefParts = function(str) {
	var m = str.match(/^([^:]+):(.*)$/);
	return m && { prefix: m[1], title: m[2] };
};

/**
 * Normalize and analyze a wikilink target.
 *
 * Returns an object containing
 * - href: The expanded target string
 * - hrefSrc: The original target wikitext
 * - title: A title object *or*
 * - language: An interwikiInfo object *or*
 * - interwiki: An interwikiInfo object.
 * - localprefix: Set if the link had a localinterwiki prefix (or prefixes)
 * - fromColonEscapedText: Target was colon-escaped ([[:en:foo]])
 * - prefix: The original namespace or language/interwiki prefix without a
 *   colon escape.
 *
 * @return {Object} The target info.
 */
WikiLinkHandler.prototype.getWikiLinkTargetInfo = function(token, hrefKV) {
	var env = this.manager.env;

	var info = {
		href: Util.tokensToString(hrefKV.v),
		hrefSrc: hrefKV.vsrc,
	};

	if (Array.isArray(hrefKV.v) && hrefKV.v.some(
		t => t instanceof defines.Token &&
			/\bmw:(Nowiki|Extension)/.test(t.getAttribute('typeof'))
	)) {
		throw new Error('Xmlish tags in title position are invalid.');
	}

	if (/^:/.test(info.href)) {
		info.fromColonEscapedText = true;
		// remove the colon escape
		info.href = info.href.substr(1);
	}
	if (/^:/.test(info.href)) {
		if (env.conf.parsoid.linting) {
			var lint = {
				dsr: token.dataAttribs.tsr,
				params: { href: ':' + info.href },
				templateInfo: undefined,
			};
			if (this.options.inTemplate) {
				// `frame.title` is already the result of calling
				// `getPrefixedDBKey`, but for the sake of consistency with
				// `findEnclosingTemplateName`, we do a little more work to
				// match `env.makeLink`.
				var name = Util.sanitizeTitleURI(env.page.relativeLinkPrefix +
						this.manager.frame.title).replace(/^\.\//, '');
				lint.templateInfo = { name: name };
				// TODO(arlolra): Pass tsr info to the frame
				lint.dsr = [0, 0];
			}
			env.log('lint/multi-colon-escape', lint);
		}
		// This will get caught by the caller, and mark the target as invalid
		throw new Error('Multiple colons prefixing href.');
	}

	var title = env.resolveTitle(Util.decodeURIComponent(info.href));
	var hrefBits = hrefParts(info.href);
	if (hrefBits) {
		var nsPrefix = hrefBits.prefix;
		info.prefix = nsPrefix;
		var nnn = Util.normalizeNamespaceName(nsPrefix.trim());
		var interwikiInfo = env.conf.wiki.interwikiMap.get(nnn);
		// check for interwiki / language links
		var ns = env.conf.wiki.namespaceIds.get(nnn);
		// also check for url to protect against [[constructor:foo]]
		if (ns !== undefined) {
			info.title = env.makeTitleFromURLDecodedStr(title);
		} else if (interwikiInfo && interwikiInfo.localinterwiki !== undefined) {
			if (hrefBits.title === '') {
				// Empty title => main page (T66167)
				info.title = env.makeTitleFromURLDecodedStr(env.conf.wiki.mainpage);
			} else {
				info.href = hrefBits.title;
				// Recurse!
				hrefKV = new KV('href', (/:/.test(info.href) ? ':' : '') + info.href);
				hrefKV.vsrc = info.hrefSrc;
				info = this.getWikiLinkTargetInfo(token, hrefKV);
				info.localprefix = nsPrefix +
					(info.localprefix ? (':' + info.localprefix) : '');
			}
		} else if (interwikiInfo && interwikiInfo.url) {
			info.href = hrefBits.title;
			// Ensure a valid title, even though we're discarding the result
			env.makeTitleFromURLDecodedStr(title);
			// Interwiki or language link? If no language info, or if it starts
			// with an explicit ':' (like [[:en:Foo]]), it's not a language link.
			if (info.fromColonEscapedText ||
				(interwikiInfo.language === undefined && interwikiInfo.extralanglink === undefined)) {
				// An interwiki link.
				info.interwiki = interwikiInfo;
			} else {
				// A language link.
				info.language = interwikiInfo;
			}
		} else {
			info.title = env.makeTitleFromURLDecodedStr(title);
		}
	} else {
		info.title = env.makeTitleFromURLDecodedStr(title);
	}

	return info;
};

/**
 * Handle mw:redirect tokens.
 */
WikiLinkHandler.prototype.onRedirect = Promise.async(function *(token, frame) {
	// Avoid duplicating the link-processing code by invoking the
	// standard onWikiLink handler on the embedded link, intercepting
	// the generated tokens using the callback mechanism, reading
	// the href from the result, and then creating a
	// <link rel="mw:PageProp/redirect"> token from it.

	var rlink = new SelfclosingTagTk('link', Util.clone(token.attribs), Util.clone(token.dataAttribs));
	var wikiLinkTk = rlink.dataAttribs.linkTk;
	rlink.setAttribute('rel', 'mw:PageProp/redirect');

	// Remove the nested wikiLinkTk token and the cloned href attribute
	rlink.dataAttribs.linkTk = undefined;
	rlink.removeAttribute('href');

	// Transfer href attribute back to wikiLinkTk, since it may have been
	// template-expanded in the pipeline prior to this point.
	wikiLinkTk.attribs = Util.clone(token.attribs);

	// Set "redirect" attribute on the wikilink token to indicate that
	// image and category links should be handled as plain links.
	wikiLinkTk.setAttribute('redirect', 'true');

	// Render the wikilink (including interwiki links, etc) then collect
	// the resulting href and transfer it to rlink.
	var r = yield this.onWikiLink(wikiLinkTk, frame);
	var isValid = r && r.tokens && r.tokens[0] &&
		/^(a|link)$/.test(r.tokens[0].name);
	if (isValid) {
		var da = r.tokens[0].dataAttribs;
		rlink.addNormalizedAttribute('href', da.a.href, da.sa.href);
		return { tokens: [rlink] };
	} else {
		// Bail!  Emit tokens as if they were parsed as a list item:
		//  #REDIRECT....
		var src = rlink.dataAttribs.src;
		var tsr = rlink.dataAttribs.tsr;
		var srcMatch = /^([^#]*)(#)/.exec(src);
		var ntokens = srcMatch[1].length ? [ srcMatch[1] ] : [];
		var hashPos = tsr[0] + srcMatch[1].length;
		var li = new TagTk('listItem', [], { tsr: [hashPos, hashPos + 1] });
		li.bullets = [ '#' ];
		ntokens.push(li);
		ntokens.push(src.slice(srcMatch[0].length));
		return { tokens: ntokens.concat(r.tokens) };
	}
});

var bailTokens = function(env, token, isExtLink) {
	var count = isExtLink ? 1 : 2;
	var tokens = ["[".repeat(count)];
	var content = [];

	if (isExtLink) {
		// FIXME: Use this attribute in regular extline
		// cases to rt spaces correctly maybe?  Unsure
		// it is worth it.
		var spaces = token.getAttribute('spaces') || '';
		if (spaces.length) { content.push(spaces); }

		var mwc = Util.lookup(token.attribs, 'mw:content');
		if (mwc.length) { content = content.concat(mwc); }
	} else {
		token.attribs.forEach(function(a) {
			if (a.k === "mw:maybeContent") {
				content = content.concat("|", a.v);
			}
		});
	}

	var dft;
	if (/mw:ExpandedAttrs/.test(token.getAttribute("typeof"))) {
		var dataMW = JSON.parse(token.getAttribute("data-mw")).attribs;
		var html;
		for (var i = 0; i < dataMW.length; i++) {
			if (dataMW[i][0].txt === "href") {
				html = dataMW[i][1].html;
				break;
			}
		}

		// Since we are splicing off '['s and ']'s from the incoming token,
		// adjust TSR of the DOM-fragment by `count` each on both end.
		var tsr = token.dataAttribs && token.dataAttribs.tsr;
		if (tsr && typeof (tsr[0]) === 'number' && typeof (tsr[1]) === 'number') {
			// If content is present, the fragment we're building doesn't
			// extend all the way to the end of the token, so the end tsr
			// is invalid.
			var end = content.length > 0 ? null : tsr[1] - count;
			tsr = [tsr[0] + count, end];
		} else {
			tsr = null;
		}

		var body = DU.ppToDOM(html);
		dft = DU.buildDOMFragmentTokens(env, token, body, null, {
			noPWrapping: true,
			tsr: tsr,
		});
	} else {
		dft = token.getAttribute("href");
	}

	tokens = tokens.concat(dft, content, "]".repeat(count));
	return tokens;
};

/**
 * Handle a mw:WikiLink token.
 */
WikiLinkHandler.prototype.onWikiLink = Promise.async(function *(token, frame) { // eslint-disable-line require-yield
	var env = this.manager.env;
	var hrefKV = Util.lookupKV(token.attribs, 'href');
	var target;

	try {
		target = this.getWikiLinkTargetInfo(token, hrefKV);
	} catch (e) {
		// Invalid title
		target = null;
	}

	if (!target) {
		return { tokens: bailTokens(env, token, false) };
	}

	// First check if the expanded href contains a pipe.
	if (/[|]/.test(target.href)) {
		// It does. This 'href' was templated and also returned other
		// parameters separated by a pipe. We don't have any sane way to
		// handle such a construct currently, so prevent people from editing
		// it.
		// TODO: add useful debugging info for editors ('if you would like to
		// make this content editable, then fix template X..')
		// TODO: also check other parameters for pipes!
		return { tokens: Util.placeholder(null, token.dataAttribs) };
	}

	// Don't allow internal links to pages containing PROTO:
	// See Parser::replaceInternalLinks2()
	if (env.conf.wiki.hasValidProtocol(target.href)) {
		// NOTE: Tokenizing this as src seems little suspect
		var src = '[' + token.attribs.slice(1).reduce(function(prev, next) {
			return prev + '|' + Util.tokensToString(next.v);
		}, target.href) + ']';

		var extToks = this.urlParser.tokenizeExtlink(src);
		if (extToks) {
			var tsr = token.dataAttribs && token.dataAttribs.tsr;
			Util.shiftTokenTSR(extToks, 1 + (tsr ? tsr[0] : 0));
		} else {
			extToks = src;
		}

		var tokens = ['['].concat(extToks, ']');
		tokens.rank = this.rank - 0.002;  // Magic rank, since extlink is -0.001
		return { tokens: tokens };
	}

	// Ok, it looks like we have a sane href. Figure out which handler to use.
	var isRedirect = !!token.getAttribute('redirect');
	return (yield this._wikiLinkHandler(token, frame, target, isRedirect));
});

/**
 * Figure out which handler to use to render a given WikiLink token. Override
 * this method to add new handlers or swap out existing handlers based on the
 * target structure.
 */
WikiLinkHandler.prototype._wikiLinkHandler = function(token, frame, target, isRedirect) {
	var title = target.title;
	if (title) {
		if (isRedirect) {
			return this.renderWikiLink(token, frame, target);
		}
		if (title.getNamespace().isMedia()) {
			// Render as a media link.
			return this.renderMedia(token, frame, target);
		}
		if (!target.fromColonEscapedText) {
			if (title.getNamespace().isFile()) {
				// Render as a file.
				return this.renderFile(token, frame, target);
			}
			if (title.getNamespace().isCategory()) {
				// Render as a category membership.
				return this.renderCategory(token, frame, target);
			}
		}
		// Render as plain wiki links.
		return this.renderWikiLink(token, frame, target);

	// language and interwiki links
	} else {
		if (target.interwiki) {
			return this.renderInterwikiLink(token, frame, target);
		} else if (target.language) {
			var noLanguageLinks = this.env.page.title.getNamespace().isATalkNamespace() ||
				!this.env.conf.wiki.interwikimagic;
			if (noLanguageLinks) {
				target.interwiki = target.language;
				return this.renderInterwikiLink(token, frame, target);
			} else {
				return this.renderLanguageLink(token, frame, target);
			}
		}
	}

	// Neither a title, nor a language or interwiki. Should not happen.
	throw new Error("Unknown link type");
};

/* ------------------------------------------------------------
 * This (overloaded) function does three different things:
 * - Extracts link text from attrs (when k === "mw:maybeContent").
 *   As a performance micro-opt, only does if asked to (getLinkText)
 * - Updates existing rdfa type with an additional rdf-type,
 *   if one is provided (rdfaType)
 * - Collates about, typeof, and linkAttrs into a new attr. array
 * ------------------------------------------------------------ */
function buildLinkAttrs(attrs, getLinkText, rdfaType, linkAttrs) {
	var newAttrs = [];
	var linkTextKVs = [];
	var about;

	// In one pass through the attribute array, fetch about, typeof, and linkText
	//
	// about && typeof are usually at the end of the array if at all present
	for (var i = 0, l = attrs.length; i < l; i++) {
		var kv = attrs[i];
		var k  = kv.k;
		var v  = kv.v;

		// link-text attrs have the key "maybeContent"
		if (getLinkText && k === "mw:maybeContent") {
			linkTextKVs.push(kv);
		} else if (k.constructor === String && k) {
			if (k.trim() === "typeof") {
				rdfaType = rdfaType ? rdfaType + " " + v : v;
			} else if (k.trim() === "about") {
				about = v;
			} else if (k.trim() === "data-mw") {
				newAttrs.push(kv);
			}
		}
	}

	if (rdfaType) {
		newAttrs.push(new KV('typeof', rdfaType));
	}

	if (about) {
		newAttrs.push(new KV('about', about));
	}

	if (linkAttrs) {
		newAttrs = newAttrs.concat(linkAttrs);
	}

	return {
		attribs: newAttrs,
		contentKVs: linkTextKVs,
		hasRdfaType: rdfaType !== null,
	};
}

/**
 * Generic wiki link attribute setup on a passed-in new token based on the
 * wikilink token and target. As a side effect, this method also extracts the
 * link content tokens and returns them.
 *
 * @return {Array} Content tokens.
 */
WikiLinkHandler.prototype.addLinkAttributesAndGetContent = function(newTk, token, target, buildDOMFragment) {
	var attribs = token.attribs;
	var dataAttribs = token.dataAttribs;
	var newAttrData = buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]);
	var content = newAttrData.contentKVs;
	var env = this.manager.env;

	// Set attribs and dataAttribs
	newTk.attribs = newAttrData.attribs;
	newTk.dataAttribs = Util.clone(dataAttribs);
	newTk.dataAttribs.src = undefined; // clear src string since we can serialize this

	// Note: Link tails are handled on the DOM in handleLinkNeighbours, so no
	// need to handle them here.
	if (content.length > 0) {
		newTk.dataAttribs.stx = 'piped';
		var out = [];
		var l = content.length;
		// re-join content bits
		for (var i = 0; i < l; i++) {
			var toks = content[i].v;
			// since this is already a link, strip autolinks from content
			if (!Array.isArray(toks)) { toks = [ toks ]; }
			toks = toks.filter(function(t) { return t !== ''; });
			toks = toks.map(function(t, j) {
				if (t.constructor === TagTk && t.name === 'a') {
					if (toks[j + 1] && toks[j + 1].constructor === EndTagTk &&
						toks[j + 1].name === 'a') {
						// autonumbered links in the stream get rendered
						// as an <a> tag with no content -- but these ought
						// to be treated as plaintext since we don't allow
						// nested links.
						return '[' + t.getAttribute('href') + ']';
					}
					return ''; // suppress <a>
				}
				if (t.constructor === EndTagTk && t.name === 'a') {
					return ''; // suppress </a>
				}
				return t;
			});
			toks = toks.filter(function(t) { return t !== ''; });
			out = out.concat(toks);
			if (i < l - 1) {
				out.push('|');
			}
		}

		if (buildDOMFragment) {
			// content = [part 0, .. part l-1]
			// offsets = [start(part-0), end(part l-1)]
			var offsets = dataAttribs.tsr ? [content[0].srcOffsets[0], content[l - 1].srcOffsets[1]] : null;
			content = [ Util.getDOMFragmentToken(out, offsets, { noPWrapping: true, noPre: true, token: token }) ];
		} else {
			content = out;
		}
	} else {
		newTk.dataAttribs.stx = 'simple';
		var morecontent = Util.decodeURIComponent(target.href);

		// Strip leading colon
		morecontent = morecontent.replace(/^:/, '');

		// Try to match labeling in core
		if (env.conf.wiki.namespacesWithSubpages[env.page.ns]) {
			// subpage links with a trailing slash get the trailing slashes stripped.
			// See https://gerrit.wikimedia.org/r/173431
			var match = morecontent.match(/^((\.\.\/)+|\/)(?!\.\.\/)(.*?[^\/])\/+$/);
			if (match) {
				morecontent = match[3];
			} else if (/^\.\.\//.test(morecontent)) {
				morecontent = env.resolveTitle(morecontent);
			}
		}

		// for interwiki links, include the interwiki prefix in the link text
		if (target.interwiki) {
			morecontent = target.prefix + ':' + morecontent;
		}

		// for local links, include the local prefix in the link text
		if (target.localprefix) {
			morecontent = target.localprefix + ':' + morecontent;
		}

		content = [ morecontent ];
	}
	return content;
};

/**
 * Render a plain wiki link.
 */
WikiLinkHandler.prototype.renderWikiLink = Promise.async(function *(token, frame, target) { // eslint-disable-line require-yield
	var newTk = new TagTk('a');
	var content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

	newTk.addNormalizedAttribute('href', this.env.makeLink(target.title), target.hrefSrc);

	// Add title unless it's just a fragment
	if (target.href[0] !== '#') {
		newTk.setAttribute('title', target.title.getPrefixedText());
	}

	return { tokens: [newTk].concat(content, [new EndTagTk('a')]) };
});

/**
 * Render a category 'link'. Categories are really page properties, and are
 * normally rendered in a box at the bottom of an article.
 */
WikiLinkHandler.prototype.renderCategory = Promise.async(function *(token, frame, target) {
	var tokens = [];
	var newTk = new SelfclosingTagTk('link');
	var content = this.addLinkAttributesAndGetContent(newTk, token, target);
	var env = this.manager.env;

	// Change the rel to be mw:PageProp/Category
	Util.lookupKV(newTk.attribs, 'rel').v = 'mw:PageProp/Category';

	var strContent = Util.tokensToString(content);
	var saniContent = Util.sanitizeTitleURI(strContent).replace(/#/g, '%23');
	newTk.addNormalizedAttribute('href', env.makeLink(target.title), target.hrefSrc);
	// Change the href to include the sort key, if any (but don't update the rt info)
	if (strContent && strContent !== '' && strContent !== target.href) {
		var hrefkv = Util.lookupKV(newTk.attribs, 'href');
		hrefkv.v += '#';
		hrefkv.v += saniContent;
	}

	tokens.push(newTk);

	if (content.length === 1) {
		return { tokens: tokens };
	} else {
		// Deal with sort keys that come from generated content (transclusions, etc.)
		var inVals = [ { "txt": "mw:sortKey" }, { "html": content } ];
		var outVals = yield Util.expandValuesToDOM(
			this.manager.env,
			this.manager.frame,
			inVals,
			this.options.wrapTemplates,
			this.options.inTemplate
		);
		var dataMW = newTk.getAttribute("data-mw");
		if (dataMW) {
			dataMW = JSON.parse(dataMW);
			dataMW.attribs.push(outVals);
		} else {
			dataMW = { attribs: [outVals] };
		}

		// Mark token as having expanded attrs
		newTk.addAttribute("about", env.newAboutId());
		newTk.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
		newTk.addAttribute("data-mw", JSON.stringify(dataMW));

		return { tokens: tokens };
	}
});

/**
 * Render a language link. Those normally appear in the list of alternate
 * languages for an article in the sidebar, so are really a page property.
 */
WikiLinkHandler.prototype.renderLanguageLink = Promise.async(function *(token, frame, target) { // eslint-disable-line require-yield
	// The prefix is listed in the interwiki map

	var newTk = new SelfclosingTagTk('link', [], token.dataAttribs);
	this.addLinkAttributesAndGetContent(newTk, token, target);

	// add title attribute giving the presentation name of the
	// "extra language link"
	if (target.language.extralanglink !== undefined &&
		target.language.linktext) {
		newTk.addNormalizedAttribute('title', target.language.linktext);
	}

	// We set an absolute link to the article in the other wiki/language
	var absHref = target.language.url.replace("$1", target.href);
	if (target.language.protorel !== undefined) {
		absHref = absHref.replace(/^https?:/, '');
	}
	newTk.addNormalizedAttribute('href', Util.sanitizeURI(absHref), target.hrefSrc);

	// Change the rel to be mw:PageProp/Language
	Util.lookupKV(newTk.attribs, 'rel').v = 'mw:PageProp/Language';

	return { tokens: [newTk] };
});

/**
 * Render an interwiki link.
 */
WikiLinkHandler.prototype.renderInterwikiLink = Promise.async(function *(token, frame, target) { // eslint-disable-line require-yield
	// The prefix is listed in the interwiki map

	var tokens = [];
	var newTk = new TagTk('a', [], token.dataAttribs);
	var content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

	// We set an absolute link to the article in the other wiki/language
	var absHref = target.interwiki.url.replace("$1", target.href);
	if (target.interwiki.protorel !== undefined) {
		absHref = absHref.replace(/^https?:/, '');
	}
	newTk.addNormalizedAttribute('href', Util.sanitizeURI(absHref), target.hrefSrc);

	// Change the rel to be mw:ExtLink
	Util.lookupKV(newTk.attribs, 'rel').v = 'mw:WikiLink/Interwiki';
	// Remember that this was using wikitext syntax though
	newTk.dataAttribs.isIW = true;
	// Add title unless it's just a fragment (and trim off fragment)
	// (The normalization here is similar to what Title#getPrefixedDBKey() does.)
	if (target.href[0] !== "#") {
		var titleAttr = target.interwiki.prefix + ':' +
				Util.decodeURIComponent(target.href.replace(/#[\s\S]*/, '').replace(/_/g, ' '));
		newTk.setAttribute("title", titleAttr);
	}
	tokens.push(newTk);

	tokens = tokens.concat(content, [new EndTagTk('a')]);
	return { tokens: tokens };
});

/**
 * Get the format for media.
 */
function getFormat(opts) {
	if (opts.manualthumb) {
		return "thumbnail";
	}
	return opts.format && opts.format.v;
}

/**
 * Extract the dimensions for media.
 */
function handleSize(env, opts, info) {
	var height = info.height;
	var width = info.width;

	console.assert(typeof height === 'number' && !Number.isNaN(height));
	console.assert(typeof width === 'number' && !Number.isNaN(width));

	if (info.thumburl && info.thumbheight) {
		height = info.thumbheight;
	}

	if (info.thumburl && info.thumbwidth) {
		width = info.thumbwidth;
	}

	// Audio files don't have dimensions, so we fallback to these arbitrary
	// defaults, and the "mw-default-audio-height" class is added.
	if (info.mediatype === 'AUDIO') {
		height = /* height || */ 32;  // Arguably, audio should respect a defined height
		width = width || env.conf.wiki.widthOption;
	}

	var mustRender;
	if (info.mustRender !== undefined) {
		mustRender = info.mustRender;
	} else {
		mustRender = info.mediatype !== 'BITMAP';
	}

	// Handle client-side upscaling (including 'border')

	// Calculate the scaling ratio from the user-specified width and height
	var ratio = null;
	if (opts.size.v.height && info.height) {
		ratio = opts.size.v.height / info.height;
	}
	if (opts.size.v.width && info.width) {
		var r = opts.size.v.width / info.width;
		ratio = (ratio === null || r < ratio) ? r : ratio;
	}

	if (ratio !== null && ratio > 1) {
		// If the user requested upscaling, then this is denied in the thumbnail
		// and frameless format, except for files with mustRender.
		var format = getFormat(opts);
		if (!mustRender && (format === 'thumbnail' || format === 'frameless')) {
			// Upscaling denied
			height = info.height;
			width = info.width;
		} else {
			// Upscaling allowed
			// In the batch API, these will already be correct, but the non-batch
			// API returns the source width and height whenever client-side scaling
			// is requested.
			if (!env.conf.parsoid.useBatchAPI) {
				height = Math.round(info.height * ratio);
				width = Math.round(info.width * ratio);
			}
		}
	}

	return { height: height, width: width };
}

/**
 * Get the style and class lists for an image's wrapper element.
 *
 * @private
 * @param {Object} opts The option hash from renderFile.
 * @param {Object} info The info hash from handleInfo.
 * @return {Object}
 * @return {boolean} return.isInline Whether the image is inline after handling options.
 * @return {Array} return.classes The list of classes for the wrapper.
 */
function getWrapperInfo(opts, info) {
	var format = getFormat(opts);
	var isInline = !(format === 'thumbnail' || format === 'framed');
	var wrapperClasses = [];
	var halign = (opts.format && opts.format.v === 'framed') ? 'right' : null;

	if (!opts.size.src) {
		wrapperClasses.push('mw-default-size');
	}

	// Hardcoded until defined heights are respected.  See `handleSize`
	if (info.mediatype === 'AUDIO') {
		wrapperClasses.push('mw-default-audio-height');
	}

	if (opts.border) {
		wrapperClasses.push('mw-image-border');
	}

	if (opts.halign) {
		halign = opts.halign.v;
	}

	var halignOpt = opts.halign && opts.halign.v;
	switch (halign) {
		case 'none':
			// PHP parser wraps in <div class="floatnone">
			isInline = false;
			if (halignOpt === 'none') {
				wrapperClasses.push('mw-halign-none');
			}
			break;

		case 'center':
			// PHP parser wraps in <div class="center"><div class="floatnone">
			isInline = false;
			if (halignOpt === 'center') {
				wrapperClasses.push('mw-halign-center');
			}
			break;

		case 'left':
			// PHP parser wraps in <div class="floatleft">
			isInline = false;
			if (halignOpt === 'left') {
				wrapperClasses.push('mw-halign-left');
			}
			break;

		case 'right':
			// PHP parser wraps in <div class="floatright">
			isInline = false;
			if (halignOpt === 'right') {
				wrapperClasses.push('mw-halign-right');
			}
			break;
	}

	if (isInline) {
		var valignOpt = opts.valign && opts.valign.v;
		switch (valignOpt) {
			case 'middle':
				wrapperClasses.push('mw-valign-middle');
				break;

			case 'baseline':
				wrapperClasses.push('mw-valign-baseline');
				break;

			case 'sub':
				wrapperClasses.push('mw-valign-sub');
				break;

			case 'super':
				wrapperClasses.push('mw-valign-super');
				break;

			case 'top':
				wrapperClasses.push('mw-valign-top');
				break;

			case 'text_top':
				wrapperClasses.push('mw-valign-text-top');
				break;

			case 'bottom':
				wrapperClasses.push('mw-valign-bottom');
				break;

			case 'text_bottom':
				wrapperClasses.push('mw-valign-text-bottom');
				break;
		}
	}

	return {
		classes: wrapperClasses,
		isInline: isInline,
	};
}

/**
 * Abstract way to get the path for an image given an info object.
 *
 * @private
 * @param {Object} info
 * @param {string|null} info.thumburl The URL for a thumbnail.
 * @param {string} info.url The base URL for the image.
 */
function getPath(info) {
	var path = '';
	if (info.thumburl) {
		path = info.thumburl;
	} else if (info.url) {
		path = info.url;
	}
	return path.replace(/^https?:\/\//, '//');
}

/**
 * Determine the name of an option.
 * @return {Object}
 * @return {string} return.ck Canonical key for the image option.
 * @return {string} return.v Value of the option.
 * @return {string} return.ak
 *   Aliased key for the image option - includes `"$1"` for placeholder.
 * @return {string} return.s
 *   Whether it's a simple option or one with a value.
 * }.
 */
function getOptionInfo(optStr, env) {
	var oText = optStr.trim();
	var lowerOText = oText.toLowerCase();
	var getOption = env.conf.wiki.getMagicPatternMatcher(
			WikitextConstants.Media.PrefixOptions);
	// oText contains the localized name of this option.  the
	// canonical option names (from mediawiki upstream) are in
	// English and contain an '(img|timedmedia)_' prefix.  We drop the
	// prefix before stuffing them in data-parsoid in order to
	// save space (that's shortCanonicalOption)
	var canonicalOption = env.conf.wiki.magicWords[oText] ||
			env.conf.wiki.magicWords[lowerOText] || '';
	var shortCanonicalOption = canonicalOption.replace(/^(img|timedmedia)_/,  '');
	// 'imgOption' is the key we'd put in opts; it names the 'group'
	// for the option, and doesn't have an img_ prefix.
	var imgOption = WikitextConstants.Media.SimpleOptions.get(canonicalOption);
	var bits = getOption(optStr.trim());
	var normalizedBit0 = bits ? bits.k.trim().toLowerCase() : null;
	var key = bits ? WikitextConstants.Media.PrefixOptions.get(normalizedBit0) : null;

	if (imgOption && key === null) {
		return {
			ck: imgOption,
			v: shortCanonicalOption,
			ak: optStr,
			s: true,
		};
	} else {
		// bits.a has the localized name for the prefix option
		// (with $1 as a placeholder for the value, which is in bits.v)
		// 'normalizedBit0' is the canonical English option name
		// (from mediawiki upstream) with a prefix.
		// 'key' is the parsoid 'group' for the option; it doesn't
		// have a prefix (it's the key we'd put in opts)

		if (bits && key) {
			shortCanonicalOption = normalizedBit0.replace(/^(img|timedmedia)_/,  '');
			// map short canonical name to the localized version used
			return {
				ck: shortCanonicalOption,
				v: bits.v,
				ak: optStr,
				s: false,
			};
		} else {
			return null;
		}
	}
}

/**
 * Make option token streams into a stringy thing that we can recognize.
 *
 * @param {Array} tstream
 * @param {string} prefix Anything that came before this part of the recursive call stack.
 * @return {string|null}
 */
function stringifyOptionTokens(tstream, prefix, env) {
	var tokenType, tkHref, nextResult, optInfo, skipToEndOf;
	var resultStr = '';

	prefix = prefix || '';

	for (var i = 0; i < tstream.length; i++) {
		var currentToken = tstream[i];

		if (skipToEndOf) {
			if (currentToken.name === skipToEndOf && currentToken.constructor === EndTagTk) {
				skipToEndOf = undefined;
			}
			continue;
		}

		if (currentToken.constructor === String) {
			resultStr += currentToken;
		} else if (Array.isArray(currentToken)) {
			nextResult = stringifyOptionTokens(currentToken, prefix + resultStr, env);

			if (nextResult === null) {
				return null;
			}

			resultStr += nextResult;
		} else if (currentToken.constructor !== EndTagTk) {
			// This is actually a token
			if (currentToken.name === 'span' && currentToken.getAttribute('typeof') === 'mw:Nowiki') {
				// if this is a nowiki, we must be in a caption
				return null;
			}
			// Similar to Util.tokensToString()'s includeEntities
			if (Util.isEntitySpanToken(currentToken)) {
				resultStr += currentToken.dataAttribs.src;
				skipToEndOf = 'span';
				continue;
			}
			if (currentToken.name === 'a') {
				if (optInfo === undefined) {
					optInfo = getOptionInfo(prefix + resultStr, env);
					if (optInfo === null) {
						// An <a> tag before a valid option?
						// This is most likely a caption.
						optInfo = undefined;
						return null;
					}
				}

				// link and alt options are whitelisted for accepting arbitrary
				// wikitext (even though only strings are supported in reality)
				// SSS FIXME: Is this actually true of all options rather than
				// just link and alt?
				if (optInfo.ck === 'link' || optInfo.ck === 'alt') {
					tokenType = Util.lookup(currentToken.attribs, 'rel');
					tkHref = Util.lookup(currentToken.attribs, 'href');

					// Reset the optInfo since we're changing the nature of it
					optInfo = undefined;
					// Figure out the proper string to put here and break.
					if (tokenType === 'mw:ExtLink' &&
							currentToken.dataAttribs.stx === 'url') {
						// Add the URL
						resultStr += tkHref;
						// Tell our loop to skip to the end of this tag
						skipToEndOf = 'a';
					} else if (tokenType === 'mw:WikiLink') {
						// Nothing to do -- the link content will be
						// captured by walking the rest of the tokens.
					} else {
						// There shouldn't be any other kind of link...
						// This is likely a caption.
						return null;
					}
				} else {
					// Why would there be an a tag without a link?
					return null;
				}
			}
		}
	}

	return resultStr;
}

// Set up the actual image structure, attributes etc
WikiLinkHandler.prototype.handleImage = function(opts, info, _, dataMw, optSources) {
	var img = new SelfclosingTagTk('img', []);

	if ('alt' in opts) {
		img.addNormalizedAttribute('alt', opts.alt.v, opts.alt.src);
	}

	img.addNormalizedAttribute('resource', this.env.makeLink(opts.title.v), opts.title.src);
	img.addAttribute('src', getPath(info));

	if (opts.lang) {
		img.addNormalizedAttribute('lang', opts.lang.v, opts.lang.src);
	}

	if (!dataMw.errors) {
		// Add (read-only) information about original file size (T64881)
		img.addAttribute('data-file-width', String(info.width));
		img.addAttribute('data-file-height', String(info.height));
		img.addAttribute('data-file-type', info.mediatype && info.mediatype.toLowerCase());
	}

	var size = handleSize(this.env, opts, info);
	img.addNormalizedAttribute('height', String(size.height));
	img.addNormalizedAttribute('width', String(size.width));

	if (opts.page) {
		dataMw.page = opts.page.v;
	}

	// Handle "responsive" images, i.e. srcset
	if (info.responsiveUrls) {
		var candidates = [];
		Object.keys(info.responsiveUrls).forEach(function(density) {
			candidates.push(
				info.responsiveUrls[density].replace(/^https?:\/\//, '//') +
				' ' + density + 'x');
		});
		if (candidates.length > 0) {
			img.addAttribute('srcset', candidates.join(', '));
		}
	}

	return {
		rdfaType: 'mw:Image',
		elt: img,
		hasLink: (opts.link === undefined || opts.link && opts.link.v !== ''),
	};
};

var addTracks = function(info) {
	var timedtext;
	if (info.thumbdata && Array.isArray(info.thumbdata.timedtext)) {
		// BatchAPI's `getAPIData`
		timedtext = info.thumbdata.timedtext;
	} else if (Array.isArray(info.timedtext)) {
		// "videoinfo" prop
		timedtext = info.timedtext;
	} else {
		timedtext = [];
	}
	return timedtext.map(function(o) {
		var track = new SelfclosingTagTk('track');
		track.addAttribute('kind', o.kind);
		track.addAttribute('type', o.type);
		track.addAttribute('src', o.src);
		track.addAttribute('srclang', o.srclang);
		track.addAttribute('label', o.label);
		track.addAttribute('data-mwtitle', o.title);
		track.addAttribute('data-dir', o.dir);
		return track;
	});
};

// This is a port of TMH's parseTimeString()
var parseTimeString = function(timeString, length) {
	var time = 0;
	var parts = timeString.split(':');
	if (parts.length > 3) {
		return false;
	}
	for (var i = 0; i < parts.length; i++) {
		var num = parseInt(parts[i], 10);
		if (Number.isNaN(num)) {
			return false;
		}
		time += num * Math.pow(60, parts.length - 1 - i);
	}
	if (time < 0) {
		time = 0;
	} else if (length !== undefined) {
		console.assert(typeof length === 'number');
		if (time > length) { time = length - 1; }
	}
	return time;
};

// Handle media fragments
// https://www.w3.org/TR/media-frags/
var parseFrag = function(info, opts, dataMw) {
	var time;
	var frag = '';
	if (opts.starttime || opts.endtime) {
		frag += '#t=';
		if (opts.starttime) {
			time = parseTimeString(opts.starttime.v, info.duration);
			if (time !== false) {
				frag += time;
			}
			dataMw.starttime = opts.starttime.v;
		}
		if (opts.endtime) {
			time = parseTimeString(opts.endtime.v, info.duration);
			if (time !== false) {
				frag += ',' + time;
			}
			dataMw.endtime = opts.endtime.v;
		}
	}
	return frag;
};

var addSources = function(info, opts, dataMw, hasDimension) {
	var frag = parseFrag(info, opts, dataMw);

	var derivatives;
	var dataFromTMH = true;
	if (info.thumbdata && Array.isArray(info.thumbdata.derivatives)) {
		// BatchAPI's `getAPIData`
		derivatives = info.thumbdata.derivatives;
	} else if (Array.isArray(info.derivatives)) {
		// "videoinfo" prop
		derivatives = info.derivatives;
	} else {
		derivatives = [
			{
				src: info.url,
				type: info.mime,
				width: String(info.width),
				height: String(info.height),
			},
		];
		dataFromTMH = false;
	}

	return derivatives.map(function(o) {
		var source = new SelfclosingTagTk('source');
		source.addAttribute('src', o.src + frag);
		source.addAttribute('type', o.type);
		var fromFile = o.transcodekey !== undefined ? '' : '-file';
		if (hasDimension) {
			source.addAttribute('data' + fromFile + '-width', o.width);
			source.addAttribute('data' + fromFile + '-height', o.height);
		}
		if (dataFromTMH) {
			source.addAttribute('data-title', o.title);
			source.addAttribute('data-shorttitle', o.shorttitle);
		}
		return source;
	});
};

// These options don't exist for media.  They can be specified, but not added
// to the output.  However, we make sure to preserve them.  Note that if
// `optSources` is not `null`, all options are preserved so this is redundant.
var silentOptions = function(opts, dataMw, optSources) {
	if (!optSources) {
		if (opts.hasOwnProperty('alt')) {
			if (!dataMw.attribs) { dataMw.attribs = []; }
			dataMw.attribs.push(['alt', { html: opts.alt.src }]);
		}
		if (opts.hasOwnProperty('link')) {
			if (!dataMw.attribs) { dataMw.attribs = []; }
			dataMw.attribs.push(['href', { html: opts.link.src }]);
		}
	}
};

WikiLinkHandler.prototype.handleVideo = function(opts, info, manualinfo, dataMw, optSources) {
	var start = new TagTk('video');

	if (manualinfo || info.thumburl) {
		start.addAttribute('poster', getPath(manualinfo || info));
	}

	start.addAttribute('controls', '');
	start.addAttribute('preload', 'none');

	var size = handleSize(this.env, opts, info);
	start.addNormalizedAttribute('height', String(size.height));
	start.addNormalizedAttribute('width', String(size.width));

	start.addNormalizedAttribute('resource',
		this.env.makeLink(opts.title.v), opts.title.src);

	silentOptions(opts, dataMw, optSources);

	if (opts.thumbtime) {
		dataMw.thumbtime = opts.thumbtime.v;
	}

	var sources = addSources(info, opts, dataMw, true);
	var tracks = addTracks(info);

	var end = new EndTagTk('video');
	var elt = [start].concat(sources, tracks, end);

	return {
		rdfaType: 'mw:Video',
		elt: elt,
		hasLink: false,
	};
};

WikiLinkHandler.prototype.handleAudio = function(opts, info, manualinfo, dataMw, optSources) {
	var start = new TagTk('video');

	if (manualinfo || info.thumburl) {
		start.addAttribute('poster', getPath(manualinfo || info));
	}

	start.addAttribute('controls', '');
	start.addAttribute('preload', 'none');

	var size = handleSize(this.env, opts, info);
	start.addNormalizedAttribute('height', String(size.height));
	start.addNormalizedAttribute('width', String(size.width));

	start.addNormalizedAttribute('resource',
		this.env.makeLink(opts.title.v), opts.title.src);

	silentOptions(opts, dataMw, optSources);

	var sources = addSources(info, opts, dataMw, false);
	var tracks = addTracks(info);

	var end = new EndTagTk('video');
	var elt = [start].concat(sources, tracks, end);

	return {
		rdfaType: 'mw:Audio',
		elt: elt,
		hasLink: false,
	};
};

// Unfortunately, we need the size and title before doing the info request,
// which depend on having parsed options.  Since `getOptionInfo()` happens
// before knowing the mediatype, we end up being too liberal in what options
// are permitted, and then need to retroactively flag them as bogus.  This
// leads to a problem with needing the original tokens of the bogus options
// that then become the caption.  For example:
//  [[File:Foo.jpg|thumbtime=[[Foo]]]]
// Since Foo.jpg is not a video, PHP will parse everything after | as a caption.
// If Parsoid were to emulate this, we'd have trouble making [[Foo]] a valid
// link without the original tokens. See the FIXME.
//
// However, the fact that the caption is dependent on the exact set of options
// parsed is a bug, not a feature.  It prevents anyone from ever safely adding
// media options in the future, since any new option could potentially change
// the caption in existing wikitext.  So, rather than jumping through hoops
// to support this, we should probably look towards being stricter on the PHP
// side, and migrating content. (T163582)
var markAsBogus = function(opts, optList, prefix) {
	var seenCaption = false;
	for (var i = optList.length - 1; i > -1; i--) {
		var o = optList[i];
		var key = prefix + o.ck;
		if (o.ck === 'bogus' ||
				WikitextConstants.Media.SimpleOptions.has(key) ||
				WikitextConstants.Media.PrefixOptions.has(key)) {
			continue;
		}
		// Aha! bogus
		if (seenCaption) {
			o.ck = 'bogus';
			continue;
		}
		seenCaption = true;
		if (o.ck === 'caption') {
			continue;
		}
		opts.caption = opts[o.ck];
		// FIXME: This should use the original tokens.
		opts.caption.v = opts.caption.src || opts.caption.v;
		opts[o.ck] = undefined;
		o.ck = 'caption';
	}
};

var extractInfo = function(env, o) {
	var data = o.data;
	if (env.conf.parsoid.useBatchAPI) {
		return data.batchResponse;
	} else {
		var ns = data.imgns;
		// `useVideoInfo` is for legacy requests; batching returns thumbdata.
		var prop = env.conf.wiki.useVideoInfo ? 'videoinfo' : 'imageinfo';
		// title is guaranteed to be not null here
		var image = data.pages[ns + ':' + o.title.getKey()];
		if (!image || !image[prop] || !image[prop][0] ||
				// Fallback to adding mw:Error
				(image.missing !== undefined && image.known === undefined)) {
			return null;
		} else {
			return image[prop][0];
		}
	}
};

// Use sane defaults
var errorInfo = function(env, opts) {
	var widthOption = env.conf.wiki.widthOption;
	return {
		url: './Special:FilePath/' + Util.sanitizeTitleURI(opts.title.v.getKey()),
		// Preserve width and height from the wikitext options
		// even if the image is non-existent.
		width: opts.size.v.width || widthOption,
		height: opts.size.v.height || opts.size.v.width || widthOption,
	};
};

var makeErr = function(key, message, params) {
	var e = { key: key, message: message };
	// Additional error info for clients that could fix the error.
	if (params !== undefined) { e.params = params; }
	return e;
};

// Internal Helper
WikiLinkHandler.prototype._requestInfo = Promise.async(function *(reqs, errorHandler) {
	var env = this.manager.env;
	var errs = [];
	var infos;
	try {
		var result = yield Promise.all(
			reqs.map(function(s) { return s.promise; })
		);
		infos = result.map(function(r, i) {
			var info = extractInfo(env, r);
			if (!info) {
				info = errorHandler();
				errs.push(makeErr('apierror-filedoesnotexist', 'This image does not exist.', reqs[i].params));
			} else if (info.hasOwnProperty('thumberror')) {
				errs.push(makeErr('apierror-unknownerror', info.thumberror));
			}
			return info;
		});
	} catch (e) {
		errs = [makeErr('apierror-unknownerror', e)];
		infos = reqs.map(function() { return errorHandler(); });
	}
	return { errs: errs, info: infos };
});

// Handle a response to an (image|video)info API request.
WikiLinkHandler.prototype.handleInfo = Promise.async(function *(token, opts, optSources, errs, info, manualinfo) {
	console.assert(Array.isArray(errs));

	// FIXME: Not doing this till we fix up wt2html error handling
	//
	// Bump resource use
	// this.manager.env.bumpParserResourceUse('image');

	var dataMwAttr = token.getAttribute('data-mw');
	var dataMw = dataMwAttr ? JSON.parse(dataMwAttr) : {};

	// Add error info to data-mw
	if (errs.length > 0) {
		if (Array.isArray(dataMw.errors)) {
			errs = dataMw.errors.concat(errs);
		}
		dataMw.errors = errs;
	}

	// T110692: The batching API seems to return these as strings.
	// Till that is fixed, let us make sure these are numbers.
	info.height = Number(info.height);
	info.width = Number(info.width);

	var o;
	switch (info.mediatype) {
		case 'AUDIO':
			o = this.handleAudio(opts, info, manualinfo, dataMw, optSources);
			break;
		case 'VIDEO':
			o = this.handleVideo(opts, info, manualinfo, dataMw, optSources);
			break;
		default:
			if (manualinfo) { info = manualinfo; }
			// Now that we have a mediatype, let's mark opts that don't apply
			// as bogus, while being mindful of caption.
			markAsBogus(opts, token.dataAttribs.optList, 'img_');
			o = this.handleImage(opts, info, null, dataMw, optSources);
	}

	var iContainerName = o.hasLink ? 'a' : 'span';
	var innerContain = new TagTk(iContainerName, []);
	var innerContainClose = new EndTagTk(iContainerName);

	if (o.hasLink) {
		if (opts.link) {
			// FIXME: handle tokens here!
			if (this.urlParser.tokenizeURL(opts.link.v)) {
				// an external link!
				innerContain.addAttribute('href', opts.link.v, opts.link.src);
			} else if (opts.link.v) {
				var link = this.env.makeTitleFromText(opts.link.v, undefined, true);
				if (link !== null) {
					innerContain.addNormalizedAttribute('href', this.env.makeLink(link), opts.link.src);
				} else {
					// Treat same as if opts.link weren't present
					innerContain.addNormalizedAttribute('href', this.env.makeLink(opts.title.v), opts.title.src);
					// but maybe consider it a caption
					var pos = token.dataAttribs.optList.reduce(function(prv, cur, ind) {
						return cur.ck === 'link' ? ind : prv;
					}, 0);
					if (!opts.caption || opts.caption.pos < pos) {
						opts.link.v = opts.link.src;
						opts.caption = opts.link;
					}
				}
			}
			// No href if link= was specified
		} else {
			innerContain.addNormalizedAttribute('href', this.env.makeLink(opts.title.v), opts.title.src);
		}
	}

	var wrapperInfo = getWrapperInfo(opts, info);
	var wrapperClasses = wrapperInfo.classes;
	var isInline = wrapperInfo.isInline === true;
	var containerName = isInline ? 'figure-inline' : 'figure';
	var container = new TagTk(containerName, [], Util.clone(token.dataAttribs));
	var dataAttribs = container.dataAttribs;
	var containerClose = new EndTagTk(containerName);

	if (!dataAttribs.uneditable) {
		dataAttribs.src = undefined;
	}

	if (opts.class) {
		wrapperClasses = wrapperClasses.concat(opts.class.v.split(' '));
	}

	if (wrapperClasses.length) {
		container.addAttribute('class', wrapperClasses.join(' '));
	}

	var rdfaType = o.rdfaType;
	var format = getFormat(opts);

	// Add mw:Error to the RDFa type.
	// Prepend since rdfaType is updated with /<format> further down.
	if (errs.length > 0) {
		rdfaType = "mw:Error " + rdfaType;
	}

	// If the format is something we *recognize*, add the subtype
	switch (format) {
		case 'thumbnail':
			rdfaType += '/Thumb';
			break;
		case 'framed':
			rdfaType += '/Frame';
			break;
		case 'frameless':
			rdfaType += '/Frameless';
			break;
	}

	// Tell VE that it shouldn't try to edit this
	if (dataAttribs.uneditable) {
		rdfaType += " mw:Placeholder";
	}

	// Set typeof and transfer existing typeof over as well
	container.addAttribute("typeof", rdfaType);
	var type = token.getAttribute("typeof");
	if (type) {
		container.addSpaceSeparatedAttribute("typeof", type);
	}

	var tokens = [container, innerContain].concat(o.elt, innerContainClose);
	var manager = this.manager;

	if (optSources && !dataAttribs.uneditable) {
		var inVals = optSources.map(function(e) { return e[1]; });
		var outVals = yield Util.expandValuesToDOM(
			manager.env, manager.frame, inVals,
			this.options.wrapTemplates,
			this.options.inTemplate
		);
		if (!dataMw.attribs) { dataMw.attribs = []; }
		for (var i = 0; i < outVals.length; i++) {
			dataMw.attribs.push([optSources[i][0].optKey, outVals[i]]);
		}
		container.addAttribute("about", manager.env.newAboutId());
		container.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
	}

	if (opts.caption !== undefined) {
		if (!isInline) {
			tokens = tokens.concat([
				new TagTk('figcaption'),
				Util.getDOMFragmentToken(
					opts.caption.v, opts.caption.srcOffsets, {
						noPWrapping: true, noPre: true, token: token,
					}),
				new EndTagTk('figcaption'),
			]);
		} else {
			if (!Array.isArray(opts.caption.v)) {
				opts.caption.v = [ opts.caption.v ];
			}
			// Parse the caption asynchronously.
			var captionDOM = yield Util.promiseToProcessContent(
				manager.env, manager.frame,
				opts.caption.v.concat([new EOFTk()]), {
					pipelineType: "tokens/x-mediawiki/expanded",
					pipelineOpts: {
						noPWrapping: true, noPre: true,
					},
					srcOffsets: opts.caption.srcOffsets
				});
			// Use parsed DOM given in `captionDOM`
			dataMw.caption = DU.ppToXML(captionDOM.body, { innerXML: true });
		}
	}

	if (opts.manualthumb !== undefined) {
		dataMw.thumb = opts.manualthumb.v;
	}

	if (Object.keys(dataMw).length) {
		container.addAttribute("data-mw", JSON.stringify(dataMw));
	}

	tokens.push(containerClose);
	return { tokens: tokens };
});

/**
 * Render a file. This can be an image, a sound, a PDF etc.
 */
WikiLinkHandler.prototype.renderFile = Promise.async(function *(token, frame, target) {
	var title = target.title;

	// First check if we have a cached copy of this image expansion, and
	// avoid any further processing if we have a cache hit.
	var env = this.manager.env;
	var cachedMedia = env.mediaCache[token.dataAttribs.src];
	if (cachedMedia) {
		var wrapperTokens = DU.encapsulateExpansionHTML(env, token, cachedMedia, {
			noAboutId: true,
			setDSR: true,
		});
		var firstWrapperToken = wrapperTokens[0];

		// Capture the delta between the old/new wikitext start posn.
		// 'tsr' values are stripped in the original DOM and won't be
		// present.  Since dsr[0] is identical to tsr[0] in this case,
		// dsr[0] is a safe substitute, if present.
		var firstDa = firstWrapperToken.dataAttribs;
		if (token.dataAttribs.tsr && firstDa.dsr) {
			if (!firstDa.tmp) { firstDa.tmp = {}; }
			firstDa.tmp.tsrDelta = token.dataAttribs.tsr[0] - firstDa.dsr[0];
		}

		return { tokens: wrapperTokens };
	}

	var content = buildLinkAttrs(token.attribs, true, null, null).contentKVs;

	var opts = {
		title: {
			v: title,
			src: Util.lookupKV(token.attribs, 'href').vsrc,
		},
		size: {
			v: {
				height: null,
				width: null,
			},
		},
	};

	token.dataAttribs.optList = [];

	var optKVs = content;
	var optSources = [];
	var hasExpandableOpt = false;
	var hasTransclusion = function(toks) {
		return Array.isArray(toks) && toks.find(function(t) {
			return t.constructor === SelfclosingTagTk &&
				t.getAttribute("typeof") === "mw:Transclusion";
		}) !== undefined;
	};

	while (optKVs.length > 0) {
		var oContent = optKVs.shift();
		var origOptSrc, optInfo, oText;

		origOptSrc = oContent.v;
		if (Array.isArray(origOptSrc) && origOptSrc.length === 1) {
			origOptSrc = origOptSrc[0];
		}
		oText = Util.tokensToString(oContent.v, true, { includeEntities: true });

		if (oText.constructor !== String) {
			// Might be that this is a valid option whose value is just
			// complicated. Try to figure it out, step through all tokens.
			var maybeOText = stringifyOptionTokens(oText, '', env);
			if (maybeOText !== null) {
				oText = maybeOText;
			}
		}

		if (oText.constructor === String) {
			if (oText.match(/\|/)) {
				// Split the pipe-separated string into pieces
				// and convert each one into a KV obj and add them
				// to the beginning of the array. Note that this is
				// a hack to support templates that provide multiple
				// image options as a pipe-separated string. We aren't
				// really providing editing support for this yet, or
				// ever, maybe.
				//
				// TODO(arlolra): Tables in captions suppress breaking on
				// "linkdesc" pipes so `stringifyOptionTokens` should account
				// for pipes in table cell content.  For the moment, breaking
				// here is acceptable since it matches the php implementation
				// bug for bug.
				var pieces = oText.split("|").map(function(s) {
					return new KV("mw:maybeContent", s);
				});
				optKVs = pieces.concat(optKVs);

				// Record the fact that we won't provide editing support for this.
				token.dataAttribs.uneditable = true;
				continue;
			} else {
				// We're being overly accepting of media options at this point,
				// since we don't know the type yet.  After the info request,
				// we'll filter out those that aren't appropriate.
				optInfo = getOptionInfo(oText, env);
			}
		}

		// For the values of the caption and options, see
		// getOptionInfo's documentation above.
		//
		// If there are multiple captions, this code always
		// picks the last entry. This is the spec; see
		// "Image with multiple captions" parserTest.
		if (oText.constructor !== String || optInfo === null ||
				// Deprecated options
				['noicon', 'noplayer', 'disablecontrols'].includes(optInfo.ck)) {
			// No valid option found!?
			// Record for RT-ing
			var optsCaption = {
				v: oContent.constructor === String ? oContent : oContent.v,
				src: oContent.vsrc || oText,
				srcOffsets: oContent.srcOffsets,
				// remember the position
				pos: token.dataAttribs.optList.length,
			};
			// if there was a 'caption' previously, round-trip it as a
			// "bogus option".
			if (opts.caption) {
				token.dataAttribs.optList.splice(opts.caption.pos, 0, {
					ck: 'bogus',
					ak: opts.caption.src,
				});
				optsCaption.pos++;
			}
			opts.caption = optsCaption;
			continue;
		}

		var opt = {
			ck: optInfo.v,
			ak: oContent.vsrc || optInfo.ak,
		};

		if (optInfo.s === true) {
			// Default: Simple image option
			if (optInfo.ck in opts) {
				// first option wins, the rest are 'bogus'
				token.dataAttribs.optList.push({
					ck: 'bogus',
					ak: optInfo.ak,
				});
				continue;
			}
			opts[optInfo.ck] = { v: optInfo.v };
		} else {
			// Map short canonical name to the localized version used.
			opt.ck = optInfo.ck;

			// The MediaWiki magic word for image dimensions is called 'width'
			// for historical reasons
			// Unlike other options, use last-specified width.
			if (optInfo.ck === 'width') {
				// We support a trailing 'px' here for historical reasons
				// (T15500, T53628)
				var maybeDim = Util.parseMediaDimensions(optInfo.v);
				if (maybeDim !== null) {
					opts.size.v.width = Util.validateMediaParam(maybeDim.x) ?
						maybeDim.x : null;
					opts.size.v.height = maybeDim.hasOwnProperty('y') &&
						Util.validateMediaParam(maybeDim.y) ?
						maybeDim.y : null;
					// Only round-trip a valid size
					opts.size.src = oContent.vsrc || optInfo.ak;
				}
			} else {
				if (optInfo.ck in opts) { continue; } // first option wins
				opts[optInfo.ck] = {
					v: optInfo.v,
					src: oContent.vsrc || optInfo.ak,
					srcOffsets: oContent.srcOffsets,
				};
			}
		}

		// Collect option in dataAttribs (becomes data-parsoid later on)
		// for faithful serialization.
		token.dataAttribs.optList.push(opt);

		// Collect source wikitext for image options for possible template expansion.
		// FIXME: Does VE need the wikitext version as well in a "txt" key?
		optSources.push([{ "optKey": opt.ck }, { "html": origOptSrc }]);
		if (hasTransclusion(origOptSrc)) {
			hasExpandableOpt = true;
		}
	}

	// Handle image default sizes and upright option after extracting all
	// options
	if (opts.format && opts.format.v === 'framed') {
		// width and height is ignored for framed images
		// https://phabricator.wikimedia.org/T64258
		opts.size.v.width = null;
		opts.size.v.height = null;
	} else if (opts.format) {
		if (!opts.size.v.height && !opts.size.v.width) {
			var defaultWidth = env.conf.wiki.widthOption;
			if (opts.upright !== undefined) {
				if (opts.upright.v > 0) {
					defaultWidth *= opts.upright.v;
				} else {
					defaultWidth *= 0.75;
				}
				// round to nearest 10 pixels
				defaultWidth = 10 * Math.round(defaultWidth / 10);
			}
			opts.size.v.width = defaultWidth;
		}
	}

	// Add the last caption in the right position if there is one
	if (opts.caption) {
		token.dataAttribs.optList.splice(opts.caption.pos, 0, {
			ck: 'caption',
			ak: opts.caption.src,
		});
	}

	if (!hasExpandableOpt) {
		optSources = null;
	}

	var err;

	if (!env.conf.parsoid.fetchImageInfo) {
		err = makeErr('apierror-unknownerror', 'Fetch of image info disabled.');
		return this.handleInfo(token, opts, optSources, [err], errorInfo(env, opts));
	}

	var wrapResp = function(aTitle) {
		return function(data) { return { title: aTitle, data: data }; };
	};

	var dims = Object.assign({}, opts.size.v);
	if (opts.page && dims.width !== null) {
		dims.page = opts.page.v;
	}

	// "starttime" should be used if "thumbtime" isn't present,
	// but only for rendering.
	if (opts.thumbtime || opts.starttime) {
		var seek = opts.thumbtime ? opts.thumbtime.v : opts.starttime.v;
		seek = parseTimeString(seek);
		if (seek !== false) {
			dims.seek = seek;
		}
	}

	var reqs = [{
		promise: env.batcher.imageinfo(title.getKey(), dims).then(wrapResp(title)),
	}];

	// If this is a manual thumbnail, fetch the info for that as well
	if (opts.manualthumb) {
		var manualThumbTitle = env.makeTitleFromText(opts.manualthumb.v, undefined, true);
		if (!manualThumbTitle) {
			err = makeErr('apierror-invalidtitle', 'Invalid thumbnail title.', { name: opts.manualthumb.v });
			return this.handleInfo(token, opts, optSources, [err], errorInfo(env, opts));
		}
		if (manualThumbTitle.nskey === '') {
			// inherit namespace from main image
			manualThumbTitle.ns = title.ns;
			manualThumbTitle.nskey = title.nskey;
		}
		reqs.push({
			promise: env.batcher
				.imageinfo(manualThumbTitle.getKey(), opts.size.v)
				.then(wrapResp(manualThumbTitle)),
			params: { name: opts.manualthumb.v },
		});
	}

	var result = yield this._requestInfo(reqs, errorInfo.bind(null, env, opts));
	return this.handleInfo(
		token, opts, optSources, result.errs, result.info[0], result.info[1]
	);
});

WikiLinkHandler.prototype.linkToMedia = function(token, target, errs, info) {
	var nsText, fileName;
	var hrefBits = hrefParts(target.href);
	if (hrefBits) {
		nsText = (target.fromColonEscapedText ? ':' : '') + hrefBits.prefix;
		fileName = hrefBits.title;
	}

	// Only pass in the url, since media links should not link to the thumburl
	var imgHref = getPath({ url: info.url });
	var imgHrefFileName = imgHref.replace(/.*\//, '');

	var link = new TagTk('a', [], Util.clone(token.dataAttribs));
	link.addAttribute('rel', 'mw:MediaLink');
	link.addAttribute('href', imgHref);
	// Normalize title according to how PHP parser does it currently
	link.setAttribute('title', imgHrefFileName.replace(/_/g, ' '));
	link.dataAttribs.src = undefined; // clear src string since we can serialize this

	var type = token.getAttribute('typeof');
	if (type) {
		link.addSpaceSeparatedAttribute('typeof', type);
	}

	if (errs.length > 0) {
		// Set RDFa type to mw:Error so VE and other clients
		// can use this to do client-specific action on these.
		link.addAttribute('typeof', 'mw:Error');

		// Update data-mw
		var dataMwAttr = token.getAttribute('data-mw');
		var dataMw = dataMwAttr ? JSON.parse(dataMwAttr) : {};
		if (Array.isArray(dataMw.errors)) {
			errs = dataMw.errors.concat(errs);
		}
		dataMw.errors = errs;
		link.addAttribute('data-mw', JSON.stringify(dataMw));
	}

	// Record shadow attribute info:
	// - original namespace and localized version
	// - original filename and filename used in href
	link.setShadowInfo('namespace', target.title.getNamespace().getNormalizedText(), nsText);
	link.setShadowInfo('fileName', imgHrefFileName, fileName);

	var content = Util.tokensToString(token.getAttribute('href')).replace(/^:/, '');
	content = token.getAttribute('mw:maybeContent') || content;
	return { tokens: [ link, content, new EndTagTk('a') ] };
};

WikiLinkHandler.prototype.renderMedia = Promise.async(function *(token, frame, target) {
	var env = this.manager.env;
	var title = target.title;
	var reqs = [{
		promise: env.batcher
			.imageinfo(title.getKey(), { height: null, width: null })
			.then(function(data) {
				return { title: title, data: data };
			}),
	}];

	var result = yield this._requestInfo(reqs, function() {
		return {
			url: './Special:FilePath/' + (title ? Util.sanitizeTitleURI(title.getKey()) : ''),
		};
	});
	return this.linkToMedia(token, target, result.errs, result.info[0]);
});

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 * @constructor
 */
class ExternalLinkHandler extends TokenHandler { }

ExternalLinkHandler.prototype.rank = 1.15;

ExternalLinkHandler.prototype.init = function() {
	this.manager.addTransform(this.onUrlLink.bind(this),
		'ExternalLinkHandler:onUrlLink', this.rank, 'tag', 'urllink');
	this.manager.addTransform(this.onExtLink.bind(this),
		'ExternalLinkHandler:onExtLink', this.rank - 0.001, 'tag', 'extlink');
	this.manager.addTransform(this.onEnd.bind(this),
		'ExternalLinkHandler:onEnd', this.rank, 'end');

	// Create a new peg parser for image options.
	if (!this.urlParser) {
		// Actually the regular tokenizer, but we'll call it with the
		// url rule only.
		ExternalLinkHandler.prototype.urlParser = new PegTokenizer(this.env);
	}

	this._reset();
};

ExternalLinkHandler.prototype._reset = function() {
	this.linkCount = 1;
};

ExternalLinkHandler.prototype._imageExtensions = {
	'jpg': true,
	'png': true,
	'gif': true,
	'svg': true,
};

ExternalLinkHandler.prototype._hasImageLink = function(href) {
	var allowedPrefixes = this.manager.env.conf.wiki.allowExternalImages;
	var bits = href.split('.');
	var hasImageExtension = bits.length > 1 &&
		this._imageExtensions.hasOwnProperty(lastItem(bits)) &&
		href.match(/^https?:\/\//i);
	// Typical settings for mediawiki configuration variables
	// $wgAllowExternalImages and $wgAllowExternalImagesFrom will
	// result in values like these:
	//  allowedPrefixes = undefined; // no external images
	//  allowedPrefixes = [''];      // allow all external images
	//  allowedPrefixes = ['http://127.0.0.1/', 'http://example.com'];
	// Note that the values include the http:// or https:// protocol.
	// See https://phabricator.wikimedia.org/T53092
	return hasImageExtension && Array.isArray(allowedPrefixes) &&
		// true iff some prefix in the list matches href
		allowedPrefixes.some(function(prefix) {
			return href.indexOf(prefix) === 0;
		});
};

ExternalLinkHandler.prototype.onUrlLink = function(token, frame, cb) {
	var tagAttrs, builtTag;
	var env = this.manager.env;
	var origHref = Util.lookup(token.attribs, 'href');
	var href = Util.tokensToString(origHref);
	var dataAttribs = Util.clone(token.dataAttribs);

	if (this._hasImageLink(href)) {
		tagAttrs = [
			new KV('src', href),
			new KV('alt', lastItem(href.split('/'))),
			new KV('rel', 'mw:externalImage'),
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		cb({ tokens: [ new SelfclosingTagTk('img', tagAttrs, dataAttribs) ] });
	} else {
		tagAttrs = [
			new KV('rel', 'mw:ExtLink'),
			// href is set explicitly below
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		builtTag = new TagTk('a', tagAttrs, dataAttribs);
		dataAttribs.stx = 'url';

		if (!this.options.inTemplate) {
			// Since we messed with the text of the link, we need
			// to preserve the original in the RT data. Or else.
			builtTag.addNormalizedAttribute('href', href, token.getWTSource(env));
		} else {
			builtTag.addAttribute('href', href);
		}

		cb({
			tokens: [
				builtTag,
				// Make sure there are no IDN-ignored characters in the text so
				// the user doesn't accidentally copy any.
				Sanitizer.cleanUrl(env, href),
				new EndTagTk('a', [], { tsr: [dataAttribs.tsr[1], dataAttribs.tsr[1]] }),
			],
		});
	}
};

// Bracketed external link
ExternalLinkHandler.prototype.onExtLink = function(token, manager, cb) {
	var newAttrs, aStart;
	var env = this.manager.env;
	var origHref = Util.lookup(token.attribs, 'href');
	var href = Util.tokensToString(origHref);
	var hrefWithEntities = Util.tokensToString(origHref, false, {
		includeEntities: true,
	});
	var content = Util.lookup(token.attribs, 'mw:content');
	var dataAttribs = Util.clone(token.dataAttribs);
	var rdfaType = token.getAttribute('typeof');
	var magLinkRe = /(?:^|\s)(mw:(?:Ext|Wiki)Link\/(?:ISBN|RFC|PMID))(?=$|\s)/;

	if (rdfaType && magLinkRe.test(rdfaType)) {
		var newHref = href;
		var newRel = 'mw:ExtLink';
		if (/(?:^|\s)mw:(Ext|Wiki)Link\/ISBN/.test(rdfaType)) {
			newHref = env.page.relativeLinkPrefix + href;
			// ISBNs use mw:WikiLink instead of mw:ExtLink
			newRel = 'mw:WikiLink';
		}
		newAttrs = [
			new KV('href', newHref),
			new KV('rel', newRel),
		];
		token.removeAttribute('typeof');

		// SSS FIXME: Right now, Parsoid does not support templating
		// of ISBN attributes.  So, "ISBN {{echo|1234567890}}" will not
		// parse as you might expect it to.  As a result, this code below
		// that attempts to combine rdf attrs from earlier is unnecessary
		// right now.  But, it will become necessary if Parsoid starts
		// supporting templating of ISBN attributes.
		//
		// combine with existing rdfa attrs
		newAttrs = buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
		aStart = new TagTk('a', newAttrs, dataAttribs);
		cb({
			tokens: [aStart].concat(content, [new EndTagTk('a')]),
		});
	} else if (this.urlParser.tokenizeURL(hrefWithEntities)) {
		rdfaType = 'mw:ExtLink';
		if (content.length === 1 &&
				content[0].constructor === String &&
				this.urlParser.tokenizeURL(content[0]) &&
				this._hasImageLink(content[0])) {
			var src = content[0];
			content = [
				new SelfclosingTagTk('img', [
					new KV('src', src),
					new KV('alt', lastItem(src.split('/'))),
				], { type: 'extlink' }),
			];
		}

		newAttrs = [
			new KV('rel', rdfaType),
			// href is set explicitly below
		];
		// combine with existing rdfa attrs
		newAttrs = buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
		aStart = new TagTk('a', newAttrs, dataAttribs);

		if (!this.options.inTemplate) {
			// If we are from a top-level page, add normalized attr info for
			// accurate roundtripping of original content.
			//
			// targetOff covers all spaces before content
			// and we need src without those spaces.
			var tsr0a = dataAttribs.tsr[0] + 1;
			var tsr1a = dataAttribs.targetOff - (token.getAttribute('spaces') || '').length;
			aStart.addNormalizedAttribute('href', href, env.page.src.substring(tsr0a, tsr1a));
		} else {
			aStart.addAttribute('href', href);
		}

		content = Util.getDOMFragmentToken(content, dataAttribs.tsr ? dataAttribs.contentOffsets : null, { noPWrapping: true, noPre: true, token: token });

		cb({
			tokens: [aStart].concat(content, [new EndTagTk('a')]),
		});
	} else {
		// Not a link, convert href to plain text.
		cb({ tokens: bailTokens(env, token, true) });
	}
};

ExternalLinkHandler.prototype.onEnd = function(token, manager, cb) {
	this._reset();
	cb({ tokens: [ token ] });
};

if (typeof module === "object") {
	module.exports.WikiLinkHandler = WikiLinkHandler;
	module.exports.ExternalLinkHandler = ExternalLinkHandler;
}
