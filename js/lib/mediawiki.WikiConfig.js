/**
 * Per-wiki config library for interfacing with MediaWiki.
 */

var qs = require( 'querystring' ),
	util = require( 'util' ),
	request = require( 'request' )

var WikiConfig = function ( resultConf, prefix, uri ) {
	var conf = this;

	conf.iwp = prefix;

	if ( uri ) {
		this.apiURI = uri;
	}

	if ( resultConf === null ) {
		// We can't set it up any further without result JSON.
		// Just give up while we're behind.
		return;
	}

	conf.namespaceNames = {};
	conf.namespaceIds = {};
	var names = resultConf.namespaces;
	var nkeys = Object.keys( names );
	for ( var nx = 0; nx < nkeys.length; nx++ ) {
		conf.namespaceNames[nx] = names[nkeys[nx]]['*'];
		conf.namespaceIds[names[nkeys[nx]]['*'].toLowerCase()] = nkeys[nx];
	}

	var aliases = resultConf.namespacealiases;
	for ( var ax = 0; ax < aliases.length; ax++ ) {
		conf.namespaceIds[aliases[ax]['*']] = aliases[ax].id;
	}

	conf.magicWords = {};
	var mws = resultConf.magicwords;
	for ( var mwx = 0; mwx < mws.length; mwx++ ) {
		aliases = mws[mwx].aliases;
		for ( mwax = 0; mwax < aliases.length; mwax++ ) {
			conf.magicWords[aliases[mwax]] = mws[mwx].name;
		}
	}

	conf.specialPages = {};
	var specials = resultConf.specialpagealiases;
	for ( var sx = 0; sx < specials.length; sx++ ) {
		aliases = specials[sx].aliases;
		for ( var sax = 0; sax < aliases.length; sax++ ) {
			conf.specialPages[aliases[sax]] = specials[sx].realname;
		}
	}

	conf.extensionTags = resultConf.extensiontags;

	// Get the linktrail and linkprefix messages from the server
	// TODO XXX etc. : Use these somewhere
	var stripRegex = /^\/(.*)\/.*/;
	var messages = resultConf.allmessages;
	var thismsg;
	for ( var amx = 0; amx < messages.length; amx++ ) {
		thismsg = messages[amx];
		if ( thismsg['*'] ) {
			switch ( thismsg.name ) {
				case 'linktrail':
					conf.linkTrailRegex = new RegExp( thismsg['*'].match( stripRegex )[1] );
					break;
				case 'linkprefix':
					conf.linkPrefixRegex = new RegExp( thismsg['*'].match( stripRegex )[1] );
					break;
				default:
					// Do nothing!
					break;
			}
		}
	}

	// Get the general information and use it for article, upload, and image
	// paths.
	if ( resultConf.general ) {
		var general = resultConf.general;
		if ( general.articlepath ) {
			this.articlePath = general.articlepath;
		}
		if ( general.script ) {
			this.script = general.script;
		}
		if ( general.server ) {
			this.server = general.server;
		}
	}
};

WikiConfig.prototype = {
	wgScriptPath: '/wiki/',
	script: '/wiki/index.php',
	articlePath: '/wiki/$1',
	apiURI: null
};

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}

