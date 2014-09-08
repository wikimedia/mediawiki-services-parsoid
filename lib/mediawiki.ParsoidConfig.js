/*
 * Parsoid-specific configuration. We'll use this object to configure
 * interwiki regexes, mostly.
 */
"use strict";

require('./core-upgrade.js');
var url = require('url'),
	Cite = require('./ext.Cite.js').Cite,
	Util = require('./mediawiki.Util.js').Util;

var wikipedias = "en|de|fr|nl|it|pl|es|ru|ja|pt|zh|sv|vi|uk|ca|no|fi|cs|hu|ko|fa|id|tr|ro|ar|sk|eo|da|sr|lt|ms|eu|he|sl|bg|kk|vo|war|hr|hi|et|az|gl|simple|nn|la|th|el|new|roa-rup|oc|sh|ka|mk|tl|ht|pms|te|ta|be-x-old|ceb|br|be|lv|sq|jv|mg|cy|lb|mr|is|bs|yo|an|hy|fy|bpy|lmo|pnb|ml|sw|bn|io|af|gu|zh-yue|ne|nds|ku|ast|ur|scn|su|qu|diq|ba|tt|my|ga|cv|ia|nap|bat-smg|map-bms|wa|kn|als|am|bug|tg|gd|zh-min-nan|yi|vec|hif|sco|roa-tara|os|arz|nah|uz|sah|mn|sa|mzn|pam|hsb|mi|li|ky|si|co|gan|glk|ckb|bo|fo|bar|bcl|ilo|mrj|fiu-vro|nds-nl|tk|vls|se|gv|ps|rue|dv|nrm|pag|koi|pa|rm|km|kv|udm|csb|mhr|fur|mt|wuu|lij|ug|lad|pi|zea|sc|bh|zh-classical|nov|ksh|or|ang|kw|so|nv|xmf|stq|hak|ay|frp|frr|ext|szl|pcd|ie|gag|haw|xal|ln|rw|pdc|pfl|krc|crh|eml|ace|gn|to|ce|kl|arc|myv|dsb|vep|pap|bjn|as|tpi|lbe|wo|mdf|jbo|kab|av|sn|cbk-zam|ty|srn|kbd|lo|ab|lez|mwl|ltg|ig|na|kg|tet|za|kaa|nso|zu|rmy|cu|tn|chr|got|sm|bi|mo|bm|iu|chy|ik|pih|ss|sd|pnt|cdo|ee|ha|ti|bxr|om|ks|ts|ki|ve|sg|rn|dz|cr|lg|ak|tum|fj|st|tw|ch|ny|ff|xh|ng|ii|cho|mh|aa|kj|ho|mus|kr|hz|tyv|min";

var interwikiMap = new Map();
var reverseIWMap = new Map();

function insertInMaps( prefix, domain, path, protocol ) {
	interwikiMap.set( prefix, (protocol || 'http://') + domain + path );
	reverseIWMap.set( domain, prefix );
}

wikipedias.split('|').forEach(function(lang) {
	[ 'wikipedia', 'wikivoyage', 'wikibooks', 'wikisource', 'wikinews',
	  'wikiquote', 'wikiversity', 'wiktionary'
	].forEach(function(suffix) {
		insertInMaps(
			lang.replace(/-/g, '_') + suffix.replace('pedia', ''),
			lang + '.' + suffix + '.org',
			'/w/api.php'
		 );
	});
});

// Add mediawiki.org, commons and localhost too
insertInMaps( 'mediawikiwiki', 'www.mediawiki.org', '/w/api.php' );
insertInMaps( 'commonswiki', 'commons.wikimedia.org', '/w/api.php' );
insertInMaps( 'localhost', 'localhost', '/wiki/api.php' );

// Build the interwiki regexp
var it = interwikiMap.keys(),
	key = it.next(),
	interwikiRegexp = key.value;

while ( !key.done ) {
	interwikiRegexp += "|" + key.value;
	key = it.next();
}

// Subclass a Map to avoid overwriting defaults
// Maybe just let that happen ... it only seems to occur
// from localSettings
function DefaultMap(defaultMap) {
	Map.call(this);
	this.defaultMap = defaultMap;
}
Object.setPrototypeOf(DefaultMap, Map);
DefaultMap.prototype = Object.create(Map.prototype, {
	constructor: { value: DefaultMap },
	get: {
		writeable: false,
		value: function(key) {
			return this.has(key)
				? Map.prototype.get.call(this, key)
				: this.defaultMap.get(key);
		}
	},
	keys: {
		writeable: false,
		value: function() {
			// This return an array because the es6-shim doesn't
			// expose Iterators.
			var keys = Array.from(Map.prototype.keys.call(this));
			this.defaultMap.forEach(function(val, key) {
				if ( keys.indexOf(key) < 0 ) {
					keys.push(key);
				}
			});
			return keys;
		}
	}
});

/**
 * @class
 *
 * Global Parsoid configuration object. Will hold things like debug/trace
 * options, interwiki map, and local settings like fetchTemplates.
 *
 * @constructor
 * @param {Object} localSettings The localSettings object, probably from a localsettings.js file.
 * @param {Function} localSettings.setup The local settings setup function, which sets up our local configuration.
 * @param {ParsoidConfig} localSettings.setup.opts The setup function is passed the object under construction so it can extend the config directly.
 * @param {Object} options Any options we want to set over the defaults. Will not overwrite things set by the localSettings.setup function. See the class properties for more information.
 */
function ParsoidConfig( localSettings, options ) {
	// 'enwiki' etc for per-wiki proxy. Used by setInterwiki.
	this.apiProxyURIs = new Map();

	// The default api proxy, overridden by apiProxyURIs entries
	this.defaultAPIProxyURI = undefined;

	this.interwikiMap = new DefaultMap(interwikiMap);
	this.reverseIWMap = new DefaultMap(reverseIWMap);
	this.interwikiRegexp = interwikiRegexp;

	if ( localSettings && localSettings.setup ) {
		localSettings.setup( this );
	}

	// Don't freak out!
	// This happily overwrites inherited properties.
	if (options) {
		Object.assign( this, options );
	}

	// SSS FIXME: Hardcoded right now, but need a generic registration mechanism
	// for native handlers
	this.nativeExtensions = {
		cite: new Cite()
	};

	// Permissive CORS headers as Parsoid is full idempotent currently
	this.allowCORS = '*';
}

/**
 * @method
 *
 * Set an interwiki prefix.
 *
 * @param {string} prefix
 * @param {string} apiURI The URL to the wiki's api.php.
 * @param {string} apiProxyURI The URL of a proxy to use for API requests, or
 * null to explicitly disable API request proxying for this wiki. Will fall
 * back to ParsoidConfig.defaultAPIProxyURI if undefined (default value).
 */
ParsoidConfig.prototype.setInterwiki = function ( prefix, apiURI, apiProxyURI ) {
	this.interwikiMap.set( prefix, apiURI );
	this.reverseIWMap.set( url.parse( apiURI ).host, prefix );

	if ( apiProxyURI !== undefined ) {
		this.apiProxyURIs.set(prefix, apiProxyURI);
	}
	if ( this.interwikiRegexp.match( '\\|' + prefix + '\\|' ) === null ) {
		this.interwikiRegexp += '|' + prefix;
	}
};

/**
 * @method
 *
 * Remove an interwiki prefix.
 *
 * @param {string} prefix
 */
ParsoidConfig.prototype.removeInterwiki = function ( prefix ) {
	var u = url.parse( this.interwikiMap.get(prefix) );
	this.reverseIWMap.delete( u.host, null );
	this.interwikiMap.delete( prefix, null );
	this.interwikiRegexp = this.interwikiRegexp.replace(
		new RegExp( '(^|\\|)' + prefix + '(\\||$)' ), function() {
			return arguments[0] === ("|" + prefix + "|") ? "|" : '';
		}
	);
};

/**
 * @property {boolean} debug Whether to print debugging information.
 */
ParsoidConfig.prototype.debug = false;

/**
 * @property {Array} traceFlags Flags that tell us which tracing information to print.
 */
ParsoidConfig.prototype.traceFlags = null;

/**
 * @property {Array} debugFlags Flags that tell us which debugging information to print.
 */
ParsoidConfig.prototype.debugFlags = null;

/**
 * @property {Array} dumpFlags Flags that tell us what state to dump.
 */
ParsoidConfig.prototype.dumpFlags = null;

/**
 * @property {boolean} fetchTemplates Whether we should request templates from a wiki, or just use cached versions.
 */
ParsoidConfig.prototype.fetchTemplates = true;

/**
 * @property {boolean} expandExtensions Whether we should request extension tag expansions from a wiki.
 */
ParsoidConfig.prototype.expandExtensions = true;

/**
 * @property {number} maxDepth The maximum depth to which we should expand templates. Only applies if we would fetch templates anyway, and if we're actually expanding templates. So #fetchTemplates must be true and #usePHPPreProcessor must be false.
 */
ParsoidConfig.prototype.maxDepth = 40;

/**
 * @property {boolean} usePHPPreProcessor Whether we should use the PHP Preprocessor to expand templates, extension content, and the like. See #PHPPreProcessorRequest in lib/mediawiki.ApiRequest.js
 */
ParsoidConfig.prototype.usePHPPreProcessor = true;

/**
 * @property {string} defaultWiki The wiki we should use for template, page, and configuration requests. We set this as a default because a configuration file (e.g. the API service's localsettings) might set this, but we will still use the appropriate wiki when requests come in for a different prefix.
 */
ParsoidConfig.prototype.defaultWiki = 'enwiki';

/**
 * @property {boolean} useSelser Whether to use selective serialization when serializing a DOM to Wikitext. This amounts to not serializing bits of the page that aren't marked as having changed, and requires some way of getting the original text of the page. See #SelectiveSerializer in lib/mediawiki.SelectiveSerializer.js
 */
ParsoidConfig.prototype.useSelser = false;
ParsoidConfig.prototype.fetchConfig = true;

/**
 * @property {boolean} rtTestMode
 */
ParsoidConfig.prototype.rtTestMode = false;

/**
 * @property {number} Parsoid DOM format version
 * See https://bugzilla.wikimedia.org/show_bug.cgi?id=52937
 */
ParsoidConfig.prototype.version = 0;

/**
 * @property {boolean} storeDataParsoid
 */
ParsoidConfig.prototype.storeDataParsoid = false;

/**
 * @property {boolean} fetchWT
 * When transforming from html to wt, fetch the original wikitext before.
 * Intended for use in round-trip testing.
 */
 ParsoidConfig.prototype.fetchWT = false;

/**
 * @property {boolean} addHTMLTemplateParameters
 * When processing template parameters, parse them to HTML and add it to the
 * template parameters data.
 */
ParsoidConfig.prototype.addHTMLTemplateParameters = false;

/**
 * @property {boolean} linting Whether to enable linter Backend.
 */
ParsoidConfig.prototype.linting = false;

/**
 * @property {URL} linterAPI
 * The URL for LintBridge API endpoint
 */
ParsoidConfig.prototype.linterAPI = null;

/**
 * @property {Function} the logger output function
 * By default, use stderr to output logs.
 */
ParsoidConfig.prototype.loggerBackend = null;

/**
 * @property {Function} the tracer output function
 * By default, use stderr to output traces.
 */
ParsoidConfig.prototype.tracerBackend = null;

if (typeof module === "object") {
	module.exports.ParsoidConfig = ParsoidConfig;
}
