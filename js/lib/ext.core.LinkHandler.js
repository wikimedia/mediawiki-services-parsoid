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
	SanitizerConstants = sanitizerLib.SanitizerConstants;

function WikiLinkHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onWikiLink.bind( this ), "WikiLinkHandler:onWikiLink", this.rank, 'tag', 'wikilink' );
	// create a new peg parser for image options..
	if ( !this.urlParser ) {
		// Actually the regular tokenizer, but we'll call it with the
		// img_options production only.
		WikiLinkHandler.prototype.urlParser = new PegTokenizer();
	}
}

WikiLinkHandler.prototype.rank = 1.15; // after AttributeExpander

/* ------------------------------------------------------------
 * This (overloaded) function does three different things:
 * - Extracts link text from attrs (when k === "").
 *   As a performance micro-opt, only does if asked to (getLinkText)
 * - Updates existing rdfa type with an additional rdf-type,
 *   if one is provided (rdfaType)
 * - Collates about, typeof, and linkAttrs into a new attr. array
 * ------------------------------------------------------------ */
function buildLinkAttrs(attrs, getLinkText, rdfaType, linkAttrs) {
	var newAttrs = [],
		linkText = [],
		about;

	// In one pass through the attribute array,
	// fetch about, typeof, and linkText
	//
	// about && typeof are usually at the end of the array
	// if at all present
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

function splitLink( link ) {
	var match = link.match(/^(:)?([^:]+):(.*)$/);
	if ( match ) {
		return {
			colonEscape: match[1],
			interwikiPrefix: match[2],
			article: match[3]
		};
	} else {
		return null;
	}
}

function interwikiContent( token ) {
	// maybeContent is not set for links with pipetrick
	var kv = Util.lookupKV( token.attribs, 'mw:maybeContent' ),
		href = Util.tokensToString( Util.lookupKV( token.attribs, 'href' ).v );
	if ( token.dataAttribs.pipetrick ) {
		return href.substring( href.indexOf( ':' ) + 1 );
	} else if ( kv !== null ) {
		return  Util.tokensToString( kv.v );
	} else {
		return href.replace( /^:/, '' );
	}
}

// SSS FIXME: the attr called content should probably be called link-text?

WikiLinkHandler.prototype.onWikiLink = function ( token, frame, cb ) {

	var j, maybeContent, about, possibleTags, property, newType,
		hrefkv, saniContent, env = this.manager.env,
		attribs = token.attribs,
		hrefSrc = Util.lookupKV( token.attribs, 'href' ).vsrc,
		target = Util.lookup( attribs, 'href' ),
		href = Util.tokensToString( target ),
		title = Title.fromPrefixedText( env, Util.decodeURI( href ) );

	if ( title.ns.isFile() ) {
		cb( this.renderFile( token, frame, cb, href, title) );
	} else {
		//console.warn( 'title: ' + JSON.stringify( title ) );
		var newAttrs = buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]);
		var content = newAttrs.content;
		var obj = new TagTk( 'a', newAttrs.attribs, Util.clone(token.dataAttribs));
		obj.dataAttribs.src = undefined; // clear src string since we can serialize this
		obj.addNormalizedAttribute( 'href', title.makeLink(), hrefSrc );
		//console.warn('content: ' + JSON.stringify( content, null, 2 ) );

		// XXX: handle trail
		if ( content.length > 0 ) {
			var out = [];
			for ( var i = 0, l = content.length; i < l ; i++ ) {
				out = out.concat( content[i].v );
				if ( i < l - 1 ) {
					out.push( '|' );
				}
			}
			obj.dataAttribs.stx = 'piped';
			content = out;
		} else {
			var morecontent = Util.decodeURI(href);
			obj.dataAttribs.stx = 'simple';
			if ( obj.dataAttribs.pipetrick ) {
				morecontent = Util.stripPipeTrickChars(morecontent);
			}

			// Strip leading colon
			morecontent = morecontent.replace(/^:/, '');

			content = [ morecontent ];
		}

		var tokens = [];

		if ( title.ns.isCategory() && ! href.match(/^:/) ) {

			// We let this get handled earlier as a normal wikilink, but we need
			// to add in a few extras.
			obj = new SelfclosingTagTk('link', obj.attribs, obj.dataAttribs);

			// Change the rel to be mw:WikiLink/Category
			Util.lookupKV( obj.attribs, 'rel' ).v += '/Category';

			saniContent = Util.sanitizeTitleURI( Util.tokensToString( content ) ).replace( /#/g, '%23' );

			// Change the href to include the sort key, if any
			if ( saniContent && saniContent !== '' && saniContent !== href ) {
				hrefkv = Util.lookupKV( obj.attribs, 'href' );
				hrefkv.v += '#';
				hrefkv.v += saniContent;
			}

			tokens.push( obj );

			// Deal with sort keys generated via templates/extensions
			var producerInfo = Util.lookupKV( token.attribs, 'mw:valAffected' );
			if (producerInfo) {
				// Ensure that the link has about set
				about = Util.lookup( obj.attribs, 'about' );
				if (!about) {
					about = "#" + this.manager.env.newObjectId();
					obj.addAttribute("about", about);
				}

				// Update typeof
				obj.addSpaceSeparatedAttribute("typeof",
					"mw:ExpandedAttrs/" + producerInfo.v[0].substring("mw:Object/".length));

				// Update producer meta-token and add it to the token stream
				var metaToken = producerInfo.v[1];
				metaToken.addAttribute("about", about);
				var propKV = Util.lookupKV(metaToken.attribs, "property");
				propKV.v = propKV.v.replace(/mw:maybeContent/, 'mw:sortKey'); // keep it clean
				tokens.push(metaToken);
			}

			cb( {
				tokens: tokens
			} );
		} else {
			var linkParts = splitLink( href );

			if ( linkParts !== null &&
			     env.conf.wiki.interwikiMap[linkParts.interwikiPrefix] !== undefined ) {
				// The prefix is listed in the interwiki map

				var interwikiInfo = env.conf.wiki.interwikiMap[linkParts.interwikiPrefix];

				// We set an absolute link to the article in the other wiki/language
				var absHref = interwikiInfo.url.replace( "$1", linkParts.article );
				obj.addNormalizedAttribute('href', absHref, hrefSrc);

				if ( interwikiInfo.language !== undefined &&
				     linkParts.colonEscape === undefined ) {
					// It is a language link and does not start with a colon

					obj.dataAttribs.src = token.getWTSource( env );
					obj = new SelfclosingTagTk('link', obj.attribs, obj.dataAttribs);

					// Change the rel to be mw:WikiLink/Language
					Util.lookupKV( obj.attribs, 'rel' ).v += '/Language';
				} else {
					// It is a non-language interwiki link or a language link
					// that starts with a colon

					// Change the rel to be mw:WikiLink/Interwiki
					Util.lookupKV( obj.attribs, 'rel' ).v += '/Interwiki';
				}

				tokens.push( obj );

				if ( interwikiInfo.language !== undefined &&
				     linkParts.colonEscape === undefined )  {
					cb( {
						tokens: tokens
					} );
				} else {
					cb( {
						tokens: [obj].concat( interwikiContent( token ), [new EndTagTk( 'a' )] )
					} );
				}
			} else {
				for ( j = 0; j < content.length; j++ ) {
					if ( content[j].constructor !== String ) {
						property = Util.lookup( content[j].attribs, 'property' );
						if ( property && property.constructor === String &&
						     // SSS FIXME: Is this check correct?
						     property.match( /mw\:objectAttr(Val|Key)\#mw\:maybeContent/ ) ) {
							content.splice( j, 1 );
						}
					}
				}

				cb ( {
					tokens: [obj].concat( content, [ new EndTagTk( 'a' ) ] )
				} );
			}
		}
	}
};

WikiLinkHandler.prototype.renderFile = function ( token, frame, cb, fileName, title ) {
	var env = this.manager.env,
		// distinguish media types
		// if image: parse options
		rdfaAttrs = buildLinkAttrs(token.attribs, true, null, null ),
		content = rdfaAttrs.content;

	// extract options
	var i, l, kv,
		options = [],
		oHash = { height: null, width: null },
		captions = [],
		validOptions = Object.keys( WikitextConstants.Image.PrefixOptions ),
		getOption = env.conf.wiki.getMagicPatternMatcher( validOptions );

	for( i = 0, l = content.length; i<l; i++ ) {
		var oContent = content[i],
			oText = Util.tokensToString( oContent.v, true );
		//console.log( JSON.stringify( oText, null, 2 ) );
		if ( oText.constructor === String ) {
			var origOText = oText;
			oText = oText.trim();
			var lowerOText = oText.toLowerCase();
			// oText contains the localized name of this option.  the
			// canonical option names (from mediawiki upstream) are in
			// English and contain an 'img_' prefix.  We drop the
			// prefix before stuffing them in data-parsoid in order to
			// save space (that's shortCanonicalOption)
			var canonicalOption = ( env.conf.wiki.magicWords[oText] ||
				env.conf.wiki.magicWords[lowerOText] ||
				('img_'+lowerOText) );
			var shortCanonicalOption = canonicalOption.replace(/^img_/,  '');
			// 'imgOption' is the key we'd put in oHash; it names the 'group'
			// for the option, and doesn't have an img_ prefix.
			var imgOption = WikitextConstants.Image.SimpleOptions[canonicalOption],
				bits = getOption( origOText.trim() ),
				normalizedBit0 = bits ? bits.k.trim().toLowerCase() : null,
				key = bits ? WikitextConstants.Image.PrefixOptions[normalizedBit0] : null;
			if (imgOption && key === null) {
				// the options array only has non-localized values
				options.push( new KV(imgOption, shortCanonicalOption ) );
				oHash[imgOption] = shortCanonicalOption;
				if ( token.dataAttribs.optNames === undefined ) {
					token.dataAttribs.optNames = {};
				}
				// map short canonical name to the localized version used
				token.dataAttribs.optNames[shortCanonicalOption] = origOText;
				continue;
			} else {
				// bits.a has the localized name for the prefix option
				// (with $1 as a placeholder for the value, which is in bits.v)
				// 'normalizedBit0' is the canonical English option name
				// (from mediawiki upstream) with an img_ prefix.
				// 'key' is the parsoid 'group' for the option; it doesn't
				// have an img_ prefix (it's the key we'd put in oHash)

				if ( bits && key ) {
					shortCanonicalOption = normalizedBit0.replace(/^img_/, '');
					if ( token.dataAttribs.optNames === undefined ) {
						token.dataAttribs.optNames = {};
					}
					// map short canonical name to the localized version used
					token.dataAttribs.optNames[shortCanonicalOption] = bits.a;
					if ( key === 'width' ) {
						var x, y, maybeSize = bits.v.match( /^(\d*)(?:x(\d+))?$/ );
						if ( maybeSize !== null ) {
							x = maybeSize[1];
							y = maybeSize[2];
						}
						if ( x !== undefined ) {
							options.push( new KV( 'width', x ) );
							oHash.width = x;
						}
						if ( y !== undefined ) {
							options.push( new KV( 'height', y ) );
							oHash.height = y;
						}
					} else {
						oHash[key] = bits.v;
						options.push( new KV( key, bits.v ) );
						//console.warn('handle prefix ' + bits );
					}
				} else {
					// Record for RT-ing
					kv = new KV("caption", oContent.v);
					captions.push(kv);
					options.push(kv);
				}
			}
		} else {
			kv = new KV("caption", oContent.v);
			captions.push(kv);
			options.push(kv);
		}
	}

	// Set last caption value to null -- serializer can figure this out
	var caption = '';
	var numCaptions = captions.length;
	if (numCaptions > 0) {
		caption = captions[numCaptions-1].v;
		captions[numCaptions-1].v = null;

		// For the rest, we need original wikitext.
		// SSS FIXME: For now, using tokensToString
		// We need a universal solution everywhere we discard info. like this
		// Maybe use the serializer, tsr/dsr ... to figure out.
		for (i = 0; i < numCaptions-1; i++) {
			captions[i].v = Util.tokensToString(captions[i].v);
		}
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

	if ( (oHash.format && ( oHash.format === 'thumbnail') ) ||
	     (oHash.manualthumb) ) {
		return this.renderThumb( token, this.manager, cb, title, fileName,
				caption, oHash, options, rdfaAttrs);
	} else {
		// TODO: get /wiki from config!
		var linkTitle = title;
		var isImageLink = ( oHash.link === undefined || oHash.link !== '' );
		var newAttribs = [
			new KV( isImageLink ? 'rel' : 'typeof', 'mw:Image')
		];

		if ( isImageLink ) {
			if ( oHash.link !== undefined ) {
				linkTitle = Title.fromPrefixedText( env, oHash.link );
			}
			newAttribs.push( new KV('href', linkTitle.makeLink() ) )
		}
		if (oHash['class']) {
			newAttribs.push(new KV('class', oHash['class']));
		}

		newAttribs = newAttribs.concat(rdfaAttrs.attribs);

		var width=null, height=null;
		// local 'width' and 'height' vars will be strings (or null)
		if ( oHash.height===null && oHash.width===null ) {
			width = '200';
		} else {
			width = oHash.width;
			height = oHash.height;
		}

		var path = this.getThumbPath( title.key, width.replace(/px$/, '') );
		var imgAttrs = [
			new KV( 'src', path ),
			new KV( 'alt', oHash.alt || title.key )
		];
		if (height !== null) {
			imgAttrs.push( new KV( 'height', height ) );
		}
		if (width !== null) {
			imgAttrs.push( new KV( 'width', width ) );
		}

		var imgClass = [];
		if (oHash.border) { imgClass.push('thumbborder'); }
		if (imgClass.length) {
			imgAttrs.push( new KV( 'class', imgClass.join(' ') ) );
		}

		var imgStyle = [], wrapperStyle = [];
		var halign = (oHash.format==='framed') ? 'right' : null;
		var isInline = true, isFloat = false;
		var wrapper = null;
		if (oHash.halign) { halign = oHash.halign; }
		if (halign==='none') {
			// PHP parser wraps in <div class="floatnone">
			isInline = false;
		} else if (halign==='center') {
			// PHP parser wraps in <div class="center"><div class="floatnone">
			isInline = false;
			wrapperStyle.push('text-align: center;');
		} else if (halign==='left') {
			// PHP parser wraps in <div class="floatleft">
			isInline = false; isFloat = true;
			wrapperStyle.push('float: left;');
		} else if (halign==='right') {
			// PHP parser wraps in <div class="floatright">
			isInline = false; isFloat = true;
			wrapperStyle.push('float: right;');
		}
		if (!isInline) {
			wrapperStyle.push('display: block;');
		}

		var valign = 'middle';
		if (oHash.valign) { valign = oHash.valign; }
		if (isInline && !isFloat) {
			imgStyle.push('vertical-align: '+valign.replace(/_/,'-')+';');
		}
		if (wrapperStyle.length) {
			newAttribs.push( new KV( 'style', wrapperStyle.join(' ') ) );
		}
		if (imgStyle.length) {
			imgAttrs.push( new KV( 'style', imgStyle.join(' ') ) );
		}

		var a = new TagTk( isImageLink ? 'a' : 'span', newAttribs, Util.clone(token.dataAttribs));
		var img = new SelfclosingTagTk( 'img', imgAttrs );

		var tokens = [ a, img, new EndTagTk( isImageLink ? 'a' : 'span' )];
		return { tokens: tokens };
	}
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


WikiLinkHandler.prototype.renderThumb = function ( token, manager, cb, title, fileName,
		caption, oHash, options, rdfaAttrs )
{
	// It turns out that image captions can have unclosed block tags
	// which then messes up the entire DOM and wraps the reset of the
	// page into the image caption which is wrong and also screws up
	// the RTing in turn.  So, we forcibly close all unclosed block
	// tags by treating the caption as a well-nested DOM context.
	//
	// TODO: Actually build a real DOM so that inlines etc are encapsulated
	// too. This would need to apply phase 3 token transforms, as the caption
	// as an attribute is already expanded to phase 2.
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

	// TODO: get /wiki from config!
	var dataAttribs = Util.clone(token.dataAttribs);
	dataAttribs.optionList = options;
	dataAttribs.src = undefined; // clear src string since we can serialize this

	var width = 165;

	var env = this.manager.env;

	// Handle explicit width value
	if ( oHash.width ) {
		// keep local 'width' var numeric, not a string
		width = parseInt(oHash.width, 10);
	}

	// Handle upright
	if ( 'upright' in oHash ) {
		if ( oHash.upright > 0 ) {
			width = width * oHash.upright;
		} else {
			width *= 0.75;
		}
	}

	var figurestyle = "width: " + (Math.round(width + 5)) + "px;",
		figureclass = "thumb tright thumbinner";
	// note that 'border', 'frameless', and 'frame' property is ignored
	// for thumbnails

	// set horizontal alignment
	if ( oHash.halign ) {
		if ( oHash.halign === 'left' ) {
			figurestyle += ' float: left;';
			figureclass = "thumb tleft thumbinner";
		} else if ( oHash.halign === 'center' ) {
			figureclass = "thumb center thumbinner";
		} else if ( oHash.halign === 'none' ) {
			figureclass = "thumb thumbinner";
		} else {
			figurestyle += ' float: right;';
		}
	} else {
		figurestyle += ' float: right;';
	}

	// XXX: set vertical alignment (valign)
	// XXX: support prefixes

	if (oHash['class']) {
		figureclass += ' ' + oHash['class'];
	}

	var rdfaType = 'mw:Thumb',
		figAttrs = [
			new KV('class', figureclass),
			new KV('style', figurestyle)
		];

	if (rdfaAttrs.hasRdfaType) {
		// Update once more since we are updating typeof here
		// and we could be carrying a typeof from earlier in the stream.
		figAttrs = buildLinkAttrs(rdfaAttrs.attribs, false, rdfaType, figAttrs).attribs;
	} else {
		figAttrs.push(new KV('typeof', rdfaType));
	}

	var linkTitle = title;
	var isImageLink = ( oHash.link === undefined || oHash.link !== '' );
	if ( isImageLink && oHash.link !== undefined ) {
		linkTitle = Title.fromPrefixedText( env, oHash.link );
	}

	var thumbfile = title.key;
	if (oHash.manualthumb) {
		thumbfile = oHash.manualthumb;
	}

	var path = this.getThumbPath( thumbfile, width ),
		thumb = [
		new TagTk('figure', figAttrs),
		( isImageLink ?
			new TagTk( 'a', [
						new KV('href', linkTitle.makeLink()),
						new KV('class', 'image')
					] ) :
			new TagTk( 'span', [
				new KV( 'typeof', rdfaType )
			] )
		),
		new SelfclosingTagTk( 'img', [
					new KV('src', path),
					new KV('width', width + 'px'),
					//new KV('height', '160px'),
					new KV('class', 'thumbimage'),
					new KV('alt', oHash.alt || title.key ),
					// Add resource as CURIE- needs global default prefix
					// definition.
					new KV('resource', '[:' + fileName + ']')
				]),
		new EndTagTk( isImageLink ? 'a' : 'span' ),
		new SelfclosingTagTk ( 'a', [
					new KV('href', title.makeLink()),
					new KV('class', 'internal sprite details magnify'),
					new KV('title', 'View photo details')
				]),
		new TagTk( 'figcaption', [
					new KV('class', 'thumbcaption'),
					new KV('property', 'mw:thumbcaption')
				] )
	].concat( closeUnclosedBlockTags(caption), [
				new EndTagTk( 'figcaption' ),
				new EndTagTk( 'figure' )
			]);


	// set round-trip information on the wrapping figure token
	thumb[0].dataAttribs = dataAttribs;

/*
 * Wikia DOM:
<figure class="thumb tright thumbinner" style="width:270px;">
    <a href="Delorean.jpg" class="image" data-image-name="DeLorean.jpg" id="DeLorean-jpg">
        <img alt="" src="Delorean.jpg" width="268" height="123" class="thumbimage">
    </a>
    <a href="File:DeLorean.jpg" class="internal sprite details magnify" title="View photo details"></a>
    <figcaption class="thumbcaption">
        A DeLorean DMC-12 from the front with the gull-wing doors open
        <table><tr><td>test</td></tr></table>
        Continuation of the caption
    </figcaption>
    <div class="picture-attribution">
        <img src="Christian-Avatar.png" width="16" height="16" class="avatar" alt="Christian">Added by <a href="User:Christian">Christian</a>
    </div>
</figure>
*/
	//console.warn( 'thumbtokens: ' + JSON.stringify( thumb, null, 2 ) );
	return { tokens: thumb };
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

ExternalLinkHandler.prototype._isImageLink = function ( href ) {
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
		modTxt = false,
		origTxt = token.getWTSource( env ),
		txt = href;

	if ( SanitizerConstants.IDN_RE.test( txt ) ) {
		// Make sure there are no IDN-ignored characters in the text so the
		// user doesn't accidentally copy any.
		txt = Sanitizer._stripIDNs( txt );
	}

	var dataAttribs = Util.clone(token.dataAttribs);
	if ( this._isImageLink( href ) ) {
		tagAttrs = [
			new KV( 'src', href ),
			new KV( 'alt', href.split('/').last() ),
			new KV('rel', 'mw:externalImage')
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		dataAttribs.stx = "urllink";
		cb( { tokens: [ new SelfclosingTagTk('img', tagAttrs, dataAttribs) ] } );
	} else {
		tagAttrs = [
			new KV( 'rel', 'mw:ExtLink/URL' )
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
		newAttrs, aStart, hrefKv, title;

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
				this._isImageLink( content[0] ) )
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
			var tsr0 = dataAttribs.tsr[0] + 1,
				tsr1 = dataAttribs.targetOff - (token.getAttribute('spaces') || '').length;
			aStart.addNormalizedAttribute( 'href', href, env.page.src.substring(tsr0, tsr1) );
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
				tsr0 = da.tsr[0] + 1,
				tsr1 = da.targetOff - spaces.length,
				span = new TagTk('span', [new KV('typeof', 'mw:Placeholder')], {
						tsr: [tsr0, tsr1],
						src: env.page.src.substring(tsr0, tsr1)
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
