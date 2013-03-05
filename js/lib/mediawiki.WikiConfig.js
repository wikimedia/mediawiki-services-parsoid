/**
 * Per-wiki config library for interfacing with MediaWiki.
 */

var qs = require( 'querystring' ),
	util = require( 'util' ),
	request = require( 'request' ),
	baseConfig = require( './baseconfig/en.json' ).query,
	Util = require( './mediawiki.Util.js' ).Util,
	request = require( 'request' );

var WikiConfig = function ( resultConf, prefix, uri, parsoidConf ) {
	var nsid, name, conf = this;
	this.init(); // initialize hashes/arrays/etc.

	conf.iwp = prefix;

	if ( uri && ( !parsoidConf || !parsoidConf.useLocalConfig ) ) {
		this.apiURI = uri;
	}

	if ( resultConf === null ) {
		// Use the default JSON that we've already loaded above.
		resultConf = baseConfig;
	}
	var general = resultConf.general;

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
	for ( var mwx = 0; mwx < mws.length; mwx++ ) {
		mw = mws[mwx];
		aliases = mw.aliases;
		if ( aliases.length > 0 ) {
			conf.mwAliases[mw.name] = [];
		}
		for ( var mwax = 0; mwax < aliases.length; mwax++ ) {
			var alias = aliases[mwax];
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

	// Regex for stripping useless stuff out of the regex messages
	var stripRegex = /^\/\^(.*)\$\//;

	// Helper function for parsing the linktrail/linkprefix regexes
	function buildLinkNeighbourRegex( string, isTrail ) {
		var regexResult = string.match( stripRegex );

		if ( regexResult !== null ) {
			regexResult = regexResult[1].replace( /\(\.\*\??\)/, '' );
		}

		if ( isTrail ) {
			regexResult = '^' + regexResult;
		} else {
			regexResult += '$';
		}

		return new RegExp( regexResult );
	}

	// Get the general information and use it for article, upload, and image
	// paths.
	if ( resultConf.general ) {
		if ( general.articlepath ) {
			if ( general.server ) {
				conf.baseURI = general.server + general.articlepath.replace(/\$1/, '');
			}

			conf.articlePath = general.articlepath;
		}

		if ( general.script ) {
			conf.script = general.script;
		}

		if ( general.server ) {
			conf.server = general.server;
		}

		if ( general.linktrail ) {
			conf.linkTrailRegex = buildLinkNeighbourRegex( general.linktrail, true );
		} else if ( general.linktrail === '' ) {
			conf.linkTrailRegex = null;
		} else {
			conf.linkTrailRegex = Util.linkTrailRegex;
		}

		if ( general.linkprefix ) {
			conf.linkPrefixRegex = buildLinkNeighbourRegex( general.linkprefix, false );
		} else {
			conf.linkPrefixRegex = null;
		}
	}

	if ( !conf.baseURI ) {
		throw new Error( 'No baseURI was provided by the config request we made.' );
	}

	// Get information about the allowed protocols for external links.
	if ( resultConf.protocols ) {
		var proto, protocols = resultConf.protocols;
		for ( var px = 0; px < protocols.length; px++ ) {
			proto = protocols[px];
			conf._protocols[proto] = true;
		}

		conf._protocolRegex = new RegExp( '^(' + protocols.join( '|' ) + ')', 'i' );
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
	namespaceNames: null,
	namespaceIds: null,
	magicWords: null,
	mwAliases: null,
	specialPages: null,
	extensionTags: null,
	interpolatedList: null,

	/**
	 * @property {string[]}
	 * @private
	 */
	_protocols: null,

	/**
	 * @property {RegExp}
	 * @private
	 */
	_protocolRegex: null,

	init: function() {
		// give the instance its own hashes/arrays so they
		// don't get aliased.
		this.namespaceNames = {};
		this.namespaceIds = {};
		this.magicWords = {};
		this.mwAliases = {};
		this.specialPages = {};
		this.extensionTags = {};
		this.interpolatedList = [];
		this._protocols = {};
		// clone the canonicalNamespace list
		this.canonicalNamespaces =
			Object.create(WikiConfig.prototype.canonicalNamespaces);
	},

	getMagicWord: function ( alias ) {
		return this.magicWords[alias] || null;
	},

	getMagicPatternMatcher: function ( optionsList ) {
		var ix, mwlist, aliases, regex, regexString = '',
			getInterpolatedMagicWord = function ( text, useRegex, useMwList ) {
				var ix, alias, value, canonical,
					matches = text.match( useRegex );
				useMwList = useMwList || this.interpolatedList;
				useRegex = useRegex || this.namedMagicRegex;

				if ( matches === null ) {
					return null;
				}
				alias = null;
				for ( ix = 1; ix < matches.length && ix - 1 < useMwList.length && alias === null; ix++ ) {
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
	},

	/**
	 * @param {string} potentialLink
	 */
	hasValidProtocol: function ( potentialLink ) {
		if ( this._protocolRegex ) {
			return this._protocolRegex.test( potentialLink );
		} else {
			// With no available restrictions, we have to assume "no".
			return false;
		}
	}
};
Object.freeze(WikiConfig.prototype.canonicalNamespaces);

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}
