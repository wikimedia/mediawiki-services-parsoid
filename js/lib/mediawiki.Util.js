/**
 * General utilities for token transforms
 */

var HTML5 = require( 'html5' ).HTML5,
	path = require('path'),
	$ = require( 'jquery' ),
	jsDiff = require( 'diff' ),

	Util = {
	/**
	 * Determine if a tag name is block-level or not
	 *
	 * @static
	 * @method
	 * @param {String} name: Lower-case tag name
	 * @returns {Boolean}: True if tag is block-level, false otherwise.
	 */
	isBlockTag: function ( name ) {
		switch ( name ) {
			case 'div':
			case 'p':
			// tables
			case 'table':
			case 'tbody':
			case 'thead':
			case 'tfoot':
			case 'caption':
			case 'th':
			case 'tr':
			case 'td':
			// lists
			case 'ul':
			case 'ol':
			case 'li':
			case 'dl':
			case 'dt':
			case 'dd':
			// HTML5 heading content
			case 'h1':
			case 'h2':
			case 'h3':
			case 'h4':
			case 'h5':
			case 'h6':
			case 'hgroup':
			// HTML5 sectioning content
			case 'article':
			case 'aside':
			case 'body':
			case 'nav':
			case 'section':
			case 'footer':
			case 'header':
			case 'figure':
			case 'figcaption':
			case 'fieldset':
			case 'details':
			case 'blockquote':
			// other
			case 'br':
			case 'hr':
			case 'button':
			case 'canvas':
			case 'center':
			case 'col':
			case 'colgroup':
			case 'embed':
			//case 'img': // hmm!
			case 'map':
			case 'object':
			case 'pre':
			case 'progress':
			case 'video':
				return true;
			default:
				return false;
		}
	},

	// See http://www.whatwg.org/specs/web-apps/current-work/#void-elements
	voidElements: { area: 1, base: 1, br: 1, col: 1, command: 1, embed: 1, hr: 1, img: 1,
		input: 1, keygen: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 },

	/*
	 * Determine if the tag is an empty HTML tag
	 */
	isVoidElement: function ( name ) {
		return this.voidElements[name] || false;
	},

	/**
	 * Determine if a token is block-level or not
	 *
	 * @static
	 * @method
	 * @param {Object} token: The token to check
	 * @returns {Boolean}: True if token is block-level, false otherwise.
	 */
	isBlockToken: function ( token ) {
		if ( token.constructor === TagTk ||
				token.constructor === EndTagTk ||
				token.constructor === SelfclosingTagTk ) {
			return Util.isBlockTag( token.name.toLowerCase() );
		} else {
			return false;
		}
	},

	isSolTransparent: function(token) {
		var tc = token.constructor;
		if (tc === String) {
			if (token.match(/[^\s]/)) {
				return false;
			}
		} else if (tc !== CommentTk && (tc !== SelfclosingTagTk || token.name !== 'meta')) {
			return false;
		}

		return true;
	},

	toStringTokens: function(tokens, indent) {
		if (!indent) {
			indent = "";
		}

		if (tokens.constructor !== Array) {
			return [tokens.toString(false, indent)];
		} else if (tokens.length === 0) {
			return [null];
		} else {
			var buf = [];
			for (var i = 0, n = tokens.length; i < n; i++) {
				buf.push(tokens[i].toString(false, indent));
			}
			return buf;
		}
	},

	tokensToString: function ( tokens, strict ) {
		var out = [];
		// XXX: quick hack, track down non-array sources later!
		if ( ! $.isArray( tokens ) ) {
			tokens = [ tokens ];
		}
		for ( var i = 0, l = tokens.length; i < l; i++ ) {
			var token = tokens[i];
			if ( token === undefined ) {
				console.warn( 'Util.tokensToString, invalid token: ' +
								token, ' tokens:', tokens);
			} else if ( token.constructor === String ) {
				out.push( token );
			} else if ( token.constructor === CommentTk || token.constructor === NlTk ) {
				// strip comments and newlines
			} else if ( strict ) {
				// If strict, return accumulated string on encountering first non-text token
				return [out.join(''), tokens.slice( i )];
			}
		}
		return out.join('');
	},

	// deep clones by default.
	clone: function(obj, deepClone) {
		if (deepClone === undefined) {
			deepClone = true;
		}
		return $.extend(deepClone, {}, obj);
	},

	// 'cb' can only be called once after "everything" is done.
	// But, we need something that can be used in async context where it is
	// called repeatedly till we are done.
	//
	// Primarily needed in the context of async.map calls that requires a 1-shot callback.
	//
	// Use with caution!  If the async stream that we are accumulating into the buffer
	// is a firehose of tokens, the buffer will become huge.
	buildAsyncOutputBufferCB: function(cb) {
		function AsyncOutputBufferCB(cb) {
			this.accum = [];
			this.targetCB = cb;
		}

		AsyncOutputBufferCB.prototype.processAsyncOutput = function(res) {
			// * Ignore switch-to-async mode calls since
			//   we are actually collapsing async calls.
			// * Accumulate async call results in an array
			//   till we get the signal that we are all done
			// * Once we are done, pass everything to the target cb.
			if (!res.switchToAsync) {
				// There are 3 kinds of callbacks:
				// 1. cb({tokens: .. })
				// 2. cb({}) ==> toks can be undefined
				// 3. cb(foo) -- which means in some cases foo can
				//    be one of the two cases above, or it can also be a simple string.
				//
				// Version 1. is the general case.
				// Versions 2. and 3. are optimized scenarios to eliminate
				// additional processing of tokens.
				//
				// In the C++ version, this is handled more cleanly.
				var toks = res.tokens;
				if (!toks && res.constructor === String) {
					toks = res;
				}

				if (toks) {
					if (toks.constructor === Array) {
						[].push.apply(this.accum, toks);
					} else {
						this.accum.push(toks);
					}
				}

				if (!res.async) {
					// we are done!
					this.targetCB(this.accum);
				}
			}
		};

		var r = new AsyncOutputBufferCB(cb);
		return r.processAsyncOutput.bind(r);
	},

	lookupKV: function ( kvs, key ) {
		if ( ! kvs ) {
			return null;
		}
		var kv;
		for ( var i = 0, l = kvs.length; i < l; i++ ) {
			kv = kvs[i];
			if ( kv.k.constructor === String && kv.k.trim() === key ) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	lookup: function ( kvs, key ) {
		var kv = this.lookupKV(kvs, key);
		return kv === null ? null : kv.v;
	},

	lookupValue: function ( kvs, key ) {
		if ( ! kvs ) {
			return null;
		}
		var kv;
		for ( var i = 0, l = kvs.length; i < l; i++ ) {
			kv = kvs[i];
			if ( kv.v === key ) {
				// found, return it.
				return kv;
			}
		}
		// nothing found!
		return null;
	},

	/**
	 * Convert an array of key-value pairs into a hash of keys to values. For
	 * duplicate keys, the last entry wins.
	 */
	KVtoHash: function ( kvs ) {
		if ( ! kvs ) {
			console.warn( "Invalid kvs!: " + JSON.stringify( kvs, null, 2 ) );
			return {};
		}
		var res = {};
		for ( var i = 0, l = kvs.length; i < l; i++ ) {
			var kv = kvs[i],
				key = this.tokensToString( kv.k ).trim();
			//if( res[key] === undefined ) {
			res[key.toLowerCase()] = this.tokenTrim( kv.v );
			//}
		}
		//console.warn( 'KVtoHash: ' + JSON.stringify( res ));
		return res;
	},

	/**
	 * Trim space and newlines from leading and trailing text tokens.
	 */
	tokenTrim: function ( tokens ) {
		var l = tokens.length,
			i, token;
		// strip leading space
		for ( i = 0; i < l; i++ ) {
			token = tokens[i];
			if ( token.constructor === String ) {
				token = token.replace( /^\s+/, '' );
				tokens[i] = token;
				if ( token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}
		// strip trailing space
		for ( i = l - 1; i >= 0; i-- ) {
			token = tokens[i];
			if ( token.constructor === String ) {
				token = token.replace( /\s+$/, '' );
				tokens[i] = token;
				if ( token !== '' ) {
					break;
				}
			} else {
				break;
			}
		}
		return tokens;
	},

	// Strip 'end' tokens and trailing newlines
	stripEOFTkfromTokens: function ( tokens ) {
		// this.dp( 'stripping end or whitespace tokens' );
		if ( tokens.constructor !== Array ) {
			tokens = [ tokens ];
		}
		if ( ! tokens.length ) {
			return tokens;
		}
		// Strip 'end' tokens and trailing newlines
		var l = tokens[tokens.length - 1];
		if ( l.constructor === EOFTk || l.constructor === NlTk ||
				( l.constructor === String && l.match( /^\s+$/ ) ) ) {
			var origTokens = tokens;
			tokens = origTokens.slice();
			tokens.rank = origTokens.rank;
			while ( tokens.length &&
					((	l.constructor === EOFTk  || l.constructor === NlTk )  ||
				( l.constructor === String && l.match( /^\s+$/ ) ) ) )
			{
				// this.dp( 'stripping end or whitespace tokens' );
				tokens.pop();
				l = tokens[tokens.length - 1];
			}
		}
		return tokens;
	},

	/**
	 * Perform a shallow clone of a chunk of tokens
	 */
	cloneTokens: function ( chunk ) {
		var out = [],
			token, tmpToken;
		for ( var i = 0, l = chunk.length; i < l; i++ ) {
			token = chunk[i];
			if ( token.constructor === String ) {
				out.push( token );
			} else {
				tmpToken = token.clone(false); // dont clone attribs
				tmpToken.rank = 0;
				out.push(tmpToken);
			}
		}
		return out;
	},

	// Does this need separate UI/content inputs?
	formatNum: function( num ) {
		return num + '';
	},

	decodeURI: function ( s ) {
		return s.replace( /%[0-9a-f][0-9a-f]/g, function( m ) {
			try {
				// JS library function
				return decodeURI( m );
			} catch ( e ) {
				return m;
			}
		} );
	},

	sanitizeURI: function ( s ) {
		var host = s.match(/^[a-zA-Z]+:\/\/[^\/]+(?:\/|$)/),
			path = s,
			anchor = null;
		//console.warn( 'host: ' + host );
		if ( host ) {
			path = s.substr( host[0].length );
			host = host[0];
		} else {
			host = '';
		}
		var bits = path.split('#');
		if ( bits.length > 1 ) {
			anchor = bits[bits.length - 1];
			path = path.substr(0, path.length - anchor.length - 1);
		}
		host = host.replace( /%(?![0-9a-fA-F][0-9a-fA-F])|[#|]/g, function ( m ) {
			return encodeURIComponent( m );
		} );
		path = path.replace( /%(?![0-9a-fA-F][0-9a-fA-F])|[ \[\]#|]/g, function ( m ) {
			return encodeURIComponent( m );
		} );
		s = host + path;
		if ( anchor !== null ) {
			s += '#' + anchor;
		}
		return s;
	},

	/**
	 * Strip a string suffix if it matches
	 */
	stripSuffix: function ( text, suffix ) {
		var sLen = suffix.length;
		if ( sLen && text.substr( text.length - sLen, sLen ) === suffix )
		{
			return text.substr( 0, text.length - sLen );
		} else {
			return text;
		}
	},

	arrayToHash: function(a) {
		var h = {};
		for (var i = 0, n = a.length; i < n; i++) {
			h[a[i]] = 1;
		}
		return h;
	},

	// Returns the utf8 encoding of the code point
	codepointToUtf8: function(cp) {
		return unescape(encodeURIComponent(cp));
	},

	// Returns true if a given Unicode codepoint is a valid character in XML.
	validateCodepoint: function(cp) {
		return (cp ===    0x09) ||
			(cp ===   0x0a) ||
			(cp ===   0x0d) ||
			(cp >=    0x20 && cp <=   0xd7ff) ||
			(cp >=  0xe000 && cp <=   0xfffd) ||
			(cp >= 0x10000 && cp <= 0x10ffff);
	}
};

/* ----------------------------------------------------------
 * This method does two different things:
 *
 * 1. Strips all meta tags
 *    (FIXME: should I be selective and only strip mw:Object/* tags?)
 * 2. In wrap-template mode, it identifies the meta-object type
 *    and returns it.
 * ---------------------------------------------------------- */
Util.stripMetaTags = function ( tokens, wrapTemplates ) {
	var isPushed, buf = [],
		wikitext = [],
		metaObjTypes = [],
		inTemplate = false;

	for (var i = 0, l = tokens.length; i < l; i++) {
		var token = tokens[i];
		isPushed = false;
		if ([TagTk, SelfclosingTagTk].indexOf(token.constructor) !== -1) {
			// Strip all meta tags.
			// SSS FIXME: should I be selective and only strip mw:Object/* tags?
			if (wrapTemplates) {
				// If we are in wrap-template mode, extract info from the meta-tag
				var t = token.getAttribute("typeof");
				var typeMatch = t && t.match(/(mw:Object(?:\/.*)?$)/);
				if (typeMatch) {
					inTemplate = !(typeMatch[1].match(/\/End$/));
					if (inTemplate) {
						metaObjTypes.push(typeMatch[1]);
						wikitext.push(token.dataAttribs.src);
					}
				} else {
					isPushed = true;
					buf.push(token);
				}
			}

			if (!isPushed && token.name !== "meta") {
				// Dont strip token if it is not a meta-tag
				buf.push(token);
			}
		} else {
			// Assumes that non-template tokens are always text.
			// In turn, based on assumption that HTML attribute values
			// cannot contain any HTML (SSS FIXME: Isn't this true?)
			if (!inTemplate) {
				wikitext.push(token);
			}
			buf.push(token);
		}
	}

	return {
		// SSS FIXME: Assumes that either the attr. has only 1 expansion
		// OR all expansions are of the same type.
		// Consider the attr composed of pieces: s1, s2, s3
		// - s1 can be generated by a template
		// - s2 can be plain text
		// - s3 can be generated by an extension.
		// While that might be considered utter madness, there is nothing in
		// the spec right now that prevents this.  In any case, not sure
		// we do require all expandable types to be tracked.
		metaObjType: metaObjTypes[0],
		wikitext: Util.tokensToString(wikitext),
		value: buf
	};
};

Util.makeTplAffectedMeta = function ( contentType, key, val ) {
	// SSS FIXME: Assumes that all expanded attrs. have the same expandable type
	// - attr1 can be expanded by a template
	// - attr2 can be expanded by an extension
	// While that might be considered madness, there is nothing in the spec right
	// not that prevents this.  In any case, not sure we do require all
	// expandable types to be tracked.

	// <meta about="#mwt1" property="mw:objectAttr#href" data-parsoid="...">
	// about will be filled out in the end
	return new SelfclosingTagTk( 'meta',
		[new KV( "property", "mw:" + contentType + "#" + key )],
		{ src: val.wikitext });
};

// Separate closure for normalize functions that
// use a singleton html parser
( function ( Util ) {

var htmlparser = new HTML5.Parser(),

/**
 * Specialized normalization of the wiki parser output, mostly to ignore a few
 * known-ok differences.
 */
normalizeOut = function ( out ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	return out
		.replace(/<span typeof="mw:(?:(?:Placeholder|Nowiki|Object\/Template|Entity))"[^>]*>((?:[^<]+|(?!<\/span).)*)<\/span>/g, '$1')
		.replace(/[\r\n]| (data-parsoid|typeof|resource|rel|prefix|about|rev|datatype|inlist|property|vocab|content)="[^">]*"/g, '')
		.replace(/<!--.*?-->\n?/gm, '')
		.replace(/<\/?meta[^>]*>/g, '')
		.replace(/<span[^>]+about="[^]+>/g, '')
		.replace(/<span><\/span>/g, '')
		.replace(/href="(?:\.?\.\/)+/g, 'href="')
		.replace(/(<(table|tbody|tr|th|td|\/th|\/td)[^<>]*>)\s+/g, '$1');
},

/**
 * Normalize the expected parser output by parsing it using a HTML5 parser and
 * re-serializing it to HTML. Ideally, the parser would normalize inter-tag
 * whitespace for us. For now, we fake that by simply stripping all newlines.
 *
 * @arg source {string} The source to normalize.
 */
normalizeHTML = function ( source ) {
	// TODO: Do not strip newlines in pre and nowiki blocks!
	source = source.replace(/[\r\n]/g, '');
	try {
		htmlparser.parse('<body>' + source + '</body>');
		return htmlparser.document.childNodes[0].childNodes[1]
			.innerHTML
			// a few things we ignore for now..
			//.replace(/\/wiki\/Main_Page/g, 'Main Page')
			// do not expect a toc for now
			.replace(/<table[^>]+?id="toc"[^>]*>.+?<\/table>/mg, '')
			// do not expect section editing for now
			.replace(/(<span class="editsection">\[.*?<\/span> *)?<span[^>]+class="mw-headline"[^>]*>(.*?)<\/span>/g, '$2')
			// general class and titles, typically on links
			.replace(/(title|class|rel)="[^"]+"/g, '')
			// strip red link markup, we do not check if a page exists yet
			.replace(/\/index.php\?title=([^']+?)&amp;action=edit&amp;redlink=1/g, '/wiki/$1')
			// the expected html has some extra space in tags, strip it
			.replace(/<a +href/g, '<a href')
			.replace(/href="\/wiki\//g, 'href="')
			.replace(/" +>/g, '">');
	} catch(e) {
        console.log("normalizeHTML failed on" +
				source + " with the following error: " + e);
		console.trace();
		return source;
	}
},

formatHTML = function ( source ) {
	// Quick hack to insert newlines before some block level start tags
	return source.replace(
		/(?!^)<((div|dd|dt|li|p|table|tr|td|tbody|dl|ol|ul|h1|h2|h3|h4|h5|h6)[^>]*)>/g, '\n<$1>');
},

/**
 * Parse HTML, return the tree.
 *
 * @arg html {string} The HTML to parse.
 * @returns {object} The HTML DOM tree.
 */
parseHTML = function ( html ) {
	htmlparser.parse( html );
	return htmlparser.tree;
},

/**
 * Little helper function for encoding XML entities
 */
encodeXml = function ( string ) {
	var xml_special_to_escaped_one_map = {
		'&': '&amp;',
		'"': '&quot;',
		'<': '&lt;',
		'>': '&gt;'
	};

	return string.replace( /([\&"<>])/g, function ( str, item ) {
		return xml_special_to_escaped_one_map[item];
	} );
};

Util.encodeXml = encodeXml;
Util.parseHTML = parseHTML;
Util.normalizeHTML = normalizeHTML;
Util.normalizeOut = normalizeOut;
Util.formatHTML = formatHTML;

}( Util ) );

( function ( Util ) {

var convertDiffToOffsetPairs = function ( diff ) {
	var currentPair, pairs = [], srcOff = 0, outOff = 0;
	diff.map( function ( change ) {
		var pushPair = function ( pair, start ) {
			if ( !pair.added ) {
				pair.added = {start: start, end: start };
			} else if ( !pair.removed ) {
				pair.removed = {start: start, end: start };
			}

			pairs.push( [pair.added, pair.removed] );
			currentPair = {};
		};

		if ( !currentPair ) {
			currentPair = {};
		}

		if ( change.added ) {
			if ( currentPair.added ) {
				pushPair( currentPair, outOff );
			}

			currentPair.added = { start: outOff };
			outOff += change.value.length;
			currentPair.added.end = outOff;

			if ( currentPair.removed ) {
				pushPair( currentPair );
			}
		} else if ( change.removed ) {
			if ( currentPair.removed ) {
				pushPair( currentPair, srcOff );
			}

			currentPair.removed = { start: srcOff };
			srcOff += change.value.length;
			currentPair.removed.end = srcOff;

			if ( currentPair.added ) {
				pushPair( currentPair );
			}
		} else {
			if ( currentPair.added || currentPair.removed ) {
				pushPair( currentPair, currentPair.added ? srcOff : outOff );
			}

			srcOff += change.value.length;
			outOff += change.value.length;
		}
	} );

	return pairs;
};
Util.convertDiffToOffsetPairs = convertDiffToOffsetPairs;

}( Util ) );

var diff = function ( a, b, color, onlyReportChanges, useLines ) {
	var thediff, patch, diffs = 0;
	if ( color ) {
		thediff = jsDiff[useLines ? 'diffLines' : 'diffWords']( a, b ).map( function ( change ) {
			if ( useLines && change.value[-1] !== '\n' ) {
				change.value += '\n';
			}
			if ( change.added ) {
				diffs++;
				return change.value.split( '\n' ).map( function ( line ) {
					return line.green;
				} ).join( '\n' );
			} else if ( change.removed ) {
				diffs++;
				return change.value.split( '\n' ).map( function ( line ) {
					return line.red;
				} ).join( '\n' );
			} else {
				return change.value;
			}
		}).join('');
		if ( !onlyReportChanges || diffs > 0 ) {
			return thediff;
		} else {
			return '';
		}
	} else {
		patch = jsDiff.createPatch('wikitext.txt', a, b, 'before', 'after');

		// Strip the header from the patch, we know how diffs work..
		patch = patch.replace(/^[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/, '');

		// Don't care about not having a newline.
		patch = patch.replace( /^\\ No newline at end of file\n/, '' );

		return patch;
	}
};
Util.diff = diff;

var getParser = function ( env, type ) {
	var ParserPipelineFactory = require( './mediawiki.parser.js' ).ParserPipelineFactory;
	return ( new ParserPipelineFactory( env || getParserEnv() ) ).makePipeline( type );
},

parse = function ( env, cb, err, src ) {
	if ( err !== null ) {
		cb( null, err );
	} else {
		var parser = getParser( env, 'text/x-mediawiki/full' );
		parser.on( 'document', cb.bind( null, src, null ) );
		try {
			env.text = src;
			parser.process( src );
		} catch ( e ) {
			cb( null, e );
		}
	}
},

getParserEnv = function ( ls, config ) {
	var ParserEnv = require( './mediawiki.parser.environment.js' ).MWParserEnvironment,
		env = new ParserEnv( {
		// stay within the 'proxied' content, so that we can click around
		wgScriptPath: '/', //http://en.wikipedia.org/wiki',
		wgScriptExtension: '.php',
		// XXX: add options for this!
		wgUploadPath: 'http://upload.wikimedia.org/wikipedia/commons',
		fetchTemplates: true,
		// enable/disable debug output using this switch
		debug: false,
		trace: false,
		maxDepth: 40
	} );

	// add mediawiki.org
	env.setInterwiki( 'mw', 'http://www.mediawiki.org/w' );

	// add localhost default
	env.setInterwiki( 'localhost', 'http://localhost/w' );

	// add the dump in case we want to use that
	env.setInterwiki( 'dump', 'http://dump-api.wmflabs.org/w' );
	env.setInterwiki( 'dump-internal', 'http://10.4.0.162/w' );

	// Apply local settings
	if ( ls && ls.setup ) {
		ls.setup( config, env );
	}

	return env;
};

Util.getParserEnv = getParserEnv;
Util.getParser = getParser;
Util.parse = parse;

if (typeof module === "object") {
	module.exports.Util = Util;
}
