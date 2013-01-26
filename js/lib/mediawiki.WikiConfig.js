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

	var names = resultConf.namespaces;
	var nkeys = Object.keys( names );
	for ( var nx = 0; nx < nkeys.length; nx++ ) {
		conf.namespaceNames[nx] = names[nkeys[nx]]['*'];
		conf.namespaceIds[names[nkeys[nx]]['*'].toLowerCase()] = nkeys[nx];
		if ( names[nkeys[nx]].canonical ) {
			conf.canonicalNamespaces[names[nkeys[nx]].canonical.toLowerCase()] = nkeys[nx];
		} else {
			conf.canonicalNamespaces[names[nkeys[nx]]['*'].toLowerCase()] = nkeys[nx];
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

	var specials = resultConf.specialpagealiases;
	for ( var sx = 0; sx < specials.length; sx++ ) {
		aliases = specials[sx].aliases;
		for ( var sax = 0; sax < aliases.length; sax++ ) {
			conf.specialPages[aliases[sax]] = specials[sx].realname;
		}
	}

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
	namespaceNames: {
		'-2': 'Media',
		'-1': 'Special',
		'0': '',
		'1': 'Talk',
		'2': 'User',
		'3': 'User talk',
		'4': 'Project',
		'5': 'Project talk',
		'6': 'File',
		'7': 'File talk',
		'8': 'MediaWiki',
		'9': 'MediaWiki talk',
		'10': 'Template',
		'11': 'Template talk',
		'12': 'Help',
		'13': 'Help talk',
		'14': 'Category',
		'15': 'Category talk'
	},
	namespaceIds: {},
	magicWords: {
		// Behaviour switches
		'__notoc__': 'notoc',
		'__forcetoc__': 'forcetoc',
		'__toc__': 'toc',
		'__noeditsection__': 'noeditsection',
		'__newsectionlink__': 'newsectionlink',
		'__nonewsectionlink__': 'nonewsectionlink',
		'__nogallery__': 'nogallery',
		'__hiddencat__': 'hiddencat',
		'__nocontentconvert__': 'nocontentconvert',
		'__nocc__': 'nocc',
		'__notitleconvert__': 'notitleconvert',
		'__notc__': 'notc',
		'__start__': 'start',
		'__end__': 'end',
		'__index__': 'index',
		'__noindex__': 'noindex',
		'__staticredirect__': 'staticredirect',

		// Image-related magic words
		// See also mediawiki.wikitext.constants.js

		// prefix
		'link': 'img_link',
		'alt': 'img_alt',
		'page': 'img_page',
		'upright': 'img_upright',

		// format
		'thumbnail': 'thumbnail',
		'thumb': 'img_thumbnail',
		'framed': 'img_framed',
		'frame': 'img_framed',
		'frameless': 'img_frameless',
		'border': 'img_border',

		// valign
		'baseline': 'img_baseline',
		'sub': 'img_sub',
		'super': 'img_super',
		'sup': 'img_super',
		'top': 'img_top',
		'text-top': 'img_text_top',
		'middle': 'img_middle',
		'bottom': 'img_bottom',
		'text-bottom': 'img_text_bottom',

		// halign
		'left': 'img_left',
		'right': 'img_right',
		'center': 'img_center',
		'float': 'img_float',
		'none': 'img_none'
	},
	specialPages: {},
	extensionTags: {}
};

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}

