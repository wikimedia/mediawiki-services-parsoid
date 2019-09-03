/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 * @module
 */

'use strict';

const { PegTokenizer } = require('../tokenizer.js');
const { WikitextConstants } = require('../../config/WikitextConstants.js');
const { Sanitizer } = require('./Sanitizer.js');
const { ContentUtils } = require('../../utils/ContentUtils.js');
const { PipelineUtils } = require('../../utils/PipelineUtils.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');
const { Util } = require('../../utils/Util.js');
const { DOMUtils } = require('../../utils/DOMUtils.js');
const TokenHandler = require('./TokenHandler.js');
const Promise = require('../../utils/promise.js');
const { KV, EOFTk, TagTk, SelfclosingTagTk, EndTagTk, Token } = require('../../tokens/TokenTypes.js');
const { AddMediaInfo } = require('../pp/processors/AddMediaInfo');
const tu = require('../tokenizer.utils.js');

// shortcuts

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class WikiLinkHandler extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		// Handle redirects first (since they used to emit additional link tokens)
		this.manager.addTransformP(this, this.onRedirect,
			'WikiLinkHandler:onRedirect', WikiLinkHandler.rank(), 'tag', 'mw:redirect');

		// Now handle regular wikilinks.
		this.manager.addTransformP(this, this.onWikiLink,
			'WikiLinkHandler:onWikiLink', WikiLinkHandler.rank() + 0.001, 'tag', 'wikilink');

		// Create a new peg parser for image options.
		if (!this.urlParser) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			WikiLinkHandler.prototype.urlParser = new PegTokenizer(this.env);
		}
	}

	static rank() { return 1.15; /* after AttributeExpander */ }

	static _hrefParts(str) {
		const m = str.match(/^([^:]+):(.*)$/);
		return m && { prefix: m[1], title: m[2] };
	}

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
	getWikiLinkTargetInfo(token, href, hrefSrc) {
		const env = this.manager.env;
		let info = { href, hrefSrc };

		if (/^:/.test(info.href)) {
			info.fromColonEscapedText = true;
			// remove the colon escape
			info.href = info.href.substr(1);
		}
		if (/^:/.test(info.href)) {
			if (env.conf.parsoid.linting) {
				const lint = {
					dsr: token.dataAttribs.tsr,
					params: { href: ':' + info.href },
					templateInfo: undefined,
				};
				if (this.options.inTemplate) {
					// Match Linter.findEnclosingTemplateName(), by first
					// converting the title to an href using env.makeLink
					const name = env.makeLink(this.manager.frame.title)
						.replace(/^\.\//, '');
					lint.templateInfo = { name: name };
					// TODO(arlolra): Pass tsr info to the frame
					lint.dsr = [0, 0];
				}
				env.log('lint/multi-colon-escape', lint);
			}
			// This will get caught by the caller, and mark the target as invalid
			throw new Error('Multiple colons prefixing href.');
		}

		const title = env.resolveTitle(Util.decodeURIComponent(info.href));
		const hrefBits = WikiLinkHandler._hrefParts(info.href);
		if (hrefBits) {
			const nsPrefix = hrefBits.prefix;
			info.prefix = nsPrefix;
			const nnn = Util.normalizeNamespaceName(nsPrefix.trim());
			const interwikiInfo = env.conf.wiki.interwikiMap.get(nnn);
			// check for interwiki / language links
			const ns = env.conf.wiki.namespaceIds.get(nnn);
			// also check for url to protect against [[constructor:foo]]
			if (ns !== undefined) {
				info.title = env.makeTitleFromURLDecodedStr(title);
			} else if (interwikiInfo && interwikiInfo.localinterwiki !== undefined) {
				if (hrefBits.title === '') {
					// Empty title => main page (T66167)
					info.title = env.makeTitleFromURLDecodedStr(env.conf.wiki.mainpage);
				} else {
					info.href = (/:/.test(hrefBits.title) ? ':' : '') + hrefBits.title;
					// Recurse!
					info = this.getWikiLinkTargetInfo(token, info.href, info.hrefSrc);
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
	}

	/**
	 * Handle mw:redirect tokens.
	 */
	*onRedirectG(token) {
		// Avoid duplicating the link-processing code by invoking the
		// standard onWikiLink handler on the embedded link, intercepting
		// the generated tokens using the callback mechanism, reading
		// the href from the result, and then creating a
		// <link rel="mw:PageProp/redirect"> token from it.

		const rlink = new SelfclosingTagTk('link', Util.clone(token.attribs), Util.clone(token.dataAttribs));
		const wikiLinkTk = rlink.dataAttribs.linkTk;
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
		const r = yield this.onWikiLink(wikiLinkTk);
		const isValid = r && r.tokens && r.tokens[0] &&
			/^(a|link)$/.test(r.tokens[0].name);
		if (isValid) {
			const da = r.tokens[0].dataAttribs;
			rlink.addNormalizedAttribute('href', da.a.href, da.sa.href);
			return { tokens: [rlink] };
		} else {
			// Bail!  Emit tokens as if they were parsed as a list item:
			//  #REDIRECT....
			const src = rlink.dataAttribs.src;
			const tsr = rlink.dataAttribs.tsr;
			const srcMatch = /^([^#]*)(#)/.exec(src);
			const ntokens = srcMatch[1].length ? [ srcMatch[1] ] : [];
			const hashPos = tsr[0] + srcMatch[1].length;
			const tsr0 = [hashPos, hashPos + 1];
			const li = new TagTk('listItem', [new KV('bullets', ['#'], tu.expandTsrV(tsr0))], { tsr: tsr0 });
			ntokens.push(li);
			ntokens.push(src.slice(srcMatch[0].length));
			return { tokens: ntokens.concat(r.tokens) };
		}
	}

	static bailTokens(env, token, isExtLink) {
		const count = isExtLink ? 1 : 2;
		let tokens = ["[".repeat(count)];
		let content = [];

		if (isExtLink) {
			// FIXME: Use this attribute in regular extline
			// cases to rt spaces correctly maybe?  Unsure
			// it is worth it.
			const spaces = token.getAttribute('spaces') || '';
			if (spaces.length) { content.push(spaces); }

			const mwc = token.getAttribute('mw:content');
			if (mwc.length) { content = content.concat(mwc); }
		} else {
			token.attribs.forEach((a) => {
				if (a.k === "mw:maybeContent") {
					content = content.concat("|", a.v);
				}
			});
		}

		let dft;
		if (/mw:ExpandedAttrs/.test(token.getAttribute("typeof"))) {
			const dataMW = JSON.parse(token.getAttribute("data-mw")).attribs;
			let html;
			for (let i = 0; i < dataMW.length; i++) {
				if (dataMW[i][0].txt === "href") {
					html = dataMW[i][1].html;
					break;
				}
			}

			// Since we are splicing off '['s and ']'s from the incoming token,
			// adjust TSR of the DOM-fragment by `count` each on both end.
			let tsr = token.dataAttribs && token.dataAttribs.tsr;
			if (tsr && typeof (tsr[0]) === 'number' && typeof (tsr[1]) === 'number') {
				// If content is present, the fragment we're building doesn't
				// extend all the way to the end of the token, so the end tsr
				// is invalid.
				const end = content.length > 0 ? null : tsr[1] - count;
				tsr = [tsr[0] + count, end];
			} else {
				tsr = null;
			}

			const body = ContentUtils.ppToDOM(env, html);
			dft = PipelineUtils.tunnelDOMThroughTokens(env, token, body, {
				tsr: tsr,
				pipelineOpts: { inlineContext: true },
			});
		} else {
			dft = token.getAttribute("href");
		}

		tokens = tokens.concat(dft, content, "]".repeat(count));
		return tokens;
	}

	/**
	 * Handle a mw:WikiLink token.
	 */
	*onWikiLinkG(token) {
		const env = this.manager.env;
		const hrefKV = token.getAttributeKV('href');
		const hrefTokenStr = TokenUtils.tokensToString(hrefKV.v);

		// Don't allow internal links to pages containing PROTO:
		// See Parser::replaceInternalLinks2()
		if (env.conf.wiki.hasValidProtocol(hrefTokenStr)) {
			// NOTE: Tokenizing this as src seems little suspect
			const src = '[' + token.attribs.slice(1).reduce((prev, next) => {
				return prev + '|' + TokenUtils.tokensToString(next.v);
			}, hrefTokenStr) + ']';

			let extToks = this.urlParser.tokenizeExtlink(src, /* sol */true);
			if (!(extToks instanceof Error)) {
				const tsr = token.dataAttribs && token.dataAttribs.tsr;
				TokenUtils.shiftTokenTSR(extToks, 1 + (tsr ? tsr[0] : 0));
			} else {
				extToks = src;
			}

			const tokens = ['['].concat(extToks, ']');
			tokens.rank = WikiLinkHandler.rank() - 0.002;  // Magic rank, since extlink is -0.001
			return { tokens: tokens };
		}

		if (Array.isArray(hrefKV.v) && hrefKV.v.some((t) => {
			if (t instanceof Token &&
					TokenUtils.isDOMFragmentType(t.getAttribute('typeof'))) {
				const firstNode = env.fragmentMap.get(t.dataAttribs.html)[0];
				return DOMUtils.matchTypeOf(firstNode, /^mw:(Nowiki|Extension)/) !== null;
			}
			return false;
		})) {
			return { tokens: WikiLinkHandler.bailTokens(env, token, false) };
		}

		// First check if the expanded href contains a pipe.
		if (/[|]/.test(hrefTokenStr)) {
			// It does. This 'href' was templated and also returned other
			// parameters separated by a pipe. We don't have any sane way to
			// handle such a construct currently, so prevent people from editing
			// it.  See T226523
			// TODO: add useful debugging info for editors ('if you would like to
			// make this content editable, then fix template X..')
			// TODO: also check other parameters for pipes!
			return { tokens: WikiLinkHandler.bailTokens(env, token, false) };
		}

		let target;
		try {
			target = this.getWikiLinkTargetInfo(token, hrefTokenStr, hrefKV.vsrc);
		} catch (e) {
			// Invalid title
			return { tokens: WikiLinkHandler.bailTokens(env, token, false) };
		}

		// Ok, it looks like we have a sane href. Figure out which handler to use.
		const isRedirect = !!token.getAttribute('redirect');
		return (yield this._wikiLinkHandler(token, target, isRedirect));
	}

	/**
	 * Figure out which handler to use to render a given WikiLink token. Override
	 * this method to add new handlers or swap out existing handlers based on the
	 * target structure.
	 */
	_wikiLinkHandler(token, target, isRedirect) {
		const title = target.title;
		if (title) {
			if (isRedirect) {
				return this.renderWikiLink(token, target);
			}
			if (title.getNamespace().isMedia()) {
				// Render as a media link.
				return this.renderMedia(token, target);
			}
			if (!target.fromColonEscapedText) {
				if (title.getNamespace().isFile()) {
					// Render as a file.
					return this.renderFile(token, target);
				}
				if (title.getNamespace().isCategory()) {
					// Render as a category membership.
					return this.renderCategory(token, target);
				}
			}
			// Render as plain wiki links.
			return this.renderWikiLink(token, target);
		}

		// language and interwiki links
		if (target.interwiki) {
			return this.renderInterwikiLink(token, target);
		}
		if (target.language) {
			const noLanguageLinks = this.env.page.title.getNamespace().isATalkNamespace() ||
				!this.env.conf.wiki.interwikimagic;
			if (noLanguageLinks) {
				target.interwiki = target.language;
				return this.renderInterwikiLink(token, target);
			}

			return this.renderLanguageLink(token, target);
		}

		// Neither a title, nor a language or interwiki. Should not happen.
		throw new Error("Unknown link type");
	}

	/* ------------------------------------------------------------
	* This (overloaded) function does three different things:
	* - Extracts link text from attrs (when k === "mw:maybeContent").
	*   As a performance micro-opt, only does if asked to (getLinkText)
	* - Updates existing rdfa type with an additional rdf-type,
	*   if one is provided (rdfaType)
	* - Collates about, typeof, and linkAttrs into a new attr. array
	* ------------------------------------------------------------ */
	static buildLinkAttrs(attrs, getLinkText, rdfaType, linkAttrs) {
		let newAttrs = [];
		const linkTextKVs = [];
		let about;

		// In one pass through the attribute array, fetch about, typeof, and linkText
		//
		// about && typeof are usually at the end of the array if at all present
		for (let i = 0, l = attrs.length; i < l; i++) {
			const kv = attrs[i];
			const k  = kv.k;
			const v  = kv.v;

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
	addLinkAttributesAndGetContent(newTk, token, target, buildDOMFragment) {
		const attribs = token.attribs;
		const dataAttribs = token.dataAttribs;
		const newAttrData = WikiLinkHandler.buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]);
		let content = newAttrData.contentKVs;
		const env = this.manager.env;

		// Set attribs and dataAttribs
		newTk.attribs = newAttrData.attribs;
		newTk.dataAttribs = Util.clone(dataAttribs);
		newTk.dataAttribs.src = undefined; // clear src string since we can serialize this

		// Note: Link tails are handled on the DOM in handleLinkNeighbours, so no
		// need to handle them here.
		if (content.length > 0) {
			newTk.dataAttribs.stx = 'piped';
			let out = [];
			const l = content.length;
			// re-join content bits
			for (let i = 0; i < l; i++) {
				let toks = content[i].v;
				// since this is already a link, strip autolinks from content
				if (!Array.isArray(toks)) { toks = [ toks ]; }
				toks = toks.filter(t => t !== '');
				toks = toks.map((t, j) => {
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
				toks = toks.filter(t => t !== '');
				out = out.concat(toks);
				if (i < l - 1) {
					out.push('|');
				}
			}

			if (buildDOMFragment) {
				// content = [part 0, .. part l-1]
				// offsets = [start(part-0), end(part l-1)]
				const offsets = dataAttribs.tsr ? [content[0].srcOffsets[0], content[l - 1].srcOffsets[1]] : null;
				content = [ PipelineUtils.getDOMFragmentToken(out, offsets, { inlineContext: true, token: token }) ];
			} else {
				content = out;
			}
		} else {
			newTk.dataAttribs.stx = 'simple';
			let morecontent = Util.decodeURIComponent(target.href);

			// Strip leading colon
			morecontent = morecontent.replace(/^:/, '');

			// Try to match labeling in core
			if (env.conf.wiki.namespacesWithSubpages[env.page.ns]) {
				// subpage links with a trailing slash get the trailing slashes stripped.
				// See https://gerrit.wikimedia.org/r/173431
				const match = morecontent.match(/^((\.\.\/)+|\/)(?!\.\.\/)(.*?[^\/])\/+$/);
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
	}

	/**
	 * Render a plain wiki link.
	 */
	*renderWikiLinkG(token, target) { // eslint-disable-line require-yield
		const newTk = new TagTk('a');
		const content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

		newTk.addNormalizedAttribute('href', this.env.makeLink(target.title), target.hrefSrc);

		// Add title unless it's just a fragment
		if (target.href[0] !== '#') {
			newTk.setAttribute('title', target.title.getPrefixedText());
		}

		return { tokens: [newTk].concat(content, [new EndTagTk('a')]) };
	}

	/**
	 * Render a category 'link'. Categories are really page properties, and are
	 * normally rendered in a box at the bottom of an article.
	 */
	*renderCategoryG(token, target) {
		const newTk = new SelfclosingTagTk('link');
		const content = this.addLinkAttributesAndGetContent(newTk, token, target);
		const env = this.manager.env;

		// Change the rel to be mw:PageProp/Category
		newTk.getAttributeKV('rel').v = 'mw:PageProp/Category';

		const strContent = TokenUtils.tokensToString(content);
		const saniContent = Sanitizer.sanitizeTitleURI(strContent, false).replace(/#/g, '%23');
		newTk.addNormalizedAttribute('href', env.makeLink(target.title), target.hrefSrc);
		// Change the href to include the sort key, if any (but don't update the rt info)
		if (strContent && strContent !== '' && strContent !== target.href) {
			const hrefkv = newTk.getAttributeKV('href');
			hrefkv.v += '#';
			hrefkv.v += saniContent;
		}

		if (content.length !== 1) {
			// Deal with sort keys that come from generated content (transclusions, etc.)
			const key = { "txt": "mw:sortKey" };
			const contentKV = token.getAttributeKV('mw:maybeContent');
			const so = (contentKV && contentKV.srcOffsets) ?
				contentKV.srcOffsets.slice(2, 4) : undefined;
			const val = yield PipelineUtils.expandValueToDOM(
				this.manager.env,
				this.manager.frame,
				{ "html": content, srcOffsets: so },
				this.options.expandTemplates,
				this.options.inTemplate
			);
			const attr = [key, val];
			let dataMW = newTk.getAttribute("data-mw");
			if (dataMW) {
				dataMW = JSON.parse(dataMW);
				dataMW.attribs.push(attr);
			} else {
				dataMW = { attribs: [attr] };
			}

			// Mark token as having expanded attrs
			newTk.addAttribute("about", env.newAboutId());
			newTk.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
			newTk.addAttribute("data-mw", JSON.stringify(dataMW));
		}

		return { tokens: [ newTk ] };
	}

	/**
	 * Render a language link. Those normally appear in the list of alternate
	 * languages for an article in the sidebar, so are really a page property.
	 */
	*renderLanguageLinkG(token, target) { // eslint-disable-line require-yield
		// The prefix is listed in the interwiki map

		const newTk = new SelfclosingTagTk('link', [], token.dataAttribs);
		this.addLinkAttributesAndGetContent(newTk, token, target);

		// add title attribute giving the presentation name of the
		// "extra language link"
		if (target.language.extralanglink !== undefined &&
			target.language.linktext) {
			newTk.addNormalizedAttribute('title', target.language.linktext);
		}

		// We set an absolute link to the article in the other wiki/language
		const title = Sanitizer.sanitizeTitleURI(Util.decodeURIComponent(target.href), false);
		let absHref = target.language.url.replace("$1", title);
		if (target.language.protorel !== undefined) {
			absHref = absHref.replace(/^https?:/, '');
		}
		newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

		// Change the rel to be mw:PageProp/Language
		newTk.getAttributeKV('rel').v = 'mw:PageProp/Language';

		return { tokens: [newTk] };
	}

	/**
	 * Render an interwiki link.
	 */
	*renderInterwikiLinkG(token, target) { // eslint-disable-line require-yield
		// The prefix is listed in the interwiki map

		let tokens = [];
		const newTk = new TagTk('a', [], token.dataAttribs);
		const content = this.addLinkAttributesAndGetContent(newTk, token, target, true);

		// We set an absolute link to the article in the other wiki/language
		const isLocal = target.interwiki.hasOwnProperty('local');
		const title = Sanitizer.sanitizeTitleURI(Util.decodeURIComponent(target.href), !isLocal);
		let absHref = target.interwiki.url.replace("$1", title);
		if (target.interwiki.protorel !== undefined) {
			absHref = absHref.replace(/^https?:/, '');
		}
		newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

		// Change the rel to be mw:ExtLink
		newTk.getAttributeKV('rel').v = 'mw:WikiLink/Interwiki';
		// Remember that this was using wikitext syntax though
		newTk.dataAttribs.isIW = true;
		// Add title unless it's just a fragment (and trim off fragment)
		// (The normalization here is similar to what Title#getPrefixedDBKey() does.)
		if (target.href === '' || target.href[0] !== "#") {
			const titleAttr = target.interwiki.prefix + ':' +
				Util.decodeURIComponent(target.href.replace(/#[\s\S]*/, '').replace(/_/g, ' '));
			newTk.setAttribute("title", titleAttr);
		}
		tokens.push(newTk);

		tokens = tokens.concat(content, [new EndTagTk('a')]);
		return { tokens: tokens };
	}

	/**
	 * Get the style and class lists for an image's wrapper element.
	 *
	 * @private
	 * @param {Object} opts The option hash from renderFile.
	 * @return {Object}
	 * @return {boolean} return.isInline Whether the image is inline after handling options.
	 * @return {Array} return.classes The list of classes for the wrapper.
	 */
	static getWrapperInfo(opts) {
		const format = WikiLinkHandler.getFormat(opts);
		let isInline = !(format === 'thumbnail' || format === 'framed');
		const classes = [];
		let halign = (opts.format && opts.format.v === 'framed') ? 'right' : null;

		if (!opts.size.src) {
			classes.push('mw-default-size');
		}

		if (opts.border) {
			classes.push('mw-image-border');
		}

		if (opts.halign) {
			halign = opts.halign.v;
		}

		const halignOpt = opts.halign && opts.halign.v;
		switch (halign) {
			case 'none':
				// PHP parser wraps in <div class="floatnone">
				isInline = false;
				if (halignOpt === 'none') {
					classes.push('mw-halign-none');
				}
				break;

			case 'center':
				// PHP parser wraps in <div class="center"><div class="floatnone">
				isInline = false;
				if (halignOpt === 'center') {
					classes.push('mw-halign-center');
				}
				break;

			case 'left':
				// PHP parser wraps in <div class="floatleft">
				isInline = false;
				if (halignOpt === 'left') {
					classes.push('mw-halign-left');
				}
				break;

			case 'right':
				// PHP parser wraps in <div class="floatright">
				isInline = false;
				if (halignOpt === 'right') {
					classes.push('mw-halign-right');
				}
				break;
		}

		if (isInline) {
			const valignOpt = opts.valign && opts.valign.v;
			switch (valignOpt) {
				case 'middle':
					classes.push('mw-valign-middle');
					break;

				case 'baseline':
					classes.push('mw-valign-baseline');
					break;

				case 'sub':
					classes.push('mw-valign-sub');
					break;

				case 'super':
					classes.push('mw-valign-super');
					break;

				case 'top':
					classes.push('mw-valign-top');
					break;

				case 'text_top':
					classes.push('mw-valign-text-top');
					break;

				case 'bottom':
					classes.push('mw-valign-bottom');
					break;

				case 'text_bottom':
					classes.push('mw-valign-text-bottom');
					break;
			}
		}

		return { classes, isInline };
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
	 */
	static getOptionInfo(optStr, env) {
		const oText = optStr.trim();
		const getOption = env.conf.wiki.getParameterizedAliasMatcher(
			WikitextConstants.Media.PrefixOptions);
		// oText contains the localized name of this option.  the
		// canonical option names (from mediawiki upstream) are in
		// English and contain an '(img|timedmedia)_' prefix.  We drop the
		// prefix before stuffing them in data-parsoid in order to
		// save space (that's shortCanonicalOption)
		const canonicalOption = env.conf.wiki.magicWordCanonicalName(oText) || '';
		let shortCanonicalOption = canonicalOption.replace(/^(img|timedmedia)_/,  '');
		// 'imgOption' is the key we'd put in opts; it names the 'group'
		// for the option, and doesn't have an img_ prefix.
		const imgOption = WikitextConstants.Media.SimpleOptions.get(canonicalOption);
		const bits = getOption(oText);
		const normalizedBit0 = bits ? bits.k.trim().toLowerCase() : null;
		const key = bits ? WikitextConstants.Media.PrefixOptions.get(normalizedBit0) : null;

		if (imgOption && key === null) {
			return {
				ck: imgOption,
				v: shortCanonicalOption,
				ak: optStr,
				s: true,
			};
		}

		// bits.a has the localized name for the prefix option
		// (with $1 as a placeholder for the value, which is in bits.v)
		// 'normalizedBit0' is the canonical English option name
		// (from mediawiki upstream) with a prefix.
		// 'key' is the parsoid 'group' for the option; it doesn't
		// have a prefix (it's the key we'd put in opts)
		if (bits && key) {
			shortCanonicalOption = normalizedBit0.replace(/^(img|timedmedia)_/,  '');
			// map short canonical name to the localized version used

			// Note that we deliberately do entity decoding
			// *after* splitting so that HTML-encoded pipes don't
			// separate options.  This matches PHP, whether or
			// not it's a good idea.
			return {
				ck: shortCanonicalOption,
				v: Util.decodeWtEntities(bits.v),
				ak: optStr,
				s: false,
			};
		}

		return null;
	}

	/**
	 * Make option token streams into a stringy thing that we can recognize.
	 *
	 * @param {Array} tstream
	 * @param {string} prefix Anything that came before this part of the recursive call stack.
	 * @return {string|null}
	 */
	static stringifyOptionTokens(tstream, prefix, env) {
		// Seems like this should be a more general "stripTags"-like function?
		let tokenType, tkHref, nextResult, optInfo, skipToEndOf;
		let resultStr = '';
		const cachedOptInfo = () => {
			if (optInfo === undefined) {
				optInfo = WikiLinkHandler.getOptionInfo(prefix + resultStr, env);
			}
			return optInfo;
		};
		const isWhitelistedOpt = () => {
			// link and alt options are whitelisted for accepting arbitrary
			// wikitext (even though only strings are supported in reality)
			// SSS FIXME: Is this actually true of all options rather than
			// just link and alt?
			return cachedOptInfo() && /^(link|alt)$/.test(cachedOptInfo().ck);
		};

		for (let i = 0; i < tstream.length; i++) {
			const currentToken = tstream[i];

			if (skipToEndOf) {
				if (currentToken.name === skipToEndOf && currentToken.constructor === EndTagTk) {
					skipToEndOf = undefined;
				}
				continue;
			}

			if (currentToken.constructor === String) {
				resultStr += currentToken;
			} else if (Array.isArray(currentToken)) {
				nextResult = WikiLinkHandler.stringifyOptionTokens(currentToken, prefix + resultStr, env);

				if (nextResult === null) {
					return null;
				}

				resultStr += nextResult;
			} else if (currentToken.constructor !== EndTagTk) {
				// This is actually a token
				if (TokenUtils.isDOMFragmentType(currentToken.getAttribute('typeof'))) {
					if (isWhitelistedOpt()) {
						const str = TokenUtils.tokensToString([currentToken], false, {
							unpackDOMFragments: true,
							env,  // FIXME: Sneaking in `env` to avoid changing the signature
						});
						// Entity encode pipes since we wouldn't have split on
						// them from fragments and we're about to attempt to
						// when this function returns.
						// This is similar to getting the shadow "href" below.
						resultStr += str.replace(/\|/, '&vert;');
						optInfo = undefined; // might change the nature of opt
						continue;
					} else {
						// if this is a nowiki, we must be in a caption
						return null;
					}
				}
				if (currentToken.name === 'mw-quote') {
					if (isWhitelistedOpt()) {
						// just recurse inside
						optInfo = undefined; // might change the nature of opt
						continue;
					}
				}
				// Similar to TokenUtils.tokensToString()'s includeEntities
				if (TokenUtils.isEntitySpanToken(currentToken)) {
					resultStr += currentToken.dataAttribs.src;
					skipToEndOf = 'span';
					continue;
				}
				if (currentToken.name === 'a') {
					if (optInfo === undefined) {
						optInfo = WikiLinkHandler.getOptionInfo(prefix + resultStr, env);
						if (optInfo === null) {
							// An <a> tag before a valid option?
							// This is most likely a caption.
							optInfo = undefined;
							return null;
						}
					}

					if (isWhitelistedOpt()) {
						tokenType = currentToken.getAttribute('rel');
						// Using the shadow since entities (think pipes) would
						// have already been decoded.
						tkHref = currentToken.getAttributeShadowInfo('href').value;
						const isLink = (optInfo.ck === 'link');
						// Reset the optInfo since we're changing the nature of it
						optInfo = undefined;
						// Figure out the proper string to put here and break.
						if (
							tokenType === 'mw:ExtLink' &&
								currentToken.dataAttribs.stx === 'url'
						) {
							// Add the URL
							resultStr += tkHref;
							// Tell our loop to skip to the end of this tag
							skipToEndOf = 'a';
						} else if (tokenType === 'mw:WikiLink/Interwiki') {
							if (isLink) {
								resultStr += currentToken.getAttribute('href');
								i += 2;
								continue;
							}
							// Nothing to do -- the link content will be
							// captured by walking the rest of the tokens.
						} else if (tokenType === 'mw:WikiLink' || tokenType === 'mw:MediaLink') {
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

	/**
	 * Get the format for media.
	 *
	 * @param {Object} opts
	 * @return {string}
	 */
	static getFormat(opts) {
		if (opts.manualthumb) {
			return "thumbnail";
		}
		return opts.format && opts.format.v;
	}

	/**
	 * This is the set of file options that apply to the container, rather
	 * than the media element itself (or, apply generically to a span).
	 * Other options depend on the fetched media type and won't necessary be
	 * applied.
	 *
	 * @return {Set}
	 */
	static getUsed() {
		if (this.used) { return this.used; }
		this.used = new Set([
			'lang', 'width', 'class', 'upright',
			'border', 'frameless', 'framed', 'thumbnail',
			'left', 'right', 'center', 'none',
			'baseline', 'sub', 'super', 'top', 'text_top', 'middle', 'bottom', 'text_bottom',
		]);
		return this.used;
	}

	/**
	 * Render a file. This can be an image, a sound, a PDF etc.
	 */
	*renderFileG(token, target) {
		const manager = this.manager;
		const env = manager.env;

		// FIXME: Re-enable use of media cache and figure out how that fits
		// into this new processing model. See T98995
		// const cachedMedia = env.mediaCache[token.dataAttribs.src];

		const dataAttribs = Util.clone(token.dataAttribs);
		dataAttribs.optList = [];

		// Account for the possibility of an expanded target
		const dataMwAttr = token.getAttribute('data-mw');
		const dataMw = dataMwAttr ? JSON.parse(dataMwAttr) : {};

		const opts = {
			title: {
				v: env.makeLink(target.title),
				src: token.getAttributeKV('href').vsrc,
			},
			size: {
				v: {
					height: null,
					width: null,
				},
			},
		};

		let hasExpandableOpt = false;
		const hasTransclusion = function(toks) {
			return Array.isArray(toks) && toks.find(function(t) {
				return t.constructor === SelfclosingTagTk &&
					t.getAttribute("typeof") === "mw:Transclusion";
			}) !== undefined;
		};

		let optKVs = WikiLinkHandler.buildLinkAttrs(token.attribs, true, null, null).contentKVs;
		while (optKVs.length > 0) {
			const oContent = optKVs.shift();
			console.assert(oContent instanceof KV);

			let origOptSrc = oContent.v;
			if (Array.isArray(origOptSrc) && origOptSrc.length === 1) {
				origOptSrc = origOptSrc[0];
			}

			let oText = TokenUtils.tokensToString(origOptSrc, true, { includeEntities: true });

			if (oText.constructor !== String) {
				// Might be that this is a valid option whose value is just
				// complicated. Try to figure it out, step through all tokens.
				const maybeOText = WikiLinkHandler.stringifyOptionTokens(oText, '', env);
				if (maybeOText !== null) {
					oText = maybeOText;
				}
			}

			let optInfo;
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
					const pieces = oText.split("|").map(function(s) {
						return new KV("mw:maybeContent", s);
					});
					optKVs = pieces.concat(optKVs);

					// Record the fact that we won't provide editing support for this.
					dataAttribs.uneditable = true;
					continue;
				} else {
					// We're being overly accepting of media options at this point,
					// since we don't know the type yet.  After the info request,
					// we'll filter out those that aren't appropriate.
					optInfo = WikiLinkHandler.getOptionInfo(oText, env);
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
				const optsCaption = {
					v: oContent.v,
					src: oContent.vsrc || oText,
					srcOffsets: oContent.srcOffsets ?
						oContent.srcOffsets.slice(2,4) : undefined,
					// remember the position
					pos: dataAttribs.optList.length,
				};
				// if there was a 'caption' previously, round-trip it as a
				// "bogus option".
				if (opts.caption) {
					dataAttribs.optList.splice(opts.caption.pos, 0, {
						ck: 'bogus',
						ak: opts.caption.src,
					});
					optsCaption.pos++;
				}
				opts.caption = optsCaption;
				continue;
			}

			if (optInfo.ck in opts) {
				// first option wins, the rest are 'bogus'
				dataAttribs.optList.push({
					ck: 'bogus',
					ak: optInfo.ak,
				});
				continue;
			}

			const opt = {
				ck: optInfo.v,
				ak: oContent.vsrc || optInfo.ak,
			};

			if (optInfo.s === true) {
				// Default: Simple image option
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
					const maybeDim = Util.parseMediaDimensions(optInfo.v);
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
					opts[optInfo.ck] = {
						v: optInfo.v,
						src: oContent.vsrc || optInfo.ak,
						srcOffsets: oContent.srcOffsets ?
							oContent.srcOffsets.slice(2, 4) : undefined,
					};
				}
			}

			// Collect option in dataAttribs (becomes data-parsoid later on)
			// for faithful serialization.
			dataAttribs.optList.push(opt);

			// Collect source wikitext for image options for possible template expansion.
			const maybeOpt = !WikiLinkHandler.getUsed().has(opt.ck);
			let expOpt;
			// Links more often than not show up as arrays here because they're
			// tokenized as `autourl`.  To avoid unnecessarily considering them
			// expanded, we'll use a more restrictive test, at the cost of
			// perhaps missing some edgy behaviour.
			if (opt.ck === 'link') {
				expOpt = hasTransclusion(origOptSrc);
			} else {
				expOpt = Array.isArray(origOptSrc);
			}
			if (maybeOpt || expOpt) {
				const val = {};
				if (expOpt) {
					hasExpandableOpt = true;
					val.html = origOptSrc;
					val.srcOffsets = oContent.srcOffsets ?
						oContent.srcOffsets.slice(2,4) : undefined;
					yield PipelineUtils.expandValueToDOM(
						env, manager.frame, val,
						this.options.expandTemplates,
						this.options.inTemplate
					);
				}

				// This is a bit of an abuse of the "txt" property since
				// `optInfo.v` isn't unnecessarily wikitext from source.
				// It's a result of the specialized stringifying above, which
				// if interpreted as wikitext upon serialization will result
				// in some (acceptable) normalization.
				//
				// We're storing these options in data-mw because they aren't
				// guaranteed to apply to all media types and we'd like to
				// avoid the need to back them out later.
				//
				// Note that the caption in the legacy parser depends on the
				// exact set of options parsed, which we aren't attempting to
				// try and replicate after fetching the media info, since we
				// consider that more of bug than a feature.  It prevent anyone
				// from ever safely adding media options in the future.
				//
				// See T163582
				if (maybeOpt) {
					val.txt = optInfo.v;
				}
				if (!Array.isArray(dataMw.attribs)) { dataMw.attribs = []; }
				dataMw.attribs.push([opt.ck, val]);
			}
		}

		// Add the last caption in the right position if there is one
		if (opts.caption) {
			dataAttribs.optList.splice(opts.caption.pos, 0, {
				ck: 'caption',
				ak: opts.caption.src,
			});
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
				let defaultWidth = env.conf.wiki.widthOption;
				if (opts.upright !== undefined) {
					// FIXME: If defined, but a NaN, should it be treated as a caption?
					if (!Number.isNaN(Number(opts.upright.v)) && opts.upright.v > 0) {
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

		// FIXME: Default type, since we don't have the info.  That right?
		let rdfaType = 'mw:Image';

		// If the format is something we *recognize*, add the subtype
		const format = WikiLinkHandler.getFormat(opts);
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
			rdfaType += ' mw:Placeholder';
		} else {
			dataAttribs.src = undefined;
		}

		const wrapperInfo = WikiLinkHandler.getWrapperInfo(opts);

		const { isInline } = wrapperInfo;
		const containerName = isInline ? 'figure-inline' : 'figure';

		let { classes } = wrapperInfo;
		if (opts.class) {
			classes = classes.concat(opts.class.v.split(' '));
		}

		const attribs = [ new KV('typeof', rdfaType) ];
		if (classes.length > 0) { attribs.unshift(new KV('class', classes.join(' '))); }

		const container = new TagTk(containerName, attribs, dataAttribs);
		const containerClose = new EndTagTk(containerName);

		if (hasExpandableOpt) {
			container.addAttribute("about", env.newAboutId());
			container.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
		} else if (/\bmw:ExpandedAttrs\b/.test(token.getAttribute('typeof'))) {
			container.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
		}

		const span = new TagTk('span', [], {});

		// "resource" and "lang" are whitelisted attributes on spans
		span.addNormalizedAttribute('resource', opts.title.v, opts.title.src);
		if ('lang' in opts) {
			span.addNormalizedAttribute('lang', opts.lang.v, opts.lang.src);
		}

		// Token's KV attributes only accept strings, Tokens or arrays of those.
		const size = opts.size.v;
		if (size.width !== null) {
			span.addAttribute('data-width', size.width.toString());
		}
		if (size.height !== null) {
			span.addAttribute('data-height', size.height.toString());
		}

		const anchor = new TagTk('a');
		const filePath = Sanitizer.sanitizeTitleURI(target.title.getKey(), false);
		anchor.setAttribute('href', `./Special:FilePath/${filePath}`);

		const tokens = [
			container,
			anchor,
			span,
			// FIXME: The php parser seems to put the link text here instead.
			// The title can go on the `anchor` as the "title" attribute.
			target.title.getPrefixedText(),
			new EndTagTk('span'),
			new EndTagTk('a'),
		];

		if (isInline) {
			if (opts.caption) {
				if (!Array.isArray(opts.caption.v)) {
					opts.caption.v = [ opts.caption.v ];
				}
				// Parse the caption asynchronously.
				const captionDOM = yield PipelineUtils.promiseToProcessContent(
					this.manager.env,
					this.manager.frame,
					opts.caption.v.concat([new EOFTk()]),
					{
						pipelineType: "tokens/x-mediawiki/expanded",
						pipelineOpts: {
							inlineContext: true,
							expandTemplates: this.options.expandTemplates,
							inTemplate: this.options.inTemplate,
						},
						srcOffsets: opts.caption.srcOffsets,
						sol: true,
					}
				);
				// Use parsed DOM given in `captionDOM`
				// FIXME: Does this belong in `dataMw.attribs`?
				dataMw.caption = ContentUtils.ppToXML(captionDOM.body, { innerXML: true });
			}
		} else {
			// We always add a figcaption for blocks
			const tsr = (opts.caption && opts.caption.srcOffsets) ?
				opts.caption.srcOffsets : undefined;
			tokens.push(new TagTk('figcaption', [], { tsr }));
			if (opts.caption) {
				if (typeof (opts.caption.v) === 'string') {
					tokens.push(opts.caption.v);
				} else {
					tokens.push(PipelineUtils.getDOMFragmentToken(
						opts.caption.v,
						tsr,
						{ inlineContext: true, token: token }
					));
				}
			}
			tokens.push(new EndTagTk('figcaption'));
		}

		if (Object.keys(dataMw).length) {
			container.addAttribute("data-mw", JSON.stringify(dataMw));
		}

		return { tokens: tokens.concat(containerClose) };
	}

	linkToMedia(token, target, errs, info) {
		// Only pass in the url, since media links should not link to the thumburl
		const imgHref = info.url.replace(/^https?:\/\//, '//');  // Copied from getPath
		const imgHrefFileName = imgHref.replace(/.*\//, '');

		const link = new TagTk('a', [], Util.clone(token.dataAttribs));
		link.addAttribute('rel', 'mw:MediaLink');
		link.addAttribute('href', imgHref);
		// html2wt will use the resource rather than try to parse the href.
		link.addNormalizedAttribute(
			'resource',
			this.env.makeLink(target.title),
			target.hrefSrc
		);
		// Normalize title according to how PHP parser does it currently
		link.setAttribute('title', imgHrefFileName.replace(/_/g, ' '));
		link.dataAttribs.src = undefined; // clear src string since we can serialize this

		const type = token.getAttribute('typeof');
		if (type) {
			link.addSpaceSeparatedAttribute('typeof', type);
		}

		if (errs.length > 0) {
			// Set RDFa type to mw:Error so VE and other clients
			// can use this to do client-specific action on these.
			link.addAttribute('typeof', 'mw:Error');

			// Update data-mw
			const dataMwAttr = token.getAttribute('data-mw');
			const dataMw = dataMwAttr ? JSON.parse(dataMwAttr) : {};
			if (Array.isArray(dataMw.errors)) {
				errs = dataMw.errors.concat(errs);
			}
			dataMw.errors = errs;
			link.addAttribute('data-mw', JSON.stringify(dataMw));
		}

		let content = TokenUtils.tokensToString(token.getAttribute('href')).replace(/^:/, '');
		content = token.getAttribute('mw:maybeContent') || [content];
		const tokens = [link].concat(content, [new EndTagTk('a')]);
		return { tokens: tokens };
	}

	// FIXME: The media request here is only used to determine if this is a
	// redlink and deserves to be handling in the redlink post-processing pass.
	*renderMediaG(token, target) {
		const env = this.manager.env;
		const title = target.title;
		const errs = [];
		const { err, info } = yield AddMediaInfo.requestInfo(env, title.getKey(), {
			height: null, width: null,
		});
		if (err) { errs.push(err); }
		return this.linkToMedia(token, target, errs, info);
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
[
	"onRedirect", "onWikiLink", "renderWikiLink", "renderCategory",
	"renderLanguageLink", "renderInterwikiLink",
	"handleInfo", "renderFile", "renderMedia"
].forEach(function(f) {
	WikiLinkHandler.prototype[f] = Promise.async(WikiLinkHandler.prototype[f + "G"]);
});

if (typeof module === "object") {
	module.exports.WikiLinkHandler = WikiLinkHandler;
}
