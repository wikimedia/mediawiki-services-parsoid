"use strict";

var TokenCollector = require( './ext.util.TokenCollector.js' ).TokenCollector,
	Util = require( './mediawiki.Util.js' ).Util,
	$ = require( 'jquery' );

/**
 * Simple token transform version of the Cite extension.
 *
 * @class
 * @constructor
 */
function Cite ( manager, options ) {
	this.manager = manager;
	this.options = options;
	this.reset();
	// Set up the collector for ref sections
	new TokenCollector(
			manager,
			this.handleRef.bind(this),
			true, // match the end-of-input if </ref> is missing
			this.rank,
			'tag',
			'ref'
			);
	// And register for references tags
	manager.addTransform( this.onReferences.bind(this), "Cite:onReferences",
			this.referencesRank, 'tag', 'references' );
	// And register for cleanup
	manager.addTransform( this.reset.bind(this), "Cite:reset",
			this.referencesRank, 'end' );
}

Cite.prototype.reset = function ( token ) {
	this.refGroups = {};
	return { token: token };
};


// Cite should be the first thing to run in pahse 3 so the <ref>-</ref>
// content tokens are pulled out of the token stream and dont pollute
// the main token stream with any unbalanced tags/pres and the like.
Cite.prototype.rank = 2.01; // after QuoteTransformer, but before PostExpandParagraphHandler
Cite.prototype.referencesRank = 2.6; // after PostExpandParagraphHandler
//Cite.prototype.rank = 2.6;

/**
 * Handle ref section tokens collected by the TokenCollector.
 */
Cite.prototype.handleRef = function ( tokens ) {
	// remove the first ref tag
	var startTsr, endTsr,
		startTag = tokens.shift();
	startTsr = startTag.dataAttribs.tsr;
	if ( tokens[tokens.length - 1].name === 'ref' ) {
		var endTag = tokens.pop();
		endTsr = endTag.dataAttribs.tsr;
	}

	var options = $.extend({
		name: null,
		group: null
	}, Util.KVtoHash(startTag.attribs));


	var group = this.getRefGroup(options.group ),
		ref = group.add(tokens, options ),
		//console.warn( 'added tokens: ' + JSON.stringify( this.refGroups, null, 2 ));
		linkback = ref.linkbacks[ref.linkbacks.length - 1];


	var bits = [];
	if (options.group) {
		bits.push(options.group);
	}
	//bits.push(Util.formatNum( ref.groupIndex + 1 ));
	bits.push(ref.groupIndex + 1);

	var about = "#" + this.manager.env.newObjectId(),
		text  = this.manager.env.text,
		span  = new TagTk('span', [
				new KV('id', linkback),
				new KV('class', 'reference'),
				new KV('about', about),
				new KV('typeof', 'mw:Object/Ext/Cite')
			]);

	if (startTsr) {
		// For template ref tokens, both start and end tsr's are stripped.
		// So, if there is a start-tsr, there will also be an end-tsr.
		// And, if absent, it is safe to go to end-of-text.
		var start = startTsr[0],
			end   = endTsr ? endTsr[1] : text.length;
		span.dataAttribs = {
			tsr: [start, end]
		};
	}

	// NOTE: endTsr can be undefined below when it has been
	// stripped from ref-tags coming from template/extension content.
	var res = [
		span,
		new TagTk( 'a', [
				new KV('href', '#' + ref.target)
			]
		),
		'[' + bits.join(' ')  + ']',
		new EndTagTk( 'a' ),
		new EndTagTk( 'span' ),
		new SelfclosingTagTk( 'meta', [
				new KV( 'typeof', 'mw:Object/Ext/Cite/End' ),
				new KV( 'about', about)
			], { tsr: endTsr } )
	];
	//console.warn( 'ref res: ' + JSON.stringify( res, null, 2 ) );
	return { tokens: res };
};

function genPlaceholderTokens(env, token, src) {
	var tsr = token.dataAttribs.tsr, dataAttribs;
	if (tsr) {
		// src from original src
		dataAttribs = { tsr: tsr, src: env.text.substring(tsr[0], tsr[1]) };
	} else {
		// Use a default string
		dataAttribs = { src: src };
	}

	return [
		new SelfclosingTagTk('meta', [ new KV( 'typeof', 'mw:Placeholder' ) ], dataAttribs)
	];
}

/**
 * Handle references tag tokens.
 *
 * @method
 * @param {Object} TokenContext
 * @returns {Object} TokenContext
 */
Cite.prototype.onReferences = function ( token, manager ) {
	if ( token.constructor === EndTagTk ) {
		return { tokens: genPlaceholderTokens(this.manager.env, token, "</references>") };
	}

	//console.warn( 'references refGroups:' + JSON.stringify( this.refGroups, null, 2 ) );

	var refGroups = this.refGroups;

	var arrow = '↑';
	var renderLine = function( ref ) {
		var out = [ new TagTk('li', [new KV('id', ref.target)] ) ];
		if (ref.linkbacks.length === 1) {
			out = out.concat([
					new TagTk( 'a', [
								new KV('href', '#' + ref.linkbacks[0])
							]
						),
					arrow,
					new EndTagTk( 'a' )
				],
				ref.tokens // The original content tokens
			);
		} else {
			out.push( arrow );
			$.each(ref.linkbacks, function(i, linkback) {
				out = out.concat([
						new TagTk( 'a', [
								new KV('data-type', 'hashlink'),
								new KV('href', '#' + ref.linkbacks[0])
							]
						),
						// XXX: make formatNum available!
						//{
						//	type: 'TEXT',
						//	value: Util.formatNum( ref.groupIndex + '.' + i)
						//},
						ref.groupIndex + '.' + i,
						new EndTagTk( 'a' )
					],
					ref.tokens // The original content tokens
				);
			});
		}
		//console.warn( 'renderLine res: ' + JSON.stringify( out, null, 2 ));
		return out;
	};

	var res,
		attribHash = Util.KVtoHash(token.attribs),
		// Default to null group if the group param is actually empty
		dataAttribs,
		group = attribHash.group;

	if ( group && group.constructor === Array ) {
		// Array of tokens, convert to string.
		group = Util.tokensToString(group);
	}

	if ( group ) {
		// have a String, strip whitespace
		group = group.replace(/^\s*(.*)\s$/, '$1');
	}

	// Point invalid / empty groups to null
	if ( ! group ) {
		group = null;
	}

	if (group in refGroups) {
		var group = refGroups[group],
			listItems = $.map(group.refs, renderLine );

		dataAttribs = Util.clone(token.dataAttribs);
		dataAttribs.src = token.getWTSource(this.manager.env);
		res = [
			new TagTk( 'ol', [
						new KV('class', 'references'),
						new KV('typeof', 'mw:Object/References')
					], dataAttribs)
		].concat( listItems, [ new EndTagTk( 'ol' ) ] );
	} else {
		res = genPlaceholderTokens(this.manager.env, token, "<references />");
	}

	//console.warn( 'references res: ' + JSON.stringify( res, null, 2 ) );
	return { tokens: res };
};

Cite.prototype.getRefGroup = function(group) {
	var refGroups = this.refGroups;
	if (!(group in refGroups)) {
		var refs = [],
			byName = {};
		refGroups[group] = {
			refs: refs,
			byName: byName,
			add: function(tokens, options) {
				var ref;
				if (options.name && options.name in byName) {
					ref = byName[options.name];
				} else {
					var n = refs.length,
						key = n + '';
					if (options.name) {
						key = options.name + '-' + key;
					}
					ref = {
						tokens: tokens,
						index: n,
						groupIndex: n, // @fixme
						name: options.name,
						group: options.group,
						key: key,
						target: 'cite_note-' + key,
						linkbacks: []
					};
					refs[n] = ref;
					if (options.name) {
						byName[options.name] = ref;
					}
				}
				ref.linkbacks.push(
						'cite_ref-' + ref.key + '-' + ref.linkbacks.length
						);
				return ref;
			}
		};
	}
	return refGroups[group];
};

if (typeof module === "object") {
	module.exports.Cite = Cite;
}
