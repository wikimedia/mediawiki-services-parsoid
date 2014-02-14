/*
 * Generic attribute expansion handler.
 */
"use strict";

var async = require('async'),
	Util = require('./mediawiki.Util.js').Util,
	AttributeTransformManager = require('./mediawiki.TokenTransformManager.js').
	                            AttributeTransformManager,
	defines = require('./mediawiki.parser.defines.js');
// define some constructor shortcuts
var KV = defines.KV,
    EOFTk = defines.EOFTk,
    TagTk = defines.TagTk,
    SelfclosingTagTk = defines.SelfclosingTagTk;

/* ----------------------------------------------------------
 * This helper method does two different things:
 *
 * 1. Strips all meta tags (introduced by transclusions, etc)
 * 2. In wrap-template mode, it identifies the meta-object type
 *    and returns it.
 * ---------------------------------------------------------- */
function stripMetaTags( tokens, wrapTemplates ) {
	var isPushed, buf = [],
		hasGeneratedContent = false,
		inTpl = false,
		inInclude = false;

	for (var i = 0, l = tokens.length; i < l; i++) {
		var token = tokens[i];
		if ([TagTk, SelfclosingTagTk].indexOf(token.constructor) !== -1) {
			isPushed = false;
			// Strip all meta tags.
			if (wrapTemplates) {
				// If we are in wrap-template mode, extract info from the meta-tag
				var t = token.getAttribute("typeof");
				var typeMatch = t && t.match(/(mw:(Transclusion|Param|Extension|Includes\/)(.*)?$)/);
				if (typeMatch) {
					if (!typeMatch[1].match(/\/End$/)) {
						inTpl = typeMatch[1].match(/Transclusion|Param|Extension/);
						inInclude = !inTpl;
						hasGeneratedContent = true;
					} else {
						inTpl = false;
						inInclude = false;
					}
				} else {
					isPushed = true;
					buf.push(token);
				}
			}

			if (!isPushed && token.name !== "meta") {
				// Dont strip token if it is not a meta-tag
				buf.push(token);
			}
		} else {
			buf.push(token);
		}
	}

	return { hasGeneratedContent: hasGeneratedContent, value: buf };
}

/**
 * @class
 *
 * Generic attribute expansion handler.
 *
 * @constructor
 * @param {TokenTransformManager} manager The manager for this stage of the parse.
 * @param {Object} options Any options for the expander.
 */
function AttributeExpander ( manager, options ) {
	this.manager = manager;
	this.options = options;

	// XXX: only register for tag tokens?
	manager.addTransform( this.onToken.bind(this), "AttributeExpander:onToken",
			this.rank, 'any' );
}

// constants
AttributeExpander.prototype.rank = 1.12;

/**
 * Token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 *
 * @private
 * @param {Token} token -- token whose attrs being expanded
 * @param {Frame} frame -- unused here, passed in by AsyncTTM to all handlers
 * @param {Function} cb -- callback receiving the expanded token
 */
AttributeExpander.prototype.onToken = function ( token, frame, cb ) {
	// console.warn( 'AttributeExpander.onToken: ', JSON.stringify( token ) );
	if ( (token.constructor === TagTk || token.constructor === SelfclosingTagTk) &&
		// Do not process dom-fragment tokens: a separate handler deals with them.
		token.name !== 'mw:dom-fragment-token' &&
		token.attribs && token.attribs.length ) {
		cb( { async: true } );
		(new AttributeTransformManager(
			this.manager,
			{ wrapTemplates: this.options.wrapTemplates },
			this._returnAttributes.bind(this, token, cb)
		)).process(token.attribs);
	} else {
		cb( { tokens: [token] } );
	}
};

/**
 * Callback for attribute expansion in AttributeTransformManager
 *
 * @private
 */
AttributeExpander.prototype._returnAttributes = function ( token, cb, newAttrs )
{
	this.manager.env.dp( 'AttributeExpander._returnAttributes: ', newAttrs );

	var modified = false,
		metaTokens = [],
		tmpDataMW = new Map(),
		oldAttrs = token.attribs,
		a, newA, newK, i, l, updatedK, updatedV;

	// Identify attributes that were generated in full or in part using templates
	for (i = 0, l = oldAttrs.length; i < l; i++) {
		a    = oldAttrs[i];
		newA = newAttrs[i];
		newK = newA.k;

		// Preserve the key and value source, if available.
		// But, if 'a' wasn't cloned, newA will be the same as 'a'.
		// Dont try to update it and crash since a is frozen.
		if (a !== newA) {
			newA.ksrc = a.ksrc;
			newA.vsrc = a.vsrc;
			newA.srcOffsets = a.srcOffsets;
		}

		if (newK) {
			if ( Array.isArray(a.k) ) {
				if ( newK.constructor !== String || !newK.match( /mw\:maybeContent/ ) ) {
					updatedK = stripMetaTags(newK, this.options.wrapTemplates);
					newK = updatedK.value;
					if (newA.v === '') {
						// Some templates can return content that should be
						// interpreted as a key-value pair.
						// Ex: {{GetStyle}} can return style='color:red;'
						// and might be used as <div {{GetStyle}}>foo</div> to
						// generate: <div style='color:red;'>foo</div>.
						//
						// Real use case: Template {{ligne grise}} on frwp.
						//
						// To support this, we utilize the following hack.
						// If we got a string of the form "k=v" and our orig-v
						// was empty, then, we split the template content around
						// the '=' and update the 'k' and 'v' to the split values.
						var kArr = Util.tokensToString(newK, true),
							kStr = (kArr.constructor === String) ? kArr : kArr[0],
							m    = kStr.match(/([^=]+)=['"]?([^'"]*)['"]?$/);

						if (m) {
							newK = m[1];
							if (kArr.constructor === String) {
								newA.v = m[2];
							} else {
								kArr[0] = m[2];
								newA.v = kArr;
							}

							// Represent this in data-mw by assigning the entire
							// templated string to the key's HTML and blanking
							// the value's HTML. Other way round should work as well.
							tmpDataMW.set(newK, {
								k: { "txt": newK, "html": newA.k },
								v: { "html": [] }
							});
						}
					}

					if (updatedK.hasGeneratedContent && !tmpDataMW.get(newK)) {
						// newK can be an array
						if (newK.constructor !== String) {
							var key = Util.tokensToString(newK);
							tmpDataMW.set(key, {
								k: { "txt": key, "html": newA.k },
								v: { "html": newA.v }
							});
						}
					}

					modified = true;
					newA.k = newK;
				}
			} else if (newK !== a.k) {
				modified = true;
			}

			// We have a string key and potentially expanded value.
			// Check if the value came from a template/extension expansion.
			if ( newK.constructor === String && Array.isArray(a.v) ) {
				modified = true;
				if (!newK.match(/^mw:/)) {
					updatedV = stripMetaTags( newA.v, this.options.wrapTemplates );
					if (updatedV.hasGeneratedContent) {
						if (!tmpDataMW.get(newK)) {
							tmpDataMW.set(newK,  {
								k: { "txt": newK },
								v: { "html": newA.v }
							});
						}
					}

					if (!newK.match(/^mw:/)) {
						newA.v = updatedV.value;
					}
				}
			} else if (newA.v !== a.v) {
				modified = true;
			}
		}
	}

	if (modified) {
		token.attribs = newAttrs;

		// If the token already has an about, it already has transclusion/extension
		// wrapping. No need to record information about templated attributes in addition.
		//
		// FIXME: If there is a real use case for extension attributes getting
		// templated, this check can be relaxed to allow that.
		// https://gerrit.wikimedia.org/r/#/c/65575 has some reference code that
		// can be used then.
		if ( !token.getAttribute( 'about' ) && tmpDataMW.size > 0) {
			cb( { async: true } );

			// Flatten k-v pairs.
			var vals = [];
			tmpDataMW.forEach(function(obj) {
				vals.push(obj.k, obj.v);
			});

			var manager = this.manager;

			// Async-expand all token arrays to DOM.
			Util.expandValuesToDOM(manager.env, manager.frame, vals, function(err, eVals) {
				// Rebuild flattened k-v pairs.
				var expandedAttrs = [];
				for (var i = 0; i < eVals.length; i += 2) {
					expandedAttrs.push([eVals[i], eVals[i+1]]);
				}

				// Mark token as having expanded attrs.
				token.addAttribute("about", manager.env.newAboutId());
				token.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs");
				token.addAttribute("data-mw", JSON.stringify({
					attribs: expandedAttrs
				}));
				cb( { tokens: [token] });
			});

			return;
		}
		// console.warn("NEW TOK: " + JSON.stringify(token));
	}

	cb( { tokens: [token] } );
};

if (typeof module === "object") {
	module.exports.AttributeExpander = AttributeExpander;
}
