"use strict";
/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * TODO: keep round-trip information in meta tag or the like
 */

var PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	WikitextConstants = require('./mediawiki.wikitext.constants.js').WikitextConstants,
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

// SSS FIXME: the attr called content should probably be called link-text?

WikiLinkHandler.prototype.onWikiLink = function ( token, frame, cb ) {

	var j, maybeContent, about, possibleTags, property, newType,
		hrefkv, saniContent, env = this.manager.env,
		attribs = token.attribs,
		target = Util.lookup( attribs, 'href' ),
		href = Util.tokensToString( target ),
		title = env.makeTitleFromPrefixedText(env.normalizeTitle(Util.decodeURI(href)));

	if ( title.ns.isFile() ) {
		cb( this.renderFile( token, frame, cb, href, title) );
	} else {
		//console.warn( 'title: ' + JSON.stringify( title ) );
		var newAttrs = buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]);
		var content = newAttrs.content;
		var obj = new TagTk( 'a', newAttrs.attribs, Util.clone(token.dataAttribs));
		obj.dataAttribs.src = undefined; // clear src string since we can serialize this
		obj.addNormalizedAttribute( 'href', title.makeLink(), href );
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

		var tail = Util.lookup( attribs, 'tail' );
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

			if ( tail ) {
				if ( obj.dataAttribs.tsr ) {
					obj.dataAttribs.tsr[1] -= tail.length;
				}
				tokens.push(tail);
			}

			cb( {
				tokens: tokens
			} );
		} else if ( href.match( new RegExp( '^(' + this.manager.env.conf.parsoid.interwikiRegexp + '):' ) ) ) {

			obj.dataAttribs.src = token.getWTSource( env );
			obj = new SelfclosingTagTk('link', obj.attribs, obj.dataAttribs);

			// Change the rel to be mw:WikiLink/Language
			Util.lookupKV( obj.attribs, 'rel' ).v += '/Language';

			tokens.push( obj );

			if ( tail ) {
				if ( obj.dataAttribs.tsr ) {
					obj.dataAttribs.tsr[1] -= tail.length;
				}
				tokens.push(tail);
			}

			cb( {
				tokens: tokens
			} );
		} else {
			if ( tail ) {
				obj.dataAttribs.tail = tail;
				content.push( tail );
			}

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
		oHash = {},
		captions = [];
	for( i = 0, l = content.length; i<l; i++ ) {
		var oContent = content[i],
			oText = Util.tokensToString( oContent.v, true );
		//console.log( JSON.stringify( oText, null, 2 ) );
		if ( oText.constructor === String ) {
			var origOText = oText;
			oText = oText.trim();
			var lowerOText = oText.toLowerCase();
			var canonicalOption = env.conf.wiki.magicWords[oText] ||
				env.conf.wiki.magicWords[lowerOText] ||
				lowerOText;
			var imgOption = WikitextConstants.Image.SimpleOptions[canonicalOption];
			if (imgOption) {
				options.push( new KV(imgOption, origOText ) );
				oHash[imgOption] = canonicalOption;
				if ( token.dataAttribs.optNames === undefined ) {
					token.dataAttribs.optNames = {};
				}
				token.dataAttribs.optNames[canonicalOption] = origOText;
				continue;
			} else {
				var maybeSize = oText.match(/^(\d*)(?:x(\d+))?px$/);
				//console.log( maybeSize );
				if ( maybeSize !== null ) {
					var x = maybeSize[1],
						y = maybeSize[2];
					if ( x !== undefined ) {
						options.push(new KV( 'width', x ) );
						oHash.width = x;
					}
					if ( y !== undefined ) {
						options.push(new KV( 'height', y ) );
						oHash.height = y;
					}
				} else {
					var bits = origOText.split( '=', 2 ),
						normalizedBit0 = bits[0],
						trimNb0 = normalizedBit0.trim(),
						lowerNb0 = trimNb0.toLowerCase(),
						canonicalNb0 = env.conf.wiki.magicWords[trimNb0] ||
							env.conf.wiki.magicWords[lowerNb0] || lowerNb0,
						key = WikitextConstants.Image.PrefixOptions[canonicalNb0];
					if ( bits[0] && key) {
						oHash[key] = bits[1];
						if ( token.dataAttribs.optNames === undefined ) {
							token.dataAttribs.optNames = {};
						}
						token.dataAttribs.optNames[key] = bits[0];
						// Preserve white space
						// FIXME: But this doesn't work for the 'upright' key
						if (key === normalizedBit0) {
							key = bits[0];
						}
						options.push( new KV( key, bits[1] ) );
						//console.warn('handle prefix ' + bits );
					} else {
						// Record for RT-ing
						kv = new KV("caption", oContent.v);
						captions.push(kv);
						options.push(kv);
					}
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
	// XXX: render according to mode (inline, thumb, framed etc)

	if ( oHash.format && ( oHash.format === 'img_thumbnail') ) {
		return this.renderThumb( token, this.manager, cb, title, fileName,
				caption, oHash, options, rdfaAttrs);
	} else {
		// TODO: get /wiki from config!
		var newAttribs = [
			new KV('href', title.makeLink()),
			new KV('rel', 'mw:Image')
		].concat(rdfaAttrs.attribs);

		var a = new TagTk('a', newAttribs, Util.clone(token.dataAttribs));
		var width, height;
		if ( ! oHash.height && ! oHash.width ) {
			width = '200px';
		} else {
			width = oHash.width;
			height = oHash.height;
		}

		var path = this.getThumbPath( title.key, width.replace(/px$/, '') ),
			img = new SelfclosingTagTk( 'img',
				[
					// FIXME!
					new KV( 'height', height || '' ),
					new KV( 'width', width || '' ),
					new KV( 'src', path ),
					new KV( 'alt', oHash.img_alt || title.key )
				] );

		var tokens = [ a, img, new EndTagTk( 'a' )];
		var linkTail = Util.lookup(token.attribs, 'tail');
		if (linkTail) {
			if ( a.dataAttribs.tsr ) {
				a.dataAttribs.tsr[1] -= linkTail.length;
			}
			var src = a.dataAttribs.src;
			a.dataAttribs.src = src.substr(0,src.length - linkTail.length);
			tokens.push(linkTail);
		}
		return { tokens: tokens };
	}
};

// Create an url for the scaled image src.
// FIXME: This is just a dirty hack which will only ever work with the WMF
// cluster configuration which creates an on-demand thumbnail when accessing a
// width-prefixed image URL.
WikiLinkHandler.prototype.getThumbPath = function ( key, width ) {
	var env = this.manager.env;
	// Choose the applicable URL
	var scriptProtoRel = ( env.conf.wiki.apiURI || env.conf.wiki.script )
		// Make it protocol-relative
		.replace('/^https?:\/\//', '//');

	if ( env.conf.wiki.server && env.conf.wiki.script ) {
		scriptProtoRel = env.conf.wiki.server + env.conf.wiki.script;
	}

	// Simply let Special:FilePath redirect to the real thumb location
	return scriptProtoRel + '?title=Special:FilePath/' +
				key + '&width=' + width;
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
		var t;
		var openBlockTagStack = [];
		for (var i = 0, n = tokens.length; i < n; i++) {
			t = tokens[i];
			if (Util.isBlockToken(t)) {
				if (t.constructor === TagTk) {
					openBlockTagStack.push(t);
				} else if (t.constructor === EndTagTk) {
					if (openBlockTagStack.last().name === t.name) {
						openBlockTagStack.pop();
					}
				}
			}
		}

		for (i = 0, n = openBlockTagStack.length; i < n; i++) {
			t = openBlockTagStack.pop();
			t.dataAttribs.autoInsertedEnd = true;
			tokens.push(new EndTagTk(t.name));
		}

		return tokens;
	}

	// TODO: get /wiki from config!
	var dataAttribs = Util.clone(token.dataAttribs);
	dataAttribs.optionHash = oHash;
	dataAttribs.optionList = options;
	dataAttribs.src = undefined; // clear src string since we can serialize this

	var width = 165;

	// Handle upright
	if ( 'aspect' in oHash ) {
		if ( oHash.aspect > 0 ) {
			width = width * oHash.aspect;
		} else {
			width *= 0.75;
		}
	}

	var figurestyle = "width: " + (width + 5) + "px;",
		figureclass = "thumb tright thumbinner";

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
	// XXX: support other formats (border, frameless, frame)
	// XXX: support prefixes

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

	var path = this.getThumbPath( title.key, width ),
		thumb = [
		new TagTk('figure', figAttrs),
		new TagTk( 'a', [
					new KV('href', title.makeLink()),
					new KV('class', 'image')
				]),
		new SelfclosingTagTk( 'img', [
					new KV('src', path),
					new KV('width', width + 'px'),
					//new KV('height', '160px'),
					new KV('class', 'thumbimage'),
					new KV('alt', oHash.img_alt || title.key ),
					// Add resource as CURIE- needs global default prefix
					// definition.
					new KV('resource', '[:' + fileName + ']')
				]),
		new EndTagTk( 'a' ),
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

	var linkTail = Util.lookup(token.attribs, 'tail');
	if (linkTail) {
		if ( dataAttribs.tsr ) {
			dataAttribs.tsr[1] -= linkTail.length;
		}
		thumb.push(linkTail);
	}

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
		ExternalLinkHandler.prototype.urlParser = new PegTokenizer();
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

		// Since we messed with the text of the link, we need
		// to preserve the original in the RT data. Or else.
		builtTag.addNormalizedAttribute( 'href', txt, origTxt );

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
			title = env.makeTitleFromPrefixedText(env.normalizeTitle(href));
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

		aStart.addNormalizedAttribute( 'href', href, origHref );
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
