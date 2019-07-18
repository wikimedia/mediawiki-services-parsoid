/**
 * Front-end/Wrapper for a particular tree builder, in this case the
 * parser/tree builder from the node
 * {@link https://www.npmjs.com/package/domino `domino`} module.
 * Feed it tokens using
 * {@link TreeBuilder#processToken}, and it will build you a DOM tree
 * and emit an event.
 * @module
 */

'use strict';

var events = require('events');

var HTMLParser = require('domino').impl.HTMLParser;
var TokenUtils = require('../utils/TokenUtils.js').TokenUtils;
var WTUtils = require('../utils/WTUtils.js').WTUtils;
var Util = require('../utils/Util.js').Util;
var JSUtils = require('../utils/jsutils.js').JSUtils;

const { TagTk, EndTagTk, SelfclosingTagTk, NlTk, EOFTk, CommentTk } = require('../tokens/TokenTypes.js');
const { DOMDataUtils, Bag } = require('../utils/DOMDataUtils.js');
const { DOMTraverser } = require('../utils/DOMTraverser.js');
const { PrepareDOM } = require('./pp/handlers/PrepareDOM.js');

/**
 * @class
 * @extends EventEmitter
 */
class HTML5TreeBuilder extends events.EventEmitter {
	constructor(env) {
		super();
		this.env = env;

		// Token types for the tree builder.
		this.types = {
			EOF: -1,
			TEXT: 1,
			TAG: 2,
			ENDTAG: 3,
			COMMENT: 4,
			DOCTYPE: 5,
		};

		const psd = this.env.conf.parsoid;
		this.traceTime = !!(psd.traceFlags && psd.traceFlags.has("time"));

		// Reset variable state and set up the parser
		this.resetState();
	}

	/**
	 * Register for (token) 'chunk' and 'end' events from a token emitter,
	 * normally the TokenTransformDispatcher.
	 */
	addListenersOn(emitter) {
		emitter.addListener('chunk', tokens => this.onChunk(tokens));
		emitter.addListener('end', () => this.onEnd());
	}

	/**
	 * Debugging aid: set pipeline id
	 */
	setPipelineId(id) {
		this.pipelineId = id;
	}

	resetState() {
		// Reset vars
		this.tagId = 1;  // Assigned to start/self-closing tags
		this.inTransclusion = false;
		this.bag = new Bag();

		/* --------------------------------------------------------------------
		 * Crude tracking of whether we are in a table
		 *
		 * The only requirement for correctness of detecting fostering content
		 * is that as long as there is an unclosed <table> tag, this value
		 * is positive.
		 *
		 * We can ensure that by making sure that independent of how many
		 * excess </table> tags we run into, this value is never negative.
		 *
		 * So, since this.tableDepth >= 0 always, whenever a <table> tag is seen,
		 * this.tableDepth >= 1 always, and our requirement is met.
		 * -------------------------------------------------------------------- */
		this.tableDepth = 0;

		this.parser = new HTMLParser();
		this.parser.insertToken(this.types.DOCTYPE, 'html');
		this.parser.insertToken(this.types.TAG, 'body');

		this.textContentBuffer = [];
	}

	onChunk(tokens) {
		let s;
		if (this.traceTime) { s = JSUtils.startTime(); }
		var n = tokens.length;
		for (var i = 0; i < n; i++) {
			this.processToken(tokens[i]);
		}
		if (this.traceTime) {
			this.env.bumpTimeUse("HTML5 TreeBuilder", JSUtils.elapsedTime(s), 'HTML5');
		}
	}

	onEnd() {
		// Check if the EOFTk actually made it all the way through, and flag the
		// page where it did not!
		if (this.lastToken && this.lastToken.constructor !== EOFTk) {
			this.env.log("error", "EOFTk was lost in page", this.env.page.name);
		}

		// Special case where we can't call `env.createDocument()`
		const doc = this.parser.document();
		this.env.referenceDataObject(doc, this.bag);

		// Preparing the DOM is considered one "unit" with treebuilding,
		// so traversing is done here rather than during post-processing.
		//
		// Necessary when testing the port, since:
		// - de-duplicating data-object-ids must be done before we can store
		//   data-attributes to cross language barriers;
		// - the calls to fosterCommentData below are storing data-object-ids,
		//   which must be reinserted, again before storing ...
		const seenDataIds = new Set();
		const t = new DOMTraverser();
		t.addHandler(null, (...args) => PrepareDOM.prepareDOM(seenDataIds, ...args));
		t.traverse(doc.body, this.env);

		this.emit('document', doc);

		this.emit('end');
		this.resetState();
	}

	_att(maybeAttribs) {
		return maybeAttribs.map(attr => [attr.k, attr.v]);
	}

	// Keep this in sync with `DOMDataUtils.setNodeData()`
	stashDataAttribs(attribs, dataAttribs) {
		const data = { parsoid: dataAttribs };
		attribs = attribs.filter((attr) => {
			if (attr.k === 'data-mw') {
				console.assert(data.mw === undefined);
				data.mw = JSON.parse(attr.v);
				return false;
			}
			return true;
		});
		const docId = this.bag.stashObject(data);
		attribs.push({ k: DOMDataUtils.DataObjectAttrName(), v: docId });
		return attribs;
	}

	processBufferedTextContent() {
		if (this.textContentBuffer.length === 0) {
			return;
		}

		let haveNonNlTk = false;
		let data = "";
		this.textContentBuffer.forEach(function(t) {
			if (t.constructor === NlTk) {
				data += '\n';
			} else {
				haveNonNlTk = true;
				data += t;
			}
		});

		this.parser.insertToken(this.types.TEXT, data);

		// NlTks are only fostered when accompanied by
		// non-whitespace. Safe to ignore.
		if (this.inTransclusion && this.tableDepth > 0 && haveNonNlTk) {
			// If inside a table and a transclusion, add a meta tag
			// after every text node so that we can detect
			// fostered content that came from a transclusion.
			this.env.log("debug/html", this.pipelineId, "Inserting shadow transclusion meta");
			this.parser.insertToken(this.types.TAG, 'meta', [
				['typeof', 'mw:TransclusionShadow'],
			]);
		}

		this.textContentBuffer = [];
	}

	/**
	 * Adapt the token format to internal HTML tree builder format, call the actual
	 * html tree builder by emitting the token.
	 */
	processToken(token) {
		if (this.pipelineId === 0) {
			this.env.bumpWt2HtmlResourceUse('token');
		}

		var attribs = token.attribs || [];
		var dataAttribs = token.dataAttribs || { tmp: {} };

		if (!dataAttribs.tmp) {
			dataAttribs.tmp = {};
		}

		if (this.inTransclusion) {
			dataAttribs.tmp.inTransclusion = true;
		}

		// Assign tagId to open/self-closing tags
		if (token.constructor === TagTk || token.constructor === SelfclosingTagTk) {
			dataAttribs.tmp.tagId = this.tagId++;
		}

		attribs = this.stashDataAttribs(attribs, dataAttribs);

		this.env.log("trace/html", this.pipelineId, function() {
			return JSON.stringify(token);
		});

		// Store the last token
		this.lastToken = token;

		// Buffer strings & newlines and return
		if (token.constructor === String || token.constructor === NlTk) {
			this.textContentBuffer.push(token);
			return;
		}

		/* Not a string or NlTk -- collapse them into a single text node */
		this.processBufferedTextContent();

		var tName, attrs;
		switch (token.constructor) {
			case TagTk:
				tName = token.name;
				if (tName === "table") {
					this.tableDepth++;
					// Don't add foster box in transclusion
					// Avoids unnecessary insertions, the case where a table
					// doesn't have tsr info, and the messy unbalanced table case,
					// like the navbox
					if (!this.inTransclusion) {
						this.env.log("debug/html", this.pipelineId, "Inserting foster box meta");
						this.parser.insertToken(this.types.TAG, 'table', [
							['typeof', 'mw:FosterBox'],
						]);
					}
				}
				this.parser.insertToken(this.types.TAG, tName, this._att(attribs));
				if (dataAttribs && !dataAttribs.autoInsertedStart) {
					this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
					attrs = [
						['typeof', 'mw:StartTag'],
						['data-stag', `${tName}:${dataAttribs.tmp.tagId}`],
					].concat(this._att(this.stashDataAttribs([], Util.clone(dataAttribs))));
					this.parser.insertToken(
						this.types.COMMENT,
						WTUtils.fosterCommentData('mw:shadow', attrs, false)
					);
				}
				break;
			case SelfclosingTagTk:
				tName = token.name;

				// Re-expand an empty-line meta-token into its constituent comment + WS tokens
				if (TokenUtils.isEmptyLineMetaToken(token)) {
					this.onChunk(dataAttribs.tokens);
					return;
				}

				// Convert mw metas to comments to avoid fostering.
				// But <*include*> metas, behavior switch metas
				// should be fostered since they end up generating
				// HTML content at the marker site.
				if (tName === 'meta') {
					var tTypeOf = token.getAttribute('typeof');
					var shouldFoster = (/^mw:(Includes\/(OnlyInclude|IncludeOnly|NoInclude))\b/).test(tTypeOf);
					if (!shouldFoster) {
						var prop = token.getAttribute('property');
						shouldFoster = (/^(mw:PageProp\/[a-zA-Z]*)\b/).test(prop);
					}
					if (!shouldFoster) {
						// transclusions state
						if (tTypeOf.match(/^mw:Transclusion/)) {
							this.inTransclusion = /^mw:Transclusion$/.test(tTypeOf);
						}
						this.parser.insertToken(
							this.types.COMMENT,
							WTUtils.fosterCommentData(tTypeOf, this._att(attribs), false)
						);
						break;
					}
				}

				var newAttrs = this._att(attribs);
				this.parser.insertToken(this.types.TAG, tName, newAttrs);
				if (!Util.isVoidElement(tName)) {
					// VOID_ELEMENTS are automagically treated as self-closing by
					// the tree builder
					this.parser.insertToken(this.types.ENDTAG, tName, newAttrs);
				}
				break;
			case EndTagTk:
				tName = token.name;
				if (tName === 'table' && this.tableDepth > 0) {
					this.tableDepth--;
				}
				this.parser.insertToken(this.types.ENDTAG, tName);
				if (dataAttribs && !dataAttribs.autoInsertedEnd) {
					this.env.log("debug/html", this.pipelineId, "Inserting shadow meta for", tName);
					attrs = this._att(attribs).concat([
						['typeof', 'mw:EndTag'],
						['data-etag', tName],
					]);
					this.parser.insertToken(
						this.types.COMMENT,
						WTUtils.fosterCommentData('mw:shadow', attrs, false)
					);
				}
				break;
			case CommentTk:
				this.parser.insertToken(this.types.COMMENT, token.value);
				break;
			case EOFTk:
				this.parser.insertToken(this.types.EOF);
				break;
			default:
				var errors = [
					"-------- Unhandled token ---------",
					"TYPE: " + token.constructor.name,
					"VAL : " + JSON.stringify(token),
				];
				this.env.log("error", errors.join("\n"));
				break;
		}
	}
}

if (typeof module === "object") {
	module.exports.HTML5TreeBuilder = HTML5TreeBuilder;
}
