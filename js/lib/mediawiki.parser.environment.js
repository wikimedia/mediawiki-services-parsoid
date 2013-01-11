"use strict";

var Util = require('./mediawiki.Util.js').Util;
var WikiConfig = require( './mediawiki.WikiConfig.js' ).WikiConfig;
var ParsoidConfig = require( './mediawiki.ParsoidConfig.js' ).ParsoidConfig;
var ConfigRequest = require( './mediawiki.ApiRequest.js' ).ConfigRequest;
var title = require('./mediawiki.Title.js'),
	$ = require( 'jquery' ),
	Title = title.Title,
	Namespace = title.Namespace;

function Tracer(env) {
	this.env = env;
}
Tracer.prototype = {
	startPass: function(string) {
		if (this.env.trace) {
			console.warn("---- start: " + string + " ----");
		}
	},

	endPass: function(string) {
		if (this.env.trace) {
			console.warn("---- end  : " + string + " ----");
		}
	},

	traceToken: function(token, compact) {
		if (compact === undefined) {
			compact = true;
		}

		if (this.env.trace) {
			if (token.constructor === String) {
				console.warn("T: '" + token + "'");
			} else  {
				console.warn("T: " + token.toString(compact));
			}
		}
	},

	output: function(string) {
		if (this.env.trace) {
			console.warn(string);
		}
	},

	outputChunk: function(chunk) {
		if (this.env.trace) {
			console.warn("---- <chunk:tokenized> ----");
			for (var i = 0, n = chunk.length; i < n; i++) {
				console.warn(chunk[i].toString());
			}
			console.warn("---- </chunk:tokenized> ----");
		}
	}
};

var MWParserEnvironment = function(opts) {
	// The parser environment really serves several distinct purposes currently:
	// - it holds config data which is not modified at runtime -> a config object
	// - it provides debugging objects -> can be part of config (immutable)
	// - the page name, src, oldid etc is held -> a page object
	// - global per-execution state: page cache, uid
	// TODO: disentangle these!

	var options = {
		// config
		tagHooks: {},
		parserFunctions: {},
		debug: false,
		trace: false,
		wgScriptPath: "/wiki/",
		wgScript: "/wiki/index.php",
		wgUploadPath: "/wiki/images",
		wgScriptExtension: ".php",
		fetchTemplates: false,
		maxDepth: 40,
		usePHPPreProcessor: false,

		// page information
		page: {
			name: 'Main page',
			relativeLinkPrefix: '',
			id: null,
			src: null,
			dom: null
		},

		// execution state
		pageCache: {}, // @fixme use something with managed space
		uid: 1
	};
	// XXX: this should be namespaced
	$.extend(options, opts);
	$.extend(this, options);

	this.setPageName( this.page.name );

	// Tracing object
	this.tracer = new Tracer(this);

	// Default value for parsoid config
	if ( !this.parsoidConf ) {
		this.parsoidConf = new ParsoidConfig();
	}

	// Initialise empty default values for interwiki config
	this.iwp = '';
	this.conf = {};
};

// Outstanding page requests (for templates etc)
// Class-static
MWParserEnvironment.prototype.requestQueue = {};

MWParserEnvironment.prototype.setPageName = function ( pageName ) {
	this.page.name = pageName;
	// Construct a relative link prefix depending on the number of slashes in
	// pageName
	this.page.relativeLinkPrefix = '';
	var slashMatches = this.page.name.match(/\//g),
		numSlashes = slashMatches ? slashMatches.length : 0;
	if ( numSlashes ) {
		while ( numSlashes ) {
			this.page.relativeLinkPrefix += '../';
			numSlashes--;
		}
	} else {
		// Always prefix a ./ so that we don't have to escape colons. Those
		// would otherwise fool browsers into treating namespaces as
		// protocols.
		this.page.relativeLinkPrefix = './';
	}
};

MWParserEnvironment.prototype.getVariable = function( varname, options ) {
	//XXX what was the original author's intention?
	//something like this?:
	//  return this.options[varname];
	return this[varname];
};

MWParserEnvironment.prototype.setVariable = function( varname, value, options ) {
	this[varname] = value;
};

/**
 * @return MWParserFunction
 */
MWParserEnvironment.prototype.getParserFunction = function( name ) {
	if (name in this.parserFunctions) {
		return new this.parserFunctions[name]( this );
	} else {
		return null;
	}
};

/**
 * @return MWParserTagHook
 */
MWParserEnvironment.prototype.getTagHook = function( name ) {
	if (name in this.tagHooks) {
		return new this.tagHooks[name](this);
	} else {
		return null;
	}
};

/**
 * Alternate constructor - takes a localsettings object, config, and an interwiki
 * prefix to set up the environment. Calls back with the resulting object.
 */
MWParserEnvironment.getParserEnv = function ( ls, config, prefix, options, pageName, cb ) {
	var env = new this( options || {
		// stay within the 'proxied' content, so that we can click around
		wgScriptPath: '/', //http://en.wikipedia.org/wiki',
		wgScriptExtension: '.php',
		// XXX: add options for this!
		wgUploadPath: 'http://upload.wikimedia.org/wikipedia/commons',
		fetchTemplates: true,
		// enable/disable debug output using this switch
		debug: false,
		trace: false,
		maxDepth: 40,
		parsoidConf: parsoidConf
	} );

	// add mediawiki.org
	env.parsoidConf.setInterwiki( 'mw', 'http://www.mediawiki.org/w' );

	// add localhost default
	env.parsoidConf.setInterwiki( 'localhost', 'http://localhost/w' );

	// add the dump in case we want to use that
	env.parsoidConf.setInterwiki( 'dump', 'http://dump-api.wmflabs.org/w' );
	env.parsoidConf.setInterwiki( 'dump-internal', 'http://10.4.0.162/w' );

	if ( pageName ) {
		env.setPageName( pageName );
	}

	// Apply local settings
	if ( ls && ls.setup ) {
		ls.setup( config, env.parsoidConf );
	}

	// Set the current interwiki prefix
	env.iwp = '';

	// Get that wiki's config
	env.switchToConfig( prefix, function () {
		cb( env );
	} );
};

/**
 * Function that switches to a different configuration for a different wiki.
 * Caches all configs so we only need to get each one once (if we do it right)
 */
MWParserEnvironment.prototype.switchToConfig = function ( prefix, cb ) {
	var uri = this.parsoidConf.interwikiMap[prefix] + '/api' + this.wgScriptExtension;
	this.confCache = this.confCache || {};
	this.confCache[this.iwp] = this.conf;

	this.iwp = prefix;

	if ( this.confCache[this.iwp] ) {
		this.conf = this.confCache[this.iwp];
		cb();
	} else {
		var confRequest = new ConfigRequest( uri, this );
		confRequest.on( 'src', function ( error, resultConf ) {
			if ( error !== null ) {
				resultConf = {
					namespaces: {},
					namespacealiases: [],
					magicwords: [],
					specialpagealiases: [],
					extensiontags: null,
					allmessages: []
				};
			}

			this.conf = new WikiConfig( resultConf );
			cb();
		}.bind( this ) );
	}
};

MWParserEnvironment.prototype.makeTitleFromPrefixedText = function ( text ) {
	text = this.normalizeTitle( text );
	var nsText = text.split( ':', 1 )[0];
	if ( nsText && nsText !== text ) {
		var _ns = new Namespace( 0, this );
		var ns = _ns.namespaceIds[ nsText.toLowerCase().replace( ' ', '_' ) ];
		//console.warn( JSON.stringify( [ nsText, ns ] ) );
		if ( ns !== undefined ) {
			return new Title( text.substr( nsText.length + 1 ), ns, nsText, this );
		} else {
			return new Title( text, 0, '', this );
		}
	} else {
		return new Title( text, 0, '', this );
	}
};


// XXX: move to Title!
MWParserEnvironment.prototype.normalizeTitle = function( name, noUnderScores,
		preserveLeadingColon )
{
	if (typeof name !== 'string') {
		throw new Error('nooooooooo not a string');
	}
	var forceNS, self = this;
	if ( name.substr( 0, 1 ) === ':' ) {
		forceNS = preserveLeadingColon ? ':' : '';
		name = name.substr(1);
	} else {
		forceNS = '';
	}


	name = name.trim();
	if ( ! noUnderScores ) {
		name = name.replace(/[\s_]+/g, '_');
	}

	// Implement int: as alias for MediaWiki:
	if ( name.substr( 0, 4 ) === 'int:' ) {
		name = 'MediaWiki:' + name.substr( 4 );
	}

	// FIXME: Generalize namespace case normalization
	if ( name.substr( 0, 10 ).toLowerCase() === 'mediawiki:' ) {
		name = 'MediaWiki:' + name.substr( 10 );
	}

	function upperFirst( s ) { return s.substr( 0, 1 ).toUpperCase() + s.substr(1); }

	function splitNS ( ) {
		var nsMatch = name.match( /^([a-zA-Z\-]+):/ ),
			ns = nsMatch && nsMatch[1] || '';
		if( ns !== '' && ns !== name ) {
			if ( self.parsoidConf.interwikiMap[ns.toLowerCase()] ) {
				forceNS += ns + ':';
				name = name.substr( nsMatch[0].length );
				splitNS();
			} else {
				name = upperFirst( ns ) + ':' + upperFirst( name.substr( ns.length + 1 ) );
			}
		} else {
			name = upperFirst( name );
		}
	}
	splitNS();
	//name = name.split(':').map( upperFirst ).join(':');
	//if (name === '') {
	//	throw new Error('Invalid/empty title');
	//}
	return forceNS + name;
};

/**
 * @fixme do this for real eh
 */
MWParserEnvironment.prototype.resolveTitle = function( name, namespace ) {
	// Resolve subpages
	var relUp = name.match(/^(\.\.\/)+/);
	if ( relUp ) {
		var levels = relUp[0].length / 3,
			titleBits = this.page.name.split(/\//),
			newBits = titleBits.slice(0, titleBits.length - levels);
		if ( name !== relUp[0] ) {
			newBits.push( name.substr(levels * 3) );
		}
		name = newBits.join('/');
		//console.log( relUp, name );
	}

	if ( name.length && name[0] === '/' ) {
		name = this.normalizeTitle( this.page.name ) + name;
	}
	// FIXME: match against proper list of namespaces
	if ( name.indexOf(':') === -1 && namespace ) {
		// hack hack hack
		name = namespace + ':' + this.normalizeTitle( name );
	}
	// Strip leading ':'
	if (name[0] === ':') {
		name = name.substr( 1 );
	}

	return name;
};

/**
 * Simple debug helper
 */
MWParserEnvironment.prototype.dp = function ( ) {
	if ( this.debug ) {
		if ( arguments.length > 1 ) {
			try {
				console.warn( JSON.stringify( arguments, null, 2 ) );
			} catch ( e ) {
				console.trace();
				console.warn( e );
			}
		} else {
			console.warn( arguments[0] );
		}
	}
};

/**
 * Even simpler debug helper that always prints..
 */
MWParserEnvironment.prototype.ap = function ( ) {
	if ( arguments.length > 1 ) {
		try {
			console.warn( JSON.stringify( arguments, null, 2 ) );
		} catch ( e ) {
			console.warn( e );
		}
	} else {
		console.warn( arguments[0] );
	}
};
/**
 * Simple debug helper, trace-only
 */
MWParserEnvironment.prototype.tp = function ( ) {
	if ( this.debug || this.trace ) {
		if ( arguments.length > 1 ) {
			console.warn( JSON.stringify( arguments, null, 2 ) );
		} else {
			console.warn( arguments[0] );
		}
	}
};

/**
 * Generate a UID
 */
MWParserEnvironment.prototype.generateUID = function () {
	return this.uid++;
};

MWParserEnvironment.prototype.newObjectId = function () {
	return "mwt" + this.generateUID();
};

MWParserEnvironment.prototype.stripIdPrefix = function(aboutId) {
	return aboutId.replace(/^#?mwt/, '');
};

MWParserEnvironment.prototype.isParsoidObjectId = function(aboutId) {
	return aboutId.match(/^#mwt/);
}

/**
 * Default implementation of an error callback for async
 * error reporting in the parser pipeline.
 *
 * For best results, define your own. For better results,
 * call it from places you notice errors happening.
 */
MWParserEnvironment.prototype.errCB = function ( error ) {
	console.log( 'ERROR in ' + this.page.name + ':\n' + error.stack );
	process.exit( 1 );
};


if (typeof module === "object") {
	module.exports.MWParserEnvironment = MWParserEnvironment;
}

