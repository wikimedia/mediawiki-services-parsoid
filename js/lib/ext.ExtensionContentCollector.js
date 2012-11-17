"use strict";

var TokenCollector = require( './ext.util.TokenCollector.js' ).TokenCollector,
	Util = require( './mediawiki.Util.js' ).Util,
	$ = require( 'jquery' );

// List of supported extensions
var supportedExtensions = ['math', 'gallery'];

/**
 * Simple token collector for extensions
 */
function ExtensionContent ( manager, options ) {
	this.manager = manager;
	this.options = options;
	for (var i = 0; i < supportedExtensions.length; i++) {
		var ext = supportedExtensions[i];
		new TokenCollector(
				manager,
				this.handleExtensionTag.bind(this, ext),
				true, // match the end-of-input if closing tag is missing
				this.rank,
				'tag',
				ext);
	}
}

ExtensionContent.prototype.rank = 0.04;

ExtensionContent.prototype.handleExtensionTag = function(extension, tokens) {
	// We can only use tsr if we are the top-level
	// since env. only stores top-level wikitext and
	// not template wikitext.
	if (this.options.wrapTemplates && tokens.length > 1) {
		// Discard tokens and just create a span with text content
		// with span typeof set to mw:Object/Extension/Content
		var st = tokens[0],
			et = tokens.last(),
			s_tsr = (st.dataAttribs || {}).tsr,
			e_tsr = (et.dataAttribs || {}).tsr;

		// Dont crash if we dont get tsr values
		// FIXME: Just a temporary patch-up to prevent crashers in RT testing.
		if (s_tsr && e_tsr) {
			var text  = this.manager.env.text,
				nt = new TagTk('span', [
					new KV('typeof', 'mw:Object/Extension'),
					new KV('about', "#mwt" + this.manager.env.generateUID())
				], {
					tsr: [s_tsr[0], e_tsr[1]],
					src: text.substring(s_tsr[0], e_tsr[1])
				});

			return { tokens: [nt, text.substring(s_tsr[1],e_tsr[0]), new EndTagTk('span')] };
		}
	}

	return { tokens: tokens };
};

if (typeof module === "object") {
	module.exports.ExtensionContent = ExtensionContent;
}
