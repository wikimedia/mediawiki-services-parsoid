'use strict';

const { DOMUtils } = require('../../utils/DOMUtils.js');
const { DOMDataUtils } = require('../../utils/DOMDataUtils.js');
const { WTUtils } = require('../../utils/WTUtils.js');
const { tagHandlers } = require('../DOMHandlers.js');

const DOMHandler = require('./DOMHandler.js');
const FallbackHTMLHandler = require('./FallbackHTMLHandler.js');

function ClientError(message) {
	Error.captureStackTrace(this, ClientError);
	this.name = 'Bad Request';
	this.message = message || 'Bad Request';
	this.httpStatus = 400;
	this.suppressLoggingStack = true;
}
ClientError.prototype = Error.prototype;

class EncapsulatedContentHandler extends DOMHandler {
	constructor() {
		super(false);
		this.parentMap = {
			LI: { UL: 1, OL: 1 },
			DT: { DL: 1 },
			DD: { DL: 1 },
		};
	}
	*handleG(node, state, wrapperUnmodified) {
		var env = state.env;
		var self = state.serializer;
		var dp = DOMDataUtils.getDataParsoid(node);
		var dataMw = DOMDataUtils.getDataMw(node);
		var typeOf = node.getAttribute('typeof') || '';
		var src;
		if (/(?:^|\s)(?:mw:Transclusion|mw:Param)(?=$|\s)/.test(typeOf)) {
			if (dataMw.parts) {
				src = yield self.serializeFromParts(state, node, dataMw.parts);
			} else if (dp.src !== undefined) {
				env.log("error", "data-mw missing in: " + node.outerHTML);
				src = dp.src;
			} else {
				throw new ClientError("Cannot serialize " + typeOf + " without data-mw.parts or data-parsoid.src");
			}
		} else if (/(?:^|\s)mw:Extension\//.test(typeOf)) {
			if (!dataMw.name && dp.src === undefined) {
				// If there was no typeOf name, and no dp.src, try getting
				// the name out of the mw:Extension type. This will
				// generate an empty extension tag, but it's better than
				// just an error.
				var extGivenName = typeOf.replace(/(?:^|\s)mw:Extension\/([^\s]+)/, '$1');
				if (extGivenName) {
					env.log('error', 'no data-mw name for extension in: ', node.outerHTML);
					dataMw.name = extGivenName;
				}
			}
			if (dataMw.name) {
				var nativeExt = env.conf.wiki.extConfig.tags.get(dataMw.name.toLowerCase());
				if (nativeExt && nativeExt.serialHandler && nativeExt.serialHandler.handle) {
					src = yield nativeExt.serialHandler.handle(node, state, wrapperUnmodified);
				} else {
					src = yield self.defaultExtensionHandler(node, state);
				}
			} else if (dp.src !== undefined) {
				env.log('error', 'data-mw missing in: ' + node.outerHTML);
				src = dp.src;
			} else {
				throw new ClientError('Cannot serialize extension without data-mw.name or data-parsoid.src.');
			}
		} else if (/(?:^|\s)(?:mw:LanguageVariant)(?=$|\s)/.test(typeOf)) {
			return (yield state.serializer.languageVariantHandler(node));
		} else {
			throw new Error('Should never reach here');
		}
		state.singleLineContext.disable();
		// FIXME: https://phabricator.wikimedia.org/T184779
		if (dataMw.extPrefix || dataMw.extSuffix) {
			src = (dataMw.extPrefix || '') + src + (dataMw.extSuffix || '');
		}
		self.emitWikitext(this.handleListPrefix(node, state) + src, node);
		state.singleLineContext.pop();
		return WTUtils.skipOverEncapsulatedContent(node);
	}
	// XXX: This is questionable, as the template can expand
	// to newlines too. Which default should we pick for new
	// content? We don't really want to make separator
	// newlines in HTML significant for the semantics of the
	// template content.
	before(node, otherNode, state) {
		var env = state.env;
		var typeOf = node.getAttribute('typeof') || '';
		var dataMw = DOMDataUtils.getDataMw(node);
		var dp = DOMDataUtils.getDataParsoid(node);

		// Handle native extension constraints.
		if (/(?:^|\s)mw:Extension\//.test(typeOf) &&
				// Only apply to plain extension tags.
				!/(?:^|\s)mw:Transclusion(?:\s|$)/.test(typeOf)) {
			if (dataMw.name) {
				var nativeExt = env.conf.wiki.extConfig.tags.get(dataMw.name.toLowerCase());
				if (nativeExt && nativeExt.serialHandler && nativeExt.serialHandler.before) {
					var ret = nativeExt.serialHandler.before(node, otherNode, state);
					if (ret !== null) { return ret; }
				}
			}
		}

		// If this content came from a multi-part-template-block
		// use the first node in that block for determining
		// newline constraints.
		if (dp.firstWikitextNode) {
			var nodeName = dp.firstWikitextNode.toLowerCase();
			var h = tagHandlers.get(nodeName);
			if (!h && dp.stx === 'html' && nodeName !== 'a') {
				h = new FallbackHTMLHandler();
			}
			if (h) {
				return h.before(node, otherNode, state);
			}
		}

		// default behavior
		return { min: 0, max: 2 };
	}

	handleListPrefix(node, state) {
		var bullets = '';
		if (DOMUtils.isListOrListItem(node) &&
				!this.parentBulletsHaveBeenEmitted(node) &&
				!DOMUtils.previousNonSepSibling(node) &&  // Maybe consider parentNode.
				this.isTplListWithoutSharedPrefix(node) &&
				// Nothing to do for definition list rows,
				// since we're emitting for the parent node.
				!(node.nodeName === 'DD' &&
					DOMDataUtils.getDataParsoid(node).stx === 'row')) {
			bullets = this.getListBullets(state, node.parentNode);
		}
		return bullets;
	}

	// Normally we wait until hitting the deepest nested list element before
	// emitting bullets. However, if one of those list elements is about-id
	// marked, the tag handler will serialize content from data-mw parts or src.
	// This is a problem when a list wasn't assigned the shared prefix of bullets.
	// For example,
	//
	//   ** a
	//   ** b
	//
	// Will assign bullets as,
	//
	// <ul><li-*>
	//   <ul>
	//     <li-*> a</li>   <!-- no shared prefix  -->
	//     <li-**> b</li>  <!-- gets both bullets -->
	//   </ul>
	// </li></ul>
	//
	// For the b-li, getListsBullets will walk up and emit the two bullets it was
	// assigned. If it was about-id marked, the parts would contain the two bullet
	// start tag it was assigned. However, for the a-li, only one bullet is
	// associated. When it's about-id marked, serializing the data-mw parts or
	// src would miss the bullet assigned to the container li.
	isTplListWithoutSharedPrefix(node) {
		if (!WTUtils.isEncapsulationWrapper(node)) {
			return false;
		}

		var typeOf = node.getAttribute("typeof") || '';

		if (/(?:^|\s)mw:Transclusion(?=$|\s)/.test(typeOf)) {
			// If the first part is a string, template ranges were expanded to
			// include this list element. That may be trouble. Otherwise,
			// containers aren't part of the template source and we should emit
			// them.
			var dataMw = DOMDataUtils.getDataMw(node);
			if (!dataMw.parts || typeof dataMw.parts[0] !== "string") {
				return true;
			}
			// Less than two bullets indicates that a shared prefix was not
			// assigned to this element. A safe indication that we should call
			// getListsBullets on the containing list element.
			return !/^[*#:;]{2,}$/.test(dataMw.parts[0]);
		} else if (/(?:^|\s)mw:(Extension|Param)/.test(typeOf)) {
			// Containers won't ever be part of the src here, so emit them.
			return true;
		} else {
			return false;
		}
	}

	parentBulletsHaveBeenEmitted(node) {
		if (WTUtils.isLiteralHTMLNode(node)) {
			return true;
		} else if (DOMUtils.isList(node)) {
			return !DOMUtils.isListItem(node.parentNode);
		} else {
			console.assert(DOMUtils.isListItem(node));
			var parentNode = node.parentNode;
			// Skip builder-inserted wrappers
			while (this.isBuilderInsertedElt(parentNode)) {
				parentNode = parentNode.parentNode;
			}
			return !(parentNode.nodeName in this.parentMap[node.nodeName]);
		}
	}
}

module.exports = EncapsulatedContentHandler;
