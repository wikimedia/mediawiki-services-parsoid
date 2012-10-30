"use strict";

/**
 * Generic attribute expansion handler.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */
var $ = require('jquery'),
	request = require('request'),
	events = require('events'),
	qs = require('querystring'),
	Util = require('./mediawiki.Util.js').Util,
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

/**
 * Callback for attribute expansion in AttributeTransformManager
 */
AttributeExpander.prototype._returnAttributes = function ( token, cb, newAttrs )
{
	this.manager.env.dp( 'AttributeExpander._returnAttributes: ', newAttrs );

	var tokens      = [];
	var metaTokens  = [];
	var oldAttrs    = token.attribs;
	var a, newK, i, l, metaObjType, producerObjType, kv, updatedK, updatedV;

	// Identify attributes that were generated in full or in part using templates
	// and add appropriate meta tags for them.
	for (i = 0, l = oldAttrs.length; i < l; i++) {
		a    = oldAttrs[i];
		newK = newAttrs[i].k;

		// Preserve the key and value source, if available
		newAttrs[i].ksrc = a.ksrc;
		newAttrs[i].vsrc = a.vsrc;

		if (newK) {
			var contentType = "objectAttrKey"; // default
			if (a.k.constructor === Array) {
				if ( newK.constructor === String && newK.match( /mw\:maybeContent/ ) ) {
					updatedK = Util.stripMetaTags( 'mw:keyAffected', this.options.wrapTemplates );
					newAttrs.push( new KV( 'mw:keyAffected', newAttrs[i].v ) );
					newK = updatedK.value;
				} else {
					updatedK = Util.stripMetaTags(newK, this.options.wrapTemplates);
					newK = updatedK.value;
					if (newAttrs[i].v === '') {
						// Some templates can return content that should be
						// interpreted as a key-value pair.
						// Ex: {{GetStyle}} can return style='color:red;'
						// and might be used as <div {{GetStyle}}>foo</div> to
						// generate: <div style='color:red;'>foo</div>.
						//
						// To support this, we utilize the following hack.
						// If we got a string of the form "k=v" and our orig-v
						// was empty, then, we split the template content around
						// the '=' and update the 'k' and 'v' to the split values.
						var kArr = Util.tokensToString(newK, true);
						var kStr = (kArr.constructor === String) ? kArr : kArr[0];
						var m    = kStr.match(/([^=]+)=['"]?([^'"]*)['"]?$/);
						if (m) {
							contentType = "objectAttr"; // both key and value
							newK = m[1];
							if (kArr.constructor === String) {
								newAttrs[i].v = m[2];
							} else {
								kArr[0] = m[2];
								newAttrs[i].v = kArr;
							}
						}
					}
					newAttrs[i].k = newK;
				}

				if ( updatedK ) {
					metaObjType = updatedK.metaObjType;
					if (metaObjType) {
						producerObjType = metaObjType;
						metaTokens.push( Util.makeTplAffectedMeta(contentType, newK, updatedK) );
					}
				}
			}

			// We have a string key and potentially expanded value.
			// Check if the value came from a template/extension expansion.
			if (a.v.constructor === Array && newK.constructor === String) {
				if (newK.match( /mw\:maybeContent/ ) ) {
					// For mw:maybeContent attributes, at this point, we do not really know
					// what this attribute represents.
					//
					// - For regular links and images [[Foo|bar]], this attr (bar) represents
					//   link text which transforms to a DOM sub-tree. If 'bar' comes from
					//   a template, we can let template meta tags stay in the DOM sub-tree.
					//
					// - For categories [[Category:Foo|bar]], this attr (bar) is just a sort
					//   key that will be part of the href attr and will not be a DOM subtree.
					//   If 'bar' comes from a template, we have to strip all meta tags from
					//   the token stream of 'bar' and add new meta tags outside the category
					//   token recording the fact that the sort key in the href came from
					//   a template.
					//
					// We have to wait for all templates to be expanded before we know the
					// context (wikilink/category) this attr is showing up in. So, if this
					// attr has been generated by a template/extension, keep around both the
					// original as well as the stripped versions of the template-generated
					// attr, and in the link handler, we will pick the right version.
					updatedV = Util.stripMetaTags( newAttrs[i].v, this.options.wrapTemplates );
					metaObjType = updatedV.metaObjType;
					if (metaObjType) {
						kv = new KV('mw:valAffected', [
							metaObjType,
							Util.makeTplAffectedMeta("objectAttrVal", newK, updatedV)
						]);
						newAttrs.push( kv );
					}
				} else if (!newK.match(/^mw:/)) {
					updatedV = Util.stripMetaTags( newAttrs[i].v, this.options.wrapTemplates );
					newAttrs[i].v = updatedV.value;
					metaObjType = updatedV.metaObjType;
					if (metaObjType) {
						producerObjType = metaObjType;
						metaTokens.push( Util.makeTplAffectedMeta("objectAttrVal", newK, updatedV) );
					}
				}
			}
		}
	}

	// Update attrs
	token.attribs = newAttrs;

	// Update metatoken info
	l = metaTokens.length;
	if (l > 0) {
		var tokenId = token.getAttribute( 'about' );

		if ( !tokenId ) {
			tokenId = '#mwt' + this.manager.env.generateUID();
			token.addAttribute("about", tokenId);
			token.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs/" + producerObjType.substring("mw:Object/".length));
		}

		for (i = 0; i < l; i++) {
			metaTokens[i].addAttribute("about", tokenId);
		}
	}

	// console.warn("NEW TOK: " + JSON.stringify(token));

	tokens = metaTokens;
	tokens.push(token);

	cb( { tokens: tokens } );
};

if (typeof module === "object") {
	module.exports.AttributeExpander = AttributeExpander;
}
