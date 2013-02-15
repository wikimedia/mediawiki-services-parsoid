/**
 * Per-wiki config library for interfacing with MediaWiki.
 */

var qs = require( 'querystring' ),
	util = require( 'util' ),
	request = require( 'request' ),
	baseConfig = require( './mediawiki.BaseConfig.json' ).query,
	request = require( 'request' );

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
	var general = resultConf.general;

	conf.baseURI = general.server + general.articlepath.replace(/\$1/, '');

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

	// The interwikiMap maps prefixes to the corresponding information
	// gathered from the api query (prefix, language, url, local)
	conf.interwikiMap = {};
	var interwikimap = resultConf.interwikimap;
	var interwikiKeys = Object.keys(interwikimap);
	for ( var index = 0; index < interwikiKeys.length; index++ ) {
		var key = interwikimap[index].prefix;
		conf.interwikiMap[key] = interwikimap[index];
	}


	// Add in wikipedia languages too- they are not necessarily registered as
	// interwikis and are expected by parserTests.
	for( var i = 0, l = resultConf.languages.length; i < l; i++) {
		var entry = resultConf.languages[i];
		if (!conf.interwikiMap[entry.code]) {
			conf.interwikiMap[entry.code] = {
				prefix: entry.code,
				url: 'http://' + entry.code + '.wikipedia.org/wiki/$1',
				language: entry['*']
			};
		} else if (!conf.interwikiMap[entry.code].language) {
			// Not sure if this case is possible, but make sure this is
			// treated as a language.
			conf.interwikiMap[entry.code].language = entry['*'];
		}
	}

	// "mw" here refers to "magicwords", not "mediawiki"
	var mws = resultConf.magicwords;
	var mw, replaceRegex = /\$1/;
	var namedMagicOptions = [];
	if ( mws.length > 0 ) {
		// Don't use the default if we get a result.
		conf.magicWords = {};
		conf.mwAliases = {};
		conf.interpolatedList = [];
	}
	for ( var mwx = 0; mwx < mws.length; mwx++ ) {
		mw = mws[mwx];
		aliases = mw.aliases;
		if ( aliases.length > 0 ) {
			conf.mwAliases[mw.name] = [];
		}
		for ( mwax = 0; mwax < aliases.length; mwax++ ) {
			alias = aliases[mwax];
			if ( mw['case-sensitive'] !== '' ) {
				alias = alias.toLowerCase();
			}

			if ( alias.match( /\$1/ ) !== null ) {
				// This is a named option. Add it to the array.
				namedMagicOptions.push( alias.replace( replaceRegex, '(.*)' ) );
				conf.interpolatedList.push( alias );
			}
			conf.magicWords[alias] = mw.name;
			conf.mwAliases[mw.name].push( alias );
		}
	}

	if ( mws.length > 0 ) {
		// Combine the gathered named magic words into a single regex
		var namedMagicString = namedMagicOptions.join( '|' );
		conf.namedMagicRegex = new RegExp( namedMagicString );
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
	var stripRegex = /^\/\^(.*)\$\//;
	var messages = resultConf.allmessages;
	var thismsg, regexResult;
	for ( var amx = 0; amx < messages.length; amx++ ) {
		thismsg = messages[amx];
		if ( thismsg['*'] ) {
			regexResult = thismsg['*'].match( stripRegex );
			if ( regexResult !== null ) {
				regexResult = regexResult[1].replace( /\(\.\*\??\)/, '' );
			}
			switch ( thismsg.name ) {
				case 'linktrail':
					conf.linkTrailRegex = new RegExp( '^' + regexResult );
					break;
				case 'linkprefix':
					conf.linkPrefixRegex = new RegExp( regexResult + '$' );
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
	mwAliases: {},
	specialPages: {},
	extensionTags: {},
	interpolatedList: [],

	getMagicWord: function ( alias ) {
		return this.magicWords[alias] || null;
	},

	getMagicPatternMatcher: function ( optionsList ) {
		var ix, mwlist, aliases, regex, regexString = '',
			getInterpolatedMagicWord = function ( text, useRegex, useMwList ) {
				var ix, alias, value, canonical,
					useMwList = useMwList || this.interpolatedList,
					useRegex = useRegex || this.namedMagicRegex,
					matches = text.match( useRegex );

				if ( matches === null ) {
					return null;
				}
				alias = null;
				for ( var ix = 1; ix < matches.length && ix - 1 < useMwList.length && alias === null; ix++ ) {
					if ( matches[ix] !== undefined ) {
						alias = useMwList[ix - 1];
						value = matches[ix];
					}
				}
				if ( alias === null ) {
					return null;
				}
				canonical = this.getMagicWord( alias );
				if ( canonical !== null ) {
					return { k: canonical, v: value, a: alias };
				}
				return null;
			}.bind( this );


		mwlist = [];
		for ( ix = 0; ix < optionsList.length; ix++ ) {
			if ( ix > 0 ) {
				regexString += '|';
			}
			aliases = this.mwAliases[optionsList[ix]];
			regexString += aliases.join( '|' )
				.replace( /((?:^|\|)(?:[^\$]|\$[^1])*)($|\|)/g, '$1$$1$2' )
				.replace( /\$1/g, '(.*)' );
			mwlist = mwlist.concat( aliases );
		}
		regex = new RegExp( regexString );

		return function ( text ) {
			return getInterpolatedMagicWord( text, regex, mwlist );
		};
	},

	replaceInterpolatedMagicWord: function ( alias, value ) {
		return alias.replace( /\$1/, value );
	}
};

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}
