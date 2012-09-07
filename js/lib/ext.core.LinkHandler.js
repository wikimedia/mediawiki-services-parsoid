/**
 * Simple link handler. Registers after template expansions, as an
 * asynchronous transform.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 *
 * TODO: keep round-trip information in meta tag or the like
 */

var jshashes = require('jshashes'),
	PegTokenizer = require('./mediawiki.tokenizer.peg.js').PegTokenizer,
	WikitextConstants = require('./mediawiki.wikitext.constants.js').WikitextConstants,
	Util = require('./mediawiki.Util.js').Util;

function WikiLinkHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform( this.onWikiLink.bind( this ), "WikiLinkHandler:onWikiLink", this.rank, 'tag', 'wikilink' );
	// create a new peg parser for image options..
	if ( !this.imageParser ) {
		// Actually the regular tokenizer, but we'll call it with the
		// img_options production only.
		WikiLinkHandler.prototype.imageParser = new PegTokenizer();
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
	var newAttrs = [];
	var linkText = [];
	var about;

	// In one pass through the attribute array, 
	// fetch about, typeof, and linkText
	//
	// about && typeof are usually at the end of the array
	// if at all present
	for ( var i = 0, l = attrs.length; i < l; i++ ) {
		var kv = attrs[i];
		var k  = kv.k;
		var v  = kv.v;

		// link-text attrs have empty keys
		if (getLinkText && k === "") {
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
		[].push.apply(newAttrs, linkAttrs);
	}

	return {
		attribs: newAttrs,
		content: linkText,
		hasRdfaType: rdfaType !== null
	};
}

// SSS FIXME: the attr called content should probably be called link-text?

WikiLinkHandler.prototype.onWikiLink = function ( token, frame, cb ) {

	var env = this.manager.env,
		attribs = token.attribs,
		href = Util.tokensToString( Util.lookup( attribs, 'href' ) ),
		title = env.makeTitleFromPrefixedText(env.normalizeTitle(href));

	if ( title.ns.isFile() ) {
		cb( this.renderFile( token, frame, cb, href, title) );
	} else if ( title.ns.isCategory() ) {
		// Simply round-trip category links for now
		var newAttrs = buildLinkAttrs(attribs, false, "mw:Placeholder", null);
		cb( {tokens: [new SelfclosingTagTk('meta', newAttrs.attribs, Util.clone(token.dataAttribs))]} );
	} else {
		//console.warn( 'title: ' + JSON.stringify( title ) );
		var newAttrs = buildLinkAttrs(attribs, true, null, [new KV('rel', 'mw:WikiLink')]);
		var content = newAttrs.content;
		var obj = new TagTk( 'a', newAttrs.attribs, Util.clone(token.dataAttribs));

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
			content = out;
		} else {
			var morecontent = Util.decodeURI(href);
			obj.dataAttribs.stx = 'simple';
			if ( obj.dataAttribs.pipetrick ) {
				// TODO: get this from somewhere else, hard-coding is fun but ultimately bad
				// Valid title characters
				var tc = '[%!\"$&\'\\(\\)*,\\-.\\/0-9:;=?@A-Z\\\\^_`a-z~\\x80-\\xFF+]';
				// Valid namespace characters
				var nc = '[ _0-9A-Za-z\x80-\xff-]';

				// [[ns:page (context)|]] -> page
				var p1 = new RegExp( '(:?' + nc + '+:|:|)(' + tc + '+?)( ?\\(' + tc + '+\\))' );
				// [[ns:page（context）|]] -> page (different form of parenthesis)
				var p2 = new RegExp( '(:?' + nc + '+:|:|)(' + tc + '+?)( ?（' + tc + '+）)' );
				// page, context -> page
				var p3 = new RegExp( '(, |，)' + tc + '+' );

				morecontent = morecontent.replace( p1, '$2' );
				morecontent = morecontent.replace( p2, '$2' );
				morecontent = morecontent.replace( p3, '' );
			}
			content = [ morecontent ];
		}

		var tail = Util.lookup( attribs, 'tail' );
		if ( tail ) {
			obj.dataAttribs.tail = tail;
			content.push( tail );
		}
		
		cb ( {
			tokens: [obj].concat( content, [ new EndTagTk( 'a' ) ] )
		} );
	}
};

WikiLinkHandler.prototype.renderFile = function ( token, frame, cb, fileName, title ) {
	var env = this.manager.env;
	// distinguish media types
	// if image: parse options
	
	var rdfaAttrs = buildLinkAttrs(token.attribs, true, null, null);
	var content = rdfaAttrs.content;

	var MD5 = new jshashes.MD5(),
		hash = MD5.hex( title.key ),
		// TODO: Hackhack.. Move to proper test harness setup!
		path = [ this.manager.env.wgUploadPath, hash[0],
					hash.substr(0, 2), title.key ].join('/');

	// extract options
	var options = [],
		oHash = {},
		caption = [];
	for( var i = 0, l = content.length; i<l; i++ ) {
		var oContent = content[i],
			oText = Util.tokensToString( oContent.v, true );
		//console.log( JSON.stringify( oText, null, 2 ) );
		if ( oText.constructor === String ) {
			var origOText = oText;
			oText = oText.trim().toLowerCase();
			var imgOption = WikitextConstants.Image.SimpleOptions[oText];
			if (imgOption) {
				options.push( new KV(imgOption, origOText ) );
				oHash[imgOption] = oText;
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
					var bits = origOText.split( '=', 2 );
					var normalizedBit0 = bits[0].trim().toLowerCase();
					var key = WikitextConstants.Image.PrefixOptions[normalizedBit0];
					if ( bits[0] && key) {
						oHash[key] = bits[1];
						// Preserve white space
						// FIXME: But this doesn't work for the 'upright' key
						if (key === normalizedBit0) {
							key = bits[0];
						}
						options.push( new KV( key, bits[1] ) );
						//console.warn('handle prefix ' + bits );
					} else {
						if (caption.length === 0) {
							// Record the key in the options list so we can
							// re-serialize the caption at the right place.
							// But, only the first time we encounter caption text
							options.push(new KV("caption", []));
						}
						// neither simple nor prefix option, add original
						// tokens to caption.
						caption = caption.concat( oContent.v );
					}
				}
			}
		} else {
			if (caption.length === 0) {
				// Record the key in the options list so we can
				// re-serialize the caption at the right place.
				// But, only the first time we encounter caption text
				options.push(new KV("caption", []));
			}
			caption = caption.concat( oContent.v );
		}
	}

	//var contentPos = token.dataAttribs.contentPos;
	//var optionSource = token.source.substr( contentPos[0], contentPos[1] - contentPos[0] );
	//console.log( 'optionSource: ' + optionSource );
	// XXX: The trouble with re-parsing is the need to re-expand templates.
	// Figure out how often non-image links contain image-like parameters!
	//var options = this.imageParser.processImageOptions( optionSource );
	//console.log( JSON.stringify( options, null, 2 ) );
	// XXX: check if the file exists, generate thumbnail, get size
	// XXX: render according to mode (inline, thumb, framed etc)
	
	if ( oHash.format && ( oHash.format === 'thumb' || oHash.format === 'thumbnail') ) {
		return this.renderThumb( token, this.manager, cb, title, fileName, path, caption, oHash, options, rdfaAttrs);
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

		var img = new SelfclosingTagTk( 'img',
				[
					// FIXME!
					new KV( 'height', height || '' ),
					new KV( 'width', width || '' ),
					new KV( 'src', path ),
					new KV( 'alt', oHash.alt || title.key )
				] );

		return { tokens: [ a, img, new EndTagTk( 'a' )] };
	}
};

WikiLinkHandler.prototype.renderThumb = function ( token, manager, cb, title, fileName, path, caption, oHash, options, rdfaAttrs ) {
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

	var rdfaType = 'mw:Thumb';
	var figAttrs = [
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

	var thumb = [
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
					new KV('alt', oHash.alt || title.key ),
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
	].concat( caption, [
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
	if ( !this.imageParser ) {
		// Actually the regular tokenizer, but we'll call it with the
		// img_options production only.
		ExternalLinkHandler.prototype.imageParser = new PegTokenizer();
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
		href.match( /^https?:\/\// );
};

ExternalLinkHandler.prototype.onUrlLink = function ( token, frame, cb ) {
	var href = Util.sanitizeURI(Util.tokensToString(Util.lookup(token.attribs, 'href')));
	var tagAttrs;
	if ( this._isImageLink( href ) ) {
		tagAttrs = [
			new KV( 'src', href ),
			new KV( 'alt', href.split('/').last() ),
			new KV('rel', 'mw:externalImage')
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		cb( { tokens: [ new SelfclosingTagTk( 'img',
					tagAttrs,
					{ stx: 'urllink' })
				]
		} );
	} else {
		tagAttrs = [
			new KV( 'href', href ),
			new KV('rel', 'mw:ExtLink/URL')
		];

		// combine with existing rdfa attrs
		tagAttrs = buildLinkAttrs(token.attribs, false, null, tagAttrs).attribs;
		cb( {
			tokens: [
				new TagTk( 'a', tagAttrs),
				href,
				new EndTagTk( 'a' )
			]
		} );
	}
};

// Bracketed external link
ExternalLinkHandler.prototype.onExtLink = function ( token, manager, cb ) {
	var env = this.manager.env,
		href = Util.sanitizeURI(Util.tokensToString(Util.lookup(token.attribs, 'href'))),
		content = Util.lookup( token.attribs, 'mw:content'),
		newAttrs, aStart;

	//console.warn('extlink href: ' + href );
	//console.warn( 'mw:content: ' + JSON.stringify( content, null, 2 ) );

	var rdfaType = token.getAttribute('typeof');
	if (rdfaType && rdfaType.match(/\bmw:ExtLink\/ISBN\b/)) {
		var title = env.makeTitleFromPrefixedText(env.normalizeTitle(href));
		newAttrs = [
			new KV('href', title.makeLink()),
			new KV('rel', 'mw:ExtLink/ISBN')
		];

		// SSS FIXME: Right now, Parsoid does not support templating
		// of ISBN attributes.  So, "ISBN {{echo|1234567890}}" will not
		// parse as you might expect it to.  As a result, this code below 
		// that attempts to combine rdf attrs from earlier is unnecessary
		// right now.  But, it will become necessary if Parsoid starts
		// supporting templating of ISBN attributes.
		//
		// combine with existing rdfa attrs
		newAttrs = buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
		aStart = new TagTk ('a', newAttrs, Util.clone(token.dataAttribs));
		cb( {
			tokens: [aStart].concat(content, [new EndTagTk('a')])
		} );
	} else if ( this.imageParser.tokenizeURL( href )) {
		rdfaType = 'mw:ExtLink';
		if ( ! content.length ) {
			content = ['[' + this.linkCount + ']'];
			this.linkCount++;
			rdfaType = 'mw:ExtLink/Numbered';
		} else if ( content.length === 1 &&
				content[0].constructor === String &&
				this.imageParser.tokenizeURL( content[0] ) &&
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
			new KV('href', href),
			new KV('rel', rdfaType)
		];
		// combine with existing rdfa attrs
		newAttrs = buildLinkAttrs(token.attribs, false, null, newAttrs).attribs;
		aStart = new TagTk ( 'a', newAttrs, Util.clone(token.dataAttribs) );
		cb( {
			tokens: [aStart].concat(content, [new EndTagTk('a')])
		} );
	} else {
		// not a link
		var tokens = ['[', href ];
		if ( content.length ) {
			tokens = tokens.concat( [' '], content );
		}
		tokens.push(']');

		cb( {
			tokens: tokens
		} );
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
