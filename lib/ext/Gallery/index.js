/**
 * Implements the php parser's `renderImageGallery` natively.
 *
 * Params to support (on the extension tag):
 * - showfilename
 * - caption
 * - mode
 * - widths
 * - heights
 * - perrow
 *
 * A proposed spec is at: https://phabricator.wikimedia.org/P2506
 * @module ext/Gallery
 */

'use strict';

const ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.11.0');
const {
	ContentUtils,
	DOMDataUtils,
	DOMUtils,
	parseWikitextToDOM,
	Promise,
	Sanitizer,
	TokenUtils,
	Util,
} = ParsoidExtApi;

var modes = require('./modes.js');

/**
 * @class
 */
class Opts {
	constructor(env, attrs) {
		Object.assign(this, env.conf.wiki.siteInfo.general.galleryoptions);

		var perrow = parseInt(attrs.perrow, 10);
		if (!Number.isNaN(perrow)) { this.imagesPerRow = perrow; }

		var maybeDim = Util.parseMediaDimensions(String(attrs.widths), true);
		if (maybeDim && Util.validateMediaParam(maybeDim.x)) {
			this.imageWidth = maybeDim.x;
		}

		maybeDim = Util.parseMediaDimensions(String(attrs.heights), true);
		if (maybeDim && Util.validateMediaParam(maybeDim.x)) {
			this.imageHeight = maybeDim.x;
		}

		var mode = (attrs.mode || '').toLowerCase();
		if (modes.has(mode)) { this.mode = mode; }

		this.showfilename = (attrs.showfilename !== undefined);
		this.showthumbnails = (attrs.showthumbnails !== undefined);
		this.caption = attrs.caption;

		// TODO: Good contender for T54941
		const validUlAttrs = Sanitizer.attributeWhitelist('ul');
		this.attrs = Object.keys(attrs)
		.filter(function(k) { return validUlAttrs.has(k); })
		.reduce(function(o, k) {
			o[k] = (k === 'style') ? Sanitizer.checkCss(attrs[k]) : attrs[k];
			return o;
		}, {});
	}
}

/**
 * Native Parsoid implementation of the Gallery extension.
 */
class Gallery {
	constructor() {
		this.config = {
			tags: [
				{
					name: 'gallery',
					toDOM: Gallery.toDOM,
					modifyArgDict: Gallery.modifyArgDict,
					serialHandler: Gallery.serialHandler(),
				},
			],
			styles: ['mediawiki.page.gallery.styles'],
		};
	}

	static *pCaption(data) {
		const { state }  = data;
		var options = state.extToken.getAttribute('options');
		var caption = options.find(function(kv) {
			return kv.k === 'caption';
		});
		if (caption === undefined || !caption.v) { return null; }
		// `normalizeExtOptions` messes up src offsets, so we do our own
		// normalization to avoid parsing sol blocks
		const capV = caption.vsrc.replace(/[\t\r\n ]/g, ' ');
		const doc = yield parseWikitextToDOM(
			state,
			capV,
			{
				pipelineOpts: {
					extTag: 'gallery',
					inTemplate: state.parseContext.inTemplate,
					// FIXME: This needs more analysis.  Maybe it's inPHPBlock
					inlineContext: true,
				},
				srcOffsets: caption.srcOffsets.slice(2),
			},
			false  // Gallery captions are deliberately not parsed in SOL context
		);
		// Store before `migrateChildrenBetweenDocs` in render
		DOMDataUtils.visitAndStoreDataAttribs(doc.body);
		return doc.body;
	}

	static *pLine(data, obj) {
		const { state, opts } = data;
		const env = state.env;

		// Regexp from php's `renderImageGallery`
		var matches = obj.line.match(/^([^|]+)(\|(?:.*))?$/);
		if (!matches) { return null; }

		var text = matches[1];
		var caption = matches[2] || '';

		// TODO: % indicates rawurldecode.

		var title = env.makeTitleFromText(text,
				env.conf.wiki.canonicalNamespaces.file, true);

		if (title === null || !title.getNamespace().isFile()) {
			return null;
		}

		// FIXME: Try to confirm `file` isn't going to break WikiLink syntax.
		// See the check for 'FIGURE' below.
		var file = title.getPrefixedDBKey();

		var mode = modes.get(opts.mode);

		// NOTE: We add "none" here so that this renders in the block form
		// (ie. figure) for an easier structure to manipulate.
		var start = '[[';
		var middle = '|' + mode.dimensions(opts) + '|none';
		var end = ']]';
		var wt = start + file + middle + caption + end;

		// This is all in service of lining up the caption
		var shiftOffset = function(offset) {
			offset -= start.length;
			if (offset <= 0) { return null; }
			if (offset <= file.length) {
				// Align file part
				return obj.offset + offset;
			}
			offset -= file.length;
			offset -= middle.length;
			if (offset <= 0) { return null; }
			if (offset <= caption.length) {
				// Align caption part
				return obj.offset + text.length + offset;
			}
			return null;
		};

		const doc = yield parseWikitextToDOM(
			state,
			wt,
			{
				pipelineOpts: {
					extTag: 'gallery',
					inTemplate: state.parseContext.inTemplate,
					// FIXME: This needs more analysis.  Maybe it's inPHPBlock
					inlineContext: true,
				},
				frame: state.frame.newChild(state.frame.title, [], wt),
				srcOffsets: [0, wt.length],
			},
			true  // sol
		);

		var body = doc.body;

		// Now shift the DSRs in the DOM by startOffset, and strip DSRs
		// for bits which aren't the caption or file, since they
		// don't refer to actual source wikitext
		ContentUtils.shiftDSR(env, body, (dsr) => {
			dsr[0] = shiftOffset(dsr[0]);
			dsr[1] = shiftOffset(dsr[1]);
			// If either offset is invalid, remove entire DSR
			if (dsr[0] === null || dsr[1] === null) { return null; }
			return dsr;
		});

		var thumb = body.firstChild;
		if (thumb.nodeName !== 'FIGURE') {
			return null;
		}

		var rdfaType = thumb.getAttribute('typeof');

		// Detach from document
		thumb.remove();

		// Detach figcaption as well
		var figcaption = thumb.querySelector('figcaption');
		if (!figcaption) {
			figcaption = doc.createElement('figcaption');
		} else {
			figcaption.remove();
		}

		if (opts.showfilename) {
			var galleryfilename = doc.createElement('a');
			galleryfilename.setAttribute('href', env.makeLink(title));
			galleryfilename.setAttribute('class', 'galleryfilename galleryfilename-truncate');
			galleryfilename.setAttribute('title', file);
			galleryfilename.appendChild(doc.createTextNode(file));
			figcaption.insertBefore(galleryfilename, figcaption.firstChild);
		}

		var gallerytext = null;
		for (
			let capChild = figcaption.firstChild;
			capChild !== null;
			capChild = capChild.nextSibling
		) {
			if (DOMUtils.isText(capChild) && /^\s*$/.test(capChild.nodeValue)) {
				continue; // skip blank text nodes
			}
			// Found a non-blank node!
			gallerytext = figcaption;
			break;
		}

		if (gallerytext) {
			// Store before `migrateChildrenBetweenDocs` in render
			DOMDataUtils.visitAndStoreDataAttribs(gallerytext);
		}
		return { thumb: thumb, gallerytext: gallerytext, rdfaType: rdfaType };
	}

	static toDOM(state, content, args) {
		const attrs = TokenUtils.kvToHash(args, true);
		const opts = new Opts(state.env, attrs);

		// Pass this along the promise chain ...
		const data = {
			state,
			opts,
		};

		const dataAttribs = state.extToken.dataAttribs;
		let offset =
			dataAttribs.extTagOffsets[0] + dataAttribs.extTagOffsets[2];

		// Prepare the lines for processing
		const lines = content.split('\n')
		.map(function(line, ind) {
			const obj = { line: line, offset: offset };
			offset += line.length + 1;  // For the nl
			return obj;
		});

		return Promise.join(
			(opts.caption === undefined) ? null : Gallery.pCaption(data),
			Promise.map(lines, line => Gallery.pLine(data, line))
		)
		.then(function(ret) {
			// Drop invalid lines like "References: 5."
			const oLines = ret[1].filter(function(o) {
				return o !== null;
			});
			const mode = modes.get(opts.mode);
			const doc = mode.render(state.env, opts, ret[0], oLines);
			// Reload now that `migrateChildrenBetweenDocs` is done
			DOMDataUtils.visitAndLoadDataAttribs(doc.body);
			return doc;
		});
	}

	static *contentHandler(node, state) {
		var content = '\n';
		for (var child = node.firstChild; child; child = child.nextSibling) {
			switch (child.nodeType) {
				case child.ELEMENT_NODE:
					// Ignore if it isn't a "gallerybox"
					if (child.nodeName !== 'LI' ||
							child.getAttribute('class') !== 'gallerybox') {
						break;
					}
					var thumb = child.querySelector('.thumb');
					if (!thumb) { break; }
					// FIXME: The below would benefit from a refactoring that
					// assumes the figure structure, as in the link handler.
					var elt = DOMUtils.selectMediaElt(thumb);
					if (elt) {
						// FIXME: Should we preserve the original namespace?  See T151367
						if (elt.hasAttribute('resource')) {
							const resource = elt.getAttribute('resource');
							content += resource.replace(/^\.\//, '');
							// FIXME: Serializing of these attributes should
							// match the link handler so that values stashed in
							// data-mw aren't ignored.
							if (elt.hasAttribute('alt')) {
								const alt = elt.getAttribute('alt');
								content += '|alt=' + state.serializer.wteHandlers.escapeLinkContent(state, alt, false, child, true);
							}
							// The first "a" is for the link, hopefully.
							const a = thumb.querySelector('a');
							if (a && a.hasAttribute('href')) {
								const href = a.getAttribute('href');
								if (href !== resource) {
									content += '|link=' + state.serializer.wteHandlers.escapeLinkContent(state, href.replace(/^\.\//, ''), false, child, true);
								}
							}
						}
					} else {
						// TODO: Previously (<=1.5.0), we rendered valid titles
						// returning mw:Error (apierror-filedoesnotexist) as
						// plaintext.  Continue to serialize this content until
						// that version is no longer supported.
						content += thumb.textContent;
					}
					var gallerytext = child.querySelector('.gallerytext');
					if (gallerytext) {
						var showfilename = gallerytext.querySelector('.galleryfilename');
						if (showfilename) {
							showfilename.remove();  // Destructive to the DOM!
						}
						state.singleLineContext.enforce();
						var caption =
							yield state.serializeCaptionChildrenToString(
								gallerytext,
								state.serializer.wteHandlers.wikilinkHandler
							);
						state.singleLineContext.pop();
						// Drop empty captions
						if (!/^\s*$/.test(caption)) {
							content += '|' + caption;
						}
					}
					content += '\n';
					break;
				case child.TEXT_NODE:
				case child.COMMENT_NODE:
					// Ignore it
					break;
				default:
					console.assert(false, 'Should not be here!');
					break;
			}
		}
		return content;
	}

	static serialHandler() {
		return {
			handle: Promise.async(function *(node, state, wrapperUnmodified) {
				var dataMw = DOMDataUtils.getDataMw(node);
				dataMw.attrs = dataMw.attrs || {};
				// Handle the "gallerycaption" first
				var galcaption = node.querySelector('li.gallerycaption');
				if (galcaption &&
						// FIXME: VE should signal to use the HTML by removing the
						// `caption` from data-mw.
						typeof dataMw.attrs.caption !== 'string') {
					dataMw.attrs.caption =
						yield state.serializeCaptionChildrenToString(
							galcaption,
							state.serializer.wteHandlers.mediaOptionHandler
						);
				}
				var startTagSrc =
					yield state.serializer.serializeExtensionStartTag(node, state);

				if (!dataMw.body) {
					return startTagSrc;  // We self-closed this already.
				} else {
					var content;
					// FIXME: VE should signal to use the HTML by removing the
					// `extsrc` from the data-mw.
					if (typeof dataMw.body.extsrc === 'string') {
						content = dataMw.body.extsrc;
					} else {
						content = yield Gallery.contentHandler(node, state);
					}
					return startTagSrc + content + '</' + dataMw.name + '>';
				}
			}),
		};
	}

	static modifyArgDict(env, argDict) {
		// FIXME: Only remove after VE switches to editing HTML.
		if (env.conf.parsoid.nativeGallery) {
			// Remove extsrc from native extensions
			argDict.body.extsrc = undefined;

			// Remove the caption since it's redundant with the HTML
			// and we prefer editing it there.
			argDict.attrs.caption = undefined;
		}
	}
}

Gallery.pLine = Promise.async(Gallery.pLine);
Gallery.pCaption = Promise.async(Gallery.pCaption);
Gallery.contentHandler = Promise.async(Gallery.contentHandler);

if (typeof module === 'object') {
	module.exports = Gallery;
}
