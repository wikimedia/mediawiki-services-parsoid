/**
 * Per-wiki config library for interfacing with MediaWiki.
 */

var qs = require( 'querystring' ),
	util = require( 'util' ),
	request = require( 'request' )

var WikiConfig = function ( resultConf ) {
	var conf = this;

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
};

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}

