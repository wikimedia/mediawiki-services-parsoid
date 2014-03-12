"use strict";

require('./core-upgrade.js');
var Util = require('./mediawiki.Util.js').Util,
	DU = require('./mediawiki.DOMUtils.js').DOMUtils,
	pd = require('./mediawiki.parser.defines.js'),
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

	var href = node.getAttribute('href') || '';

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

var escapeWikiLinkContentString = function(contentString, state, contentNode) {
	// First, entity-escape the content.
	contentString = Util.escapeEntities(contentString);

	// Wikitext-escape content.
	//
	// When processing link text, we are no longer in newline state
	// since that will be preceded by "[[" or "[" text in target wikitext.
	state.onSOL = false;
	state.wteHandlerStack.push(state.serializer.wteHandlers.wikilinkHandler);
	state.inLink = true;
	state.inTable = DU.inTable(contentNode);
	var res = state.serializer.escapeWikiText(state, contentString, { node: contentNode });
	state.inLink = false;
	state.wteHandlerStack.pop();
	return res;
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

	// Would need to pipe for any non-string content
	// Preserve unmodified or non-minimal piped links
	if ( contentString !== undefined
		&& ( target.modified
			|| linkData.contentModified
			|| ( dp.stx !== 'piped' && !dp.pipetrick ) ))
	{
		// Strip colon escapes from the original target as that is
		// stripped when deriving the content string.
		var strippedTargetValue = target.value.replace(/^:/, ''),
			decodedTarget = Util.decodeURI(Util.decodeEntities(strippedTargetValue));

		// See if the (normalized) content matches the
		// target, either shadowed or actual.
		canUseSimple = (
			contentString === decodedTarget
			// try wrapped in forward slashes in case they were stripped
		 || ('/' + contentString + '/') === decodedTarget
		 || contentString === linkData.href
			// normalize without underscores for comparison
			// with target.value and strip any colon escape
		 || env.normalizeTitle( contentString, true ) === Util.decodeURI( strippedTargetValue )
			// Relative link
		 || ( env.conf.wiki.namespacesWithSubpages[ env.page.ns ] &&
			  ( /^\.\.\/.*[^\/]$/.test(strippedTargetValue) &&
			  contentString === env.resolveTitle(strippedTargetValue, env.page.ns) ) ||
			  ( /^\.\.\/.*?\/$/.test(strippedTargetValue) &&
			  contentString === strippedTargetValue.replace(/^(?:\.\.\/)+(.*?)\/$/, '$1') ))
			// normalize with underscores for comparison with href
		 || env.normalizeTitle( contentString ) === Util.decodeURI( linkData.href )
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

	if ( linkData.type !== null && linkData.target.value !== null  ) {
		// We have a type and target info

		// Temporary backwards-compatibility for types
		if (linkData.type === 'mw:WikiLink/Category') {
			linkData.type = 'mw:PageProp/Category';
		} else if (linkData.type === 'mw:WikiLink/Language') {
			linkData.type = 'mw:PageProp/Language';
		} else if (/^mw:ExtLink\//.test(linkData.type)) {
			linkData.type = 'mw:ExtLink';
		}

		var target = linkData.target,
			href = node.getAttribute('href') || '';
		if (/mw.ExtLink/.test(linkData.type)) {
			var targetVal = target.fromsrc || true ? target.value : Util.decodeURI(target.value);
			// Check if the href matches any of our interwiki URL patterns
				var interWikiMatch = env.conf.wiki.InterWikiMatcher.match(href);
			if (interWikiMatch &&
					// Remaining target
					// 1) is not just a fragment id (#foo), and
					// 2) does not contain a query string.
					// Both are not supported by wikitext syntax.
					!/^#|\?./.test(interWikiMatch[1]) &&
					(dp.isIW || target.modified || linkData.contentModified)) {
				//console.log(interWikiMatch);
				// External link that is really an interwiki link. Convert it.
				linkData.type = 'mw:WikiLink';
				linkData.isInterwiki = true;
				var oldPrefix = target.value.match(/^(:?[^:]+):/);
				if (oldPrefix && (
						oldPrefix[1].toLowerCase() === interWikiMatch[0].toLowerCase() ||
						// Check if the old prefix mapped to the same URL as
						// the new one. Use the old one if that's the case.
						// Example: [[w:Foo]] vs. [[:en:Foo]]
						(env.conf.wiki.interwikiMap[oldPrefix[1].toLowerCase()] || {}).url ===
						(env.conf.wiki.interwikiMap[interWikiMatch[0].replace(/^:/, '')] || {}).url
						))
				{
					// Reuse old prefix capitalization
					if (Util.decodeEntities(target.value.substr(oldPrefix[1].length+1)) !== interWikiMatch[1])
					{
						// Modified, update target.value.
						target.value = oldPrefix[1] + ':' + interWikiMatch[1];
					}
					// Else: preserve old encoding
					//console.log(oldPrefix[1], interWikiMatch);
				} else {
					target.value = interWikiMatch.join(':');
				}
			}
		}

		if (/^mw:WikiLink$/.test( linkData.type ) ||
		    /^mw:PageProp\/(?:redirect|Category|Language)$/.test( linkData.type ) ) {
			// Decode any link that did not come from the source
			if (! target.fromsrc) {
				target.value = Util.decodeURI(target.value);
			}

			// Special-case handling for category links
			if ( linkData.type === 'mw:WikiLink/Category' ||
					linkData.type === 'mw:PageProp/Category' ) {
				// Split target and sort key
				var targetParts = target.value.match( /^([^#]*)#(.*)/ );
				if ( targetParts ) {
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
					linkData.content.string = target.value;
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
			var linkTarget;

			if ( linkData.isRedirect ) {
				linkTarget = target.value;
				if (target.modified || !target.fromsrc) {
					linkTarget = linkTarget.replace(/^(\.\.?\/)*/, '').replace(/_/g, ' ');
					linkTarget = escapeWikiLinkContentString(linkTarget,
						state, linkData.contentNode);
				}
				cb( linkData.prefix + '[[' + linkTarget + ']]', node );
				return;
			} else if ( isSimpleWikiLink(env, dp, target, linkData) ) {
				// Simple case
				if (!target.modified && !linkData.contentModified) {
					linkTarget = target.value;
				} else {
					linkTarget = escapeWikiLinkContentString(linkData.content.string,
							state, linkData.contentNode);
					linkTarget = addColonEscape(this.env, linkTarget, linkData);
				}

				cb( linkData.prefix + '[[' + linkTarget + ']]' + linkData.tail, node );
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
						contentSrc = escapeWikiLinkContentString(linkData.content.string || '',
								state, linkData.contentNode);
					}
				}

				if ( contentSrc === '' && !usePT &&
						linkData.type !== 'mw:PageProp/Category' ) {
					// Protect empty link content from PST pipe trick
					contentSrc = '<nowiki/>';
				}
				linkTarget = target.value;
				linkTarget = addColonEscape(this.env, linkTarget, linkData);

				cb( linkData.prefix + '[[' + linkTarget + '|' + contentSrc + ']]' +
						linkData.tail, node );
				return;
			}
		} else if ( linkData.type === 'mw:ExtLink' ) {
			// Get plain text content, if any
			var contentStr = node.childNodes.length === 1 &&
								node.firstChild.nodeType === node.TEXT_NODE &&
								node.firstChild.nodeValue;
			// First check if we can serialize as an URL link
			if ( contentStr &&
					// Can we minimize this?
					( target.value === contentStr  ||
					node.getAttribute('href') === contentStr) &&
					// But preserve non-minimal encoding
					(target.modified || linkData.contentModified || dp.stx === 'url'))
			{
				// Serialize as URL link
				cb(target.value, node);
				return;
			} else {
				// TODO: match vs. interwikis too
				var extLinkResourceMatch = env.conf.wiki.ExtResourceURLPatternMatcher
												.match(href);
				// Fully serialize the content
				contentStr = state.serializeLinkChildrenToString(node,
						this.wteHandlers.aHandler, false);

				// First check for ISBN/RFC/PMID links. We rely on selser to
				// preserve non-minimal forms.
				if (extLinkResourceMatch) {
					var protocol = extLinkResourceMatch[0],
						serializer = env.conf.wiki.ExtResourceSerializer[protocol];

					cb(serializer(extLinkResourceMatch, target.value, contentStr), node);
					return;
				// There is an interwiki for RFCs, but strangely none for PMIDs.
				} else if (!contentStr) {
					// serialize as auto-numbered external link
					// [http://example.com]
					cb( '[' + target.value + ']', node);
					return;
				} else {

					// We expect modified hrefs to be percent-encoded already, so
					// don't need to encode them here any more. Unmodified hrefs are
					// just using the original encoding anyway.
					cb( '[' + target.value + ' ' + contentStr + ']', node );
					return;
				}
			}
		} else if ( linkData.type.match( /mw:ExtLink\/(?:RFC|PMID)/ ) ||
					/mw:(?:Wiki|Ext)Link\/ISBN/.test(rel) ) {
			// FIXME: Handle RFC/PMID in generic ExtLink handler by matching prefixes!
			// FIXME: Handle ISBN in generic WikiLink handler by looking for
			// Special:BookSources!
			cb( node.firstChild.nodeValue, node );
			return;
		} else if ( /(?:^|\s)mw:Image/.test(linkData.type) ) {
			this.handleImage( node, state, cb );
			return;
		} else {
			// Unknown rel was set
			//this._htmlElementHandler(node, state, cb);
			if ( target.modified ) {
				// encodeURI only encodes spaces and the like
				target.value = encodeURI(target.value);
			}
			cb( '[' + target.value + ' ' +
				state.serializeLinkChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node );
			return;
		}
	} else {
		// TODO: default to extlink for simple links with unknown rel set
		// switch to html only when needed to support attributes

		var isComplexLink = function ( attributes ) {
			for ( var i=0; i < attributes.length; i++ ) {
				var attr = attributes.item(i);
				// XXX: Don't drop rel and class in every case once a tags are
				// actually supported in the MW default config?
				if ( attr.name && ! ( attr.name in { href: 1, rel:1, 'class':1 } ) ) {
					return true;
				}
			}
			return false;
		};

		if ( isComplexLink ( node.attributes ) ) {
			// Complex attributes we can't support in wiki syntax
			this._htmlElementHandler(node, state, cb);
			return;
		} else {
			// encodeURI only encodes spaces and the like
			var hrefStr = encodeURI(node.getAttribute('href'));
			cb( '[' + hrefStr + ' ' +
				state.serializeLinkChildrenToString(node, this.wteHandlers.aHandler, false) +
				']', node );
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
		imgElt.parentElement !== outerElt &&
		/^(A|SPAN)$/.test(imgElt.parentElement.tagName)) {
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

	var outerDP = (outerElt && outerElt.hasAttribute( 'data-parsoid' )) ?
		DU.getDataParsoid(outerElt) : {};

	// Try to identify the local title to use for this image
	var resource = this.serializedImageAttrVal( outerElt, imgElt, 'resource' );
	if (resource.value === null) {
		// from non-parsoid HTML: try to reconstruct resource from src?
		var src = imgElt.getAttribute( 'src' );
		if (!src) {
			this.env.log("error", "In WSP.handleImage, img does not have resource or src:", node.outerHTML);
			return cb( '', node );
		}
		if (/^https?:/.test(src)) {
			// external image link, presumably $wgAllowExternalImages=true
			return cb( src, node );
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

	switch ( type ) {
		case 'mw:Image/Thumb':
			nopts.push( {
				ck: 'thumbnail',
				ak: this.getAttrValFromDataMW(outerElt, 'thumbnail', mwAliases.img_thumbnail)
			} );
			break;

		case 'mw:Image/Frame':
			framed = true;
			nopts.push( {
				ck: 'framed',
				ak: this.getAttrValFromDataMW(outerElt, 'framed', mwAliases.img_framed)
			} );
			break;

		case 'mw:Image/Frameless':
			nopts.push( {
				ck: 'frameless',
				ak: this.getAttrValFromDataMW(outerElt, 'frameless', mwAliases.img_frameless)
			} );
			break;
	}

	// XXX handle page
	// XXX handle manualthumb


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
			if (ww.value!==null && ww.value!=='') {
				//val += ww.value;
				try {
					bbox = Number(ww.value);
				} catch (e) {}
			}
			if (wh.value!==null && wh.value!=='') {
				//val += 'x' + wh.value;
				try {
					var height = Number(wh.value);
					if (bbox === null || framed || height > bbox) {
						bbox = height;
					}
				} catch (e) {}
			}
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
	cb( wikitext, node );
};

if (typeof module === "object") {
	module.exports.linkHandler = linkHandler;
	module.exports.figureHandler = figureHandler;
}
