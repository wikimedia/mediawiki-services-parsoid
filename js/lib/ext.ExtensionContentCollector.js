"use strict";

var TokenCollector = require( './ext.util.TokenCollector.js' ).TokenCollector,
	Util = require( './mediawiki.Util.js' ).Util,
	$ = require( 'jquery' );

// List of supported extensions
var supportedExtensions = ['math', 'gallery'];

ExtensionContent.prototype.rank = 0.04;

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

ExtensionContent.prototype.handleExtensionTag = function(extension, tokens) {
	// We can only use tsr if we are the top-level
	// since env. only stores top-level wikitext and
	// not template wikitext.
	if (this.options.wrapTemplates && tokens.length > 1) {
		// Discard tokens and just create a span with text content
		// with span typeof set to mw:Object/Extension/Content
		var st = tokens[0];
		var et = tokens.last();
		var s_tsr = st.dataAttribs.tsr;
		var e_tsr = et.dataAttribs.tsr;
		var text  = this.manager.env.text;
		var nt = new TagTk('span', [
				new KV('typeof', 'mw:Object/Extension/Content'),
				new KV('about', "#mwt" + this.manager.env.generateUID())
			], {
				tsr: [s_tsr[0], e_tsr[1]],
				src: text.substring(s_tsr[0], e_tsr[1])
			});
		return { tokens: [nt, text.substring(s_tsr[1],e_tsr[0]), new EndTagTk('span')] };
	} else {
		return { tokens: tokens };
	}
}

if (typeof module === "object") {
	module.exports.ExtensionContent = ExtensionContent;
}
