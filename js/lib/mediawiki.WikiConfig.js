/**
 * Per-wiki config library for interfacing with MediaWiki.
 */

var qs = require( 'querystring' ),
	util = require( 'util' ),
	request = require( 'request' ),
	baseConfig = require( './mediawiki.BaseConfig.json' ).query;

var WikiConfig = function ( resultConf, prefix, uri ) {
	var nsid, name, conf = this;

	conf.iwp = prefix;

	if ( uri ) {
		this.apiURI = uri;
	}

	if ( resultConf === null ) {
		// Use the default JSON that we've already loaded above.
		resultConf = baseConfig;
	}

	var names = resultConf.namespaces;
	var nkeys = Object.keys( names );
	for ( var nx = 0; nx < nkeys.length; nx++ ) {
		nsid = nkeys[nx];
		name = names[nsid];
		conf.namespaceNames[nsid] = name['*'];
		conf.namespaceIds[name['*'].toLowerCase()] = Number( nsid );
		if ( name.canonical ) {
			conf.canonicalNamespaces[name.canonical.toLowerCase()] = Number( nsid );
		} else {
			conf.canonicalNamespaces[name['*'].toLowerCase()] = Number( nsid );
		}
	}

	var aliases = resultConf.namespacealiases;
	for ( var ax = 0; ax < aliases.length; ax++ ) {
		conf.namespaceIds[aliases[ax]['*']] = aliases[ax].id;
	}

	var mws = resultConf.magicwords;
	if ( mws.length > 0 ) {
		// Don't use the default if we get a result.
		conf.magicWords = {};
	}
	for ( var mwx = 0; mwx < mws.length; mwx++ ) {
		aliases = mws[mwx].aliases;
		for ( mwax = 0; mwax < aliases.length; mwax++ ) {
			if ( mws[mwx]['case-sensitive'] !== '' ) {
				aliases[mwax] = aliases[mwax].toLowerCase();
			}

			conf.magicWords[aliases[mwax]] = mws[mwx].name;
		}
	}

// This path isn't necessary because we don't need special page aliases.
// Before you uncomment this, make sure you actually need it, and be sure to
// also add 'specialpagealiases' back into the API request for the config.
//	var specials = resultConf.specialpagealiases;
//	for ( var sx = 0; sx < specials.length; sx++ ) {
//		aliases = specials[sx].aliases;
//		for ( var sax = 0; sax < aliases.length; sax++ ) {
//			conf.specialPages[aliases[sax]] = specials[sx].realname;
//		}
//	}

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
	apiURI: null,
	canonicalNamespaces: {
		media: -2,
		special: -1,
		main: 0,
		'': 0,
		talk: 1,
		user: 2,
		user_talk: 3,
		project: 4,
		project_talk: 5,
		file: 6,
		image: 6,
		file_talk: 7,
		image_talk: 7,
		mediawiki: 8,
		mediawiki_talk: 9,
		template: 10,
		template_talk: 11,
		help: 12,
		help_talk: 13,
		category: 14,
		category_talk: 15
	},
	namespaceNames: {},
	namespaceIds: {},
	magicWords: {},
	specialPages: {},
	extensionTags: {}
};

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}

