"use strict";

var Util = require('./mediawiki.Util.js').Util;

var Namespace; // forward declaration

/**
 * @class
 *
 * Represents a title in a wiki.
 *
 * @constructor
 * @param {string} key The text of the title
 * @param {number} ns The id of the namespace where the page is
 * @param {string} nskey The text of the namespace name
 * @param {MWParserEnvironment} env
 */
function Title ( key, ns, nskey, env ) {
	this.key = env.resolveTitle( key, ns );

	// If the title is relative, the resolved key will contain the namespace
	// from env.page.name, so we need to take it out.
	if ( env.conf.wiki.namespacesWithSubpages[ns] && /^(\.\.\/)+|(\/)/.test( key ) ) {
		var keyParts = this.key.split(':', 2);
		// Some titles can have subpages enabled, have a "/" in the name
		// and have a namespace-like string in it
		// Ex: Utilisateur:Steven De Oliveira/Brouillon/007 : Quitte ou double
		// from bug 63636
		if (env.conf.wiki.namespaceIds[keyParts[1]] === ns) {
			this.key = keyParts.pop();
		}
	}

	this.ns = new Namespace( ns, env );

	// the original ns string
	this.nskey = nskey;
	this.env = env;
}

/**
 * @method
 * @static
 *
 * Take text, e.g. from a wikilink, and make a Title object from it.
 * Somewhat superseded by WikiLinkHandler.getWikiLinkTargetInfo.
 *
 * @param {MWParserEnvironment} env
 * @param {string} text The prefixed text.
 * @returns {Title}
 */
Title.fromPrefixedText = function ( env, text ) {
	text = env.normalizeTitle( text );
	var nsText = text.split( ':', 1 )[0];
	if ( nsText && nsText !== text ) {
		var ns = env.conf.wiki.namespaceIds[ nsText.toLowerCase().replace( ' ', '_' ) ];
		//console.warn( JSON.stringify( [ nsText, ns ] ) );
		if ( ns !== undefined ) {
			return new Title( text.substr( nsText.length + 1 ), ns, nsText, env );
		} else {
			return new Title( text, 0, '', env );
		}
	} else if ( env.page.meta && /^(\#|\/|\.\.\/)/.test( text ) ) {
		// If the link is relative, use the page's namespace.
		return new Title( text, env.page.meta.ns, '', env );
	} else {
		return new Title( text, 0, '', env );
	}
};

/**
 * @method
 *
 * Make a full link out of a title.
 *
 * @returns {string}
 */
Title.prototype.makeLink = function () {
	// XXX: links always point to the canonical namespace name.
	if ( false && this.nskey ) {
		return Util.sanitizeTitleURI( this.env.page.relativeLinkPrefix +
				this.nskey + ':' + this.key );
	} else {
		var l = this.env.page.relativeLinkPrefix,
			ns = this.ns.getDefaultName();

		if ( ns ) {
			l += ns + ':';
		}
		return Util.sanitizeTitleURI( l + this.key );
	}
};

/**
 * @method
 *
 * Get the text of the title, like you might see in a wikilink.
 *
 * @returns {string}
 */
Title.prototype.getPrefixedText = function () {
	// XXX: links always point to the canonical namespace name.
	if ( this.nskey ) {
		return Util.sanitizeURI( this.nskey + ':' + this.key );
	} else {
		var ns = this.ns.getDefaultName();

		if ( ns ) {
			ns += ':';
		}
		return Util.sanitizeTitleURI( ns + this.key );
	}
};

/**
 * @class
 *
 * Represents a namespace, meant for use in the #Title class.
 *
 * @constructor
 * @param {number} id The id of the namespace to represent.
 * @param {MWParserEnvironment} env
 */
Namespace = function( id, env ) {
	this.env = env;
	this.id = Number( id );
};

/**
 * @method
 *
 * Determine whether the namespace is the File namespace.
 *
 * @returns {boolean}
 */
Namespace.prototype.isFile = function ( ) {
	return this.id === this.env.conf.wiki.canonicalNamespaces.file;
};

/**
 * @method
 *
 * Determine whether the namespace is the Category namespace.
 *
 * @returns {boolean}
 */
Namespace.prototype.isCategory = function ( ) {
	return this.id === this.env.conf.wiki.canonicalNamespaces.category;
};

/**
 * @method
 *
 * Determine the default name of the namespace.
 *
 * @returns {string/undefined}
 */
Namespace.prototype.getDefaultName = function ( ) {
	var ns = this.env.conf.wiki.namespaceNames[this.id.toString()];
	if ( ns ) {
		ns = ns.replace(' ', '_');
	}
	return ns;
};

if (typeof module === "object") {
	module.exports.Title = Title;
	module.exports.Namespace = Namespace;
}
