/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 */
'use strict';

var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer;
var WikitextConstants = require('./mediawiki.wikitext.constants.js').WikitextConstants;
var Title = require('./mediawiki.Title.js').Title;
var Util = require('./mediawiki.Util.js').Util;
var sanitizerLib = require('./ext.core.Sanitizer.js');
var defines = require('./mediawiki.parser.defines.js');
var DU = require('./mediawiki.DOMUtils.js').DOMUtils;
var ImageInfoRequest = require('./mediawiki.ApiRequest.js').ImageInfoRequest;

// define some constructor shortcuts
var KV = defines.KV;
var EOFTk = defines.EOFTk;
var TagTk = defines.TagTk;
var SelfclosingTagTk = defines.SelfclosingTagTk;
var EndTagTk = defines.EndTagTk;
var Sanitizer = sanitizerLib.Sanitizer;
var SanitizerConstants = sanitizerLib.SanitizerConstants;


function WikiLinkHandler(manager, options) {
	this.manager = manager;
	this.options = options;
	// Handle redirects first (since they used to emit additional link tokens)
	this.manager.addTransform(this.onRedirect.bind(this), "WikiLinkHandler:onRedirect", this.rank, 'tag', 'mw:redirect');
	// Now handle regular wikilinks.
	this.manager.addTransform(this.onWikiLink.bind(this), "WikiLinkHandler:onWikiLink", this.rank + 0.001, 'tag', 'wikilink');
	// create a new peg parser for image options..
	if (!this.urlParser) {
		// Actually the regular tokenizer, but we'll call it with the
		// url rule only.
		WikiLinkHandler.prototype.urlParser = new PegTokenizer(this.manager.env);
	}
}

WikiLinkHandler.prototype.rank = 1.15; // after AttributeExpander

/**
 * Normalize and analyze a wikilink target.
 *
 * Returns an object containing
 * - href: the expanded target string
 * - hrefSrc: the original target wikitext
 * - title: a title object *or*
 *   language: an interwikiInfo object *or*
 *   interwiki: an interwikiInfo object
 * - localprefix: set if the link had a localinterwiki prefix (or prefixes)
 * - fromColonEscapedText: target was colon-escaped ([[:en:foo]])
 * - prefix: the original namespace or language/interwiki prefix without a
 *   colon escape
 *
 * @return {Object} The target info
 */
WikiLinkHandler.prototype.getWikiLinkTargetInfo = function(token) {
	var hrefInfo = Util.lookupKV(token.attribs, 'href');
	var info = {
		href: Util.tokensToString(hrefInfo.v),
		hrefSrc: hrefInfo.vsrc,
	};
	var env = this.manager.env;
	var href = info.href;

	if (/^:/.test(info.href)) {
		info.fromColonEscapedText = true;
		// remove the colon escape
		info.href = info.href.substr(1);
		href = info.href;
	}

	// strip ./ prefixes
	href = href.replace(/^(?:\.\/)+/, '');
	info.href = href;

	var hrefBits = href.match(/^([^:]+):(.*)$/);
	href = env.normalizeTitle(href, false, true);
	if (hrefBits) {
		var nsPrefix = hrefBits[1];
		info.prefix = nsPrefix;
		var nnn = Util.normalizeNamespaceName(nsPrefix.trim());
		var interwikiInfo = env.conf.wiki.interwikiMap.get(nnn);
		// check for interwiki / language links
		var ns = env.conf.wiki.namespaceIds[nnn];
		// console.warn( nsPrefix, ns, interwikiInfo );
		// also check for url to protect against [[constructor:foo]]
		if (ns !== undefined) {
			// FIXME: percent-decode first, then entity-decode!
			info.title = new Title(Util.decodeURI(href.replace(/^[^:]+:/, '')),
					ns, nsPrefix, env);
		} else if (interwikiInfo && interwikiInfo.localinterwiki !== undefined) {
			if (hrefBits[2] === '') {
				// Empty title => main page (T66167)
				info.title = new Title(env.normalizeTitle(env.conf.wiki.mainpage, false, true), 0, '', env);
			} else {
				info.href = hrefBits[2];
				// Recurse!
				var hrefKV = new KV
					('href', (/:/.test(info.href) ? ':' : '') + info.href);
				hrefKV.vsrc = info.hrefSrc;
				info = this.getWikiLinkTargetInfo
					(new TagTk('a', [hrefKV], token.dataAttribs));
				info.localprefix = nsPrefix +
					(info.localprefix ? (':' + info.localprefix) : '');
			}
		} else if (interwikiInfo && interwikiInfo.url) {
			info.href = hrefBits[2];
			// Interwiki or language link? If no language info, or if it starts
			// with an explicit ':' (like [[:en:Foo]]), it's not a language link.
			if (info.fromColonEscapedText || (interwikiInfo.language === undefined && interwikiInfo.extralanglink === undefined)) {
				// An interwiki link.
				info.interwiki = interwikiInfo;
			} else {
				// A language link.
				info.language = interwikiInfo;
			}
		} else {
			info.title = new Title(Util.decodeURI(href), 0, '', env);
		}
	} else if (/^(\#|\/|\.\.\/)/.test(href)) {
		// If the link is relative, use the page's namespace.
		info.title = new Title(Util.decodeURI(href), env.page.ns, '', env);
	} else {
		info.title = new Title(Util.decodeURI(href), 0, '', env);
	}

	return info;
};

/**
 * Handle mw:redirect tokens.
 */
WikiLinkHandler.prototype.onRedirect = function(token, frame, cb) {

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
	this.onWikiLink(wikiLinkTk, frame, function(r) {
		var isValid = r && r.tokens && r.tokens[0] &&
			/^(a|link)$/.test(r.tokens[0].name);
		if (isValid) {
			var da = r.tokens[0].dataAttribs;
			rlink.addNormalizedAttribute('href', da.a.href, da.sa.href);
			cb ({ tokens: [rlink] });
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
			cb ({ tokens: ntokens.concat(r.tokens) });
		}
	});
};



/**
 * Handle a mw:WikiLink token.
 */
WikiLinkHandler.prototype.onWikiLink = function(token, frame, cb) {
	var env = this.manager.env;
	// move out
	var attribs = token.attribs;
	var redirect = Util.lookup(attribs, 'redirect');
	var target = this.getWikiLinkTargetInfo(token);

	// First check if the expanded href contains a pipe.
	if (/[|]/.test(target.href)) {
		// It does. This 'href' was templated and also returned other
		// parameters separated by a pipe. We don't have any sane way to
		// handle such a construct currently, so prevent people from editing
		// it.
		// TODO: add useful debugging info for editors ('if you would like to
		// make this content editable, then fix template X..')
		// TODO: also check other parameters for pipes!
		cb ({
			tokens: [
				new SelfclosingTagTk('meta', [
					new KV('typeof', 'mw:Placeholder'),
				], token.dataAttribs),
			],
		});
		return;
	}

	if (!env.isValidLinkTarget(token.getAttribute("href"))) {
		var tokens = ["[["];
		if (/mw:ExpandedAttrs/.test(token.getAttribute("typeof"))) {
			var dataMW = JSON.parse(token.getAttribute("data-mw")).attribs;
			var html;
			for (var i = 0; i < dataMW.length; i++) {
				if (dataMW[i][0].txt === "href") {
					html = dataMW[i][1].html;
					break;
				}
			}

			// Since we are splicing off '[[' and ']]' from the incoming token,
			// adjust TSR of the DOM-fragment by 2 each on both end.
			var tsr = token.dataAttribs && token.dataAttribs.tsr;
			if (tsr && typeof (tsr[0]) === 'number' && typeof (tsr[1]) === 'number') {
				tsr = [tsr[0] + 2, tsr[1] - 2];
			} else {
				tsr = null;
			}

			tokens = tokens.concat(DU.buildDOMFragmentTokens(env, token, html, null, {noPWrapping: true, tsr: tsr}));
		} else {
			// FIXME: Duplicate work
			tokens[0] += Util.tokensToString(token.getAttribute("href"));
		}

		// Append rest of the attributes
		token.attribs.forEach(function(a) {
			if (a.k === "mw:maybeContent") {
				tokens = tokens.concat("|", a.v);
			}
		});

		tokens.push("]]");
		cb({tokens: tokens});
		return;
	}

	// Ok, it looks like we have a sane href. Figure out which handler to use.
	var handler = this.getWikiLinkHandler(token, target, redirect);
	// and call it.
	handler(token, frame, cb, target);
};

/**
 * Figure out which handler to use to render a given WikiLink token. Override
 * this method to add new handlers or swap out existing handlers based on the
 * target structure.
 */
WikiLinkHandler.prototype.getWikiLinkHandler = function(token, target, isRedirect) {
	var title = target.title;
	if (title) {
		if (!target.fromColonEscapedText && !isRedirect) {
			if (title.ns.isFile()) {
				// Render as a file.
				return this.renderFile.bind(this);
			} else if (title.ns.isCategory()) {
				// Render as a category membership.
				return this.renderCategory.bind(this);
			}
		}
		// Colon-escaped or non-file/category links. Render as plain wiki
		// links.
		return this.renderWikiLink.bind(this);

	// language and interwiki links
	} else if (target.interwiki) {
		return this.renderInterwikiLink.bind(this);
	} else if (target.language) {
		return this.renderLanguageLink.bind(this);
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
 * @return {Array} Content tokens
 */
WikiLinkHandler.prototype.addLinkAttributesAndGetContent = function(newTk, token, target, buildDOMFragment) {
	var title = target.title;
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
		// re-join content bits
		for (var i = 0, l = content.length; i < l ; i++) {
			var toks = content[i].v;
			// since this is already a link, strip autolinks from content
			if (!Array.isArray(toks)) { toks = [ toks ]; }
			toks = toks.filter(function(token) { return token !== ''; });
			toks = toks.map(function(token, i) {
				if (token.constructor === TagTk && token.name === 'a') {
					if (toks[i + 1] && toks[i + 1].constructor === EndTagTk &&
						toks[i + 1].name === 'a') {
						// autonumbered links in the stream get rendered
						// as an <a> tag with no content -- but these ought
						// to be treated as plaintext since we don't allow
						// nested links.
						return '[' + token.getAttribute('href') + ']';
					}
					return ''; // suppress <a>
				}
				if (token.constructor === EndTagTk && token.name === 'a') {
					return ''; // suppress </a>
				}
				return token;
			});
			toks = toks.filter(function(token) { return token !== ''; });
			out = out.concat(toks);
			if (i < l - 1) {
				out.push('|');
			}
		}

		if (buildDOMFragment) {
			// content = [part 0, .. part l-1]
			// offsets = [start(part-0), end(part l-1)]
			var offsets = dataAttribs.tsr ? [content[0].srcOffsets[0], content[l - 1].srcOffsets[1]] : null;
			content = [ Util.getDOMFragmentToken(out, offsets, {noPWrapping: true, noPre: true, token: token}) ];
		} else {
			content = out;
		}
	} else {
		newTk.dataAttribs.stx = 'simple';
		var morecontent = Util.decodeURI(target.href);
		if (token.dataAttribs.pipetrick) {
			morecontent = Util.stripPipeTrickChars(morecontent);
		}

		// Strip leading colon
		morecontent = morecontent.replace(/^:/, '');

		// Try to match labeling in core
		if (env.page.ns !== undefined &&
				env.conf.wiki.namespacesWithSubpages[ env.page.ns ]) {
			// subpage links with a trailing slash get the trailing slashes stripped.
			// See https://gerrit.wikimedia.org/r/173431
			var match = morecontent.match(/^((\.\.\/)+|\/)(?!\.\.\/)(.*?[^\/])\/+$/);
			if (match) {
				morecontent = match[3];
			} else if (/^\.\.\//.test(morecontent)) {
				morecontent = env.resolveTitle(morecontent, env.page.ns);
			}
		}

		// for interwiki links, include the interwiki prefix in the link text
		if (target.interwiki && !newTk.dataAttribs.pipetrick) {
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
WikiLinkHandler.prototype.renderWikiLink = function(token, frame, cb, target) {
	var newTk = new TagTk('a');
	var content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

	newTk.addNormalizedAttribute('href', target.title.makeLink(), target.hrefSrc);

	// Add title unless it's just a fragment
	if (target.href[0] !== "#") {
		newTk.setAttribute("title", target.title.getPrefixedText());
	}

	cb({tokens: [newTk].concat(content, [new EndTagTk('a')])});
};

/**
 * Render a category 'link'. Categories are really page properties, and are
 * normally rendered in a box at the bottom of an article.
 */
WikiLinkHandler.prototype.renderCategory = function(token, frame, cb, target) {
	var tokens = [];
	var newTk = new SelfclosingTagTk('link');
	var content = this.addLinkAttributesAndGetContent(newTk, token, target);
	var env = this.manager.env;

	// Change the rel to be mw:PageProp/Category
	Util.lookupKV(newTk.attribs, 'rel').v = 'mw:PageProp/Category';

	var strContent = Util.tokensToString(content);
	var saniContent = Util.sanitizeTitleURI(strContent).replace(/#/g, '%23');
	newTk.addNormalizedAttribute('href', target.title.makeLink(), target.hrefSrc);
	// Change the href to include the sort key, if any (but don't update the rt info)
	if (strContent && strContent !== '' && strContent !== target.href) {
		var hrefkv = Util.lookupKV(newTk.attribs, 'href');
		hrefkv.v += '#';
		hrefkv.v += saniContent;
	}

	tokens.push(newTk);

	if (content.length === 1) {
		cb({tokens: tokens});
	} else {
		// Deal with sort keys that come from generated content (transclusions, etc.)
		cb({ async: true });
		var inVals = [ { "txt": "mw:sortKey" }, { "html": content } ];
		Util.expandValuesToDOM(
			this.manager.env,
			this.manager.frame,
			inVals,
			this.options.wrapTemplates,
			function(_, outVals) {
				var sortKeyInfo = outVals;
				var dataMW = newTk.getAttribute("data-mw");
				if (dataMW) {
					dataMW = JSON.parse(dataMW);
					dataMW.attribs.push(sortKeyInfo);
				} else {
					dataMW = { attribs: [sortKeyInfo] };
				}

				// Mark token as having expanded attrs
				newTk.addAttribute("about", env.newAboutId());
				newTk.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
				newTk.addAttribute("data-mw", JSON.stringify(dataMW));

				cb({ tokens: tokens });
			}
		);
	}
};

/**
 * Render a language link. Those normally appear in the list of alternate
 * languages for an article in the sidebar, so are really a page property.
 */
WikiLinkHandler.prototype.renderLanguageLink = function(token, frame, cb, target) {
	// The prefix is listed in the interwiki map

	var newTk = new SelfclosingTagTk('link', [], token.dataAttribs);
	var content = this.addLinkAttributesAndGetContent(newTk, token, target);

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
	newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

	// Change the rel to be mw:PageProp/Language
	Util.lookupKV(newTk.attribs, 'rel').v = 'mw:PageProp/Language';

	cb({tokens: [newTk]});
};

/**
 * Render an interwiki link.
 */
WikiLinkHandler.prototype.renderInterwikiLink = function(token, frame, cb, target) {
	// The prefix is listed in the interwiki map

	var tokens = [];
	var newTk = new TagTk('a', [], token.dataAttribs);
	var content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

	// We set an absolute link to the article in the other wiki/language
	var absHref = target.interwiki.url.replace("$1", target.href);
	if (target.interwiki.protorel !== undefined) {
		absHref = absHref.replace(/^https?:/, '');
	}
	newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

	// Change the rel to be mw:ExtLink
	Util.lookupKV(newTk.attribs, 'rel').v = 'mw:ExtLink';
	// Remember that this was using wikitext syntax though
	newTk.dataAttribs.isIW = true;
	// Add title unless it's just a fragment (and trim off fragment)
	// (The normalization here is similar to what Title#getPrefixedText() does.)
	if (target.href[0] !== "#") {
		var titleAttr =
			target.interwiki.prefix + ':' +
			Util.decodeURI
			(target.href.replace(/#[\s\S]*/, '').replace(/_/g, ' '));
		newTk.setAttribute("title", titleAttr);
	}
	tokens.push(newTk);

	tokens = tokens.concat(content,
			[new EndTagTk('a')]);
	cb({tokens: tokens});
};


/**
 * Extract the dimensions for an image
 */
function handleSize(info) {
	var width, height;
	if (info.height) {
		height = info.height;
	}

	if (info.width) {
		width = info.width;
	}

	if (info.thumburl && info.thumbheight) {
		height = info.thumbheight;
	}

	if (info.thumburl && info.thumbwidth) {
		width = info.thumbwidth;
	}
	return {
		height: height,
		width: width,
	};
}

/**
 * Get the format for an image.
 */
function getFormat(opts) {
	if (opts.manualthumb) {
		return "thumbnail";
	}
	return opts.format && opts.format.v;
}

/**
 * Get the style and class lists for an image's wrapper element
 *
 * @private
 * @param {Object} opts The option hash from renderFile
 * @return {Object}
 * @return {boolean} return.isInline Whether the image is inline after handling options
 * @return {boolean} return.isFloat Whether the image is floated after handling options
 * @return {Array} return.classes The list of classes for the wrapper
 * @return {Array} return.styles The list of styles for the wrapper
 */
function getWrapperInfo(opts) {
	var format = getFormat(opts);
	var isInline = !(format === 'thumbnail' || format === 'framed');
	var wrapperStyles = [];
	var wrapperClasses = [];
	var halign = (opts.format && opts.format.v === 'framed') ? 'right' : null;
	var valign = 'middle';
	var isFloat = false;

	if (!opts.size.src) {
		wrapperClasses.push('mw-default-size');
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
			wrapperStyles.push('text-align: center;');

			if (halignOpt === 'center') {
				wrapperClasses.push('mw-halign-center');
			}
			break;

		case 'left':
			// PHP parser wraps in <div class="floatleft">
			isInline = false;
			isFloat = true;
			wrapperStyles.push('float: left;');

			if (halignOpt === 'left') {
				wrapperClasses.push('mw-halign-left');
			}
			break;

		case 'right':
			// PHP parser wraps in <div class="floatright">
			isInline = false;
			isFloat = true;
			// XXX: remove inline style
			wrapperStyles.push('float: right;');

			if (halignOpt === 'right') {
				wrapperClasses.push('mw-halign-right');
			}
			break;
	}

	if (opts.valign) {
		valign = opts.valign.v;
	}

	if (isInline && !isFloat) {
		wrapperStyles.push('vertical-align: ' + valign.replace(/_/, '-') + ';');
	}

	// always have to add these valign classes (not just when inline)
	// otherwise how can we know whether the user has removed them in VE?
	if (isInline || true) {
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
	} else {
		wrapperStyles.push('display: block;');
	}

	return { // jscs:ignore jsDoc
		styles: wrapperStyles,
		classes: wrapperClasses,
		isInline: isInline,
		isFloat: isFloat,
	};
}

/**
 * Abstract way to get the path for an image given an info object
 *
 * @private
 * @param {Object} info
 * @param {string|null} info.thumburl The URL for a thumbnail
 * @param {string} info.url The base URL for the image
 */
function getPath(info) {
	var path;
	if (info.thumburl) {
		path = info.thumburl;
	} else if (info.url) {
		path = info.url;
	}
	return path.replace(/^https?:\/\//, '//');
}

/**
 * Determine the name of an option
 * Returns an object of form
 * {
 *   ck: Canonical key for the image option
 *   v: Value of the option
 *   ak: Aliased key for the image option - includes "$1" for placeholder
 *   s: Whether it's a simple option or one with a value
 * }
 */
function getOptionInfo(optStr, env) {
	var returnObj;
	var oText = optStr.trim();
	var lowerOText = oText.toLowerCase();
	var getOption = env.conf.wiki.getMagicPatternMatcher(
			WikitextConstants.Image.PrefixOptions);
	// oText contains the localized name of this option.  the
	// canonical option names (from mediawiki upstream) are in
	// English and contain an 'img_' prefix.  We drop the
	// prefix before stuffing them in data-parsoid in order to
	// save space (that's shortCanonicalOption)
	var canonicalOption = (env.conf.wiki.magicWords[oText] ||
			env.conf.wiki.magicWords[lowerOText] ||
			('img_' + lowerOText));
	var shortCanonicalOption = canonicalOption.replace(/^img_/,  '');
	// 'imgOption' is the key we'd put in opts; it names the 'group'
	// for the option, and doesn't have an img_ prefix.
	var imgOption = WikitextConstants.Image.SimpleOptions.get(canonicalOption);
	var bits = getOption(optStr.trim());
	var normalizedBit0 = bits ? bits.k.trim().toLowerCase() : null;
	var key = bits ? WikitextConstants.Image.PrefixOptions.get(normalizedBit0) : null;

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
		// (from mediawiki upstream) with an img_ prefix.
		// 'key' is the parsoid 'group' for the option; it doesn't
		// have an img_ prefix (it's the key we'd put in opts)

		if (bits && key) {
			shortCanonicalOption = normalizedBit0.replace(/^img_/, '');
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
 * @param {string} prefix Anything that came before this part of the recursive call stack
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
						/* jshint noempty: false */
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

// Handle a response to an imageinfo API request.
// Set up the actual image structure, attributes etc
WikiLinkHandler.prototype.handleImageInfo = function(cb, token, title, opts, optSources, err, data) {
	var image, info;
	var rdfaType = 'mw:Image';
	var hasImageLink = (opts.link === undefined || opts.link && opts.link.v !== '');
	var iContainerName = hasImageLink ? 'a' : 'span';
	var innerContain = new TagTk(iContainerName, []);
	var innerContainClose = new EndTagTk(iContainerName);
	var img = new SelfclosingTagTk('img', []);
	var wrapperInfo = getWrapperInfo(opts);
	var wrapperStyles = wrapperInfo.styles;
	var wrapperClasses = wrapperInfo.classes;
	var useFigure = wrapperInfo.isInline !== true;
	var dataMW = token.getAttribute("data-mw");
	var dataMWObj = null;
	var containerName = useFigure ? 'figure' : 'span';
	var container = new TagTk(containerName, [], Util.clone(token.dataAttribs));
	var dataAttribs = container.dataAttribs;
	var containerClose = new EndTagTk(containerName);

	if (!err && data) {
		if (data.batchResponse !== undefined) {
			info = data.batchResponse;
		} else {
			var ns = data.imgns;
			image = data.pages[ns + ':' + title.key];
			if (image && image.imageinfo && image.imageinfo[0]) {
				info = image.imageinfo[0];
			} else {
				info = false;
			}
		}
	}

	// FIXME gwicke: Make sure our filename is never of the form
	// 'File:foo.png|Some caption', as is the case for example in
	// [[:de:Portal:Thüringen]]. The href is likely templated where
	// the expansion includes the pipe and caption. We don't currently
	// handle that case and pass the full string including the pipe to
	// the API. The API in turn interprets the pipe as two separate
	// titles and returns two results for each side of the pipe. The
	// full 'filename' does not match any of them, so image is then
	// undefined here. So for now (as a workaround) check if we
	// actually have an image to work with instead of crashing.
	if (!info) {
		// Use sane defaults.
		info = {
			url: './Special:FilePath/' + Util.sanitizeTitleURI(title.key),
			// Preserve width and height from the wikitext options
			// even if the image is non-existent.
			width: opts.size.v.width || 220,
			height: opts.size.v.height || opts.size.v.width || 220,
		};

		// Add mw:Error to the RDFa type.
		// Prepend since rdfaType is updated with /<format> further down.
		rdfaType = "mw:Error " + rdfaType;

		// Add error info to data-mw
		dataMWObj = dataMW ? JSON.parse(dataMW) : {};
		var errs = dataMWObj.errors;
		if (!errs) {
			errs = [];
			dataMWObj.errors = errs;
		}

		// Set appropriate error info
		if (err || !data) {
			errs.push({"key": "api-error", "message": err || "Empty API info"});
		} else if (opts.manualthumb !== undefined) {
			errs.push({
				"key": "missing-thumbnail",
				"message": "This thumbnail does not exist.",
				// Additional error info for clients that could fix the error.
				"params": {
					"name": opts.manualthumb.v,
				},
			});
		} else {
			errs.push({"key": "missing-image", "message": "This image does not exist." });
		}
	}

	// T110692: The batching API seems to return these as strings.
	// Till that is fixed, let us make sure these are numbers.
	info.height = Number(info.height);
	info.width = Number(info.width);

	var imageSrc = dataAttribs.src;
	if (!dataAttribs.uneditable) {
		dataAttribs.src = undefined;
	}

	if ('alt' in opts) {
		img.addNormalizedAttribute('alt', opts.alt.v, opts.alt.src);
	}

	img.addNormalizedAttribute('resource', opts.title.v.makeLink(), opts.title.src);
	img.addAttribute('src', getPath(info));

	if (opts.lang) {
		img.addNormalizedAttribute('lang', opts.lang.v, opts.lang.src);
	}

	if (!/\bmw:Error\b/.test(rdfaType)) {
		// Add (read-only) information about original file size (T64881)
		img.addAttribute('data-file-width', info.width);
		img.addAttribute('data-file-height', info.height);
		img.addAttribute('data-file-type', info.mediatype.toLowerCase());
	}

	if (hasImageLink) {
		if (opts.link) {
			// FIXME: handle tokens here!
			if (this.urlParser.tokenizeURL(opts.link.v)) {
				// an external link!
				innerContain.addAttribute('href', opts.link.v, opts.link.src);
			} else if (opts.link.v) {
				title = Title.fromPrefixedText(this.manager.env, opts.link.v);
				innerContain.addNormalizedAttribute('href', title.makeLink(), opts.link.src);
			}
			// No href if link= was specified
		} else {
			innerContain.addNormalizedAttribute('href', opts.title.v.makeLink());
		}
	}

	var format = getFormat(opts);
	var size = handleSize(info);
	var scalable = info.mediatype === 'DRAWING';
	// client-side upscaling for "unspecified format" (including 'border')
	if ((scalable || !format) && info.height && info.width) {
		var ratio = null;
		if (opts.size.v.height) {
			ratio = opts.size.v.height / info.height;
		}
		if (opts.size.v.width) {
			var r = opts.size.v.width / info.width;
			ratio = (ratio === null || r < ratio) ? r : ratio;
		}
		if (ratio !== null && ratio > 1) {
			size.height = Math.round(info.height * ratio);
			size.width = Math.round(info.width * ratio);
		}
	}

	if (size.height) {
		img.addNormalizedAttribute('height', size.height.toString());
	}

	if (size.width) {
		img.addNormalizedAttribute('width', size.width.toString());
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

	if (opts['class']) {
		wrapperClasses = wrapperClasses.concat(opts['class'].v.split(' '));
	}

	if (wrapperClasses.length) {
		container.addAttribute('class', wrapperClasses.join(' '));
	}

	// FIXME gwicke: We don't really want to add inline styles, as people
	// will start to depend on them otherwise.
	//  if (wrapperStyles.length) {
	//    container.addAttribute( 'style', wrapperStyles.join( ' ' ) );
	//  }

	// Set typeof and transfer existing typeof over as well
	container.addAttribute("typeof", rdfaType);
	var type = token.getAttribute("typeof");
	if (type) {
		container.addSpaceSeparatedAttribute("typeof", type);
	}

	var tokens = [ container, innerContain, img, innerContainClose ];
	var manager = this.manager;
	var setupDataMW = function(obj, str, captionDOM) {
		if (opts.caption !== undefined) {
			if (useFigure) {
				tokens = tokens.concat([
					new TagTk('figcaption'),
					Util.getDOMFragmentToken(
						opts.caption.v, opts.caption.srcOffsets, {
							noPWrapping: true, noPre: true, token: token,
						}),
					new EndTagTk('figcaption'),
				]);
			} else if (!captionDOM) {
				if (!Array.isArray(opts.caption.v)) {
					opts.caption.v = [ opts.caption.v ];
				}
				// Parse the caption asynchronously.
				return Util.processContentInPipeline(
					manager.env, manager.frame,
					opts.caption.v.concat([new EOFTk()]), {
						pipelineType: "tokens/x-mediawiki/expanded",
						pipelineOpts: {
							noPWrapping: true, noPre: true, token: token,
						},
						srcOffsets: opts.caption.srcOffsets,
						documentCB: function(doc) {
							// Async goto: return to top of function
							// with the parsed caption in `captionDOM`
							setupDataMW(obj, str, doc);
						},
					});
			} else {
				if (!obj) { obj = str ? JSON.parse(str) : {}; }
				// Use parsed DOM given in `captionDOM`
				obj.caption = captionDOM.body.innerHTML;
			}
		}
		if (opts.manualthumb !== undefined) {
			if (!obj) { obj = str ? JSON.parse(str) : {}; }
			obj.thumb = opts.manualthumb.v;
		}

		// We only parse the str -> obj if we had to update it.
		container.addAttribute("data-mw", obj ? JSON.stringify(obj) : str);

		tokens.push(containerClose);
		cb({ tokens: tokens });
	};

	if (dataAttribs.uneditable) {
		// Don't bother setting up data-mw unless we added error info
		// SSS FIXME: Is this even useful since the image has been marked unneditable?
		setupDataMW(dataMWObj, null);
	} else if (optSources) {
		cb({ async: true });
		var inVals = optSources.map(function(e) { return e[1]; });
		Util.expandValuesToDOM(manager.env, manager.frame, inVals, this.options.wrapTemplates, function(err, outVals) {
			if (!dataMWObj) {
				dataMWObj = dataMW ? JSON.parse(dataMW) : {};
			}

			if (!dataMWObj.attribs) {
				dataMWObj.attribs = [];
			}

			for (var i = 0; i < outVals.length; i++) {
				dataMWObj.attribs.push([optSources[i][0].optKey, outVals[i]]);
			}
			container.addAttribute("about", manager.env.newAboutId());
			container.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
			setupDataMW(dataMWObj);
		});
	} else {
		setupDataMW(dataMWObj, dataMW);
	}
};

/**
 * Render a file. This can be an image, a sound, a PDF etc.
 */
WikiLinkHandler.prototype.renderFile = function(token, frame, cb, target) {
	var fileName = target.href;
	var title = target.title;

	// First check if we have a cached copy of this image expansion, and
	// avoid any further processing if we have a cache hit.
	var env = this.manager.env;
	var cachedFile = env.fileCache[token.dataAttribs.src];
	if (cachedFile) {
		var wrapperTokens = DU.encapsulateExpansionHTML(env, token, cachedFile, {
			noAboutId: true,
			setDSR: true,
		});
		var firstWrapperToken = wrapperTokens[0];

		// Capture the delta between the old/new wikitext start posn.
		// 'tsr' values are stripped in the original DOM and won't be
		// present.  Since dsr[0] is identical to tsr[0] in this case,
		// dsr[0] is a safe substitute, if present.
		if (token.dataAttribs.tsr && firstWrapperToken.dataAttribs.dsr) {
			firstWrapperToken.dataAttribs.tsrDelta = token.dataAttribs.tsr[0] -
				firstWrapperToken.dataAttribs.dsr[0];
		}

		cb({ tokens: wrapperTokens });
		return;
	}

	// distinguish media types
	// if image: parse options
	var content = buildLinkAttrs(token.attribs, true, null, null).contentKVs;

	// extract options
	// option hash
	// keys normalized
	// values object
	// {
	//   v: normalized value (object with width / height for size)
	//   src: the original source
	// }
	//
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
		oText = Util.tokensToString(oContent.v, true);

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
				var pieces = oText.split("|").map(function(s) {
					return new KV("mw:maybeContent", s);
				});
				optKVs = pieces.concat(optKVs);

				// Record the fact that we won't provide editing support for this.
				token.dataAttribs.uneditable = true;
				continue;
			} else {
				optInfo = getOptionInfo(oText, env);
			}
		}

		// For the values of the caption and options, see
		// getOptionInfo's documentation above.
		//
		// If there are multiple captions, this code always
		// picks the last entry. This is the spec; see
		// "Image with multiple captions" parserTest.
		if (oText.constructor !== String || optInfo === null) {
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
				var maybeSize = optInfo.v.match(/^(\d*)(?:x(\d+))?\s*(?:px\s*)?$/);
				if (maybeSize !== null) {
					opts.size.v.width = maybeSize[1] && Number(maybeSize[1]) || null;
					opts.size.v.height = maybeSize[2] && Number(maybeSize[2]) || null;
					// Only round-trip a valid size
					opts.size.src = oContent.vsrc || optInfo.ak;
				}
			} else {
				if (optInfo.ck in opts) { continue; } // first option wins
				opts[optInfo.ck] = {
					v: optInfo.v,
					src: oContent.vsrc || optInfo.ak,
				};
			}
		}

		// Collect option in dataAttribs (becomes data-parsoid later on)
		// for faithful serialization.
		token.dataAttribs.optList.push(opt);

		// Collect source wikitext for image options for possible template expansion.
		// FIXME: Does VE need the wikitext version as well in a "txt" key?
		optSources.push([{"optKey": opt.ck }, {"html": origOptSrc}]);
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
			// Default to 220px thumb width as in WMF configuration
			var defaultWidth = 220;
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

	// reset title if this is a manual thumbnail
	if (opts.manualthumb) {
		title = Title.fromPrefixedText(env, opts.manualthumb.v);
		if (title.nskey === '') {
			// inherit namespace from main image
			title.ns = opts.title.v.ns;
			title.nskey = opts.title.v.nskey;
		}
	}

	if (!env.conf.parsoid.fetchImageInfo) {
		return this.handleImageInfo(cb, token, title, opts, optSources, 'Fetch of image info disabled.', undefined);
	}

	var cacheEntry = env.batcher.imageinfo(title.key, opts.size.v,
		this.handleImageInfo.bind(this, cb, token, title, opts, optSources));
	if (cacheEntry !== undefined) {
		this.handleImageInfo(cb, token, title, opts, optSources, null, cacheEntry);
	} else {
		cb({ async: true });
	}
};

function ExternalLinkHandler(manager, options) {
	this.options = options;
	this.manager = manager;
	this.manager.addTransform(this.onUrlLink.bind(this), "ExternalLinkHandler:onUrlLink", this.rank, 'tag', 'urllink');
	this.manager.addTransform(this.onExtLink.bind(this), "ExternalLinkHandler:onExtLink",
			this.rank - 0.001, 'tag', 'extlink');
	this.manager.addTransform(this.onEnd.bind(this), "ExternalLinkHandler:onEnd",
			this.rank, 'end');
	// create a new peg parser for image options..
	if (!this.urlParser) {
		// Actually the regular tokenizer, but we'll call it with the
		// url rule only.
		ExternalLinkHandler.prototype.urlParser = new PegTokenizer(this.manager.env);
	}
	this._reset();
}

ExternalLinkHandler.prototype._reset = function() {
	this.linkCount = 1;
};

ExternalLinkHandler.prototype.rank = 1.15;

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
		this._imageExtensions.hasOwnProperty(bits[bits.length - 1]) &&
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
	var href = Util.tokensToString(Util.lookup(token.attribs, 'href'));
	var txt = href;

	if (SanitizerConstants.IDN_RE.test(txt)) {
		// Make sure there are no IDN-ignored characters in the text so the
		// user doesn't accidentally copy any.
		txt = Sanitizer._stripIDNs(txt);
	}

	var dataAttribs = Util.clone(token.dataAttribs);
	if (this._hasImageLink(href)) {
		tagAttrs = [
			new KV('src', href),
			new KV('alt', href.split('/').last()),
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
			builtTag.addNormalizedAttribute('href', txt, token.getWTSource(env));
		} else {
			builtTag.addAttribute('href', txt);
		}

		cb({
			tokens: [
				builtTag,
				txt,
				new EndTagTk('a', [], { tsr: [dataAttribs.tsr[1], dataAttribs.tsr[1]] }),
			],
		});
	}
};

// Bracketed external link
ExternalLinkHandler.prototype.onExtLink = function(token, manager, cb) {
	var newAttrs, aStart, title;
	var env = this.manager.env;
	var origHref = Util.lookup(token.attribs, 'href');
	var href = Util.tokensToString(origHref);
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
		aStart = new TagTk ('a', newAttrs, dataAttribs);
		cb({
			tokens: [aStart].concat(content, [new EndTagTk('a')]),
		});
	} else if (this.urlParser.tokenizeURL(href)) {
		rdfaType = 'mw:ExtLink';
		if (content.length === 1 &&
				content[0].constructor === String &&
				this.urlParser.tokenizeURL(content[0]) &&
				this._hasImageLink(content[0])) {
			var src = content[0];
			content = [
				new SelfclosingTagTk('img', [
					new KV('src', src),
					new KV('alt', src.split('/').last()),
				], { type: 'extlink' }),
			];
		}

		newAttrs = [
			new KV('rel', rdfaType),
			// href is set explicitly below
		];
		// combine with existing rdfa attrs
		newAttrs = buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
		aStart = new TagTk ('a', newAttrs, dataAttribs);

		if (SanitizerConstants.IDN_RE.test(href)) {
			// Make sure there are no IDN-ignored characters in the text so the
			// user doesn't accidentally copy any.
			href = Sanitizer._stripIDNs(href);
		}

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

		content = Util.getDOMFragmentToken(content, dataAttribs.tsr ? dataAttribs.contentOffsets : null, {noPWrapping: true, noPre: true, token: token});

		cb({
			tokens: [aStart].concat(content, [new EndTagTk('a')]),
		});
	} else {
		// Not a link, convert href to plain text.
		var tokens = ['['];
		var closingTok = null;
		var spaces = token.getAttribute('spaces') || '';

		if ((token.getAttribute("typeof") || "").match(/mw:ExpandedAttrs/)) {
			// The token 'non-url' came from a template.
			// Introduce a span and capture the original source for RT purposes.
			var da = token.dataAttribs;
			// targetOff covers all spaces before content
			// and we need src without those spaces.
			var tsr0b = da.tsr[0] + 1;
			var tsr1b = da.targetOff - spaces.length;
			var span = new TagTk('span', [new KV('typeof', 'mw:Placeholder')], {
				tsr: [tsr0b, tsr1b],
				src: env.page.src.substring(tsr0b, tsr1b),
			});
			tokens.push(span);
			closingTok = new EndTagTk('span');
		}

		var hrefText = token.getAttribute("href");
		if (Array.isArray(hrefText)) {
			tokens = tokens.concat(hrefText);
		} else {
			tokens.push(hrefText);
		}

		if (closingTok) {
			tokens.push(closingTok);
		}

		// FIXME: Use this attribute in regular extline
		// cases to rt spaces correctly maybe?  Unsure
		// it is worth it.
		if (spaces) {
			tokens.push(spaces);
		}

		if (content.length) {
			tokens = tokens.concat(content);
		}

		tokens.push(']');

		cb({ tokens: tokens });
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
