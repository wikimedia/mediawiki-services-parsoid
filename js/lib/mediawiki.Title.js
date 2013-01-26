"use strict";

var Util = require('./mediawiki.Util.js').Util;

function Title ( key, ns, nskey, env ) {
	this.key = env.resolveTitle( key );

	this.ns = new Namespace( ns, env );

	// the original ns string
	this.nskey = nskey;
	this.env = env;
}

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


function Namespace( id, env ) {
	var ids = env.conf.wiki.namespaceIds;
	var names = env.conf.wiki.namespaceNames;
	this.id = id;
	this.namespaceIds = env.conf.wiki.canonicalNamespaces;
	this.canonicalNamespaces = env.conf.wiki.canonicalNamespaces;

	if ( ids ) {
		for ( var ix in ids ) {
		if ( ids.hasOwnProperty( ix ) ) {
			this.namespaceIds[ix.toLowerCase()] = ids[ix] - 0;
			}
		}
	}

	this.namespaceNames = ( names ) ? names : {
		'6': 'File',
		'-2': 'Media',
		'-1': 'Special',
		'0': '',
		'14': 'Category'
	};
}

Namespace.prototype.isFile = function ( ) {
	return this.id === this.canonicalNamespaces.file;
};
Namespace.prototype.isCategory = function ( ) {
	return this.id === this.canonicalNamespaces.category;
};

Namespace.prototype.getDefaultName = function ( ) {
	return this.namespaceNames[this.id.toString()];
};


if (typeof module === "object") {
	module.exports.Title = Title;
	module.exports.Namespace = Namespace;
}

