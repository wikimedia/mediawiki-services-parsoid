"use strict";

require('./core-upgrade.js');
var url = require('url');

var Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	pd = require('./mediawiki.parser.defines.js'),
	AutoURLLinkText = require('./wts.ConstrainedText.js').AutoURLLinkText,
	ExtLinkText = require('./wts.ConstrainedText.js').ExtLinkText,
	MagicLinkText = require('./wts.ConstrainedText.js').MagicLinkText,
	WikiLinkText = require('./wts.ConstrainedText.js').WikiLinkText,
	Title = require('./mediawiki.Title.js').Title;

var splitLinkContentString = function (contentString, dp, target) {
	var tail = dp.tail,
		prefix = dp.prefix;
	if (dp.pipetrick) {
		// Drop the content completely..
		return { contentString: '', tail: tail || '', prefix: prefix || '' };
	} else {
		if ( tail && contentString.substr( contentString.length - tail.length ) === tail ) {
			// strip the tail off the content
			contentString = Util.stripSuffix( contentString, tail );
		} else if ( tail ) {
			tail = '';
		}

		if ( prefix && contentString.substr( 0, prefix.length ) === prefix ) {
			contentString = contentString.substr( prefix.length );
		} else if ( prefix ) {
			prefix = '';
		}

		return {
			contentString: contentString || '',
			tail: tail || '',
			prefix: prefix || ''
		};
	}
};

// Helper function for munging protocol-less absolute URLs:
// If this URL is absolute, but doesn't contain a protocol,
// try to find a localinterwiki protocol that would work.
var getHref = function( env, node ) {
	var href = node.getAttribute('href') || '';
	if (/^\/[^\/]/.test(href)) {
		// protocol-less but absolute.  let's find a base href
		var i, bases = [], nhref;
		env.conf.wiki.interwikiMap.forEach(function(interwikiInfo, prefix) {
			if (interwikiInfo.localinterwiki !== undefined &&
				interwikiInfo.url !== undefined) {
				// this is a possible base href
				bases.push(interwikiInfo.url);
			}
		});
		for (i=0; i<bases.length; i++) {
			// evaluate the url relative to this base
			nhref = url.resolve(bases[i], href);
			// can this match the pattern?
			var re = '^' +
				bases[i].split('$1').map(Util.escapeRegExp).join('[\\s\\S]*') +
				'$';
			if (new RegExp(re).test(nhref)) {
				return nhref;
			}
		}
	}
	return href;
};

// Helper function for getting RT data from the tokens
var getLinkRoundTripData = function( env, node, state ) {
	var dp = DU.getDataParsoid( node );
	var rtData = {
		type: null,
		target: null, // filled in below
		tail: dp.tail || '',
		prefix: dp.prefix || '',
		content: {} // string or tokens
	};

	// Figure out the type of the link
	var rel = node.getAttribute('rel');
	if ( rel ) {
		var typeMatch = rel.match( /(?:^|\s)(mw:[^\s]+)/ );
		if ( typeMatch ) {
			rtData.type = typeMatch[1];
		}
	}

	var href = getHref( env, node );

	// Save the token's "real" href for comparison
	rtData.href = href.replace( /^(\.\.?\/)+/, '' );

	// Now get the target from rt data
	rtData.target = state.serializer.serializedAttrVal(node, 'href', {});

	// Check if the link content has been modified
	// FIXME: This will only work with selser of course. Hard to test without
	// selser.
	var pd = DU.loadDataAttrib(node, "parsoid-diff", {});
	var changes = pd.diff || [];
	if (changes.indexOf('subtree-changed') !== -1) {
		rtData.contentModified = true;
	}

	// Get the content string or tokens
	var contentParts;
	if (node.childNodes.length >= 1 && DU.allChildrenAreText(node)) {
		var contentString = node.textContent;
		if (rtData.target.value && rtData.target.value !== contentString && !dp.pipetrick) {
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
	} else if ( node.childNodes.length ) {
		rtData.contentNode = node;
	} else if ( /^mw:PageProp\/redirect$/.test( rtData.type ) ) {
		rtData.isRedirect = true;
		rtData.prefix = dp.src ||
			( ( env.conf.wiki.mwAliases.redirect[0] || '#REDIRECT' ) + ' ' );
	}

	return rtData;
};

/** The provided URL is already percent-encoded -- but it may still
 *  not be safe for wikitext.  Add additional escapes to make the URL
 *  wikitext-safe. Don't touch percent escapes already in the url,
 *  though!  */
var escapeExtLinkURL = function(url) {
	// this regexp is the negation of EXT_LINK_URL_CLASS in the PHP parser
	return url.replace(/[\]\[<>"\x00-\x20\x7F\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/g, function(m) {
		return Util.entityEncodeAll(m);
	});
};

var escapeWikiLinkContentString = function(linkTarget, state, node) {
	// First, entity-escape the content.
	linkTarget = Util.escapeEntities(linkTarget);

	// Wikitext-escape content.
	//
	// When processing link text, we are no longer in newline state
	// since that will be preceded by "[[" or "[" text in target wikitext.
	state.onSOL = false;
	state.wteHandlerStack.push(state.serializer.wteHandlers.wikilinkHandler);
	state.inLink = true;
	var res = state.serializer.wteHandlers.escapeWikiText(state, linkTarget, { node: node });
	state.inLink = false;
	state.wteHandlerStack.pop();

	// env.isValidLinkTarget doesn't check for anything that the tokenizer
	// already handles. So, handle those here.
	//
	// FIXME: Should we make env.isValidLinkTarget self-contained so that
	// it can be used in other contexts without relying on tokenizer fixups?
	if (!state.env.isValidLinkTarget(linkTarget) || /[\|]/.test(linkTarget)) {
		linkTarget = "MediaWiki:Badtitletext";
	}

	return { contentSrc: res, linkTarget: linkTarget };
};

/**
 * Add a colon escape to a wikilink target string if needed.
 */
var addColonEscape = function(env, linkTarget, linkData) {
	if (linkData.target.fromsrc) {
		return linkTarget;
	}
	var linkTitle = Title.fromPrefixedText(env, linkTarget);
	if (linkTitle
		&& (linkTitle.ns.isCategory() || linkTitle.ns.isFile())
		&& linkData.type === 'mw:WikiLink'
		&& !/^:/.test(linkTarget))
	{
		// Escape category and file links
		return ':' + linkTarget;
	} else {
		return linkTarget;
	}
};

// Figure out if we need a piped or simple link
var isSimpleWikiLink = function(env, dp, target, linkData) {

	var contentString = linkData.content.string,
		canUseSimple = false;

	// Would need to pipe for any non-string content.
	// Preserve unmodified or non-minimal piped links.
	if ( contentString !== undefined
		&& ( target.modified
			|| linkData.contentModified
			|| ( dp.stx !== 'piped' && !dp.pipetrick ) )
		// Relative links are not simple
		&& !contentString.match(/^\.\//))
	{
		// Strip colon escapes from the original target as that is
		// stripped when deriving the content string.
		var strippedTargetValue = target.value.replace(/^:/, ''),
			decodedTarget = Util.decodeURI(Util.decodeEntities(strippedTargetValue)),
			hrefHasProto = /^\w+:\/\//.test(linkData.href);

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
			// normalize without underscores for comparison
			// with target.value and strip any colon escape
		 || env.normalizeTitle( contentString, true ) === Util.decodeURI( strippedTargetValue )
			// Relative link
		 || ( env.conf.wiki.namespacesWithSubpages[ env.page.ns ] &&
			  ( /^\.\.\/.*[^\/]$/.test(strippedTargetValue) &&
			  contentString === env.resolveTitle(strippedTargetValue, env.page.ns) ) ||
			  ( /^\.\.\/.*?\/$/.test(strippedTargetValue) &&
			  contentString === strippedTargetValue.replace(/^(?:\.\.\/)+(.*?)\/$/, '$1') ))
			// if content == href this could be a simple link... eg [[Foo]].
			// but if href is an absolute url with protocol, this won't
			// work: [[http://example.com]] is not a valid simple link!
		 || (!hrefHasProto &&
			 ( contentString === linkData.href ||
			   // normalize with underscores for comparison with href
			   env.normalizeTitle( contentString ) === Util.decodeURI( linkData.href ) ))
		);
	}

	return canUseSimple;
};

// Figure out if we need to use the pipe trick
var usePipeTrick = function(env, dp, target, linkData) {

	var contentString = linkData.content.string;
	if (!dp.pipetrick) {
		return false;
	} else if (linkData.type === 'mw:PageProp/Language') {
		return true;
	} else if (contentString === undefined || linkData.type === 'mw:PageProp/Category') {
		return false;
	}

	// Strip colon escapes from the original target as that is
	// stripped when deriving the content string.
	var strippedTargetValue = target.value.replace(/^:/, ''),
		identicalTarget = function (a, b) {
			return (
				a === Util.stripPipeTrickChars(b) ||
				env.normalizeTitle(a) === env.normalizeTitle(Util.stripPipeTrickChars(Util.decodeURI(b)))
			);
		};

	// Only preserve pipe trick instances across edits, but don't
	// introduce new ones.
	return identicalTarget(contentString, strippedTargetValue)
		|| identicalTarget(contentString, linkData.href)
			// Interwiki links with pipetrick have their prefix
			// stripped, so compare against a stripped version
		|| ( linkData.isInterwiki &&
			  env.normalizeTitle( contentString ) ===
				target.value.replace(/^:?[a-zA-Z]+:/, '') );
};

var linkHandler = function(node, state, cb) {
	// TODO: handle internal/external links etc using RDFa and dataAttribs
	// Also convert unannotated html links without advanced attributes to
	// external wiki links for html import. Might want to consider converting
	// relative links without path component and file extension to wiki links.
	var env = state.env,
		dp = DU.getDataParsoid( node ),
		linkData, contentParts,
		contentSrc = '',
		rel = node.getAttribute('rel') || '';

	// Get the rt data from the token and tplAttrs
	linkData = getLinkRoundTripData(env, node, state);

	if (linkData.type === null && !node.querySelector('IMG')) {
		linkData.type = 'mw:ExtLink';
	}

	if ( linkData.type !== null && linkData.target.value !== null  ) {
		// We have a type and target info

		if (/^mw:ExtLink\//.test(linkData.type)) {
			linkData.type = 'mw:ExtLink';
		}

		var target = linkData.target,
			href = getHref( env, node );
		if (/\b(mw:ExtLink|mw:PageProp\/Language)\b/.test(linkData.type)) {
			var targetVal = target.fromsrc || true ? target.value : Util.decodeURI(target.value);
			// Check if the href matches any of our interwiki URL patterns
			var interWikiMatch = env.conf.wiki.InterWikiMatcher().match(href);
			if (interWikiMatch &&
					// Remaining target
					// 1) is not just a fragment id (#foo), and
					// 2) does not contain a query string.
					// Both are not supported by wikitext syntax.
					!/^#|\?./.test(interWikiMatch[1]) &&
					// ExtLinks should have content to convert.
					( linkData.type !== 'mw:ExtLink' ||
					  ( linkData.content.string || linkData.contentNode ) ) &&
					(dp.isIW || target.modified || linkData.contentModified)) {
				//console.log(interWikiMatch);
				// External link that is really an interwiki link. Convert it.
				if (linkData.type === 'mw:ExtLink') {
					linkData.type = 'mw:WikiLink';
				}
				linkData.isInterwiki = true;
				// could this be confused with a language link?
				var iwi = env.conf.wiki.interwikiMap.get
					( interWikiMatch[0].toLowerCase().replace( /^:/, '' ) );
				linkData.isInterwikiLang = iwi && iwi.language !== undefined;
				// is this our own wiki?
				linkData.isLocal = iwi && iwi.localinterwiki !== undefined;
				// strip off localinterwiki prefixes
				var localPrefix = '', oldPrefix;
				while (true) {
					oldPrefix = target.value.slice(localPrefix.length).
						match(/^(:?[^:]+):/);
					if (!oldPrefix) { break; }
					iwi = env.conf.wiki.interwikiMap.get
						( Util.normalizeNamespaceName
							( oldPrefix[1].replace( /^:/, '' ) ) );
					if (!iwi || iwi.localinterwiki === undefined) { break; }
					localPrefix += oldPrefix[1] + ':';
				}
				// should we preserve the old prefix?
				if (oldPrefix && (
						oldPrefix[1].toLowerCase() === interWikiMatch[0].toLowerCase() ||
						// Check if the old prefix mapped to the same URL as
						// the new one. Use the old one if that's the case.
						// Example: [[w:Foo]] vs. [[:en:Foo]]
						(env.conf.wiki.interwikiMap.get(oldPrefix[1].toLowerCase().trim().replace(/^:/, '')) || {}).url ===
						(env.conf.wiki.interwikiMap.get(interWikiMatch[0].toLowerCase().replace(/^:/, '')) || {}).url
						))
				{
					// Reuse old prefix capitalization
					if (Util.decodeEntities(target.value.substr(oldPrefix[1].length+1)) !== interWikiMatch[1])
					{
						// Modified, update target.value.
						target.value = localPrefix + oldPrefix[1] + ':' + interWikiMatch[1];
					}
					// Else: preserve old encoding
					//console.log(oldPrefix[1], interWikiMatch);
				} else if (/\bmw:PageProp\/Language\b/.test(linkData.type)) {
					target.value = interWikiMatch.join(':').replace(/^:/, '');
				} else if (linkData.isLocal) {
					// - interwikiMatch will be ":en", ":de", etc.
					// - This tests whether the interwiki-like link is actually
					//   a local wikilink.
					target.value = interWikiMatch[1];
					linkData.isInterwiki = linkData.isInterwikiLang = false;
				} else {
					target.value = interWikiMatch.join(':');
				}
			}
		}

		if (/^mw:WikiLink$/.test( linkData.type ) ||
			Util.solTransparentLinkRegexp.test( linkData.type ) ) {
			// Decode any link that did not come from the source
			if (! target.fromsrc) {
				target.value = Util.decodeURI(target.value);
			}

			// Special-case handling for category links
			if ( linkData.type === 'mw:PageProp/Category' ) {
				// Split target and sort key
				var targetParts = target.value.match( /^([^#]*)#(.*)/ ),
					prevNode = node.previousSibling;

				// Check that the previous element isn't a redirect link,
				// as that would mean we're in the output of '#REDIRECT [[Category:…]]'
				// and we don't need to output anything for this one, the
				// redirect took care of that.
				if (prevNode && DU.isElt(prevNode) && DU.hasNodeName(prevNode, "link") &&
					prevNode.getAttribute('rel') === "mw:PageProp/redirect" &&
					prevNode.getAttribute('href') === node.getAttribute('href')) {
					return;
				} else if ( targetParts ) {
					target.value = targetParts[1]
						.replace( /^(\.\.?\/)*/, '' )
						.replace(/_/g, ' ');
					contentParts = splitLinkContentString(
							Util.decodeURI( targetParts[2] )
								.replace( /%23/g, '#' )
								// gwicke: verify that spaces are really
								// double-encoded!
								.replace( /%20/g, ' '),
							dp );
					linkData.content.string = contentParts.contentString;
					dp.tail = linkData.tail = contentParts.tail;
					dp.prefix = linkData.prefix = contentParts.prefix;
				} else if ( dp.pipetrick ) {
					// Handle empty sort key, which is not encoded as fragment
					// in the LinkHandler
					linkData.content.string = '';
				} else { // No sort key, will serialize to simple link
					// Normalize the content string
					linkData.content.string = target.value.replace(/^\.\//, '').replace(/_/g, ' ');
				}

				// Special-case handling for template-affected sort keys
				// FIXME: sort keys cannot be modified yet, but if they are,
				// we need to fully shadow the sort key.
				//if ( ! target.modified ) {
					// The target and source key was not modified
					var sortKeySrc = this.serializedAttrVal(node, 'mw:sortKey', {});
					if ( sortKeySrc.value !== null ) {
						linkData.contentNode = undefined;
						linkData.content.string = sortKeySrc.value;
						// TODO: generalize this flag. It is already used by
						// getAttributeShadowInfo. Maybe use the same
						// structure as its return value?
						linkData.content.fromsrc = true;
					}
				//}
			} else if ( linkData.type === 'mw:PageProp/Language' ) {
				// Fix up the the content string
				// TODO: see if linkData can be cleaner!
				if (linkData.content.string === undefined) {
					linkData.content.string = Util.decodeURI(Util.decodeEntities(target.value));
				}
			}

			// The string value of the content, if it is plain text.
			var linkTarget, escapedRes;

			if ( linkData.isRedirect ) {
				linkTarget = target.value;
				if (target.modified || !target.fromsrc) {
					linkTarget = linkTarget.replace(/^(\.\.?\/)*/, '').replace(/_/g, ' ');
					escapedRes = escapeWikiLinkContentString(linkTarget,
						state, node);
					linkTarget = escapedRes.linkTarget;
					// Determine if it's a redirect to a category, in which case
					// it needs a ':' on front to distingish from a category link.
					var categoryMatch = linkTarget.match(/^([^:]+)[:]/);
					if (categoryMatch) {
						var ns = this.env.conf.wiki.namespaceIds[Util.normalizeNamespaceName(categoryMatch[1])];
						if (ns === this.env.conf.wiki.canonicalNamespaces.category) {
							// Check that the next node isn't a category link,
							// in which case we don't want the ':'.
							var nextNode = node.nextSibling;
							if (!(nextNode && DU.isElt(nextNode) && DU.hasNodeName(nextNode, "link") &&
								nextNode.getAttribute('rel') === "mw:PageProp/Category" &&
								nextNode.getAttribute('href') === node.getAttribute('href'))) {
								linkTarget = ':' + linkTarget;
							}
						}
					}
				}
				cb( new WikiLinkText( linkData.prefix + '[[' + linkTarget + ']]', node, env.conf.wiki, linkData.type ), node );
				return;
			} else if ( isSimpleWikiLink(env, dp, target, linkData) ) {
				// Simple case
				if (!target.modified && !linkData.contentModified) {
					linkTarget = target.value;
				} else {
					escapedRes = escapeWikiLinkContentString(linkData.content.string,
							state, node);
					linkTarget = addColonEscape(this.env, escapedRes.linkTarget, linkData);
					if (linkData.isInterwikiLang && !/^[:]/.test(linkTarget) &&
						linkData.type !== 'mw:PageProp/Language') {
						// ensure interwiki links can't be confused with
						// interlanguage links.
						linkTarget = ':' + linkTarget;
					}
				}
				cb( new WikiLinkText( linkData.prefix + '[[' + linkTarget + ']]' + linkData.tail, node, env.conf.wiki, linkData.type ), node );
				return;
			} else {
				var usePT = usePipeTrick(env, dp, target, linkData);

				// First get the content source
				if ( linkData.contentNode ) {
					contentSrc = state.serializeLinkChildrenToString(
							linkData.contentNode,
							this.wteHandlers.wikilinkHandler, false);
					// strip off the tail and handle the pipe trick
					contentParts = splitLinkContentString(contentSrc, dp);
					contentSrc = contentParts.contentString;
					dp.tail = contentParts.tail;
					linkData.tail = contentParts.tail;
					dp.prefix = contentParts.prefix;
					linkData.prefix = contentParts.prefix;
				} else if ( !usePT ) {
					if (linkData.content.fromsrc) {
						contentSrc = linkData.content.string;
					} else {
						escapedRes = escapeWikiLinkContentString(linkData.content.string || '',
								state, node);
						contentSrc = escapedRes.contentSrc;
					}
				}

				if ( contentSrc === '' && !usePT &&
						linkData.type !== 'mw:PageProp/Category' ) {
					// Protect empty link content from PST pipe trick
					contentSrc = '<nowiki/>';
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
					escapedRes = escapeWikiLinkContentString(linkTarget,
						state, node);
					linkTarget = escapedRes.linkTarget;
				}
				linkTarget = addColonEscape(this.env, linkTarget, linkData);

				cb( new WikiLinkText(
					linkData.prefix +
					'[[' + linkTarget + '|' + contentSrc + ']]' +
					linkData.tail, node, env.conf.wiki, linkData.type ), node );
				return;
			}
		} else if ( linkData.type === 'mw:ExtLink' ) {
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
			// Get plain text content, if any
			var contentStr = node.childNodes.length >= 1 &&
				DU.allChildrenAreText(node) ? node.textContent : null;
			// First check if we can serialize as an URL link
			if ( contentStr &&
					// Can we minimize this?
					( target.value === contentStr  ||
					getHref( env, node ) === contentStr) &&
					// But preserve non-minimal encoding
					(target.modified || linkData.contentModified || dp.stx === 'url'))
			{
				// Serialize as URL link
				cb( new AutoURLLinkText( urlStr, node ), node );
				return;
			} else {
				// TODO: match vs. interwikis too
				var magicLinkMatch = env.conf.wiki.ExtResourceURLPatternMatcher
												.match(href);
				// Fully serialize the content
				contentStr = state.serializeLinkChildrenToString(node,
						this.wteHandlers.aHandler, false);

				// First check for ISBN/RFC/PMID links. We rely on selser to
				// preserve non-minimal forms.
				if (magicLinkMatch) {
					var serializer = env.conf.wiki.ExtResourceSerializer[magicLinkMatch[0]];
					cb( new MagicLinkText( serializer(magicLinkMatch, target.value, contentStr ), node ), node );
					return;
				// There is an interwiki for RFCs, but strangely none for PMIDs.
				} else {
					// serialize as auto-numbered external link
					// [http://example.com]
					var linktext, Construct;

					// If it's just anchor text, serialize as an internal link.
					if ( /^#/.test( urlStr ) ) {
						Construct = WikiLinkText;
						linktext = '[[' + urlStr + (contentStr ? '|' + contentStr : '') + ']]';
					} else {
						Construct = ExtLinkText;
						linktext = '[' + urlStr + (contentStr ? ' ' + contentStr : '') + ']';
					}

					cb( new Construct( linktext, node, env.conf.wiki, linkData.type ), node );
					return;
				}
			}
		} else if ( linkData.type.match( /mw:ExtLink\/(?:RFC|PMID)/ ) ||
					/mw:(?:Wiki|Ext)Link\/ISBN/.test(rel) ) {
			// FIXME: Handle RFC/PMID in generic ExtLink handler by matching prefixes!
			// FIXME: Handle ISBN in generic WikiLink handler by looking for
			// Special:BookSources!
			cb( new MagicLinkText( node.firstChild.nodeValue, node ), node );
			return;
		} else if ( /(?:^|\s)mw:Image/.test(linkData.type) ) {
			this.handleImage( node, state, cb );
			return;
		} else {
			// Unknown rel was set
			//this._htmlElementHandler(node, state, cb);
			if (target.modified || !target.fromsrc) {
				target.value = escapeExtLinkURL(target.value);
			}
			cb( new ExtLinkText(
				'[' + target.value + ' ' +
				state.serializeLinkChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node, env.conf.wiki, linkData.type ), node );
			return;
		}
	} else {
		// TODO: default to extlink for simple links with unknown rel set
		// switch to html only when needed to support attributes

		var safeAttr = new Set(["href", "rel", "class", "title"]);
		var isComplexLink = function ( attributes ) {
			for ( var i=0; i < attributes.length; i++ ) {
				var attr = attributes.item(i);
				// XXX: Don't drop rel and class in every case once a tags are
				// actually supported in the MW default config?
				if ( attr.name && !safeAttr.has(attr.name) ) {
					return true;
				}
			}
			return false;
		};

		if ( isComplexLink ( node.attributes ) ) {
			// Complex attributes we can't support in wiki syntax
			this._htmlElementHandler(node, state, cb);
			return;
		} else if (node.querySelector('IMG') &&
				   node.querySelector('IMG').parentElement === node) {
			// this is a basic html figure: <a><img></a>
			return state.serializer.figureHandler(node, state, cb);
		} else {
			// href is already percent-encoded, etc., but it might contain
			// spaces or other wikitext nasties.  escape the nasties.
			var hrefStr = escapeExtLinkURL(getHref( env, node ));
			cb( new ExtLinkText(
				'[' + hrefStr + ' ' +
				state.serializeLinkChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node, env.conf.wiki, 'mw:ExtLink' ), node );
			return;
		}
	}
};

var figureHandler = function(node, state, cb) {
	var env = state.env,
		mwAliases = env.conf.wiki.mwAliases;
	// All figures have a fixed structure:
	//
	// <figure or span typeof="mw:Image...">
	//  <a or span><img ...><a or span>
	//  <figcaption or span>....</figcaption>
	// </figure or span>
	//
	// Pull out this fixed structure, being as generous as possible with
	// possibly-broken HTML.
	var outerElt = node;
	var imgElt = node.querySelector('IMG'); // first IMG tag
	var linkElt = null;
	// parent of img is probably the linkElt
	if (imgElt &&
		(imgElt.parentElement.tagName === 'A' ||
		 (imgElt.parentElement.tagName === 'SPAN' &&
		  imgElt.parentElement !== outerElt))) {
		linkElt = imgElt.parentElement;
	}
	// FIGCAPTION or last child (which is not the linkElt) is the caption.
	var captionElt = node.querySelector('FIGCAPTION');
	if (!captionElt) {
		for (captionElt = node.lastElementChild;
			 captionElt;
			 captionElt = captionElt.previousElementSibling) {
			if (captionElt !== linkElt && captionElt !== imgElt &&
				/^(SPAN|DIV)$/.test(captionElt.tagName)) {
				break;
			}
		}
	}
	// special case where `node` is the IMG tag itself!
	if (node.tagName === 'IMG') {
		linkElt = captionElt = null;
		outerElt = imgElt = node;
	}

	// The only essential thing is the IMG tag!
	if (!imgElt) {
		this.env.log("error", "In WSP.handleImage, node does not have any img elements:", node.outerHTML );
		return cb( '', node );
	}

	var outerDP = (outerElt) ? DU.getDataParsoid(outerElt) : {};

	// Try to identify the local title to use for this image
	var resource = this.serializedImageAttrVal( outerElt, imgElt, 'resource' );
	if (resource.value === null) {
		// from non-parsoid HTML: try to reconstruct resource from src?
		// (this won't work for manual-thumb images)
		var src = imgElt.getAttribute( 'src' );
		if (!src) {
			this.env.log("error", "In WSP.handleImage, img does not have resource or src:", node.outerHTML);
			return cb( '', node );
		}
		if (/^https?:/.test(src)) {
			// external image link, presumably $wgAllowExternalImages=true
			return cb( new AutoURLLinkText( src, node ), node );
		}
		resource = {
			value: src,
			fromsrc: false,
			modified: false
		};
	}
	if ( !resource.fromsrc ) {
		resource.value = resource.value.replace( /^(\.\.?\/)+/, '' );
	}

	// Do the same for the link
	var link = null;
	if ( linkElt && linkElt.hasAttribute('href') ) {
		link = this.serializedImageAttrVal( outerElt, linkElt, 'href' );
		if ( !link.fromsrc ) {
			if (linkElt.getAttribute('href') === imgElt.getAttribute('resource'))
			{
				// default link: same place as resource
				link = resource;
			}
			link.value = link.value.replace( /^(\.\.?\/)+/, '' );
		}
	}

	// Reconstruct the caption
	var caption = null;
	if (captionElt) {
		state.inCaption = true;
		caption = state.serializeChildrenToString( captionElt, this.wteHandlers.wikilinkHandler, false );
		state.inCaption = false;
	} else if (outerElt) {
		caption = DU.getDataMw(outerElt).caption;
	}

	// Fetch the alt (if any)
	var alt = this.serializedImageAttrVal( outerElt, imgElt, 'alt' );

	// Fetch the lang (if any)
	var lang = this.serializedImageAttrVal( outerElt, imgElt, 'lang' );

	// Ok, start assembling options, beginning with link & alt & lang
	var nopts = [];
	[ { name: 'link', value: link, cond: !(link && link.value === resource.value) },
	  { name: 'alt',  value: alt,  cond: alt.value !== null },
	  { name: 'lang', value: lang, cond: lang.value !== null }
	].forEach(function(o) {
		if (!o.cond) { return; }
		if (o.value && o.value.fromsrc) {
			nopts.push( {
				ck: o.name,
				ak: [ o.value.value ]
			} );
		} else {
			nopts.push( {
				ck: o.name,
				v: o.value ? o.value.value : '',
				ak: mwAliases['img_' + o.name]
			} );
		}
	});

	// Handle class-signified options
	var classes = outerElt ? outerElt.classList : [];
	var extra = []; // 'extra' classes
	var val;

	// work around a bug in domino <= 1.0.13
	if (!outerElt.hasAttribute('class')) { classes = []; }

	for ( var ix = 0; ix < classes.length; ix++ ) {

		switch ( classes[ix] ) {
			case 'mw-halign-none':
			case 'mw-halign-right':
			case 'mw-halign-left':
			case 'mw-halign-center':
				val = classes[ix].replace( /^mw-halign-/, '' );
				nopts.push( {
					ck: val,
					ak: mwAliases['img_' + val]
				} );
				break;

			case 'mw-valign-top':
			case 'mw-valign-middle':
			case 'mw-valign-baseline':
			case 'mw-valign-sub':
			case 'mw-valign-super':
			case 'mw-valign-text-top':
			case 'mw-valign-bottom':
			case 'mw-valign-text-bottom':
				val = classes[ix].replace( /^mw-valign-/, '' ).
					replace(/-/g, '_');
				nopts.push( {
					ck: val,
					ak: mwAliases['img_' + val]
				} );
				break;

			case 'mw-image-border':
				nopts.push( {
					ck: 'border',
					ak: mwAliases.img_border
				} );
				break;

			case 'mw-default-size':
				// handled below
				break;

			default:
				extra.push(classes[ix]);
				break;
		}
	}
	if (extra.length) {
		nopts.push( {
			ck: 'class',
			v: extra.join(' '),
			ak: mwAliases.img_class
		} );
	}

	// Handle options signified by typeof attribute
	var type = (outerElt.getAttribute('typeof') || '').
		match(/(?:^|\s)(mw:Image\S*)/);
	type = type ? type[1] : null;
	var framed = false;

	var manualthumb = DU.getDataMw(outerElt).thumb;
	if (manualthumb !== undefined) {
		type = null;
		nopts.push( {
			ck: 'manualthumb',
			ak: this.getAttributeValue(outerElt, 'manualthumb', mwAliases.img_manualthumb),
			v: manualthumb
		} );
	}

	switch ( type ) {
		case 'mw:Image/Thumb':
			nopts.push( {
				ck: 'thumbnail',
				ak: this.getAttributeValue(outerElt, 'thumbnail', mwAliases.img_thumbnail)
			} );
			break;

		case 'mw:Image/Frame':
			framed = true;
			nopts.push( {
				ck: 'framed',
				ak: this.getAttributeValue(outerElt, 'framed', mwAliases.img_framed)
			} );
			break;

		case 'mw:Image/Frameless':
			nopts.push( {
				ck: 'frameless',
				ak: this.getAttributeValue(outerElt, 'frameless', mwAliases.img_frameless)
			} );
			break;
	}

	// XXX handle page

	// Handle width and height

	// Get the user-specified width/height from wikitext
	var wh = this.serializedImageAttrVal( outerElt, imgElt, 'height' ),
		ww = this.serializedImageAttrVal( outerElt, imgElt, 'width' ),
		getOpt = function(key) {
			if (!outerDP.optList) {
				return null;
			}
			return outerDP.optList.find(function(o) { return o.ck === key; });
		},
		getLastOpt = function(key) {
			var o = outerDP.optList || [], i;
			for (i=o.length-1; i>=0; i--) {
				if (o[i].ck === key) {
					return o[i];
				}
			}
			return null;
		},
		sizeUnmodified = ww.fromDataMW || (!ww.modified && !wh.modified),
		upright = getOpt('upright');

	// XXX: Infer upright factor from default size for all thumbs by default?
	// Better for scaling with user prefs, but requires knowledge about
	// default used in VE.
	if (sizeUnmodified && upright
			// Only serialize upright where it is actually respected
			// This causes some dirty diffs, but makes sure that we don't
			// produce nonsensical output after a type switch.
			// TODO: Only strip if type was actually modified.
			&& type in {'mw:Image/Frameless':1, 'mw:Image/Thumb':1})
	{
		// preserve upright option
		nopts.push({
			ck: upright.ck,
			ak: [upright.ak] // FIXME: don't use ak here!
		});
	}

	if ( !(outerElt && outerElt.classList.contains('mw-default-size')) ) {
		var size = getLastOpt('width'),
			sizeString = (size && size.ak) || (ww.fromDataMW && ww.value);
		if (sizeUnmodified && sizeString) {
			// preserve original width/height string if not touched
			nopts.push( {
				ck: 'width',
				v: sizeString, // original size string
				ak: ['$1'] // don't add px or the like
			} );
		} else {
			var bbox = null;
			// Serialize to a square bounding box
			if (ww.value!==null && ww.value!=='' && ww.value!==undefined) {
				bbox = +ww.value;
			}
			if (wh.value!==null && wh.value!=='' && wh.value!==undefined) {
				var height = +wh.value;
				if (bbox === null || height > bbox) {
					bbox = height;
				}
			}
			if (bbox!==null) {
				nopts.push( {
					ck: 'width',
					// MediaWiki interprets 100px as a width restriction only, so
					// we need to make the bounding box explicitly square
					// (100x100px). The 'px' is added by the alias though, and can
					// be localized.
					v:  bbox + 'x' + bbox,
					ak: mwAliases.img_width // adds the 'px' suffix
				} );
			}
		}
	}

	var opts = outerDP.optList || []; // original wikitext options

	// Add bogus options from old optlist in order to round-trip cleanly (bug 62500)
	opts.forEach(function(o) {
		if (o.ck === 'bogus') {
			nopts.push( {
				ck: 'bogus',
				ak: [ o.ak ]
			});
		}
	});

	// Put the caption last, by default.
	if (typeof(caption) === 'string') {
		nopts.push( {
			ck: 'caption',
			ak: [caption]
		} );
	}

	// ok, sort the new options to match the order given in the old optlist
	// and try to match up the aliases used
	var changed = false;
	nopts.forEach(function(no) {
		// Make sure we have an array here. Default in data-parsoid is
		// actually a string.
		// FIXME: don't reuse ak for two different things!
		if ( !Array.isArray(no.ak) ) {
			no.ak = [no.ak];
		}

		no.sortId = opts.length;
		var idx = opts.findIndex(function(o) {
			return o.ck === no.ck &&
				// for bogus options, make sure the source matches too.
				(o.ck !== 'bogus' || o.ak === no.ak[0]);
		});
		if (idx < 0) {
			// New option, default to English localization for most languages
			// TODO: use first alias (localized) instead for RTL languages (bug
			// 51852)
			no.ak = no.ak.last();
			changed = true;
			return; /* new option */
		}

		no.sortId = idx;
		// use a matching alias, if there is one
		var a = no.ak.find(function(a) {
			// note the trim() here; that allows us to snarf eccentric
			// whitespace from the original option wikitext
			if ('v' in no) { a = a.replace( '$1', no.v ); }
			return a === String(opts[idx].ak).trim();
		});
		// use the alias (incl whitespace) from the original option wikitext
		// if found; otherwise use the last alias given (English default by
		// convention that works everywhere).
		// TODO: use first alias (localized) instead for RTL languages (bug
		// 51852)
		if (a !== undefined && no.ck !== 'caption') {
			no.ak = opts[idx].ak;
			no.v = undefined; // prevent double substitution
		} else {
			no.ak = no.ak.last();
			if ( !(no.ck === 'caption' && a !== undefined) ) {
				changed = true;
			}
		}
	});

	// Filter out bogus options if the image options/caption have changed.
	if (changed) {
		nopts = nopts.filter(function(no) { return no.ck !== 'bogus'; });
		// empty captions should get filtered out in this case, too (bug 62264)
		nopts = nopts.filter(function(no) {
			return !(no.ck === 'caption' && no.ak==='');
		});
	}

	// sort!
	nopts.sort(function(a, b) { return a.sortId - b.sortId; });

	// emit all the options as wikitext!
	var wikitext = '[[' + resource.value;
	nopts.forEach(function(o) {
		wikitext += '|';
		if (o.v !== undefined) {
			wikitext += o.ak.replace( '$1', o.v );
		} else {
			wikitext += o.ak;
		}
	});
	wikitext += ']]';
	cb( new WikiLinkText( wikitext, node, env.conf.wiki, 'mw:Image' ), node );
};

if (typeof module === "object") {
	module.exports.linkHandler = linkHandler;
	module.exports.figureHandler = figureHandler;
}
