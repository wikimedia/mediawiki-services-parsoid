/**
 * Serializes link markup.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

var url = require('url');

var CT = require('./ConstrainedText.js');
var ContentUtils = require('../utils/ContentUtils.js').ContentUtils;
var DiffUtils = require('./DiffUtils.js').DiffUtils;
var DOMDataUtils = require('../utils/DOMDataUtils.js').DOMDataUtils;
var DOMUtils = require('../utils/DOMUtils.js').DOMUtils;
var JSUtils = require('../utils/jsutils.js').JSUtils;
var Promise = require('../utils/promise.js');
var TokenUtils = require('../utils/TokenUtils.js').TokenUtils;
var Util = require('../utils/Util.js').Util;
var WTUtils = require('../utils/WTUtils.js').WTUtils;
const { WTSUtils }  = require('../html2wt/WTSUtils.js');

var AutoURLLinkText = CT.AutoURLLinkText;
var ExtLinkText = CT.ExtLinkText;
var MagicLinkText = CT.MagicLinkText;
var WikiLinkText = CT.WikiLinkText;
var lastItem = JSUtils.lastItem;

var REDIRECT_TEST_RE = /^([ \t\n\r\0\x0b])*$/;
var MW_TITLE_WHITESPACE_RE = /[ _\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/**
 * Strip a string suffix if it matches.
 */
var stripSuffix = function(text, suffix) {
	var sLen = suffix.length;
	if (sLen && text.substr(-sLen) === suffix) {
		return text.substr(0, text.length - sLen);
	} else {
		return text;
	}
};

var splitLinkContentString = function(contentString, dp, target) {
	var tail = dp.tail;
	var prefix = dp.prefix;

	if (tail && contentString.substr(contentString.length - tail.length) === tail) {
		// strip the tail off the content
		contentString = stripSuffix(contentString, tail);
	} else if (tail) {
		tail = '';
	}

	if (prefix && contentString.substr(0, prefix.length) === prefix) {
		contentString = contentString.substr(prefix.length);
	} else if (prefix) {
		prefix = '';
	}

	return {
		contentString: contentString || '',
		tail: tail || '',
		prefix: prefix || '',
	};
};

// Helper function for munging protocol-less absolute URLs:
// If this URL is absolute, but doesn't contain a protocol,
// try to find a localinterwiki protocol that would work.
var getHref = function(env, node) {
	var href = node.getAttribute('href') || '';
	if (/^\/[^\/]/.test(href)) {
		// protocol-less but absolute.  let's find a base href
		var bases = [];
		var nhref;
		env.conf.wiki.interwikiMap.forEach(function(interwikiInfo, prefix) {
			if (interwikiInfo.localinterwiki !== undefined &&
				interwikiInfo.url !== undefined) {
				// this is a possible base href
				bases.push(interwikiInfo.url);
			}
		});
		for (var i = 0; i < bases.length; i++) {
			// evaluate the url relative to this base
			nhref = url.resolve(bases[i], href);
			// can this match the pattern?
			var re = '^' +
				bases[i].split('$1').map(JSUtils.escapeRegExp).join('[\\s\\S]*') +
				'$';
			if (new RegExp(re).test(nhref)) {
				return nhref;
			}
		}
	}
	return href;
};

function normalizeIWP(str) {
	return str.toLowerCase().trim().replace(/^:/, '');
}

var escapeLinkTarget = function(linkTarget, state) {
	// Entity-escape the content.
	linkTarget = Util.escapeWtEntities(linkTarget);
	return {
		linkTarget: linkTarget,
		// Is this an invalid link?
		invalidLink: !state.env.isValidLinkTarget(linkTarget) ||
			// `isValidLinkTarget` omits fragments (the part after #) so,
			// even though "|" is an invalid character, we still need to ensure
			// it doesn't appear in there.  The percent encoded version is fine
			// in the fragment, since it won't break the parse.
			/\|/.test(linkTarget)
	};
};

// Helper function for getting RT data from the tokens
var getLinkRoundTripData = Promise.async(function *(env, node, state) {
	var dp = DOMDataUtils.getDataParsoid(node);
	var wiki = env.conf.wiki;
	var rtData = {
		type: null, // could be null
		href: null, // filled in below
		origHref: null, // filled in below
		target: null, // filled in below
		tail: dp.tail || '',
		prefix: dp.prefix || '',
		content: {},  // string or tokens
	};

	// Figure out the type of the link
	if (node.hasAttribute('rel')) {
		var rel = node.getAttribute('rel');
		// Parsoid only emits and recognizes ExtLink, WikiLink, and PageProp rel values.
		// Everything else defaults to ExtLink during serialization (unless it is
		// serializable to a wikilink)
		var typeMatch = rel.match(/\b(mw:(WikiLink|ExtLink|MediaLink|PageProp)[^\s]*)\b/);
		if (typeMatch) {
			rtData.type = typeMatch[1];
			// Strip link subtype info
			if (/^mw:(Wiki|Ext)Link\//.test(rtData.type)) {
				rtData.type = 'mw:' + typeMatch[2];
			}
		}
	}

	// Default link type if nothing else is set
	if (rtData.type === null && !DOMUtils.selectMediaElt(node)) {
		rtData.type = 'mw:ExtLink';
	}

	// Get href, and save the token's "real" href for comparison
	var href = getHref(env, node);
	rtData.origHref = href;
	rtData.href = href.replace(/^(\.\.?\/)+/, '');

	// WikiLinks should be relative (but see below); fixup the link type
	// if a WikiLink has an absolute URL.
	// (This may get converted back to a WikiLink below, in the interwiki
	// handling code.)
	if (rtData.type === 'mw:WikiLink' &&
		(/^(\w+:)?\/\//.test(rtData.href) || /^\//.test(rtData.origHref))) {
		rtData.type = 'mw:ExtLink';
	}

	// Now get the target from rt data
	rtData.target = yield state.serializer.serializedAttrVal(node, 'href');

	// Check if the link content has been modified or is newly inserted content.
	// FIXME: This will only work with selser of course. Hard to test without selser.
	if (state.inModifiedContent || DiffUtils.hasDiffMark(node, env, 'subtree-changed')) {
		rtData.contentModified = true;
	}

	// Get the content string or tokens
	var contentParts;
	if (node.hasChildNodes() && DOMUtils.allChildrenAreText(node)) {
		var contentString = node.textContent;
		if (rtData.target.value && rtData.target.value !== contentString) {
			// Try to identify a new potential tail
			contentParts = splitLinkContentString(contentString, dp, rtData.target);
			rtData.content.string = contentParts.contentString;
			rtData.tail = contentParts.tail;
			rtData.prefix = contentParts.prefix;
		} else {
			rtData.tail = '';
			rtData.prefix = '';
			rtData.content.string = contentString;
		}
	} else if (node.hasChildNodes()) {
		rtData.contentNode = node;
	} else if (/^mw:PageProp\/redirect$/.test(rtData.type)) {
		rtData.isRedirect = true;
		rtData.prefix = dp.src ||
			((wiki.mwAliases.redirect[0] || '#REDIRECT') + ' ');
	}

	// Update link type based on additional analysis.
	// What might look like external links might be serializable as a wikilink.
	var target = rtData.target;

	// mw:MediaLink annotations are considered authoritative
	// and interwiki link matches aren't made for these
	if (/\bmw:MediaLink\b/.test(rtData.type)) {
		// Parse title from resource attribute (see analog in image handling)
		var resource = yield state.serializer.serializedAttrVal(node, 'resource');
		if (resource.value === null) {
			// from non-parsoid HTML: try to reconstruct resource from href?
			// (See similar code which tries to guess resource from <img src>)
			var mediaPrefix = wiki.namespaceNames[wiki.namespaceIds.get('media')];
			resource = {
				value: mediaPrefix + ':' + rtData.origHref.replace(/.*\//, ''),
				fromsrc: false,
				modified: false,
			};
		}
		rtData.target = resource;
		rtData.href = rtData.target.value.replace(/^(\.\.?\/)+/, '');
		return rtData;
	}

	// Check if the href matches any of our interwiki URL patterns
	var interWikiMatch = wiki.interWikiMatcher().match(href);
	if (interWikiMatch
		// Question mark is a valid title char, so it won't fail the test below,
		// but gets percent encoded on the way out since it has special
		// semantics in a url.  That will break the url we're serializing, so
		// protect it.
		// FIXME: If ever the default value for $wgExternalInterwikiFragmentMode
		// changes, we can reduce this by always stripping off the fragment
		// identifier, since in "html5" mode, that isn't encoded.  At present,
		// we can only do that if we know it's a local interwiki link.
		&& !/\?/.test(interWikiMatch[1])
		// Ensure we have a valid link target, otherwise falling back to extlink
		// is preferable, since it won't serialize as a link.
		&& (!interWikiMatch[1].length ||
			!escapeLinkTarget(interWikiMatch[1], state).invalidLink)
		// ExtLinks should have content to convert.
		&& (rtData.type !== 'mw:ExtLink' || rtData.content.string || rtData.contentNode)
		&& (dp.isIW || target.modified || rtData.contentModified)) {
		// External link that is really an interwiki link. Convert it.
		// TODO: Leaving this for backwards compatibility, remove when 1.5 is no longer bound
		if (rtData.type === 'mw:ExtLink') {
			rtData.type = 'mw:WikiLink';
		}
		rtData.isInterwiki = true;
		// could this be confused with a language link?
		var iwi = wiki.interwikiMap.get(normalizeIWP(interWikiMatch[0]));
		rtData.isInterwikiLang = iwi && iwi.language !== undefined;
		// is this our own wiki?
		rtData.isLocal = iwi && iwi.localinterwiki !== undefined;
		// strip off localinterwiki prefixes
		var localPrefix = '';
		var oldPrefix;
		while (true) {  // eslint-disable-line
			oldPrefix = target.value.slice(localPrefix.length).match(/^(:?[^:]+):/);
			if (!oldPrefix) {
				break;
			}
			iwi = wiki.interwikiMap.get(
				Util.normalizeNamespaceName(oldPrefix[1].replace(/^:/, ''))
			);
			if (!iwi || iwi.localinterwiki === undefined) {
				break;
			}
			localPrefix += oldPrefix[1] + ':';
		}

		if (target.fromsrc && !target.modified) {
			// Leave the target alone!
		} else if (/\bmw:PageProp\/Language\b/.test(rtData.type)) {
			target.value = interWikiMatch.join(':').replace(/^:/, '');
		} else if (
			oldPrefix && ( // Should we preserve the old prefix?
				oldPrefix[1].toLowerCase() === interWikiMatch[0].toLowerCase() ||
				// Check if the old prefix mapped to the same URL as
				// the new one. Use the old one if that's the case.
				// Example: [[w:Foo]] vs. [[:en:Foo]]
				(wiki.interwikiMap.get(normalizeIWP(oldPrefix[1])) || {}).url ===
					(wiki.interwikiMap.get(normalizeIWP(interWikiMatch[0])) || {}).url
			)
		) {
			// Reuse old prefix capitalization
			if (Util.decodeWtEntities(target.value.substr(oldPrefix[1].length + 1)) !== interWikiMatch[1]) {
				// Modified, update target.value.
				target.value = localPrefix + oldPrefix[1] + ':' + interWikiMatch[1];
			}
			// Ensure that we generate an interwiki link and not a language link!
			if (rtData.isInterwikiLang && !(/^:/.test(target.value))) {
				target.value = ':' + target.value;
			}
			// Else: preserve old encoding
		} else if (rtData.isLocal) {
			// - interwikiMatch will be ":en", ":de", etc.
			// - This tests whether the interwiki-like link is actually
			//   a local wikilink.
			target.value = interWikiMatch[1];
			rtData.isInterwiki = rtData.isInterwikiLang = false;
		} else {
			target.value = interWikiMatch.join(':');
		}
	}

	return rtData;
});

/**
 * The provided URL is already percent-encoded -- but it may still
 * not be safe for wikitext.  Add additional escapes to make the URL
 * wikitext-safe. Don't touch percent escapes already in the url,
 * though!
 * @private
 */
var escapeExtLinkURL = function(urlStr) {
	// this regexp is the negation of EXT_LINK_URL_CLASS in the PHP parser
	return urlStr.replace(/[\]\[<>"\x00-\x20\x7F\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]|-(?=\{)/g, function(m) {
		return Util.entityEncodeAll(m);
	}).replace(
		// IPv6 host names are bracketed with [].  Entity-decode these.
		/^([a-z][^:\/]*:)?\/\/&#x5B;([0-9a-f:.]+)&#x5D;(:\d|\/|$)/i,
		'$1//[$2]$3'
	);
};

/**
 * Add a colon escape to a wikilink target string if needed.
 * @private
 */
var addColonEscape = function(env, linkTarget, linkData) {
	var linkTitle = env.makeTitleFromText(linkTarget);
	if ((linkTitle.getNamespace().isCategory() || linkTitle.getNamespace().isFile())
		&& linkData.type === 'mw:WikiLink'
		&& !/^:/.test(linkTarget)) {
		// Escape category and file links
		return ':' + linkTarget;
	} else {
		return linkTarget;
	}
};

var isURLLink = function(env, node, linkData) {
	var target = linkData.target;

	// Get plain text content, if any
	var contentStr = node.hasChildNodes() &&
		DOMUtils.allChildrenAreText(node) ? node.textContent : null;
	// First check if we can serialize as an URL link
	return contentStr &&
			// Can we minimize this?
			(target.value === contentStr  || getHref(env, node) === contentStr) &&
			// protocol-relative url links not allowed in text
			// (see autourl rule in peg tokenizer, T32269)
			!(/^\/\//).test(contentStr) && Util.isProtocolValid(contentStr, env);
};

// Figure out if we need a piped or simple link
var isSimpleWikiLink = function(env, dp, target, linkData) {
	var canUseSimple = false;
	var contentString = linkData.content.string;

	// FIXME (SSS):
	// 1. Revisit this logic to see if all these checks
	//    are still relevant or whether this can be simplified somehow.
	// 2. There are also duplicate computations for env.normalizedTitleKey(..)
	//    and Util.decodeURIComponent(..) that could be removed.
	// 3. This could potentially be refactored as if-then chains.

	// Would need to pipe for any non-string content.
	// Preserve unmodified or non-minimal piped links.
	if (contentString !== undefined
		&& (target.modified || linkData.contentModified || dp.stx !== 'piped')
		// Relative links are not simple
		&& !contentString.match(/^\.\//)
	) {
		// Strip colon escapes from the original target as that is
		// stripped when deriving the content string.
		// Strip ./ prefixes as well since they are relative link prefixes
		// added to all titles.
		var strippedTargetValue = target.value.replace(/^(:|\.\/)/, '');
		var decodedTarget = Util.decodeWtEntities(strippedTargetValue);
		// Deal with the protocol-relative link scenario as well
		var hrefHasProto = /^(\w+:)?\/\//.test(linkData.href);

		// Normalize content string and decoded target before comparison.
		// Piped links don't come down this path => it is safe to normalize both.
		contentString = contentString.replace(/_/g, ' ');
		decodedTarget = decodedTarget.replace(/_/g, ' ');

		// See if the (normalized) content matches the
		// target, either shadowed or actual.
		canUseSimple = (
			contentString === decodedTarget
			// try wrapped in forward slashes in case they were stripped
		|| ('/' + contentString + '/') === decodedTarget
			// normalize as titles and compare
		|| env.normalizedTitleKey(contentString, true) === decodedTarget.replace(MW_TITLE_WHITESPACE_RE, '_')
			// Relative link
		|| (env.conf.wiki.namespacesWithSubpages[env.page.ns] &&
			(/^\.\.\/.*[^\/]$/.test(strippedTargetValue) &&
			contentString === env.resolveTitle(strippedTargetValue)) ||
			(/^\.\.\/.*?\/$/.test(strippedTargetValue) &&
			contentString === strippedTargetValue.replace(/^(?:\.\.\/)+(.*?)\/$/, '$1')))
			// if content == href this could be a simple link... eg [[Foo]].
			// but if href is an absolute url with protocol, this won't
			// work: [[http://example.com]] is not a valid simple link!
		|| (!hrefHasProto &&
				// Always compare against decoded uri because
				// <a rel="mw:WikiLink" href="7%25 Solution">7%25 Solution</a></p>
				// should serialize as [[7% Solution|7%25 Solution]]
				(contentString === Util.decodeURIComponent(linkData.href) ||
				// normalize with underscores for comparison with href
				env.normalizedTitleKey(contentString, true) === Util.decodeURIComponent(linkData.href)))
		);
	}

	return canUseSimple;
};

var serializeAsWikiLink = Promise.async(function *(node, state, linkData) {
	var contentParts;
	var contentSrc = '';
	var isPiped = false;
	var requiresEscaping = true;
	var env = state.env;
	var wiki = env.conf.wiki;
	var oldSOLState = state.onSOL;
	var target = linkData.target;
	var dp = DOMDataUtils.getDataParsoid(node);

	// Decode any link that did not come from the source (data-mw/parsoid)
	// Links that come from data-mw/data-parsoid will be true titles,
	// but links that come from hrefs will need to be url-decoded.
	// Ex: <a href="/wiki/A%3Fb">Foobar</a>
	if (!target.fromsrc) {
		// Omit fragments from decoding
		var hash = target.value.indexOf('#');
		if (hash > -1) {
			target.value = Util.decodeURIComponent(target.value.substring(0, hash)) + target.value.substring(hash);
		} else {
			target.value = Util.decodeURIComponent(target.value);
		}
	}

	// Special-case handling for category links
	if (linkData.type === 'mw:PageProp/Category') {
		// Split target and sort key
		var targetParts = target.value.match(/^([^#]*)#(.*)/);

		if (targetParts) {
			target.value = targetParts[1]
				.replace(/^(\.\.?\/)*/, '')
				.replace(/_/g, ' ');
			// FIXME: Reverse `Sanitizer.sanitizeTitleURI(strContent).replace(/#/g, '%23');`
			var strContent = Util.decodeURIComponent(targetParts[2]);
			contentParts = splitLinkContentString(strContent, dp);
			linkData.content.string = contentParts.contentString;
			dp.tail = linkData.tail = contentParts.tail;
			dp.prefix = linkData.prefix = contentParts.prefix;
		} else { // No sort key, will serialize to simple link
			// Normalize the content string
			linkData.content.string = target.value.replace(/^\.\//, '').replace(/_/g, ' ');
		}

		// Special-case handling for template-affected sort keys
		// FIXME: sort keys cannot be modified yet, but if they are,
		// we need to fully shadow the sort key.
		// if ( !target.modified ) {
		// The target and source key was not modified
		var sortKeySrc =
			yield state.serializer.serializedAttrVal(node, 'mw:sortKey');
		if (sortKeySrc.value !== null) {
			linkData.contentNode = undefined;
			linkData.content.string = sortKeySrc.value;
			// TODO: generalize this flag. It is already used by
			// getAttributeShadowInfo. Maybe use the same
			// structure as its return value?
			linkData.content.fromsrc = true;
		}
		// }
	} else if (linkData.type === 'mw:PageProp/Language') {
		// Fix up the the content string
		// TODO: see if linkData can be cleaner!
		if (linkData.content.string === undefined) {
			linkData.content.string = Util.decodeWtEntities(target.value);
		}
	}

	// The string value of the content, if it is plain text.
	var linkTarget, escapedTgt;
	if (linkData.isRedirect) {
		linkTarget = target.value;
		if (target.modified || !target.fromsrc) {
			linkTarget = linkTarget.replace(/^(\.\.?\/)*/, '').replace(/_/g, ' ');
			escapedTgt = escapeLinkTarget(linkTarget, state);
			linkTarget = escapedTgt.linkTarget;
			// Determine if it's a redirect to a category, in which case
			// it needs a ':' on front to distingish from a category link.
			var categoryMatch = linkTarget.match(/^([^:]+)[:]/);
			if (categoryMatch) {
				var ns = wiki.namespaceIds.get(Util.normalizeNamespaceName(categoryMatch[1]));
				if (ns === wiki.canonicalNamespaces.category) {
					// Check that the next node isn't a category link,
					// in which case we don't want the ':'.
					var nextNode = node.nextSibling;
					if (!(
						nextNode && DOMUtils.isElt(nextNode) && nextNode.nodeName === "LINK" &&
						nextNode.getAttribute('rel') === "mw:PageProp/Category" &&
						nextNode.getAttribute('href') === node.getAttribute('href')
					)) {
						linkTarget = ':' + linkTarget;
					}
				}
			}
		}
	} else if (isSimpleWikiLink(env, dp, target, linkData)) {
		// Simple case
		if (!target.modified && !linkData.contentModified) {
			linkTarget = target.value.replace(/^\.\//, '');
		} else {
			// If token has templated attrs or is a subpage, use target.value
			// since content string will be drastically different.
			if (WTUtils.hasExpandedAttrsType(node) ||
				/(^|\/)\.\.\//.test(target.value)) {
				linkTarget = target.value.replace(/^\.\//, '');
			} else {
				escapedTgt = escapeLinkTarget(linkData.content.string, state);
				if (!escapedTgt.invalidLink) {
					linkTarget = addColonEscape(env, escapedTgt.linkTarget, linkData);
				} else {
					linkTarget = escapedTgt.linkTarget;
				}
			}
			if (linkData.isInterwikiLang && !/^[:]/.test(linkTarget) &&
				linkData.type !== 'mw:PageProp/Language') {
				// ensure interwiki links can't be confused with
				// interlanguage links.
				linkTarget = ':' + linkTarget;
			}
		}
	} else if (isURLLink(state.env, node, linkData)/* && !linkData.isInterwiki */) {
		// Uncomment the above check if we want [[wikipedia:Foo|http://en.wikipedia.org/wiki/Foo]]
		// for '<a href="http://en.wikipedia.org/wiki/Foo">http://en.wikipedia.org/wiki/Foo</a>'
		linkData.linkType = "mw:URLLink";
	} else {
		// Emit piped wikilink syntax
		isPiped = true;

		// First get the content source
		if (linkData.contentNode) {
			var cs = yield state.serializeLinkChildrenToString(
				linkData.contentNode,
				state.serializer.wteHandlers.wikilinkHandler
			);
			// strip off the tail and handle the pipe trick
			contentParts = splitLinkContentString(cs, dp);
			contentSrc = contentParts.contentString;
			dp.tail = contentParts.tail;
			linkData.tail = contentParts.tail;
			dp.prefix = contentParts.prefix;
			linkData.prefix = contentParts.prefix;
			requiresEscaping = false;
		} else {
			contentSrc = linkData.content.string || '';
			requiresEscaping = !linkData.content.fromsrc;
		}

		if (contentSrc === '' &&
			linkData.type !== 'mw:PageProp/Category') {
			// Protect empty link content from PST pipe trick
			contentSrc = '<nowiki/>';
			requiresEscaping = false;
		}

		linkTarget = target.value;
		if (target.modified || !target.fromsrc) {
			// Links starting with ./ shouldn't get _ replaced with ' '
			var linkContentIsRelative =
				linkData.content && linkData.content.string &&
				linkData.content.string.match(/^\.\//);
			linkTarget = linkTarget.replace(/^(\.\.?\/)*/, '');
			if (!linkData.isInterwiki && !linkContentIsRelative) {
				linkTarget = linkTarget.replace(/_/g, ' ');
			}
			escapedTgt = escapeLinkTarget(linkTarget, state);
			linkTarget = escapedTgt.linkTarget;
		}

		// If we are reusing the target from source, we don't
		// need to worry about colon-escaping because it will
		// be in the right form already.
		//
		// Trying to eliminate this check and always check for
		// colon-escaping seems a bit tricky when the reused
		// target has encoded entities that won't resolve to
		// valid titles.
		if ((!escapedTgt || !escapedTgt.invalidLink) && !target.fromsrc) {
			linkTarget = addColonEscape(env, linkTarget, linkData);
		}
	}
	if (linkData.linkType === "mw:URLLink") {
		state.emitChunk(new AutoURLLinkText(node.textContent, node), node);
		return;
	}

	if (linkData.isRedirect) {
		// Drop duplicates
		if (state.redirectText !== null) {
			return;
		}

		// Buffer redirect text if it is not in start of file position
		if (!REDIRECT_TEST_RE.test(state.out + state.currLine.text)) {
			state.redirectText = linkData.prefix + '[[' + linkTarget + ']]';
			state.emitChunk('', node);  // Flush seperators for this node
			return;
		}

		// Set to some non-null string
		state.redirectText = 'unbuffered';
	}

	var pipedText;
	if (escapedTgt && escapedTgt.invalidLink) {
		// If the link target was invalid, instead of emitting an invalid link,
		// omit the link and serialize just the content instead. But, log the
		// invalid html for Parsoid clients to investigate later.
		state.env.log("error/html2wt/link", "Bad title text", node.outerHTML);

		// For non-piped content, use the original invalid link text
		pipedText = isPiped ? contentSrc : linkTarget;

		if (requiresEscaping) {
			// Escape the text in the old sol context
			state.onSOL = oldSOLState;
			pipedText = state.serializer.wteHandlers.escapeWikiText(state, pipedText, { node: node });
		}
		state.emitChunk(linkData.prefix + pipedText + linkData.tail, node);
	} else {
		if (isPiped && requiresEscaping) {
			// We are definitely not in sol context since content
			// will be preceded by "[[" or "[" text in target wikitext.
			pipedText = '|' + state.serializer.wteHandlers.escapeLinkContent(state, contentSrc, false, node, false);
		} else if (isPiped) {
			pipedText = '|' + contentSrc;
		} else {
			pipedText = '';
		}
		state.emitChunk(new WikiLinkText(
			linkData.prefix + '[[' + linkTarget + pipedText + ']]' + linkData.tail,
			node, wiki, linkData.type), node);
	}
});

var serializeAsExtLink = Promise.async(function *(node, state, linkData) {
	var target = linkData.target;
	var urlStr = target.value;
	if (target.modified || !target.fromsrc) {
		// We expect modified hrefs to be percent-encoded already, so
		// don't need to encode them here any more. Unmodified hrefs are
		// just using the original encoding anyway.
		// BUT we do have to encode certain special wikitext
		// characters (like []) which aren't necessarily
		// percent-encoded because they are valid in URLs and HTML5
		urlStr = escapeExtLinkURL(urlStr);
	}

	if (isURLLink(state.env, node, linkData)) {
		// Serialize as URL link
		state.emitChunk(new AutoURLLinkText(urlStr, node), node);
		return;
	}

	var wiki = state.env.conf.wiki;

	// TODO: match vs. interwikis too
	var magicLinkMatch = wiki.ExtResourceURLPatternMatcher.match(Util.decodeURI(linkData.origHref));
	var pureHashMatch = /^#/.test(urlStr);
	// Fully serialize the content
	var contentStr = yield state.serializeLinkChildrenToString(
		node,
		pureHashMatch ?
			state.serializer.wteHandlers.wikilinkHandler :
			state.serializer.wteHandlers.aHandler
	);
	// First check for ISBN/RFC/PMID links. We rely on selser to
	// preserve non-minimal forms.
	if (magicLinkMatch) {
		var serializer = wiki.ExtResourceSerializer[magicLinkMatch[0]];
		var serialized = serializer(magicLinkMatch, target.value, contentStr);
		if (serialized[0] === '[') {
			// Serialization as a magic link failed (perhaps the
			// content string wasn't appropriate).
			state.emitChunk(
				magicLinkMatch[0] === 'ISBN' ?
					new WikiLinkText(serialized, node, wiki, 'mw:WikiLink') :
					new ExtLinkText(serialized, node, wiki, 'mw:ExtLink'),
				node
			);
		} else {
			state.emitChunk(new MagicLinkText(serialized, node), node);
		}
		return;
	// There is an interwiki for RFCs, but strangely none for PMIDs.
	} else {
		// serialize as auto-numbered external link
		// [http://example.com]
		var linktext, Construct;
		// If it's just anchor text, serialize as an internal link.
		if (pureHashMatch) {
			Construct = WikiLinkText;
			linktext = '[[' + urlStr + (contentStr ? '|' + contentStr : '') + ']]';
		} else {
			Construct = ExtLinkText;
			linktext = '[' + urlStr + (contentStr ? ' ' + contentStr : '') + ']';
		}
		state.emitChunk(new Construct(linktext, node, wiki, linkData.type), node);
		return;
	}
});

/**
 * Main link handler.
 * @function
 * @param {Node} node
 * @return {Promise}
 */
var linkHandler = Promise.async(function *(state, node) {
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links without advanced attributes to
	// external wiki links for html import. Might want to consider converting
	// relative links without path component and file extension to wiki links.
	var env = state.env;
	var wiki = env.conf.wiki;

	// Get the rt data from the token and tplAttrs
	var linkData = yield getLinkRoundTripData(env, node, state);
	var linkType = linkData.type;
	if (wiki.ExtResourceURLPatternMatcher.match(Util.decodeURI(linkData.origHref))) {
		// Override the 'rel' type if this is a magic link
		linkType = 'mw:ExtLink';
	}
	if (linkType !== null && linkData.target.value !== null) {
		// We have a type and target info
		if (/^mw:WikiLink|mw:MediaLink$/.test(linkType) ||
			TokenUtils.solTransparentLinkRegexp.test(linkType)) {
			// [[..]] links: normal, category, redirect, or lang links
			// (except images)
			return (yield serializeAsWikiLink(node, state, linkData));
		} else if (linkType === 'mw:ExtLink') {
			// [..] links, autolinks, ISBN, RFC, PMID
			return (yield serializeAsExtLink(node, state, linkData));
		} else {
			throw new Error('Unhandled link serialization scenario: ' +
							node.outerHTML);
		}
	} else {
		var safeAttr = new Set(["href", "rel", "class", "title", DOMDataUtils.DataObjectAttrName()]);
		var isComplexLink = function(attributes) {
			for (var i = 0; i < attributes.length; i++) {
				var attr = attributes.item(i);
				// XXX: Don't drop rel and class in every case once a tags are
				// actually supported in the MW default config?
				if (attr.name && !safeAttr.has(attr.name)) {
					return true;
				}
			}
			return false;
		};

		var isFigure = false;
		if (isComplexLink(node.attributes)) {
			env.log("error/html2wt/link", "Encountered", node.outerHTML,
					"-- serializing as extlink and dropping <a> attributes unsupported in wikitext.");
		} else {
			var media = DOMUtils.selectMediaElt(node);
			isFigure = !!(media && media.parentElement === node);
		}

		var hrefStr;
		if (isFigure) {
			// this is a basic html figure: <a><img></a>
			return (yield state.serializer.figureHandler(node));
		} else {
			// href is already percent-encoded, etc., but it might contain
			// spaces or other wikitext nasties.  escape the nasties.
			hrefStr = escapeExtLinkURL(getHref(env, node));
			var handler = state.serializer.wteHandlers.aHandler;
			var str = yield state.serializeLinkChildrenToString(node, handler);
			var chunk;
			if (!hrefStr) {
				// Without an href, we just emit the string as text.
				// However, to preserve targets for anchor links,
				// serialize as a span with a name.
				if (node.hasAttribute('name')) {
					var name = node.getAttribute('name');
					var doc = node.ownerDocument;
					var span = doc.createElement('span');
					span.setAttribute('name', name);
					span.appendChild(doc.createTextNode(str));
					chunk = span.outerHTML;
				} else {
					chunk = str;
				}
			} else {
				chunk = new ExtLinkText('[' + hrefStr + ' ' + str + ']',
										node, wiki, 'mw:ExtLink');
			}
			state.emitChunk(chunk, node);
		}
	}
});

function eltNameFromMediaType(type) {
	switch (type) {
		case 'mw:Audio':
			return 'AUDIO';
		case 'mw:Video':
			return 'VIDEO';
		default:
			return 'IMG';
	}
}

/**
 * Main figure handler.
 *
 * All figures have a fixed structure:
 * ```
 * <figure or figure-inline typeof="mw:Image...">
 *  <a or span><img ...><a or span>
 *  <figcaption>....</figcaption>
 * </figure or figure-inline>
 * ```
 * Pull out this fixed structure, being as generous as possible with
 * possibly-broken HTML.
 *
 * @function
 * @param {Node} node
 * @return {Promise}
 */
var figureHandler = Promise.async(function *(state, node) {
	var env = state.env;
	var outerElt = node;

	const mediaTypeInfo = WTSUtils.getMediaType(node);
	const { rdfaType } = mediaTypeInfo;
	let { format } = mediaTypeInfo;

	var eltName = eltNameFromMediaType(rdfaType);
	var elt = node.querySelector(eltName);
	// TODO: Remove this when version 1.7.0 of the content is no longer supported
	if (!elt && rdfaType === 'mw:Audio') {
		eltName = 'VIDEO';
		elt = node.querySelector(eltName);
	}

	var linkElt = null;
	// parent of elt is probably the linkElt
	if (elt &&
			(elt.parentElement.tagName === 'A' ||
			(elt.parentElement.tagName === 'SPAN' &&
			elt.parentElement !== outerElt))) {
		linkElt = elt.parentElement;
	}

	// FIGCAPTION or last child (which is not the linkElt) is the caption.
	var captionElt = node.querySelector('FIGCAPTION');
	if (!captionElt) {
		for (captionElt = node.lastElementChild;
			captionElt;
			captionElt = captionElt.previousElementSibling) {
			if (captionElt !== linkElt && captionElt !== elt &&
				/^(SPAN|DIV)$/.test(captionElt.tagName)) {
				break;
			}
		}
	}

	// special case where `node` is the ELT tag itself!
	if (node.tagName === eltName) {
		linkElt = captionElt = null;
		outerElt = elt = node;
	}

	// Maybe this is "missing" media, i.e. a redlink
	let isMissing = false;
	if (!elt &&
			/^FIGURE/.test(outerElt.nodeName) &&
			outerElt.firstChild && outerElt.firstChild.nodeName === 'A' &&
			outerElt.firstChild.firstChild && outerElt.firstChild.firstChild.nodeName === 'SPAN') {
		linkElt = outerElt.firstChild;
		elt = linkElt.firstChild;
		isMissing = true;
	}

	// The only essential thing is the ELT tag!
	if (!elt) {
		env.log("error/html2wt/figure",
			"In WSP.figureHandler, node does not have any " + eltName + " elements:",
			node.outerHTML);
		state.emitChunk('', node);
		return;
	}

	// Try to identify the local title to use for this image.
	var resource = yield state.serializer.serializedImageAttrVal(outerElt, elt, 'resource');
	if (resource.value === null) {
		// from non-parsoid HTML: try to reconstruct resource from src?
		// (this won't work for manual-thumb images)
		if (!elt.hasAttribute('src')) {
			env.log("error/html2wt/figure",
					"In WSP.figureHandler, img does not have resource or src:",
					node.outerHTML);
			state.emitChunk('', node);
			return;
		}
		var src = elt.getAttribute('src');
		if (/^https?:/.test(src)) {
			// external image link, presumably $wgAllowExternalImages=true
			state.emitChunk(new AutoURLLinkText(src, node), node);
			return;
		}
		resource = {
			value: src,
			fromsrc: false,
			modified: false,
		};
	}
	if (!resource.fromsrc) {
		resource.value = resource.value.replace(/^(\.\.?\/)+/, '');
	}

	var nopts = [];
	var outerDP = outerElt ? DOMDataUtils.getDataParsoid(outerElt) : {};
	var outerDMW = outerElt ? DOMDataUtils.getDataMw(outerElt) : {};
	var mwAliases = state.env.conf.wiki.mwAliases;

	var getOpt = function(key) {
		if (!outerDP.optList) {
			return null;
		}
		return outerDP.optList.find(function(o) { return o.ck === key; });
	};
	var getLastOpt = function(key) {
		var o = outerDP.optList || [];
		for (var i = o.length - 1; i >= 0; i--) {
			if (o[i].ck === key) {
				return o[i];
			}
		}
		return null;
	};

	// Try to identify the local title to use for the link.
	let link;

	const linkFromDataMw = WTSUtils.getAttrFromDataMw(outerDMW, 'link', true);
	if (linkFromDataMw !== null) {
		// "link" attribute on the `outerElt` takes precedence
		if (linkFromDataMw[1].html !== undefined) {
			link = yield state.serializer.getAttributeValueAsShadowInfo(outerElt, 'link');
		} else {
			link = {
				value: `link=${linkFromDataMw[1].txt}`,
				modified: false,
				fromsrc: false,
				fromDataMW: true,
			};
		}
	} else if (linkElt && linkElt.hasAttribute('href')) {
		link = yield state.serializer.serializedImageAttrVal(outerElt, linkElt, 'href');
		if (!link.fromsrc) {
			if (linkElt.getAttribute('href') ===
				elt.getAttribute('resource')) {
				// default link: same place as resource
				link = resource;
			}
			link.value = link.value.replace(/^(\.\.?\/)+/, '');
		}
	} else {
		// Otherwise, just try and get it from data-mw
		link = yield state.serializer.getAttributeValueAsShadowInfo(outerElt, 'href');
	}

	if (link && !link.modified && !link.fromsrc) {
		const linkOpt = getOpt('link');
		if (linkOpt) {
			link.fromsrc = true;
			link.value = linkOpt.ak;
		}
	}

	// Reconstruct the caption
	if (!captionElt && typeof outerDMW.caption === 'string') {
		captionElt = outerElt.ownerDocument.createElement('div');
		ContentUtils.ppToDOM(env, outerDMW.caption, { node: captionElt, markNew: true });
		// Needs a parent node in order for WTS to be happy:
		// DocumentFragment to the rescue!
		outerElt.ownerDocument.createDocumentFragment().appendChild(captionElt);
	}

	var caption = null;
	if (captionElt) {
		caption = yield state.serializeCaptionChildrenToString(
			captionElt, state.serializer.wteHandlers.mediaOptionHandler
		);
	}

	// Fetch the alt (if any)
	var alt =
		yield state.serializer.serializedImageAttrVal(outerElt, elt, 'alt');
	// Fetch the lang (if any)
	var lang =
		yield state.serializer.serializedImageAttrVal(outerElt, elt, 'lang');

	// Ok, start assembling options, beginning with link & alt & lang
	// Other media don't have links in output.
	const linkCond = elt.nodeName === 'IMG' && (!link || link.value !== resource.value);

	// "alt" for non-image is handle below
	const altCond = alt.value !== null && elt.nodeName === 'IMG';

	[
		{ name: 'link', value: link, cond: linkCond },
		{ name: 'alt',  value: alt,  cond: altCond },
		{ name: 'lang', value: lang, cond: lang.value !== null },
	].forEach(function(o) {
		if (!o.cond) { return; }
		if (o.value && o.value.fromsrc) {
			nopts.push({
				ck: o.name,
				ak: [ o.value.value ],
			});
		} else {
			let value = o.value ? o.value.value : '';
			if (o.value && /^(link|alt)$/.test(o.name)) {
				// see wt2html/tt/WikiLinkHandler.js: link and alt are whitelisted
				// for accepting arbitrary wikitext, even though it is stripped
				// to a string before emitting.
				value = state.serializer.wteHandlers.escapeLinkContent(state, value, false, node, true);
			}
			nopts.push({
				ck: o.name,
				v: value,
				ak: mwAliases['img_' + o.name],
			});
		}
	});

	// Handle class-signified options
	var classes = outerElt ? outerElt.classList : [];
	var extra = []; // 'extra' classes
	var val;

	for (var ix = 0; ix < classes.length; ix++) {
		switch (classes[ix]) {
			case 'mw-halign-none':
			case 'mw-halign-right':
			case 'mw-halign-left':
			case 'mw-halign-center':
				val = classes[ix].replace(/^mw-halign-/, '');
				nopts.push({
					ck: val,
					ak: mwAliases['img_' + val],
				});
				break;

			case 'mw-valign-top':
			case 'mw-valign-middle':
			case 'mw-valign-baseline':
			case 'mw-valign-sub':
			case 'mw-valign-super':
			case 'mw-valign-text-top':
			case 'mw-valign-bottom':
			case 'mw-valign-text-bottom':
				val = classes[ix].replace(/^mw-valign-/, '')
				.replace(/-/g, '_');
				nopts.push({
					ck: val,
					ak: mwAliases['img_' + val],
				});
				break;

			case 'mw-image-border':
				nopts.push({
					ck: 'border',
					ak: mwAliases.img_border,
				});
				break;

			case 'mw-default-size':
			case 'mw-default-audio-height':
				// handled below
				break;

			default:
				extra.push(classes[ix]);
				break;
		}
	}

	if (extra.length) {
		nopts.push({
			ck: 'class',
			v: extra.join(' '),
			ak: mwAliases.img_class,
		});
	}

	var paramFromDataMw = Promise.async(function *(o) {
		var v = outerDMW[o.prop];
		if (v === undefined) {
			var a = WTSUtils.getAttrFromDataMw(outerDMW, o.ck, true);
			if (a !== null && a[1].html === undefined) { v = a[1].txt; }
		}
		if (v !== undefined) {
			var ak = yield state.serializer.getAttributeValue(
				outerElt, o.ck, mwAliases[o.alias]
			);
			nopts.push({
				ck: o.ck,
				ak: ak,
				v: v,
			});
			// Piggyback this here ...
			if (o.prop === 'thumb') { format = ''; }
		}
	});

	let mwParams = [
		{ prop: 'thumb', ck: 'manualthumb', alias: 'img_manualthumb' },
		{ prop: 'page',  ck: 'page',        alias: 'img_page' },
		// mw:Video specific
		{ prop: 'starttime', ck: 'starttime', alias: 'timedmedia_starttime' },
		{ prop: 'endtime', ck: 'endtime', alias: 'timedmedia_endtime' },
		{ prop: 'thumbtime', ck: 'thumbtime', alias: 'timedmedia_thumbtime' },
	];

	// "alt" for images is handled above
	if (elt.nodeName !== 'IMG') {
		mwParams = mwParams.concat([
			{ prop: 'link', ck: 'link', alias: 'img_link' },
			{ prop: 'alt', ck: 'alt', alias: 'img_alt' },
		]);
	}

	yield Promise.map(mwParams, paramFromDataMw);

	switch (format) {
		case 'Thumb':
			nopts.push({
				ck: 'thumbnail',
				ak: yield state.serializer.getAttributeValue(
					outerElt, 'thumbnail', mwAliases.img_thumbnail
				)
			});
			break;
		case 'Frame':
			nopts.push({
				ck: 'framed',
				ak: yield state.serializer.getAttributeValue(
					outerElt, 'framed', mwAliases.img_framed
				)
			});
			break;
		case 'Frameless':
			nopts.push({
				ck: 'frameless',
				ak: yield state.serializer.getAttributeValue(
					outerElt, 'frameless', mwAliases.img_frameless
				)
			});
			break;
	}

	// Get the user-specified height from wikitext
	var wh =
		yield state.serializer.serializedImageAttrVal(outerElt, elt, `${isMissing ? 'data-' : ''}height`);
	// Get the user-specified width from wikitext
	var ww =
		yield state.serializer.serializedImageAttrVal(outerElt, elt, `${isMissing ? 'data-' : ''}width`);

	var sizeUnmodified = ww.fromDataMW || (!ww.modified && !wh.modified);
	var upright = getOpt('upright');

	// XXX: Infer upright factor from default size for all thumbs by default?
	// Better for scaling with user prefs, but requires knowledge about
	// default used in VE.
	if (sizeUnmodified && upright
		// Only serialize upright where it is actually respected
		// This causes some dirty diffs, but makes sure that we don't
		// produce nonsensical output after a type switch.
		// TODO: Only strip if type was actually modified.
		&& format in { 'Frameless': 1, 'Thumb': 1 }) {
		// preserve upright option
		nopts.push({
			ck: upright.ck,
			ak: [upright.ak],  // FIXME: don't use ak here!
		});
	}

	if (!(outerElt && outerElt.classList.contains('mw-default-size'))) {
		var size = getLastOpt('width');
		var sizeString = (size && size.ak) || (ww.fromDataMW && ww.value);
		if (sizeUnmodified && sizeString) {
			// preserve original width/height string if not touched
			nopts.push({
				ck: 'width',
				v: sizeString,  // original size string
				ak: ['$1'],  // don't add px or the like
			});
		} else {
			var bbox = null;
			// Serialize to a square bounding box
			if (ww.value !== null && ww.value !== ''
				&& ww.value !== undefined) {
				bbox = +ww.value;
			}
			if (wh.value !== null && wh.value !== '' && wh.value !== undefined &&
				// As with "mw-default-size", editing clients should remove the
				// "mw-default-audio-height" if they want to factor a defined
				// height into the bounding box size.  However, note that, at
				// present, a defined height for audio is ignored while parsing,
				// so this only has the effect of modifying the width.
				(rdfaType !== 'mw:Audio' ||
					!outerElt.classList.contains('mw-default-audio-height'))) {
				var height = +wh.value;
				if (bbox === null || height > bbox) {
					bbox = height;
				}
			}
			if (bbox !== null) {
				nopts.push({
					ck: 'width',
					// MediaWiki interprets 100px as a width
					// restriction only, so we need to make the bounding
					// box explicitly square (100x100px). The 'px' is
					// added by the alias though, and can be localized.
					v:  bbox + 'x' + bbox,
					ak: mwAliases.img_width,  // adds the 'px' suffix
				});
			}
		}
	}

	var opts = outerDP.optList || []; // original wikitext options

	// Add bogus options from old optlist in order to round-trip cleanly (T64500)
	opts.forEach(function(o) {
		if (o.ck === 'bogus') {
			nopts.push({
				ck: 'bogus',
				ak: [ o.ak ],
			});
		}
	});

	// Put the caption last, by default.
	if (typeof (caption) === 'string') {
		nopts.push({
			ck: 'caption',
			ak: [caption],
		});
	}

	// ok, sort the new options to match the order given in the old optlist
	// and try to match up the aliases used
	var changed = false;
	nopts.forEach(function(no) {
		// Make sure we have an array here. Default in data-parsoid is
		// actually a string.
		// FIXME: don't reuse ak for two different things!
		if (!Array.isArray(no.ak)) {
			no.ak = [no.ak];
		}

		no.sortId = opts.length;
		var idx = opts.findIndex(function(o) {
			return o.ck === no.ck &&
				// for bogus options, make sure the source matches too.
				(o.ck !== 'bogus' || o.ak === no.ak[0]);
		});
		if (idx < 0) {
			// Preferred words are first in the alias list
			// (but not in old versions of mediawiki).
			no.ak = state.env.conf.wiki.useOldAliasOrder ?
				lastItem(no.ak) : no.ak[0];
			changed = true;
			return; /* new option */
		}

		no.sortId = idx;
		// use a matching alias, if there is one
		var a = no.ak.find(function(b) {
			// note the trim() here; that allows us to snarf eccentric
			// whitespace from the original option wikitext
			if ('v' in no) { b = b.replace('$1', no.v); }
			return b === String(opts[idx].ak).trim();
		});
		// use the alias (incl whitespace) from the original option wikitext
		// if found; otherwise use the last alias given (English default by
		// convention that works everywhere).
		// TODO: use first alias (localized) instead for RTL languages (T53852)
		if (a !== undefined && no.ck !== 'caption') {
			no.ak = opts[idx].ak;
			no.v = undefined; // prevent double substitution
		} else {
			no.ak = lastItem(no.ak);
			if (!(no.ck === 'caption' && a !== undefined)) {
				changed = true;
			}
		}
	});

	// Filter out bogus options if the image options/caption have changed.
	if (changed) {
		nopts = nopts.filter(function(no) { return no.ck !== 'bogus'; });
		// empty captions should get filtered out in this case, too (T64264)
		nopts = nopts.filter(function(no) {
			return !(no.ck === 'caption' && no.ak === '');
		});
	}

	// sort!
	nopts.sort(function(a, b) { return a.sortId - b.sortId; });

	// emit all the options as wikitext!
	var wikitext = '[[' + resource.value;
	nopts.forEach(function(o) {
		wikitext += '|';
		if (o.v !== undefined) {
			wikitext += o.ak.replace('$1', o.v);
		} else {
			wikitext += o.ak;
		}
	});
	wikitext += ']]';

	state.emitChunk(
		new WikiLinkText(wikitext, node, state.env.conf.wiki, rdfaType),
		node);
});


if (typeof module === "object") {
	module.exports.linkHandler = linkHandler;
	module.exports.figureHandler = figureHandler;
}
