'use strict';

const { PegTokenizer } = require('../tokenizer.js');
const { Sanitizer } = require('./Sanitizer.js');
const { PipelineUtils } = require('../../utils/PipelineUtils.js');
const { TokenUtils } = require('../../utils/TokenUtils.js');
const { Util } = require('../../utils/Util.js');
const TokenHandler = require('./TokenHandler.js');
const { JSUtils } = require('../../utils/jsutils.js');
const { KV, TagTk, SelfclosingTagTk, EndTagTk } = require('../../tokens/TokenTypes.js');
const { WikiLinkHandler } = require('./WikiLinkHandler.js');

// shortcuts
const lastItem = JSUtils.lastItem;

/**
 * @class
 * @extends module:wt2html/tt/TokenHandler
 */
class ExternalLinkHandler extends TokenHandler {
	constructor(manager, options) {
		super(manager, options);
		this.manager.addTransform(
			(token, cb) => this.onUrlLink(token, cb),
			'ExternalLinkHandler:onUrlLink',
			ExternalLinkHandler.rank(), 'tag', 'urllink');
		this.manager.addTransform(
			(token, cb) => this.onExtLink(token, cb),
			'ExternalLinkHandler:onExtLink',
			ExternalLinkHandler.rank() - 0.001, 'tag', 'extlink');
		this.manager.addTransform(
			(token, cb) => this.onEnd(token, cb),
			'ExternalLinkHandler:onEnd',
			ExternalLinkHandler.rank(), 'end');

		// Create a new peg parser for image options.
		if (!this.urlParser) {
			// Actually the regular tokenizer, but we'll call it with the
			// url rule only.
			ExternalLinkHandler.prototype.urlParser = new PegTokenizer(this.env);
		}

		this._reset();
	}

	static rank() { return 1.15; }

	_reset() {
		this.linkCount = 1;
	}

	static _imageExtensions(str) {
		switch (str) {
			case 'jpg': // fall through
			case 'png': // fall through
			case 'gif': // fall through
			case 'svg': // fall through
				return true;
			default:
				return false;
		}
	}

	_hasImageLink(href) {
		const allowedPrefixes = this.manager.env.conf.wiki.allowExternalImages;
		const bits = href.split('.');
		const hasImageExtension = bits.length > 1 &&
			ExternalLinkHandler._imageExtensions(lastItem(bits)) &&
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
			allowedPrefixes.some(
				prefix => href.indexOf(prefix) === 0
			);
	}

	onUrlLink(token, cb) {
		let tagAttrs, builtTag;
		const env = this.manager.env;
		const origHref = token.getAttribute('href');
		const href = TokenUtils.tokensToString(origHref);
		const dataAttribs = Util.clone(token.dataAttribs);

		if (this._hasImageLink(href)) {
			tagAttrs = [
				new KV('src', href),
				new KV('alt', lastItem(href.split('/'))),
				new KV('rel', 'mw:externalImage'),
			];

			// combine with existing rdfa attrs
			tagAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
			cb({ tokens: [ new SelfclosingTagTk('img', tagAttrs, dataAttribs) ] });
		} else {
			tagAttrs = [
				new KV('rel', 'mw:ExtLink'),
				// href is set explicitly below
			];

			// combine with existing rdfa attrs
			tagAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
			builtTag = new TagTk('a', tagAttrs, dataAttribs);
			dataAttribs.stx = 'url';

			if (!this.options.inTemplate) {
				// Since we messed with the text of the link, we need
				// to preserve the original in the RT data. Or else.
				builtTag.addNormalizedAttribute('href', href, token.getWTSource(this.manager.frame));
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
	}

	// Bracketed external link
	onExtLink(token, cb) {
		let newAttrs, aStart;
		const env = this.manager.env;
		const origHref = token.getAttribute('href');
		const hasExpandedAttrs = /mw:ExpandedAttrs/.test(token.getAttribute('typeof'));
		const href = TokenUtils.tokensToString(origHref);
		const hrefWithEntities = TokenUtils.tokensToString(origHref, false, {
			includeEntities: true,
		});
		let content = token.getAttribute('mw:content');
		const dataAttribs = Util.clone(token.dataAttribs);
		let rdfaType = token.getAttribute('typeof');
		const magLinkRe = /(?:^|\s)(mw:(?:Ext|Wiki)Link\/(?:ISBN|RFC|PMID))(?=$|\s)/;
		let tokens;

		if (rdfaType && magLinkRe.test(rdfaType)) {
			let newHref = href;
			let newRel = 'mw:ExtLink';
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
			newAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
			aStart = new TagTk('a', newAttrs, dataAttribs);
			tokens = [aStart].concat(content, [new EndTagTk('a')]);
			cb({
				tokens: tokens
			});
		} else if (
			(!hasExpandedAttrs && typeof origHref === 'string') ||
				this.urlParser.tokenizesAsURL(hrefWithEntities)
		) {
			rdfaType = 'mw:ExtLink';
			if (
				content.length === 1 &&
				content[0].constructor === String &&
				env.conf.wiki.hasValidProtocol(content[0]) &&
				this.urlParser.tokenizesAsURL(content[0]) &&
				this._hasImageLink(content[0])
			) {
				const src = content[0];
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
			newAttrs = WikiLinkHandler.buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
			aStart = new TagTk('a', newAttrs, dataAttribs);

			if (!this.options.inTemplate) {
				// If we are from a top-level page, add normalized attr info for
				// accurate roundtripping of original content.
				//
				// extLinkContentOffsets[0] covers all spaces before content
				// and we need src without those spaces.
				const tsr0a = dataAttribs.tsr[0] + 1;
				const tsr1a = dataAttribs.extLinkContentOffsets[0] - (token.getAttribute('spaces') || '').length;
				aStart.addNormalizedAttribute('href', href, this.manager.frame.srcText.substring(tsr0a, tsr1a));
			} else {
				aStart.addAttribute('href', href);
			}

			content = PipelineUtils.getDOMFragmentToken(
				content,
				dataAttribs.tsr ? dataAttribs.extLinkContentOffsets : null,
				{ inlineContext: true, token: token }
			);

			tokens = [aStart].concat(content, [new EndTagTk('a')]);
			cb({
				tokens: tokens,
			});
		} else {
			// Not a link, convert href to plain text.
			cb({ tokens: WikiLinkHandler.bailTokens(env, token, true) });
		}
	}

	onEnd(token, cb) {
		this._reset();
		cb({ tokens: [ token ] });
	}
}

if (typeof module === "object") {
	module.exports.ExternalLinkHandler = ExternalLinkHandler;
}
