/**
 * This is a Serializer class that will run through a DOM looking for special
 * change markers, usually supplied by an HTML5 WYSIWYG editor (like the
 * VisualEditor for MediaWiki), and determining what needs to be
 * serialized and what can simply be copied over.
 */

'use strict';

var WikitextSerializer = require( './mediawiki.WikitextSerializer.js' ).WikitextSerializer,
	Util = require( './mediawiki.Util.js' ).Util,
	DU = require( './mediawiki.DOMUtils.js' ).DOMUtils,
	apirql = require( './mediawiki.ApiRequest.js' ),
	DoesNotExistError = apirql.DoesNotExistError,
	// don't redefine Node
	NODE = require('./mediawiki.wikitext.constants.js').Node,
	ParserPipelineFactory = require('./mediawiki.parser.js').ParserPipelineFactory,
	DOMDiff = require('./mediawiki.DOMDiff.js').DOMDiff;

/**
 * Create a selective serializer.
 *
 * @arg options {object} Contains these members:
 *   * env - an instance of MWParserEnvironment, see Util.getParserEnv
 *   * oldtext - the old text of the document, if any
 *   * oldid - the ID of the old revision you want to compare to, if any (default to latest revision)
 *
 * If one of options.env.page.name or options.oldtext is set, we use the selective serialization
 * method, only reporting the serialized wikitext for parts of the page that changed. Else, we
 * fall back to serializing the whole DOM.
 */
var SelectiveSerializer = function ( options ) {
	this.wts = options.wts || new WikitextSerializer( options );

	this.env = options.env || {};

	// The output wikitext collector
	this.wtChunks = [];

	// Debug options
	this.trace = this.env.debug || (
		this.env.traceFlags && (this.env.traceFlags.indexOf("selser") !== -1)
	);

	if ( this.trace ) {
		SelectiveSerializer.prototype.debug_pp = function () {
			Util.debug_pp.apply(Util, arguments);
		};

		SelectiveSerializer.prototype.debug = function ( ) {
			this.debug_pp.apply(this, ["SS:", ' '].concat([].slice.apply(arguments)));
		};
	} else {
		SelectiveSerializer.prototype.debug_pp = function ( ) {};
		SelectiveSerializer.prototype.debug = function ( ) {};
	}
};

var SSP = SelectiveSerializer.prototype;

/**
 * Get a substring of the original wikitext
 */
SSP.getSource = function(start, end) {
	return this.env.page.src.substring( start, end );
};


/**
 * TODO: Replace these callbacks with a single, simple chunkCB that gets an
 * 'unmodified', 'separator', 'modified' flag from the WTS.
 *
 * Only need to remember last flag state and last separator(s) then. Use
 * unmodified source (from range annotation on *modified* node) plus
 * separator, then fully serialized source.
 *
 * Consequence: Range annotations should not include IEW between unmodified
 * and modified elements.
 */


/**
 * The chunkCB handler for the WTS
 *
 * Assumption: separator source is passed in a single call.
 */
SSP.handleSerializedResult = function( res, dpsSource ) {

	this.debug("---- dps:", dpsSource || 'null', "----");

	if( dpsSource === undefined ) {
		console.trace();
	}

	if ( dpsSource === null ) {
		// unmodified, just discard
		this.lastSeparator = '';
		this.lastType = 'unmodified';
	} else if (dpsSource === 'separator') {
		if ( this.lastType === 'modified' ) {
			// push separator
			this.lastSeparator = '';
			this.wtChunks.push(res);
		} else {
			// collect separator(s)
			this.lastSeparator = (this.lastSeparator || '') + res;
		}
		this.lastType = 'separator';
	} else {
		// Modified element source

		// TODO: push unmodified source up to separator from
		// data-parsoid-serialize dsr data
		if (this.lastType === 'separator' || this.lastType === 'unmodified') {
			try {
				// Try to decode data-parsoid-serialize
				var dps = JSON.parse(dpsSource);
				this.debug('dps', dps );

				if (dps.srcRange) {
					var origSrc = this.getSource(dps.srcRange[0], dps.srcRange[1]) || '';
					this.wtChunks.push(origSrc);
				}
			} catch (e) {
				console.error('Error decoding dps ' + dpsSource);
				console.trace();
			}
		}

		// Push separator, if any
		if ( this.lastSeparator ) {
			this.wtChunks.push(this.lastSeparator);
			this.lastSeparator = '';
		}

		// finally push the newly serialized wikitext
		this.wtChunks.push(res);
		this.lastType = 'modified';
	}

};


SSP.doSerializeDOM = function ( err, doc, cb, finalcb ) {
	var matchedRes, nonNewline, nls = 0, latestSerID = null,
		self = this;
	Util.stripFirstParagraph( doc );

	if ( err || this.env.page.dom === null ) {
		// If there's no old source, fall back to non-selective serialization.
		this.wts.serializeDOM(doc, cb, finalcb);
	} else {
		// If we found text, then use this chunk callback.
		var diff = new DOMDiff(this.env).diff( doc );

		// If we found text, then use this chunk callback.
		if ( this.trace || ( this.env.dumpFlags &&
					this.env.dumpFlags.indexOf( 'dom:serialize-ids' ) !== -1) )
		{
			console.log( '----- DOM after assigning serialize-ids -----' );
			console.log( doc.innerHTML );
			//console.log( '-------- state: --------- ');
			//console.log('startdsr: ' + state.startPos);
			//console.log('lastdsr: ' + state.curPos);
		}

		if ( ! diff.isEmpty ) {

			doc = diff.dom;
			//console.log('doc', doc.outerHTML);

			// Add the serializer info
			new DiffToSelserConverter(this.env, doc).convert();

			// Call the WikitextSerializer to do our bidding
			this.wts.serializeDOM(
					doc,
					this.handleSerializedResult.bind(this),
					function () {
						//console.log( 'chunks', self.wtChunks );
						cb( self.wtChunks.join( '' ) );
						finalcb();
					});
		} else {
			// Nothing was modified, just re-use the original source
			cb( this.env.page.src );
			finalcb();
		}
	}
};


SSP.parseOriginalSource = function ( doc, cb, finalcb, err, src ) {
	var self = this,
		parserPipelineFactory = new ParserPipelineFactory( this.env ),
		parserPipeline = parserPipelineFactory.makePipeline( 'text/x-mediawiki/full' );

	// Makes sure that the src is available even when just fetched.
	this.env.page.src = src;

	// Parse the wikitext src to the original DOM, and pass that on to
	// doSerializeDOM
	this.parserPipeline.once( 'document', function ( doc ) {
		// XXX: need to get body with .tree.document.childNodes[0].childNodes[1] ?
		self.env.page.dom = doc;
		self.doSerializeDOM(err, doc, cb, finalcb);
	} );
};


/**
 * The main serializer handler. Calls detectDOMChanges and prepares and calls
 * WikitextSerializer.serializeDOM if changes were found.
 */
SSP.serializeDOM = function( doc, cb, finalcb ) {
	if ( this.env.page.dom ) {
		this.doSerializeDOM(null, doc, cb, finalcb);
	} else if ( this.env.page.src ) {
		// Have the src, only parse the src to the dom
		this.parseOriginalSource( doc, cb, finalcb, null, this.env.page.src );
	} else {
		// Start by getting the old text of this page
		Util.getPageSrc( this.env, this.env.page.name,
				this.parseOriginalSource.bind(this, doc, cb, finalcb),
				this.env.page.id || null );
	}
};



/**
 * Create a Selser DOM from a diff-annotated DOM
 *
 * Traverses a diff-annotated DOM and adds selser information based on it
 */
function DiffToSelserConverter ( env, diffDOM ) {
	this.env = env;
	this.currentId = 0;
	this.startPos = 0; // start offset of the current unmodified chunk
	this.curPos = 0; // end offset of the last processed node
	this.dom = diffDOM;
	// TODO: abstract the debug method setup!
	this.debug = env.debug ||
		(env.traceFlags && env.traceFlags.indexOf('selser') !== -1) ?
						console.error : function(){};
}

DiffToSelserConverter.prototype.convert = function () {
	//console.log('convert dom', this.dom);
	this.doConvert(this.dom);
};


DiffToSelserConverter.prototype.doConvert = function(parentNode, parentDSR) {
	var node;

	for ( var i = 0; i < parentNode.childNodes.length; i++ ) {
		node = parentNode.childNodes[i];
		var dvec = null,
			dp = null,
			src = '',
			nodeType = node.nodeType,
			nodeName = node.nodeName.toLowerCase(),
			inIndentPre = this.inIndentPre,
			isModified = false;

		//console.warn("n: " + node.nodeName + "; s: " +
		//		this.startPos + "; c: " + this.curPos);

		if ( nodeType === NODE.TEXT_NODE || nodeType === NODE.COMMENT_NODE ) {
			src = (node.nodeValue || '');
			if (nodeType === NODE.COMMENT_NODE) {
				src = '<!--' + src + '-->';
			}
			// Get the wikitext source length adjusted for any stripped
			// leading ws in indent-pre context
			var srcLen = this.srcTextLen(src, inIndentPre);
			if ( this.startPos === null ) {
				// not included in a source range, so make sure it is fully
				// serialized
				if (! DU.isIEW(node) &&
						! DU.hasCurrentDiffMark(node.parentNode, this.env))
				{
					this.markTextOrCommentNode(node, false);
				}
			} else {
				this.movePos(srcLen);
			}
		} else if ( nodeType === NODE.ELEMENT_NODE )
		{

			// data-ve-changed is what we watch for the change markers.
			dvec = Util.getJSONAttribute(node, 'data-ve-changed', {});
			// get data-parsoid
			dp = Util.getJSONAttribute( node, 'data-parsoid', null);


			isModified = DU.hasChangeMarker(dvec) ||
				// Marked as modified by our diff algo
				DU.hasCurrentDiffMark(node, this.env) ||
				// no data-parsoid: new content
				! dp;
				// TODO: also *detect* element modifications without change
				// markers! use outerHTML?

			if (DU.isTplElementNode(this.env, node))
			{
				// Don't descend into template content
				var type = node.getAttribute('typeof');
				if(dp && dp.dsr && type.match(/^mw:Object/)) {
					// Only use the dsr from the typeof-marked elements
					this.updatePos(dp.dsr[1]);
				}
				this.debug('tpl', this.startPos, this.curPos);
				// nothing to see here, move along..
				continue;
			} else if ( // need to fully serialize if there is no startPos
					this.startPos === null ||
					isModified ||
					// No DSR / DSR mismatch. TODO: ignore minor variations in
					// separator newlines
					!dp.dsr || dp.dsr[0] !== this.curPos )
			{

				// Mark element for serialization.
				this.markElementNode(node, isModified, dp );
				continue;

			}

			if ( node.childNodes.length &&
					dp.dsr[2] !== null &&
					// Don't descend into html-pres for now.
					// FIXME: Handle pres properly in general!
					(nodeName !== 'pre' || dp.stx !== 'html') )
			{
				// Prepare for recursion
				if ( DU.isIndentPre(node) ) {
					this.inIndentPre = true;
				}

				// Remember positions before adjusting them for the child
				var lastID = this.currentId,
					lastRange = [this.startPos, this.curPos];
				// Try to update the position for the child
				if (dp && dp.dsr) {
					this.updatePos(dp.dsr[0] + dp.dsr[2]);
				}

				// Handle the subdom.
				this.doConvert(node, dp.dsr);

				if ( this.currentId !== lastID ) {
					// something was modified
					if (nodeName === 'table' ||
							nodeName === 'ul' ||
							nodeName === 'ol' ||
							nodeName === 'dl' )
					{
						this.debug('lastrange', lastRange);
						// We want to fully serialize elements of this type
						// until our support for selective serialization in
						// these elements is improved. Hence, mark this node
						// for full serialization.
						this.markElementNode(node, true, dp, lastRange);
					}
				}
				// reset pre state
				this.inIndentPre = inIndentPre;
			}

			// Move the position past the element.
			if (dp && dp.dsr && dp.dsr[1]) {
				//console.log( 'back up, update pos to', dp.dsr[1]);
				this.updatePos(dp.dsr[1]);
			}
		}
	}

	// Check if the expected end source offset still matches. If it does not,
	// content was removed.
	if ( parentDSR && parentDSR[3] !== null ) {
		var endPos = parentDSR[1] - parentDSR[3];
		if (this.curPos !== endPos) {
			this.debug('end pos mismatch', this.curPos, endPos, parentDSR);
			if ( this.startPos === null ) {
				this.startPos = this.curPos;
			}
			// Insert a modification marker
			this.insertModificationMarker(parentNode, null);
		}
		// Now jump over the gap
		this.debug('updating end pos to', endPos);
		this.updatePos(endPos);
	} else if ( parentNode.nodeName.toLowerCase() === 'body' &&
			this.startPos !== null &&
			this.startPos !== this.curPos )
	{
		this.insertModificationMarker(parentNode, null);
	}
};

/**
 * Utility: Calculate the wikitext source text length for the content of a DOM
 * text node, depending on whether the text node is inside an indent-pre block
 * or not.
 *
 * FIXME: Fix DOMUtils.indentPreDSRCorrection to properly handle text nodes
 * that are not direct children of pre nodes, and use it instead of this code.
 * This code might break when the (optional) leading newline is stripped by
 * the HTML parser.
 */
DiffToSelserConverter.prototype.srcTextLen = function( src, inIndentPre ) {
	if ( ! inIndentPre ) {
		return src.length;
	} else {
		var nlMatch = src.match(/\n/g),
			nlCount = nlMatch ? nlMatch.length : 0;
		return src.length + nlCount;
	}
};

/**
 * Insert a modification marker meta with the current position. This starts a
 * new serialization chunk. Used to handle gaps in unmodified content.
 */
DiffToSelserConverter.prototype.insertModificationMarker = function(parentNode, beforeNode) {
	var modMarker = parentNode.ownerDocument.createElement('meta');
	modMarker.setAttribute('typeof', 'mw:ChangeMarker');
	parentNode.insertBefore(modMarker, beforeNode);
	this.markElementNode(modMarker, false);
	this.startPos = null;
};


/**
 * Wrap a bare (DSR-less) text or comment node in a span and set modification
 * markers on that, so that it is serialized out using the WTS
 */
DiffToSelserConverter.prototype.markTextOrCommentNode = function(node, modified, srcRange) {
	var wrapper = DU.wrapTextInSpan(node, 'mw:SerializeMarker');
	this.markElementNode(wrapper, modified, null, srcRange);
	return wrapper;
};

/**
 * Set change information on an element node
 *
 * TODO: implement!
 */
DiffToSelserConverter.prototype.markElementNode = function(node, modified, dp, srcRange)
{
	var srcRange;
	if ( srcRange || this.startPos !== null ) {
		srcRange = srcRange || [this.startPos, this.curPos];
	}
	// Add serialization info to this node
	DU.setJSONAttribute(node, 'data-parsoid-serialize',
			{
				id: this.currentId,
				modified: modified,
				// might be undefined
				srcRange: srcRange
			} );

	if(modified) {
		// Increment the currentId
		this.currentId++;
		if( dp && dp.dsr ) {
			// reset this positions
			this.startPos = dp.dsr[1];
			this.updatePos(dp.dsr[1]);
		} else {
			this.startPos = null;
			this.curPos = null;
		}
	} else {
		if( dp && dp.dsr ) {
			// reset this positions
			this.startPos = dp.dsr[0];
			this.updatePos(dp.dsr[1]);
		} else {
			this.startPos = null;
			this.curPos = null;
		}
	}
};

/**
 * Set startPos to curPos if it is null and move curPos by passed-in delta.
 */
DiffToSelserConverter.prototype.movePos = function (delta) {
	if ( this.curPos !== null && delta !== null ) {
		this.updatePos( this.curPos + delta );
	}
};

/**
 * Update startPos (if null) and curPos to the passed-in position
 */
DiffToSelserConverter.prototype.updatePos = function ( pos ) {
	//console.log(pos);
	//console.trace();
	if ( pos !== undefined && pos !== null ) {
		if ( this.startPos === null ) {
			this.startPos = pos;
		}
		this.curPos = pos;
	}
};



if ( typeof module === 'object' ) {
	module.exports.SelectiveSerializer = SelectiveSerializer;
}

