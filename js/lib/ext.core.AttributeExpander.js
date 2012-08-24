/**
 * Generic attribute expansion handler.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */
var $ = require('jquery'),
	request = require('request'),
	events = require('events'),
	qs = require('querystring'),
	ParserFunctions = require('./ext.core.ParserFunctions.js').ParserFunctions,
	AttributeTransformManager = require('./mediawiki.TokenTransformManager.js')
									.AttributeTransformManager,
	defines = require('./mediawiki.parser.defines.js');


function AttributeExpander ( manager, options ) {
	this.manager = manager;
	this.options = options;
	// XXX: only register for tag tokens?
	manager.addTransform( this.onToken.bind(this), "AttributeExpander:onToken",
			this.rank, 'any' );
}

// constants
AttributeExpander.prototype.rank = 1.11;

/**
 * Token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 */
AttributeExpander.prototype.onToken = function ( token, frame, cb ) {
	// console.warn( 'AttributeExpander.onToken: ', JSON.stringify( token ) );
	if ( (token.constructor === TagTk ||
			token.constructor === SelfclosingTagTk) &&
				token.attribs &&
				token.attribs.length ) {
		// clone the token
		token = token.clone();
		var atm = new AttributeTransformManager(
					this.manager,
					{ wrapTemplates: this.options.wrapTemplates },
					this._returnAttributes.bind( this, token, cb )
				);
		cb( { async: true } );
		atm.process(token.attribs);
	} else {
		cb ( { tokens: [token] } );
	}
};

/* ----------------------------------------------------------
 * This method does two different things:
 *
 * 1. Strips all meta tags 
 *    (FIXME: should I be selective and only strip mw:Object/* tags?)
 * 2. In wrap-template mode, it identifies the meta-object type
 *    and returns it.
 * ---------------------------------------------------------- */
function stripMetaTags(tokens, wrapTemplates) {
	var buf = [];
	var metaTag, metaObjType;

	for (var i = 0, l = tokens.length; i < l; i++) {
		var token = tokens[i];
		if (token.constructor === SelfclosingTagTk && token.name === 'meta') {
			// Strip all meta tags.
 			// SSS FIXME: should I be selective and only strip mw:Object/* tags?
			if (wrapTemplates) {
				// If we are in wrap-template mode, extract info from the meta-tag
				var t = token.getAttribute("typeof");
				var typeMatch = t.match(/(mw:Object(?:\/.*)?$)/);
				if (typeMatch) {
					if (!typeMatch[1].match(/\/End$/)) {
						metaObjType = typeMatch[1];
						metaTag = token;
					}
				} else {
					buf.push(token);
				}
			}
		} else {
			buf.push(token);
		}
	}

	return {
		value: buf,
		metaObjType: metaObjType,
		metaTag: metaTag
	};
}

/**
 * Callback for attribute expansion in AttributeTransformManager
 */
AttributeExpander.prototype._returnAttributes = function ( token, cb, newAttrs )
{
	this.manager.env.dp( 'AttributeExpander._returnAttributes: ', newAttrs );

	var tokens      = [];
	var metaTokens  = [];
	var dataAttribs = token.dataAttribs;
	var oldAttrs    = token.attribs;
	var i, l, metaObjType;

	// Identify attributes that were generated in full or in part using templates
	// and add appropriate meta tags for them.
	for (i = 0, l = oldAttrs.length; i < l; i++) {
		var a    = oldAttrs[i];
		var newK = newAttrs[i].k;

		if (newK) {
			if (a.k.constructor === Array) {
				var updatedK = stripMetaTags(newK, this.options.wrapTemplates);
				newK = updatedK.value;
				newAttrs[i].k = newK;
				metaObjType = updatedK.metaObjType;
				if (metaObjType) {
					// <meta about="#mwt1" property="mw:objectAttr#href" data-parsoid="...">
					// about will be filled out in the end
					metaTokens.push(new SelfclosingTagTk('meta',
						[new KV("property", "mw:objectAttrKey#" + newK)],
						updatedK.metaTag.dataAttribs)
					);
				}
			}

			if (a.v.constructor === Array) {
				var updatedV = stripMetaTags(newAttrs[i].v, this.options.wrapTemplates);
				newAttrs[i].v = updatedV.value;
				metaObjType = updatedV.metaObjType;
				if (metaObjType) {
					if (newK.constructor !== String) {
						// SSS FIXME: Can this happen at all? Looks like not
						newK = this.manager.env.tokensToString(newK);
					}
					// <meta about="#mwt1" property="mw:objectAttr#href" data-parsoid="...">
					// about will be filled out in the end
					metaTokens.push(new SelfclosingTagTk('meta', 
						[new KV("property", "mw:objectAttrVal#" + newK)],
						updatedV.metaTag.dataAttribs)
					);
				}
			}
		}
	}

	// Update attrs
	token.attribs = newAttrs;

	// Update metatoken info
	l = metaTokens.length;
	if (l > 0) {
		var tokenId = '#mwt' + this.manager.env.generateUID();
		token.addAttribute("about", tokenId);
		token.addSpaceSeparatedAttribute("typeof", metaObjType + "/Attributes");
		for (i = 0; i < l; i++) {
			metaTokens[i].addAttribute("about", tokenId);
		}
	}

	tokens = metaTokens;
	tokens.push(token);

	cb( { tokens: tokens } );
};

if (typeof module === "object") {
	module.exports.AttributeExpander = AttributeExpander;
}
