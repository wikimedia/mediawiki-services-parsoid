/*
 * Parsoid-specific configuration. We'll use this object to configure
 * interwiki regexes, mostly.
 */
"use strict";

var Cite = require('./ext.Cite.js').Cite;

var wikipedias = "en|de|fr|nl|it|pl|es|ru|ja|pt|zh|sv|vi|uk|ca|no|fi|cs|hu|ko|fa|id|tr|ro|ar|sk|eo|da|sr|lt|ms|eu|he|sl|bg|kk|vo|war|hr|hi|et|az|gl|simple|nn|la|th|el|new|roa-rup|oc|sh|ka|mk|tl|ht|pms|te|ta|be-x-old|ceb|br|be|lv|sq|jv|mg|cy|lb|mr|is|bs|yo|an|hy|fy|bpy|lmo|pnb|ml|sw|bn|io|af|gu|zh-yue|ne|nds|ku|ast|ur|scn|su|qu|diq|ba|tt|my|ga|cv|ia|nap|bat-smg|map-bms|wa|kn|als|am|bug|tg|gd|zh-min-nan|yi|vec|hif|sco|roa-tara|os|arz|nah|uz|sah|mn|sa|mzn|pam|hsb|mi|li|ky|si|co|gan|glk|ckb|bo|fo|bar|bcl|ilo|mrj|fiu-vro|nds-nl|tk|vls|se|gv|ps|rue|dv|nrm|pag|koi|pa|rm|km|kv|udm|csb|mhr|fur|mt|wuu|lij|ug|lad|pi|zea|sc|bh|zh-classical|nov|ksh|or|ang|kw|so|nv|xmf|stq|hak|ay|frp|frr|ext|szl|pcd|ie|gag|haw|xal|ln|rw|pdc|pfl|krc|crh|eml|ace|gn|to|ce|kl|arc|myv|dsb|vep|pap|bjn|as|tpi|lbe|wo|mdf|jbo|kab|av|sn|cbk-zam|ty|srn|kbd|lo|ab|lez|mwl|ltg|ig|na|kg|tet|za|kaa|nso|zu|rmy|cu|tn|chr|got|sm|bi|mo|bm|iu|chy|ik|pih|ss|sd|pnt|cdo|ee|ha|ti|bxr|om|ks|ts|ki|ve|sg|rn|dz|cr|lg|ak|tum|fj|st|tw|ch|ny|ff|xh|ng|ii|cho|mh|aa|kj|ho|mus|kr|hz|tyv|min";

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
	var self = this;
	this.interwikiMap = {};

	// 'enwiki' etc for per-wiki proxy. Used by setInterwiki.
	this.apiProxyURIs = {};

	// The default api proxy, overridden by apiProxyURIs entries
	this.defaultAPIProxyURI = undefined;

	// XXX: move to prototype to avoid reconstructing this for each request?
	wikipedias.split( '|' ).forEach(function(lang) {
		// Wikipedia
		var dbLangPrefix = lang.replace(/-/g, '_');
		self.interwikiMap[dbLangPrefix + 'wiki'] = 'http://' + lang +
				'.wikipedia.org/w/api.php';

		// Wiktionary
		self.interwikiMap[dbLangPrefix + 'wiktionary'] = 'http://' + lang +
				'.wiktionary.org/w/api.php';

		// Wikivoyage, Wikibooks, Wikisource, Wikiquote, Wikiversity all follow
		// the same pattern
		['voyage', 'books', 'source', 'quote', 'versity'].forEach(function(suffix) {
			self.interwikiMap[dbLangPrefix + 'wiki' + suffix] = 'http://' + lang + '.wiki' +
				suffix + '.org/w/api.php';
		});
	});

	// Add mediawiki.org too
	this.interwikiMap.mediawikiwiki = 'http://www.mediawiki.org/w/api.php';
	// Also commons
	this.interwikiMap.commonswiki = 'http://commons.wikimedia.org/w/api.php';

	// Add localhost too
	this.interwikiMap.localhost = 'http://localhost/wiki/api.php';

	this.interwikiRegexp = Object.keys( this.interwikiMap ).join( '|' );

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
	this.interwikiMap[prefix] = apiURI;
	if (apiProxyURI !== undefined) {
		this.apiProxyURIs[prefix] = apiProxyURI;
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
	delete this.interwikiMap[prefix];
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
 * @property {string} traceFlags Flags that tell us which tracing information to print.
 */
ParsoidConfig.prototype.traceFlags = null;

/**
 * @property {string} dumpFlags Flags that tell us what state to dump.
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
 * @property {boolean} editMode
 */
ParsoidConfig.prototype.editMode = true;

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

if (typeof module === "object") {
	module.exports.ParsoidConfig = ParsoidConfig;
}
