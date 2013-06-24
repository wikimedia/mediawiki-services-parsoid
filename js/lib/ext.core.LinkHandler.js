"use strict";
/*
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 */

var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	WikitextConstants = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	Title = require( './mediawiki.Title.js' ).Title,
	Util = require('./mediawiki.Util.js').Util,
	// Why mess around? We already have a URL sanitizer.
	sanitizerLib = require( './ext.core.Sanitizer.js' ),
	Sanitizer = sanitizerLib.Sanitizer,
	SanitizerConstants = sanitizerLib.SanitizerConstants,
	defines = require('./mediawiki.parser.defines.js'),
	DU = require('./mediawiki.DOMUtils.js').DOMUtils;
// define some constructor shortcuts
var KV = defines.KV,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk,
    EndTagTk = defines.EndTagTk,
	ImageInfoRequest = require( './mediawiki.ApiRequest.js' ).ImageInfoRequest;

function WikiLinkHandler( manager, options ) {
	this.manager = manager;
	// Handle redirects first as they can emit additonal link tokens
	this.manager.addTransform( this.onRedirect.bind( this ), "WikiLinkHandler:onRedirect", this.rank, 'tag', 'mw:redirect' );
	// Now handle regular wikilinks.
	this.manager.addTransform( this.onWikiLink.bind( this ), "WikiLinkHandler:onWikiLink", this.rank + 0.001, 'tag', 'wikilink' );
	// create a new peg parser for image options..
	if ( !this.urlParser ) {
		// Actually the regular tokenizer, but we'll call it with the
		// img_options production only.
		WikiLinkHandler.prototype.urlParser = new PegTokenizer();
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
 * - fromColonEscapedText: target was colon-escaped ([[:en:foo]])
 * - prefix: the original namespace or language/interwiki prefix without a
 *   colon escape
 *
 * @returns {Object} The target info
 */
WikiLinkHandler.prototype.getWikiLinkTargetInfo = function (token) {
	var hrefInfo = Util.lookupKV( token.attribs, 'href' ),
		info = {
			href: Util.tokensToString(hrefInfo.v),
			hrefSrc: hrefInfo.vsrc
		},
		env = this.manager.env,
		href = info.href;

	if (/^:/.test(info.href)) {
		info.fromColonEscapedText = true;
		// remove the colon escape
		info.href = info.href.substr(1);
		href = info.href;
	}

	var nsPrefix = href.split( ':', 1 )[0];
	href = env.normalizeTitle( href, false, true );
	if ( nsPrefix && nsPrefix !== href ) {
		info.prefix = nsPrefix;
		var interwikiInfo = env.conf.wiki.interwikiMap[nsPrefix.toLowerCase()
														.replace( ' ', '_' )],
			// check for interwiki / language links
			ns = env.conf.wiki.canonicalNamespaces[ nsPrefix.toLowerCase()
														.replace( ' ', '_' ) ];
		//console.warn( JSON.stringify( [ nsText, ns ] ) );
		if ( interwikiInfo ) {
			// interwiki or language link
			if (info.fromColonEscapedText || interwikiInfo.language === undefined ) {
				info.interwiki = interwikiInfo;
				info.href = info.href.substr( nsPrefix.length + 1 );
			} else {
				info.language = interwikiInfo;
				info.href = info.href.substr( nsPrefix.length + 1 );
			}
		} else if ( ns !== undefined ) {
			// FIXME: percent-decode first, then entity-decode!
			info.title = new Title( Util.decodeURI(href.substr( nsPrefix.length + 1 )),
					ns, nsPrefix, env );
		} else {
			info.title = new Title( Util.decodeURI(href), 0, '', env );
		}
	} else if ( /^(\#|\/|\.\.\/)/.test( href ) ) {
		// If the link is relative, use the page's namespace.
		info.title = new Title( Util.decodeURI(href), env.page.meta.ns, '', env );
	} else {
		info.title = new Title( Util.decodeURI(href), 0, '', env );
	}

	return info;
};

/**
 * Handle mw:redirect tokens.
 */
WikiLinkHandler.prototype.onRedirect = function ( token, frame, cb ) {
	var rlink = new SelfclosingTagTk( 'link', [],
			Util.clone( token.dataAttribs ) ),
		wikiLinkTk = rlink.dataAttribs.linkTk,
		target = this.getWikiLinkTargetInfo(token);

	// Remove the nested wikiLinkTk token
	rlink.dataAttribs.linkTk = undefined;

	rlink.addAttribute( 'rel', 'mw:PageProp/redirect' );

	rlink.addNormalizedAttribute( 'href', target.title.makeLink(), target.hrefSrc );

	var tokens = [rlink];
	if (target.title && target.title.ns.isCategory() && !target.title.fromColonEscapedText) {
		// Add the category link token back into the token stream. This means
		// that this is both a redirect and a category link.
		//
		// Also, this won't round-trip without selser. Instead it will
		// duplicate [[Category:Foo]] on each round-trip. As these
		// redirects should really be to [[:Category:Foo]] these cases
		// should be rare enough to not add much noise in rt testing.
		tokens.push(wikiLinkTk);
	}
	cb ({ tokens: tokens });
};



/**
 * Handle a mw:WikiLink token.
 */
WikiLinkHandler.prototype.onWikiLink = function ( token, frame, cb ) {

	var j, maybeContent, about, possibleTags, property, newType,
		hrefkv, strContent, saniContent, env = this.manager.env,
		// move out
		attribs = token.attribs,
		redirect = Util.lookup( attribs, 'redirect' ),
		target = this.getWikiLinkTargetInfo(token);

	// First check if the expanded href contains a pipe.
	if (/[|]/.test(target.href)) {
		// It does. This 'href' was templated and also returned other
		// parameters separated by a pipe. We don't have any sane way to
		// handle such a construct currently, so prevent people from editing
		// it.
		// TODO: add useful debugging info for editors ('if you would like to
		// make this content editable, then fix template X..')
		// TODO: also check other parameters for pipes!
		cb ({tokens: [new SelfclosingTagTk('meta',
					[new KV('typeof', 'mw:Placeholder')], token.dataAttribs)]});
		return;
	}

	// Ok, it looks like we have a sane href. Figure out which handler to use.
	var handler = this.getWikiLinkHandler(token, target);
	// and call it.
	handler(token, frame, cb, target);
};

/**
 * Figure out which handler to use to render a given WikiLink token. Override
 * this method to add new handlers or swap out existing handlers based on the
 * target structure.
 */
WikiLinkHandler.prototype.getWikiLinkHandler = function (token, target) {
	var title = target.title;
	if ( title ) {
		if (!target.fromColonEscapedText) {
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
	var newAttrs = [],
		linkText = [],
		about;

	// In one pass through the attribute array, fetch about, typeof, and
	// linkText
	//
	// about && typeof are usually at the end of the array if at all present
	for ( var i = 0, l = attrs.length; i < l; i++ ) {
		var kv = attrs[i],
			k  = kv.k,
			v  = kv.v;

		// link-text attrs have the key "maybeContent"
		if (getLinkText && k === "mw:maybeContent") {
			linkText.push(kv);
		} else if (k.constructor === String && k) {
			if (k.trim() === "typeof") {
				rdfaType = rdfaType ? rdfaType + " " + v : v;
			} else if (k.trim() === "about") {
				about = v;
			}
		}
	}

	if (rdfaType) {
		newAttrs.push(new KV( 'typeof', rdfaType ));
	}

	if (about) {
		newAttrs.push(new KV('about', about));
	}

	if (linkAttrs) {
		newAttrs = newAttrs.concat(linkAttrs);
	}

	return {
		attribs: newAttrs,
		content: linkText,
		hasRdfaType: rdfaType !== null
	};
}

/**
 * Generic wiki link attribute setup on a passed-in new token based on the
 * wikilink token and target. As a side effect, this method also extracts the
 * link content tokens and returns them.
 *
 * @returns {Array} Content tokens
 */
WikiLinkHandler.prototype.addLinkAttributesAndGetContent = function (newTk, token, target) {
	//console.warn( 'title: ' + JSON.stringify( title ) );
	var title = target.title,
		attribs = token.attribs,
		newAttrData = buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]),
		content = newAttrData.content;
	// Set attribs and dataAttribs
	newTk.attribs = newAttrData.attribs;
	newTk.dataAttribs = Util.clone(token.dataAttribs);

	newTk.dataAttribs.src = undefined; // clear src string since we can serialize this

	// Note: Link tails are handled on the DOM in handleLinkNeighbours, so no
	// need to handle them here.
	if ( content.length > 0 ) {
		var out = [];
		// re-join content bits
		for ( var i = 0, l = content.length; i < l ; i++ ) {
			out = out.concat( content[i].v );
			if ( i < l - 1 ) {
				out.push( '|' );
			}
		}
		newTk.dataAttribs.stx = 'piped';
		content = out;
	} else {
		var morecontent = Util.decodeURI(target.href);
		newTk.dataAttribs.stx = 'simple';
		if ( token.dataAttribs.pipetrick ) {
			morecontent = Util.stripPipeTrickChars(morecontent);
		}

		// Strip leading colon
		morecontent = morecontent.replace(/^:/, '');

		content = [ morecontent ];
	}
	return content;
};

/**
 * Render a plain wiki link.
 */
WikiLinkHandler.prototype.renderWikiLink = function (token, frame, cb, target) {
	var tokens = [],
		newTk = new TagTk('a'),
		content = this.addLinkAttributesAndGetContent(newTk, token, target);

	newTk.addNormalizedAttribute( 'href', target.title.makeLink(), target.hrefSrc );

	tokens.push( newTk );
	tokens = tokens.concat(content, [new EndTagTk('a')]);

	cb({tokens: tokens});
};

/**
 * Render a category 'link'. Categories are really page properties, and are
 * normally rendered in a box at the bottom of an article.
 */
WikiLinkHandler.prototype.renderCategory = function (token, frame, cb, target) {

	var tokens = [],
		newTk = new SelfclosingTagTk('link'),
		content = this.addLinkAttributesAndGetContent(newTk, token, target);

	// Change the rel to be mw:WikiLink / Category
	Util.lookupKV( newTk.attribs, 'rel' ).v += '/Category';

	var strContent = Util.tokensToString( content ),
		saniContent = Util.sanitizeTitleURI( strContent ).replace( /#/g, '%23' );
	newTk.addNormalizedAttribute( 'href', target.title.makeLink(), target.hrefSrc );
	// Change the href to include the sort key, if any (but don't update the
	// rt info)
	if ( strContent && strContent !== '' && strContent !== target.href ) {
		var hrefkv = Util.lookupKV( newTk.attribs, 'href' );
		hrefkv.v += '#';
		hrefkv.v += saniContent;
	}

	tokens.push( newTk );

	// Deal with sort keys generated via templates/extensions
	var producerInfo = Util.lookupKV( token.attribs, 'mw:valAffected' );
	if (producerInfo) {
		// Ensure that the link has about set
		var about = Util.lookup( newTk.attribs, 'about' );
		if (!about) {
			about = this.manager.env.newAboutId();
			newTk.addAttribute("about", about);
		}

		// Update typeof
		newTk.addSpaceSeparatedAttribute("typeof",
				"mw:ExpandedAttrs/" + producerInfo.v[0].match(/mw:(.*)/)[1]);

		// Update producer meta-token and add it to the token stream
		var metaToken = producerInfo.v[1];
		metaToken.addAttribute("about", about);
		var propKV = Util.lookupKV(metaToken.attribs, "property");
		propKV.v = propKV.v.replace(/mw:maybeContent/, 'mw:sortKey'); // keep it clean
		tokens.push(metaToken);
	}
	cb({tokens: tokens});
};


/**
 * Render a language link. Those normally appear in the list of alternate
 * languages for an article in the sidebar, so are really a page property.
 */
WikiLinkHandler.prototype.renderLanguageLink = function (token, frame, cb, target) {
	// The prefix is listed in the interwiki map

	var newTk = new SelfclosingTagTk('link', [], token.dataAttribs),
		content = this.addLinkAttributesAndGetContent(newTk, token, target);

	// We set an absolute link to the article in the other wiki/language
	var absHref = target.language.url.replace( "$1", target.href );
	newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

	// Change the rel to be mw:WikiLink/Language
	Util.lookupKV( newTk.attribs, 'rel' ).v = 'mw:WikiLink/Language';

	cb({tokens: [newTk]});
};

/**
 * Render an interwiki link.
 */
WikiLinkHandler.prototype.renderInterwikiLink = function (token, frame, cb, target) {
	// The prefix is listed in the interwiki map

	var tokens = [],
		newTk = new TagTk('a', [], token.dataAttribs),
		content = this.addLinkAttributesAndGetContent(newTk, token, target);

	// We set an absolute link to the article in the other wiki/language
	var absHref = target.interwiki.url.replace( "$1", target.href );
	newTk.addNormalizedAttribute('href', absHref, target.hrefSrc);

	// Change the rel to be mw:WikiLink/Interwiki
	Util.lookupKV( newTk.attribs, 'rel' ).v = 'mw:WikiLink/Interwiki';

	tokens.push( newTk );

	// If this is a simple link, include the prefix in the link text
	if (newTk.dataAttribs.stx === 'simple' && !newTk.dataAttribs.pipetrick) {
		content.unshift(target.prefix + ':');
	}

	tokens = tokens.concat( content,
			[new EndTagTk( 'a' )] );
	cb({tokens: tokens});
};


/**
 * Handle the dimensions for an image
 *
 * @private
 * @param {number} height
 * @param {number} width
 * @param {Object} info Image info for the image in question
 * @param {number/null} info.height
 * @param {number/null} info.width
 * @param {string/null} info.thumburl
 * @param {number/null} info.thumbwidth
 * @param {number/null} info.thumbheight
 * @param {Object} dataAttribs Data attributes for the image, which we may modify
 * @returns {Object}
 * @returns {number} return.h
 * @returns {number} return.w
 */
function handleDims( height, width, info, dataAttribs ) {
	if ( info.height ) {
		height = info.height;
		dataAttribs.img.h = height;
	}

	if ( info.width ) {
		width = info.width;
		dataAttribs.img.w = width;
	}

	if ( info.thumburl && info.thumbheight ) {
		height = info.thumbheight;
	}

	if ( info.thumburl && info.thumbwidth ) {
		width = info.thumbwidth;
	}

	return {
		h: height,
		w: width
	};
}

/**
 * Get the style and class lists for an image's wrapper element
 *
 * @private
 * @param {Object} oHash The option hash from renderFile
 * @param {boolean} isInline Whether the image is inline
 * @param {boolean} isFloat Whether the image is floated
 * @returns {Object}
 * @returns {boolean} return.isInline Whether the image is inline after handling options
 * @returns {boolean} return.isFloat Whether the image is floated after handling options
 * @returns {Array} return.classes The list of classes for the wrapper
 * @returns {Array} return.styles The list of styles for the wrapper
 */
function getWrapperInfo( oHash, isInline, isFloat ) {
	var wrapperStyles = [],
		wrapperClasses = [],
		halign = ( oHash.format === 'framed' ) ? 'right' : null,
		valign = 'middle';

	if ( oHash.height === null && oHash.width === null ) {
		wrapperClasses.push( 'mw-default-size' );
	}

	if ( oHash.border ) {
		wrapperClasses.push( 'mw-image-border' );
	}

	if ( oHash.halign ) {
		halign = oHash.halign;
	}

	switch ( halign ) {
		case 'none':
			// PHP parser wraps in <div class="floatnone">
			isInline = false;

			if ( oHash.halign === 'none' ) {
				wrapperClasses.push( 'mw-halign-none' );
			}
			break;

		case 'center':
			// PHP parser wraps in <div class="center"><div class="floatnone">
			isInline = false;
			wrapperStyles.push( 'text-align: center;' );

			if ( oHash.halign === 'center' ) {
				wrapperClasses.push( 'mw-halign-center' );
			}
			break;

		case 'left':
			// PHP parser wraps in <div class="floatleft">
			isInline = false;
			isFloat = true;
			wrapperStyles.push( 'float: left;' );

			if ( oHash.halign === 'left' ) {
				wrapperClasses.push( 'mw-halign-left' );
			}
			break;

		case 'right':
			// PHP parser wraps in <div class="floatright">
			isInline = false;
			isFloat = true;
			wrapperStyles.push( 'float: right;' );

			if ( oHash.halign === 'right' ) {
				wrapperClasses.push( 'mw-halign-right' );
			}
			break;
	}

	if ( oHash.valign ) {
		valign = oHash.valign;
	}

	if ( isInline && !isFloat ) {
		wrapperStyles.push( 'vertical-align: ' + valign.replace( /_/, '-' ) + ';' );
	}

	if ( isInline ) {
		switch ( oHash.valign ) {
			case 'middle':
				wrapperClasses.push( 'mw-valign-middle' );
				break;

			case 'baseline':
				wrapperClasses.push( 'mw-valign-baseline' );
				break;

			case 'sub':
				wrapperClasses.push( 'mw-valign-sub' );
				break;

			case 'super':
				wrapperClasses.push( 'mw-valign-super' );
				break;

			case 'top':
				wrapperClasses.push( 'mw-valign-top' );
				break;

			case 'text_top':
				wrapperClasses.push( 'mw-valign-text-top' );
				break;

			case 'bottom':
				wrapperClasses.push( 'mw-valign-bottom' );
				break;

			case 'text_bottom':
				wrapperClasses.push( 'mw-valign-text-bottom' );
				break;
		}
	} else {
		wrapperStyles.push( 'display: block;' );
	}

	return {
		styles: wrapperStyles,
		classes: wrapperClasses,
		isInline: isInline,
		isFloat: isFloat
	};
}

/**
 * Abstract way to get the path for an image given an info object
 *
 * @private
 * @param {Object} info
 * @param {string/null} info.thumburl The URL for a thumbnail
 * @param {string} info.url The base URL for the image
 */
function getPath( info ) {
	var path;
	if ( info.thumburl ) {
		path = info.thumburl;
	} else if ( info.url ) {
		path = info.url;
	}
	return path.replace(/^https?:\/\//, '//');
}

// It turns out that image captions can have unclosed block tags which
// then messes up the entire DOM and wraps the reset of the page into
// the image caption which is wrong and also screws up the RTing in
// turn.  So, we forcibly close all unclosed block tags by treating
// the caption as a well-nested DOM context.
//
// TODO: Actually build a real DOM so that inlines etc are
// encapsulated too. This would need to apply phase 3 token
// transforms, as the caption as an attribute is already expanded to
// phase 2.
function closeUnclosedBlockTags(tokens) {
	var i, j, n, t,
		// Store the index of a token in the 'tokens' array
		// rather than the token itself.
		openBlockTagStack = [];

	for (i = 0, n = tokens.length; i < n; i++) {
		t = tokens[i];
		if (Util.isBlockToken(t)) {
			if (t.constructor === TagTk) {
				openBlockTagStack.push(i);
			} else if (t.constructor === EndTagTk && openBlockTagStack.length > 0) {
				if (tokens[openBlockTagStack.last()].name === t.name) {
					openBlockTagStack.pop();
				}
			}
		}
	}

	n = openBlockTagStack.length;
	if (n > 0) {
		if (Object.isFrozen(tokens)) {
			tokens = tokens.slice();
		}
		for (i = 0; i < n; i++) {
			j = openBlockTagStack.pop();
			t = tokens[j].clone();
			t.dataAttribs.autoInsertedEnd = true;
			tokens[j] = t;
			tokens.push(new EndTagTk(t.name));
		}
	}

	return tokens;
}

/**
 * Render a file. This can be an image, a sound, a PDF etc.
 *
 * FIXME: move all these nested functions out so that the data flow becomes
 * clearer.
 */
WikiLinkHandler.prototype.renderFile = function (token, frame, cb, target)
{
	var fileName = target.href,
		title = target.title;
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
	function getOptionInfo( optStr ) {
		var returnObj,
			oText = optStr.trim(),
			lowerOText = oText.toLowerCase(),

			// oText contains the localized name of this option.  the
			// canonical option names (from mediawiki upstream) are in
			// English and contain an 'img_' prefix.  We drop the
			// prefix before stuffing them in data-parsoid in order to
			// save space (that's shortCanonicalOption)

			canonicalOption = ( env.conf.wiki.magicWords[oText] ||
				env.conf.wiki.magicWords[lowerOText] ||
				( 'img_' + lowerOText ) ),
			shortCanonicalOption = canonicalOption.replace( /^img_/,  '' ),

			// 'imgOption' is the key we'd put in oHash; it names the 'group'
			// for the option, and doesn't have an img_ prefix.

			imgOption = WikitextConstants.Image.SimpleOptions[canonicalOption],
			bits = getOption( optStr.trim() ),
			normalizedBit0 = bits ? bits.k.trim().toLowerCase() : null,
			key = bits ? WikitextConstants.Image.PrefixOptions[normalizedBit0] : null;

		if (imgOption && key === null) {
			return {
				ck: imgOption,
				v: shortCanonicalOption,
				ak: optStr,
				s: true
			};
		} else {
			// bits.a has the localized name for the prefix option
			// (with $1 as a placeholder for the value, which is in bits.v)
			// 'normalizedBit0' is the canonical English option name
			// (from mediawiki upstream) with an img_ prefix.
			// 'key' is the parsoid 'group' for the option; it doesn't
			// have an img_ prefix (it's the key we'd put in oHash)

			if ( bits && key ) {
				shortCanonicalOption = normalizedBit0.replace(/^img_/, '');
				// map short canonical name to the localized version used
				return {
					ck: shortCanonicalOption,
					v: bits.v,
					ak: optStr,
					s: false
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
	 * @returns {string}
	 */
	function stringifyOptionTokens( tstream, prefix ) {
		var i, currentToken, tokenType, tkHref, nextResult,
			skipToEndOf,
			resultStr = '';

		prefix = prefix || '';

		for ( i = 0; i < tstream.length; i++ ) {
			if ( skipToEndOf ) {
				if ( currentToken.name === skipToEndOf && currentToken.constructor === EndTagTk ) {
					skipToEndOf = undefined;
				}
				continue;
			}

			currentToken = tstream[i];

			if ( currentToken.constructor === String ) {
				resultStr += currentToken;
			} else if ( currentToken.constructor === Array ) {
				nextResult = stringifyOptionTokens( currentToken, prefix + resultStr );

				if ( nextResult === null ) {
					return null;
				}

				resultStr += nextResult;
			} else {
				// This is actually a token
				if ( currentToken.name === 'a' ) {
					if ( optInfo === undefined ) {
						optInfo = getOptionInfo( prefix + resultStr );
						if ( optInfo === null ) {
							// An a tag before a valid option? This is most
							// likely a caption.
							optInfo = undefined;
							return null;
						}
					}

					if ( optInfo.ck === 'link' ) {
						tokenType = Util.lookup( currentToken.attribs, 'rel' );
						tkHref = Util.lookup( currentToken.attribs, 'href' );

						// Reset the optInfo since we're changing the nature of it
						optInfo = undefined;
						// Figure out the proper string to put here and break.
						if ( tokenType === 'mw:ExtLink/URL' ) {
							// Add the URL
							resultStr += tkHref;
							// Tell our loop to skip to the end of this tag
							skipToEndOf = 'a';
						} else if ( tokenType === 'mw:WikiLink' ) {
							// This maybe assumes some stuff about wikilinks,
							// but nothing we haven't already assumed
							resultStr += tkHref.replace( /^(\.\.?\/)*/g, '' );
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
	function handleResponse( linkTitle, err, data ) {
		if (err || !data) {
			// FIXME gwicke: Handle this error!!
			cb ({tokens: [new SelfclosingTagTk('meta',
						[new KV('typeof', 'mw:Placeholder')], token.dataAttribs)]});
			return;
		}
		var	dims, image, info, containerName, container, containerClose,
			dataAttribs,
			rdfaType = 'mw:Image',
			captionClass = [ 'mw-figcaption' ],
			iContainerName = hasImageLink ? 'a' : 'span',
			ns = data.imgns,
			innerContain = new TagTk( iContainerName, [] ),
			innerContainClose = new EndTagTk( iContainerName ),
			linkDataAttribs = innerContain.dataAttribs,
			img = new SelfclosingTagTk( 'img', [] ),
			origFilename = Util.lookupKV( token.attribs, 'href' ).vsrc,
			wrapperInfo = getWrapperInfo( oHash, !useFigure ),
			wrapperStyles = wrapperInfo.styles,
			wrapperClasses = wrapperInfo.classes,
			wrapper = null;

		useFigure = wrapperInfo.isInline !== true;

		containerName = useFigure ? 'figure' : 'span';
		container = new TagTk( containerName, [], Util.clone( token.dataAttribs ) );
		containerClose = new EndTagTk( containerName );
		dataAttribs = container.dataAttribs;

		if ( err ) {
			// Probably we're running without an API. Fair enough, we'll use
			// sane defaults.
			image = {
				imageinfo: [
					{
						url: './Special:FilePath/' + filename,
						width: 200,
						height: 200
					}
				]
			};
			info = image.imageinfo[0];
		} else {
			image = data.pages[ns + ':' + filename];
			// SSS FIXME: image.missing doesn't seem to be very useful.
			// It is often "" even both for missing images as well as valid images.
			//
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
			if (!image || !image.imageinfo) {
				// FIXME gwicke: Handle missing images properly!!
				cb ({tokens: [new SelfclosingTagTk('meta',
							[new KV('typeof', 'mw:Placeholder')], token.dataAttribs)]});
				return;
			}
			info = image.imageinfo[0];
		}

		// We can roundtrip this now, but still need a good cache key. Use the
		// source for now.
		dataAttribs.cacheKey = dataAttribs.src;
		dataAttribs.src = undefined;


		// But we need some extra information!
		dataAttribs.img = {};

		dims = handleDims( height, width, info, dataAttribs );

		// Update some already-defined nonsense based on response
		height = dims.h;
		width = dims.w;
		path = getPath( info );

		if ( oHash.alt ) {
			img.addNormalizedAttribute( 'alt', oHash.alt, altBackup );
		}

		img.addNormalizedAttribute( 'resource', linkTitle.makeLink(), origFilename );
		img.addAttribute( 'src', path );

		if ( hasImageLink ) {
			if ( oHash.link !== undefined ) {
				linkTitle = Title.fromPrefixedText( env, oHash.link );
			}
			innerContain.addNormalizedAttribute( 'href', linkTitle.makeLink(), oHash.link );
		}

		if ( height ) {
			img.addNormalizedAttribute( 'height', String( height ), oHash.height );
		}

		if ( width ) {
			img.addNormalizedAttribute( 'width', String( width ), oHash.width );
		}

		if ( oHash.height !== null ) {
			// Indicate that there was a height option in the image call
			dataAttribs.img.htset = true;
		}

		if ( oHash.width !== null ) {
			// Indicate that there was a width option in the image call
			dataAttribs.img.wdset = true;
		}

		if ( oHash.format === 'thumbnail' || oHash.format === 'framed' ) {
			if ( oHash.upright !== undefined ) {
				if ( oHash.upright > 0 ) {
					width *= oHash.upright;
				} else {
					width *= 0.75;
					wrapperClasses.push( 'mw-halign-upright' );
				}
			}

			if ( caption !== undefined ) {
				caption = closeUnclosedBlockTags( caption );
			}
		}

		// If the format is something we *recognize*, add the subtype
		switch ( oHash.format ) {
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

		if ( oHash['class'] ) {
			wrapperClasses = wrapperClasses.concat( oHash['class'].split( ' ' ) );
		}

		if ( wrapperClasses.length ) {
			container.addAttribute( 'class', wrapperClasses.join( ' ' ) );
		}

		// FIXME gwicke: We don't really want to add inline styles, as people
		// will start to depend on them otherwise.
		//if (wrapperStyles.length) {
		//	container.addAttribute( 'style', wrapperStyles.join( ' ' ) );
		//}

		container.addAttribute( 'typeof', rdfaType );

		var tokens = [
				container,
				innerContain,
				img,
				innerContainClose
			];

		if ( caption !== undefined  && !useFigure ) {
			container.addAttribute( 'data-mw', JSON.stringify( {
				caption: captionSrc
			} ) );
		} else if ( caption !== undefined ) {
			tokens = tokens.concat( [
				new TagTk( 'figcaption', [
					new KV( 'class', captionClass.join( ' ' ) )
				] ),
				caption,
				new EndTagTk( 'figcaption' )
			] );
		}

		tokens.push( containerClose );

		cb( { tokens: tokens } );
	}

	// First check if we have a cached copy of this image expansion, and
	// avoid any further processing if we have a cache hit.
	var cachedImage = this.manager.env.imageCache[token.dataAttribs.src];
	if (cachedImage) {
		// Use the cached result.
		// mw:DOMFragment wrapping is simplified as we know that we are
		// dealing with a single subtree rooted either at a figure or a span.
		var wrapperTokens = DU.getWrapperTokens(cachedImage.nodes),
			firstWrapperToken = wrapperTokens[0];
		DU.addTypeOf(firstWrapperToken, 'mw:DOMFragment');
		firstWrapperToken.dataAttribs.html = cachedImage.html;

		// Transfer tsr to the first token
		firstWrapperToken.dataAttribs.tsr = token.dataAttribs.tsr;

		// Capture the delta between the old/new wikitext start posn.
		// 'tsr' values are stripped in the original DOM and won't be
		// present.  Since dsr[0] is identical to tsr[0] in this case,
		// dsr[0] is a safe substitute, if present.
		if (token.dataAttribs.tsr && firstWrapperToken.dataAttribs.dsr) {
			firstWrapperToken.dataAttribs.tsrDelta = token.dataAttribs.tsr[0] -
				firstWrapperToken.dataAttribs.dsr[0];
		}

		//console.log('cache hit for ' + token.dataAttribs.src);
		cb( {tokens: wrapperTokens} );
		return;
	}

	var env = this.manager.env,
		// distinguish media types
		// if image: parse options
		content = buildLinkAttrs(token.attribs, true, null, null ).content;

	// extract options
	// TODO gwicke: abstract out!
	var i, l, kv, captionSrc, linkSrc, caption, captionOffset, altBackup,
		// option hash, both keys and values normalized
		oHash = { height: null, width: null },
		validOptions = Object.keys( WikitextConstants.Image.PrefixOptions ),
		getOption = env.conf.wiki.getMagicPatternMatcher( validOptions );

	token.dataAttribs.optList = [];

	for( i = 0, l = content.length; i<l; i++ ) {
		var optInfo, maybeOText,
			oContent = content[i],
			oText = Util.tokensToString( oContent.v, true );
		//console.log( JSON.stringify( oText, null, 2 ) );

		optInfo = undefined;

		if ( oText === '' ) {
			token.dataAttribs.optList.push( {
				ck: '',
				ak: ''
			} );
			continue;
		}

		if ( oText.constructor !== String ) {
			// Might be that this is a valid option whose value is just
			// complicated. Try to figure it out, step through all tokens.
			maybeOText = stringifyOptionTokens( oText, '' );
			if ( maybeOText !== null ) {
				oText = maybeOText;
			}
		}

		if ( oText.constructor === String ) {
			if ( optInfo === undefined ) {
				optInfo = getOptionInfo( oText );
			}
		}

		// For the values of the caption and options, see
		// getOptionInfo's documentation above
		if ( oText.constructor !== String || optInfo === null ) {
			// No valid option found!?
			// Record for RT-ing
			caption = {
				v: oContent.v,
				ak: oText
			};
			// So we know where to put it in the array at the end
			captionOffset = token.dataAttribs.optList.length;
			captionSrc = oContent.vsrc;
			continue;
		}

		if ( optInfo.ck === 'alt' ) {
			// Holds the shadow info for the alt option until we can save it
			altBackup = oContent.vsrc;
		}

		if ( optInfo.s === true ) {
			// Simple image option
			oHash[optInfo.ck] = optInfo.v;
			token.dataAttribs.optList.push( {
				ck: optInfo.v,
				ak: optInfo.ak
			} );
		} else {
			// map short canonical name to the localized version used
			token.dataAttribs.optList.push( {
				ck: optInfo.ck,
				ak: optInfo.ak
			} );

			if ( optInfo.ck === 'width' ) {
				var x, y, maybeSize = optInfo.v.match( /^(\d*)(?:x(\d+))?$/ );
				if ( maybeSize !== null ) {
					x = maybeSize[1];
					y = maybeSize[2];
				}
				if ( x !== undefined ) {
					oHash.width = x;
				}
				if ( y !== undefined ) {
					oHash.height = y;
				}
			} else {
				oHash[optInfo.ck] = optInfo.v;
				//console.warn('handle prefix ' + bits );
			}
		}
	}

	// Add the caption if there is one
	if ( caption ) {
		token.dataAttribs.optList.splice( captionOffset, 0, {
			ck: 'caption',
			ak: caption.ak
		} );
		caption = caption.v;
	}

	//var contentPos = token.dataAttribs.contentPos;
	//var optionSource = token.source.substring( contentPos[0], contentPos[1] );
	//console.log( 'optionSource: ' + optionSource );
	// XXX: The trouble with re-parsing is the need to re-expand templates.
	// Figure out how often non-image links contain image-like parameters!
	//var options = this.urlParser.processImageOptions( optionSource );
	//console.log( JSON.stringify( options, null, 2 ) );
	// XXX: check if the file exists, generate thumbnail, get size
	// XXX: render according to mode (inline, thumb, framed etc

	// TODO: get /wiki from config!
	var linkTitle = title,
		hasImageLink = ( oHash.link === undefined || oHash.link !== '' ),
		useFigure = (
			oHash.format === 'thumbnail' ||
			oHash.format === 'framed' ||
			oHash.manualthumb
		);

	var width = null, height = null;
	// local 'width' and 'height' vars will be strings (or null)
	if ( oHash.height === null && oHash.width === null ) {
		width = '200';
	} else {
		width = oHash.width;
		height = oHash.height;
	}

	var path = this.getThumbPath( title.key, width.replace(/px$/, '') ),
		filename = title.key,
		constraints = {};

	if ( oHash.height ) {
		constraints.height =  parseInt( oHash.height, 10 );
	}

	if ( oHash.width ) {
		constraints.width = parseInt( oHash.width, 10 );
	}

	if ( oHash.format && oHash.format !== 'framed' ) {
		if ( !constraints.height && !constraints.width ) {
			constraints.height = 180;
			constraints.width = 180;
		}
	}

	var infoRequest = new ImageInfoRequest( env, filename, constraints );

	infoRequest.on( 'src', handleResponse.bind( null, linkTitle ) );
	cb( { async: true } );
};

// Create an url for the scaled image src.
// FIXME: This is just a dirty hack which will only ever work with the WMF
// cluster configuration which creates an on-demand thumbnail when accessing a
// width-prefixed image URL.
WikiLinkHandler.prototype.getThumbPath = function ( key, width ) {
	var env = this.manager.env,
		// Make a relative link.
		link = Title.fromPrefixedText( env, 'Special:FilePath' ).makeLink();
	// Simply let Special:FilePath redirect to the real thumb location
	return link + '/' + key + '?width=' + width;
};

function ExternalLinkHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onUrlLink.bind( this ), "ExternalLinkHandler:onUrlLink", this.rank, 'tag', 'urllink' );
	this.manager.addTransform( this.onExtLink.bind( this ), "ExternalLinkHandler:onExtLink",
			this.rank - 0.001, 'tag', 'extlink' );
	this.manager.addTransform( this.onEnd.bind( this ), "ExternalLinkHandler:onEnd",
			this.rank, 'end' );
	// create a new peg parser for image options..
	if ( !this.urlParser ) {
		// Actually the regular tokenizer, but we'll call it with the
		// img_options production only.
		ExternalLinkHandler.prototype.urlParser = new PegTokenizer( this.manager.env );
	}
	this._reset();
}

ExternalLinkHandler.prototype._reset = function () {
	this.linkCount = 1;
};

ExternalLinkHandler.prototype.rank = 1.15;
ExternalLinkHandler.prototype._imageExtensions = {
	'jpg': true,
	'png': true,
	'gif': true,
	'svg': true
};

ExternalLinkHandler.prototype._hasImageLink = function ( href ) {
	var bits = href.split( '.' );
	return bits.length > 1 &&
		this._imageExtensions[ bits[bits.length - 1] ] &&
		href.match( /^https?:\/\//i );
};

ExternalLinkHandler.prototype.onUrlLink = function ( token, frame, cb ) {
	var env = this.manager.env,
		tagAttrs,
		builtTag,
		href = Util.tokensToString( Util.lookup( token.attribs, 'href' ) ),
		origTxt = token.getWTSource( env ),
		txt = href;

	if ( SanitizerConstants.IDN_RE.test( txt ) ) {
		// Make sure there are no IDN-ignored characters in the text so the
		// user doesn't accidentally copy any.
		txt = Sanitizer._stripIDNs( txt );
	}

	var dataAttribs = Util.clone(token.dataAttribs);
	if ( this._hasImageLink( href ) ) {
		tagAttrs = [
			new KV( 'src', href ),
			new KV( 'alt', href.split('/').last() ),
			new KV( 'rel', 'mw:externalImage' )
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		cb( { tokens: [ new SelfclosingTagTk('img', tagAttrs, dataAttribs) ] } );
	} else {
		tagAttrs = [
			new KV( 'rel', 'mw:ExtLink/URL' )
			// href is set explicitly below
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		builtTag = new TagTk( 'a', tagAttrs, dataAttribs );

		if (origTxt) {
			// origTxt will be null for content from templates
			//
			// Since we messed with the text of the link, we need
			// to preserve the original in the RT data. Or else.
			builtTag.addNormalizedAttribute( 'href', txt, origTxt );
		} else {
			builtTag.addAttribute( 'href', token.getAttribute('href') );
		}

		cb( {
			tokens: [
				builtTag,
				txt,
				new EndTagTk( 'a' )
			]
		} );
	}
};

// Bracketed external link
ExternalLinkHandler.prototype.onExtLink = function ( token, manager, cb ) {
	var env = this.manager.env,
		origHref = Util.lookup( token.attribs, 'href' ),
		href = Util.tokensToString( origHref ),
		content = Util.lookup( token.attribs, 'mw:content'),
		newAttrs, aStart, title;

	//console.warn('extlink href: ' + href );
	//console.warn( 'mw:content: ' + JSON.stringify( content, null, 2 ) );

	var dataAttribs = Util.clone(token.dataAttribs);
	var rdfaType = token.getAttribute('typeof'), magLinkRe = /\bmw:ExtLink\/(?:ISBN|RFC|PMID)\b/;
	if ( rdfaType && rdfaType.match( magLinkRe ) ) {
		if ( rdfaType.match( /\bmw:ExtLink\/ISBN/ ) ) {
			title = Title.fromPrefixedText( env, href );
			newAttrs = [
				new KV('href', title.makeLink()),
				new KV('rel', rdfaType.match( magLinkRe )[0] )
			];
		} else {
			newAttrs = [
				new KV('href', href),
				new KV('rel', rdfaType.match( magLinkRe )[0] )
			];
		}

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
		cb( {
			tokens: [aStart].concat(content, [new EndTagTk('a')])
		} );
	} else if ( this.urlParser.tokenizeURL( href )) {
		rdfaType = 'mw:ExtLink';
		if ( ! content.length ) {
			content = ['[' + this.linkCount + ']'];
			this.linkCount++;
			rdfaType = 'mw:ExtLink/Numbered';
		} else if ( content.length === 1 &&
				content[0].constructor === String &&
				this.urlParser.tokenizeURL( content[0] ) &&
				this._hasImageLink( content[0] ) )
		{
			var src = content[0];
			content = [ new SelfclosingTagTk( 'img',
					[
					new KV( 'src', src ),
					new KV( 'alt', src.split('/').last() )
					],
					{ type: 'extlink' })
				];
		}

		newAttrs = [
			new KV('rel', rdfaType)
			// href is set explicitly below
		];
		// combine with existing rdfa attrs
		newAttrs = buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
		aStart = new TagTk ( 'a', newAttrs, dataAttribs );

		if ( SanitizerConstants.IDN_RE.test( href ) ) {
			// Make sure there are no IDN-ignored characters in the text so the
			// user doesn't accidentally copy any.
			href = Sanitizer._stripIDNs( href );
		}

		if (dataAttribs.tsr) {
			// If we are from a top-level page, add normalized attr info for
			// accurate roundtripping of original content.
			//
			// targetOff covers all spaces before content
			// and we need src without those spaces.
			var tsr0a = dataAttribs.tsr[0] + 1,
				tsr1a = dataAttribs.targetOff - (token.getAttribute('spaces') || '').length;
			aStart.addNormalizedAttribute( 'href', href, env.page.src.substring(tsr0a, tsr1a) );
		} else {
			aStart.addAttribute( 'href', href );
		}
		cb( {
			tokens: [aStart].concat(content, [new EndTagTk('a')])
		} );
	} else {
		// Not a link, convert href to plain text.
		var tokens = ['['],
			closingTok = null,
			spaces = token.getAttribute('spaces') || '';

		if ((token.getAttribute("typeof") || "").match(/mw:ExpandedAttrs/)) {
			// The token 'non-url' came from a template.
			// Introduce a span and capture the original source for RT purposes.
			var da = token.dataAttribs,
				// targetOff covers all spaces before content
				// and we need src without those spaces.
				tsr0b = da.tsr[0] + 1,
				tsr1b = da.targetOff - spaces.length,
				span = new TagTk('span', [new KV('typeof', 'mw:Placeholder')], {
						tsr: [tsr0b, tsr1b],
						src: env.page.src.substring(tsr0b, tsr1b)
					} );

			tokens.push(span);
			closingTok = new EndTagTk('span');
		}

		var hrefText = token.getAttribute("href");
		if (hrefText.constructor === Array) {
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

		if ( content.length ) {
			tokens = tokens.concat( content );
		}

		tokens.push(']');

		cb( { tokens: tokens } );
	}
};

ExternalLinkHandler.prototype.onEnd = function ( token, manager, cb ) {
	this._reset();
	cb( { tokens: [ token ] } );
};


if (typeof module === "object") {
	module.exports.WikiLinkHandler = WikiLinkHandler;
	module.exports.ExternalLinkHandler = ExternalLinkHandler;
}
