/*
 * Per-wiki config library for interfacing with MediaWiki.
 */
'use strict';
require('./core-upgrade.js');

var baseConfig = require('./baseconfig/enwiki.json').query;
var JSUtils = require('./jsutils.js').JSUtils;
var Util = require('./mediawiki.Util.js').Util;
var request = require('request');

// Make sure our base config is never modified
JSUtils.deepFreeze(baseConfig);


/**
 * @class
 *
 * Per-wiki configuration object.
 *
 * @constructor
 * @param {MWParserEnvironment} env
 * @param {Object} resultConf The configuration object from a MediaWiki API request. See the #ConfigRequest class in lib/mediawiki.ApiRequest.js for information about how we get this object. If null, we use the contents of lib/mediawiki.BaseConfig.json instead.
 * @param {string} prefix The interwiki prefix this config will represent. Will be used for caching elsewhere in the code.
 * @param {string} apiURI The URI that represents this wiki's API endpoint. Usually ends in api.php.
 * @param {string} [apiProxy] The proxy that should be used to access apiURI.
 */
function WikiConfig(env, resultConf, prefix, apiURI, apiProxy) {
	var nsid, name;
	var conf = this;

	// Mapping from canonical namespace name to id
	// The English namespace names are built-in and will work in any language.
	this.canonicalNamespaces = {
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
		category_talk: 15,
	};

	// Seed localized namespace name to id mapping with canonicalNamespaces
	this.namespaceIds = Object.create(this.canonicalNamespaces);

	// The interwiki prefix
	this.iwp = prefix || "";

	// The URI for api.php on this wiki.
	this.apiURI = apiURI || null;

	// The proxy to use for this wiki.
	this.apiProxy = apiProxy;

	if (resultConf === null) {
		// Use the default JSON that we've already loaded above.
		resultConf = baseConfig;
	}

	var general = resultConf.general;

	// Warn about older versions ( 1.21 matches baseconfigs )
	var apiVersion = parseFloat((general.generator || "").substr("MediaWiki ".length));
	if (Number.isNaN(apiVersion) || apiVersion < 1.21) {
		env.log("warning", "The MediaWiki API appears to be very old and" +
			" may not support necessary features. Proceed with caution!");
	}

	// Store the wiki's main page.
	this.mainpage = general.mainpage;

	// The language
	this.lang = general.lang;
	this.rtl = general.rtl !== undefined;

	var names = resultConf.namespaces;
	var nkeys = Object.keys(names);

	// Mapping from namespace id to the canonical name. Start with defaults.
	this.namespaceNames = {
		'6': 'File',
		'-2': 'Media',
		'-1': 'Special',
		'0': '',
		'14': 'Category',
	};

	this._categoryRegexpSource = "Category";
	this._specialAliases = ['Special'];

	// Namespace IDs that have subpages enabled.
	this.namespacesWithSubpages = {};
	for (var nx = 0; nx < nkeys.length; nx++) {
		nsid = nkeys[nx];
		name = names[nsid];
		this.namespaceNames[nsid] = name['*'];
		if (nsid === '-1' && name['*'] !== 'Special') {
			this._specialAliases.push(name['*']);
		}
		if (nsid === "14" && name['*'] !== "Category") {
			this._categoryRegexpSource += "|" + name['*'];
		}
		this.namespaceIds[Util.normalizeNamespaceName(name['*'])] = Number(nsid);
		if (name.canonical) {
			// XXX: is this b/c?
			this.canonicalNamespaces[Util.normalizeNamespaceName(name.canonical)] =
				Number(nsid);
		} else {
			this.canonicalNamespaces[Util.normalizeNamespaceName(name['*'])] =
				Number(nsid);
		}
		if ('subpages' in names[nsid]) {
			this.namespacesWithSubpages[ Number(nsid) ] = true;
		}
	}

	// add in a parsoid pseudo-namespace


	var aliases = resultConf.namespacealiases;
	for (var ax = 0; ax < aliases.length; ax++) {
		this.namespaceIds[Util.normalizeNamespaceName(aliases[ax]['*'])] = aliases[ax].id;
		if (aliases[ax].id === -1) {
			this._specialAliases.push(aliases[ax]['*']);
		}
	}

	// The interwikiMap maps prefixes to the corresponding information
	// gathered from the api query (prefix, language, url, local)
	this.interwikiMap = new Map();
	var iwMap = resultConf.interwikimap;
	Object.keys(iwMap).forEach(function(key) {
		var interwiki = iwMap[key];
		conf.interwikiMap.set(interwiki.prefix, interwiki);
		if (!/\$1/.test(interwiki.url)) {
			// Fix up broken interwiki hrefs that are missing a $1 placeholder
			// Just append the placeholder at the end.
			// This makes sure that the InterWikiMatcher below adds one match
			// group per URI, and that interwiki links work as expected.
			interwiki.url += '$1';
		}
	});

	var cachedMatcher = null;
	this.InterWikiMatcher = function() {
		if (cachedMatcher) {
			return cachedMatcher;
		}
		var keys = [];
		var patterns = [];
		conf.interwikiMap.forEach(function(val, key) {
			keys.push(key);
			var url = val.url;
			var protocolRelative = url.startsWith('//');
			if (val.protorel !== undefined) {
				url = url.replace(/^https?:/, '');
				protocolRelative = true;
			}
			patterns.push(
				// Support protocol-relative URLs
				(protocolRelative ? '(?:https?:)?' : '') +
				// Avoid regexp escaping on placeholder
				Util.escapeRegExp(url.replace('$1', '%1'))
				// Now convert placeholder to group match
				.replace('%1', '(.*?)')
			);
		});
		var reString = '^(?:' + patterns.join('|') + ')$';
		var regExp = new RegExp(reString);
		var match = function(s) {
			var matches = s.match(regExp);
			if (matches) {
				var groups = matches.slice(1);
				for (var i = 0; i < groups.length; i++) {
					if (groups[i] !== undefined) {
						// The interwiki prefix: 'en', 'de' etc
						var key = keys[i];
						if (conf.interwikiMap.get(key).language) {
							// Escape language interwikis with a colon
							key = ':' + key;
						}
						return [
							key,
							groups[i],
						];
					}
				}
			}
			return false;
		};
		// cache this result so we don't have to recompute it later
		cachedMatcher = { match: match };
		return cachedMatcher;
	};


	// "mw" here refers to "magicwords", not "mediawiki"
	var mws = resultConf.magicwords;
	var mw;
	var replaceRegex = /\$1/;
	var namedMagicOptions = [];

	// Canonical magic word names on this wiki, indexed by aliases.
	this.magicWords = {};

	// Lists of aliases, indexed by canonical magic word name.
	this.mwAliases = {};

	// RegExps matching aliases, indexed by canonical magic word name.
	this._mwRegexps = {};

	// Behavior switch regexp
	this.bswRegexp = null;

	// List of magic words that are interpolated, i.e., they have $1 in their aliases.
	this._interpolatedMagicWords = [];

	// List of magic word aliases with $1 in their names, indexed by canonical name.
	this._interpolatedMagicWordAliases = {};

	var bsws = [];
	for (var j = 0; j < mws.length; j++) {
		mw = mws[j];
		aliases = mw.aliases;
		if (aliases.length > 0) {
			this.mwAliases[mw.name] = [];
			this._interpolatedMagicWordAliases[mw.name] = [];
		}
		for (var k = 0; k < aliases.length; k++) {
			var alias = aliases[k];

			var match = alias.match(/^__(.*)__$/);
			if (match) {
				bsws.push(match[1]);
				if (mw['case-sensitive'] !== '') {
					bsws.push(match[1].toLowerCase());
				}
			}

			this.mwAliases[mw.name].push(alias);
			if (mw['case-sensitive'] !== '') {
				alias = alias.toLowerCase();
				this.mwAliases[mw.name].push(alias);
			}
			this.magicWords[alias] = mw.name;

			if (alias.match(/\$1/) !== null) {
				// This is a named option. Add it to the array.
				namedMagicOptions.push(alias.replace(replaceRegex, '(.*)'));
				this._interpolatedMagicWords.push(alias);
				this._interpolatedMagicWordAliases[mw.name].push(alias);
			}
		}
		this._mwRegexps[mw.name] =
			new RegExp('^(' +
				this.mwAliases[mw.name].map(Util.escapeRegExp).join('|') +
				')$',
				mw['case-sensitive'] === '' ? '' : 'i');
	}

	if (mws.length > 0) {
		// Combine the gathered named magic words into a single regex
		var namedMagicString = namedMagicOptions.join('|');
		this.namedMagicRegex = new RegExp(namedMagicString);
	}

	this.bswRegexp = new RegExp(
		'(?:' + bsws.map(Util.escapeRegExp).join("|") + ')'
	);
	this.bswPagePropRegexp = new RegExp(
		'(?:^|\\s)mw:PageProp/' + this.bswRegexp.source + '(?=$|\\s)'
	);

	// Special page names on this wiki, indexed by aliases.
	// We need these to recognize localized ISBN magic links.
	var specialPages = this.specialPages = new Map();
	(resultConf.specialpagealiases || []).forEach(function(special) {
		specialPages.set(
			special.realname,
			new RegExp(
				special.aliases.map(function(a) {
					// Treat space and underscore interchangeably, and use
					// escapeRegExp to protect special characters in the title
					return a.split(/[ _]/g).map(Util.escapeRegExp).join('[ _]');
				}).join('|')
			)
		);
	});

	// Special case for localized ISBN ExtResourceMatcher
	var isbnRegExp = new RegExp(
		'^(?:(?:[.][.]?/)*)' +
		'(?:' + this._specialAliases.map(function(a) {
			return a.split(/[ _]/g).map(Util.escapeRegExp).join('[ _]');
		}).join('|') + ')(?:%3[Aa]|:)(?:' +
		(this.specialPages.get('Booksources') || /Booksources/).source +
		')(?:%2[Ff]|/)(\\d+[Xx]?)$',
		// Strictly speaking, only the namespace is case insensitive.
		// But we're feeling generous.
		'i'
	);
	var superMatch = WikiConfig.prototype.ExtResourceURLPatternMatcher.match;
	this.ExtResourceURLPatternMatcher = {
		match: function(s) {
			var r = superMatch(s);
			if (!r) {
				var m = s.match(isbnRegExp);
				if (m) {
					return [ 'ISBN', m[1] ];
				}
			}
			return r;
		},
	};

	// Regex for stripping useless stuff out of the regex messages
	var stripRegex = /^\/\^(.*)\$\//;

	// Convert PCRE \x{ff} style code points used by PHP to JS \u00ff style code
	// points. For background search for \u in http://www.pcre.org/pcre.txt.
	function convertCodePoints(regexp) {
		return regexp.replace(/\\x\{([0-9a-fA-F]+)\}/g, function(m, chars) {
			// pad to four hex digits
			while (chars.length < 4) {
				chars = '0' + chars;
			}
			return '\\u' + chars;
		});
	}

	// Helper function for parsing the linktrail/linkprefix regexes
	function buildLinkNeighbourRegex(string, isTrail) {
		var regexResult = string.match(stripRegex);

		if (regexResult !== null) {
			regexResult = regexResult[1].replace(/\(\.\*\??\)/, '');
			regexResult = convertCodePoints(regexResult);
		}

		if (regexResult === '()') {
			// At least zh gives us a linktrail value of /^()(.*)$/sD, which
			// would match anything. Refuse to use such a non-sense regexp.
			return null;
		}

		if (isTrail) {
			regexResult = '^' + regexResult;
		} else {
			regexResult += '$';
		}

		try {
			return new RegExp(regexResult);
		} catch (e) {
			console.error(e);
			return null;
		}
	}

	// Get the general information and use it for article, upload, and image
	// paths.
	if (resultConf.general) {
		if (general.mainpage) {
			this.mainpage = general.mainpage;
		}

		if (general.articlepath) {
			if (general.server) {
				this.baseURI = general.server + general.articlepath.replace(/\$1/, '');
			}

			this.articlePath = general.articlepath;
		}

		if (general.script) {
			this.script = general.script;
		}

		if (general.server) {
			this.server = general.server;
		}

		if (general.linktrail) {
			this.linkTrailRegex = buildLinkNeighbourRegex(general.linktrail, true);
		} else if (general.linktrail === '') {
			this.linkTrailRegex = null;
		} else {
			this.linkTrailRegex = Util.linkTrailRegex;
		}

		if (general.linkprefixcharset) {
			// New MediaWiki post https://gerrit.wikimedia.org/r/#/c/91425/
			// returns just the char class, for example 'a-z'.
			try {
				this.linkPrefixRegex = new RegExp(
						'[' + convertCodePoints(general.linkprefixcharset) + ']+$');
			} catch (e) {
				console.error(e);
				this.linkPrefixRegex = null;
			}
		} else if (general.linkprefix) {
			this.linkPrefixRegex = buildLinkNeighbourRegex(general.linkprefix, false);
		} else {
			this.linkPrefixRegex = null;
		}

		if (general['case'] === 'case-sensitive') {
			this.caseSensitive = true;
		} else {
			this.caseSensitive = false;
		}

		if (general.externalimages) {
			this.allowExternalImages = general.externalimages;
		}

		if (general.imagewhitelistenabled !== undefined) {
			this.enableImageWhitelist = true;
			// XXX we don't actually support the on-wiki whitelist (T53268)
			// if we did, we would probably want to fetch and cache
			//  MediaWiki:External image whitelist
			// here (rather than do so on every parse)
		} else {
			this.enableImageWhitelist = false;
		}
	}

	if (!this.baseURI) {
		throw new Error('No baseURI was provided by the config request we made.');
	}

	// Allowed protocol prefixes
	this._protocols = {};
	// Get information about the allowed protocols for external links.
	// For very far backwards compatibility, default to enwiki config if
	// protocols siprop is not provided.
	var protocols = resultConf.hasOwnProperty("protocols") ?
			resultConf.protocols : baseConfig.protocols;
	for (var px = 0; px < protocols.length; px++) {
		var proto = protocols[px];
		this._protocols[proto] = true;
	}
	var alternation = protocols.map(Util.escapeRegExp).join('|');
	this._anchoredProtocolRegex = new RegExp('^(' + alternation + ')', 'i');
	this._unanchoredProtocolRegex = new RegExp('(?:\\W|^)(' + alternation + ')', 'i');

	// Extension tags on this wiki, indexed by their aliases.
	this.extensionTags = {};
	if (resultConf.extensiontags) {
		var extensions = resultConf.extensiontags;
		for (var ex = 0; ex < extensions.length; ex++) {
			var ext = extensions[ex];
			// Strip the tag wrappers because we only want the name
			this.extensionTags[ext.replace(/(^<|>$)/g, '').toLowerCase()] = true;
		}
	}

	// Function hooks on this wiki, indexed by their normalized form
	this.functionHooks = new Set(resultConf.functionhooks || []);

	// Match a wikitext line containing just whitespace, comments, and
	// sol transparent links and behavior switches.
	// Redirects should not contain any preceding non-whitespace chars.
	this.solTransparentWikitextRegexp = JSUtils.rejoin(
		"^\\s*",
		"(?:",
			"(?:", this._mwRegexps.redirect.source.slice(2, -2), ")",
			"\\s+\\[\\[[^\\]]*?\\]\\]",
		")?",
		"(?:",
			"\\[\\[",
			"(?:", this._categoryRegexpSource, ")",
			"\\:[^\\]]*?\\]\\]",
		"|",
			"__", this.bswRegexp, "__",
		"|",
			Util.COMMENT_REGEXP,
		"|",
			"\\s",
		")*$",
		{ flags: "i" }
	);

	// Almost the same thing (see the start/end), but don't allow whitespace.
	this.solTransparentWikitextNoWsRegexp = JSUtils.rejoin(
		"((?:",
			"(?:", this._mwRegexps.redirect.source.slice(2, -2), ")",
			"\\s+\\[\\[[^\\]]*?\\]\\]",
		")?",
		"(?:",
			"\\[\\[",
			"(?:", this._categoryRegexpSource, ")",
			"\\:[^\\]]*?\\]\\]",
		"|",
			"__", this.bswRegexp, "__",
		"|",
			Util.COMMENT_REGEXP,
		")*)",
		{ flags: "i" }
	);
}

/**
 * @method
 *
 * Get the canonical name of a magic word alias.
 *
 * @param {string} alias
 * @return {string|null}
 */
WikiConfig.prototype.getMagicWordIdFromAlias = function(alias) {
	if (this.magicWords.hasOwnProperty(alias)) {
		return this.magicWords[alias];
	} else {
		return null;
	}
};

/**
 * Get canonical magicword name for the input word
 *
 * @param {string} word
 * @return {string}
 */
WikiConfig.prototype.magicWordCanonicalName = function(word) {
	return this.getMagicWordIdFromAlias(word) || this.getMagicWordIdFromAlias(word.toLowerCase());
};

/**
 * Check if a string is a recognized magic word
 */
WikiConfig.prototype.isMagicWord = function(word) {
	return this.magicWordCanonicalName(word) !== null;
};

/**
 * Convert the internal canonical magic word name to the wikitext alias
 */
WikiConfig.prototype.getMagicWordWT = function(word, suggest) {
	var aliases = this.mwAliases[ word ];
	if (!Array.isArray(aliases) || aliases.length === 0) {
		return suggest;
	}
	var ind = 0;
	if (suggest) {
		ind = aliases.indexOf(suggest);
	}
	return aliases[ ind > 0 ? ind : 0 ];
};

/**
 * @method
 *
 * Get a regexp matching a localized magic word, given its id.
 *
 * @param {string} id
 * @return {RegExp}
 */
WikiConfig.prototype.getMagicWordMatcher = function(id) {
	// if 'id' is not found, return a regexp which will never match.
	return this._mwRegexps[id] || /[]/;
};

/**
 * @method
 *
 * Get a matcher function for fetching values out of interpolated magic words, i.e. those with $1 in their aliases.
 *
 * @param {Map} optionsMap The map of options you want to check for (e.g. the map of all interpolated image options)
 * @return {Function}
 */
WikiConfig.prototype.getMagicPatternMatcher = function(optionsMap) {
	var aliases, regex;
	var regexString = '';
	var getInterpolatedMagicWord = function(text, useRegex, useMwList) {
		useMwList = useMwList || this._interpolatedMagicWords;
		useRegex = useRegex || this.namedMagicRegex;
		var matches = text.match(useRegex);
		if (matches === null) {
			return null;
		}
		var value;
		var alias = null;
		for (var ix = 1; ix < matches.length && ix - 1 < useMwList.length && alias === null; ix++) {
			if (matches[ix] !== undefined) {
				alias = useMwList[ix - 1];
				value = matches[ix];
			}
		}
		if (alias === null) {
			return null;
		}
		var canonical = this.getMagicWordIdFromAlias(alias);
		if (canonical !== null) {
			return { k: canonical, v: value, a: alias };
		}
		return null;
	}.bind(this);

	var mwlist = [];
	var first = true;
	optionsMap.forEach(function(value, option) {
		if (!first) {
			regexString += '|';
		}
		first = false;
		aliases = this._interpolatedMagicWordAliases[option];
		if (aliases === undefined) { aliases = ['UNKNOWN_' + option]; }
		regexString += aliases.join('|')
			.replace(/((?:^|\|)(?:[^\$]|\$[^1])*)($|\|)/g, '$1$$1$2')
			.replace(/\$1/g, '(.*)');
		mwlist = mwlist.concat(aliases);
	}.bind(this));
	regex = new RegExp('^(?:' + regexString + ')$');

	return function(text) {
		return getInterpolatedMagicWord(text, regex, mwlist);
	};
};

/**
 * @method
 *
 * Builds a magic word string out of an alias with $1 in it and a value for the option.
 *
 * @param {string} alias
 * @param {string} value
 * @return {string}
 */
WikiConfig.prototype.replaceInterpolatedMagicWord = function(alias, value) {
	return alias.replace(/\$1/, value);
};



// Default RFC/PMID resource URL patterns
WikiConfig.prototype.ExtResourceURLPatterns = {
	// ISBN validation is done below in serializer.
	'ISBN': {
		prefix: "(?:(?:[.][.]?/)*)",
		re: 'Special(?:%3[Aa]|:)Book[Ss]ources(?:%2[Ff]|/)%isbn',
	},
	'RFC': { re: '//tools.ietf.org/html/rfc%s' },
	'PMID': { re: '//www.ncbi.nlm.nih.gov/pubmed/%s?dopt=Abstract' },
};

var unispace = /[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

WikiConfig.prototype.ExtResourceSerializer = {
	'ISBN': function(hrefWT, href, content) {
		var normalized = Util.decodeEntities(content).replace(unispace, ' ')
			.replace(/[\- \t]/g, '').toUpperCase();
		// validate ISBN length and format, so as not to produce magic links
		// which aren't actually magic
		var valid = /^ISBN(97[89])?\d{9}(\d|X)$/.test(normalized);
		if (hrefWT.join('') === normalized && valid) {
			return content;
		} else {
			href = href.replace(/^\.\//, ''); // strip "./" prefix
			return '[[' + href + '|' + content + ']]';
		}
	},
	'RFC': function(hrefWT, href, content) {
		var normalized = Util.decodeEntities(content).replace(unispace, ' ')
			.replace(/[ \t]/g, ' ');
		return hrefWT.join(' ') === normalized ? content : '[' + href + ' ' + content + ']';
	},
	'PMID': function(hrefWT, href, content) {
		var normalized = Util.decodeEntities(content).replace(unispace, ' ')
			.replace(/[ \t]/g, ' ');
		return hrefWT.join(' ') === normalized ? content : '[' + href + ' ' + content + ']';
	},
};

/**
 * Matcher for RFC/PMID URL patterns, returning the type and number. The match
 * method takes a string and returns false on no match or a tuple like this on match:
 * ['RFC', '12345']
 * @property {Object} ExtResourceURLPatternMatcher
 * @property {Function} ExtResourceURLPatternMatcher.match
 */
WikiConfig.prototype.ExtResourceURLPatternMatcher = (function() {
	var keys = Object.keys(WikiConfig.prototype.ExtResourceURLPatterns);
	var patterns = [];

	keys.forEach(function(key) {
		var reOpts = WikiConfig.prototype.ExtResourceURLPatterns[key];
		var re = Util.escapeRegExp(reOpts.re).replace('%s', '(\\w+)').replace('%d', '(\\d+)').replace('%isbn', '(\\d+[Xx]?)');
		patterns.push("^(?:" + (reOpts.prefix || "") + re + ")$");
	});

	var regExp = new RegExp(patterns.join('|'));
	var match = function(s) {
		var matches = s.match(regExp);
		if (matches) {
			var groups = matches.slice(1);
			for (var i = 0; i < groups.length; i++) {
				if (groups[i] !== undefined) {
					return [
						// The key: 'PMID', 'RFC' etc
						keys[i],
						groups[i],
					];
				}
			}
		}
		return false;
	};
	return {
		match: match,
	};
})();

/**
 * Matcher for valid protocols, must be anchored at start of string.
 * @param {string} potentialLink
 */
WikiConfig.prototype.hasValidProtocol = function(potentialLink) {
	return this._anchoredProtocolRegex.test(potentialLink);
};

/**
 * Matcher for valid protocols, may occur at any point within string.
 * @param {string} potentialLink
 */
WikiConfig.prototype.findValidProtocol = function(potentialLink) {
	return this._unanchoredProtocolRegex.exec(potentialLink);
};

/**
 * @param {string} potentialTag in lower case
 */
WikiConfig.prototype.isExtensionTag = function(potentialTag) {
	if (this.extensionTags === null) {
		return false;
	} else {
		return this.extensionTags[potentialTag.toLowerCase()] === true;
	}
};

/**
 * @param {string} newTag
 */
WikiConfig.prototype.addExtensionTag = function(newTag) {
	this.extensionTags[newTag] = true;
};


/**
 * @param {string} tagName
 */
WikiConfig.prototype.removeExtensionTag = function(tagName) {
	delete this.extensionTags[tagName];
};

if (typeof module === 'object') {
	module.exports.WikiConfig = WikiConfig;
}
