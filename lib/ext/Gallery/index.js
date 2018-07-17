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

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.9.0');
var Promise = ParsoidExtApi.Promise;
var Util = ParsoidExtApi.Util;
var DU = ParsoidExtApi.DOMUtils;

// Use a relative include since it's questionably whether we want to expose
// this through the extensions api, and galleries are ostensibly core
// functionality.  See T156099
var Sanitizer = require('../../wt2html/tt/Sanitizer.js').Sanitizer;
var SanitizerConstants = require('../../wt2html/tt/Sanitizer.js').SanitizerConstants;

var modes = require('./modes.js');

/**
 * @class
 */
var Opts = function(env, attrs) {
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
	var validUlAttrs = SanitizerConstants.attrWhiteList.ul;
	this.attrs = Object.keys(attrs)
	.filter(function(k) { return validUlAttrs.includes(k); })
	.reduce(function(o, k) {
		o[k] = (k === 'style') ? Sanitizer.checkCss(attrs[k]) : attrs[k];
		return o;
	}, {});
};

// FIXME: This is too permissive.  The php implementation only calls
// `replaceInternalLinks` on the gallery caption.  We should have a new
// tokenizing rule that only tokenizes text / wikilink.
var pCaption = Promise.async(function *(data) {
	var options = data.extToken.getAttribute('options');
	var caption = options.find(function(kv) {
		return kv.k === 'caption';
	});
	if (caption === undefined || !caption.v) { return null; }
	var doc = yield Util.promiseToProcessContent(
		data.manager.env,
		data.manager.frame,
		caption.v,
		{
			pipelineType: 'text/x-mediawiki/full',
			pipelineOpts: {
				extTag: 'gallery',
				inTemplate: data.pipelineOpts.inTemplate,
				noPre: true,
				noPWrapping: true,
			},
			srcOffsets: caption.srcOffsets.slice(2),
		}
	);
	// Store before `migrateChildrenBetweenDocs` in render
	DU.visitDOM(doc.body, DU.storeDataAttribs);
	return doc.body;
});

var pLine = Promise.async(function *(data, obj) {
	var env = data.manager.env;
	var opts = data.opts;

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
	var diff = file.length - matches[1].length;
	var startOffset = obj.offset - start.length - diff - middle.length;
	var srcOffsets = [startOffset, startOffset + wt.length];

	var doc = yield Util.promiseToProcessContent(env, data.manager.frame, wt, {
		pipelineType: 'text/x-mediawiki/full',
		pipelineOpts: {
			extTag: 'gallery',
			inTemplate: data.pipelineOpts.inTemplate,
			noPre: true,
			noPWrapping: true,
		},
		srcOffsets: srcOffsets,
	});
	var body = doc.body;

	var thumb = body.firstChild;
	if (thumb.nodeName !== 'FIGURE') {
		return null;
	}

	var rdfaType = thumb.getAttribute('typeof');

	// Clean it out for reuse later
	while (body.firstChild) { body.firstChild.remove(); }

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

	var gallerytext = !/^\s*$/.test(figcaption.innerHTML) && figcaption;
	if (gallerytext) {
		// Store before `migrateChildrenBetweenDocs` in render
		DU.visitDOM(gallerytext, DU.storeDataAttribs);
	}
	return { thumb: thumb, gallerytext: gallerytext, rdfaType: rdfaType };
});

var tokenHandler = function(manager, pipelineOpts, extToken, cb) {
	var env = manager.env;
	var argDict = Util.getExtArgInfo(extToken).dict;
	var opts = new Opts(env, argDict.attrs);

	// FIXME: Only remove after VE switches to editing HTML.
	if (env.nativeGallery) {
		// Remove extsrc from native extensions
		argDict.body.extsrc = undefined;

		// Remove the caption since it's redundant with the HTML
		// and we prefer editing it there.
		argDict.attrs.caption = undefined;
	}

	// Pass this along the promise chain ...
	var data = {
		manager: manager,
		pipelineOpts: pipelineOpts,
		extToken: extToken,
		opts: opts,
	};

	var extSrc = extToken.getAttribute('source');
	var dataAttribs = extToken.dataAttribs;
	var extBody = Util.extractExtBody(extToken);

	var offset = dataAttribs.tsr[0] + dataAttribs.tagWidths[0];

	// Prepare the lines for processing
	var lines = extBody.split('\n')
	.map(function(line, ind) {
		var obj = { line: line, offset: offset };
		offset += line.length + 1;  // For the nl
		return obj;
	})
	.filter(function(obj, ind, arr) {
		return !((ind === 0 || ind === arr.length - 1) && /^\s*$/.test(obj.line));
	});

	cb({ async: true });

	Promise.join(
		(opts.caption === undefined) ? null : pCaption(data),
		Promise.map(lines, pLine.bind(null, data))
	)
	.then(function(ret) {
		// Drop invalid lines like "References: 5."
		var oLines = ret[1].filter(function(o) {
			return o !== null;
		});
		var mode = modes.get(opts.mode);
		var doc = mode.render(opts, ret[0], oLines);
		// Reload now the `migrateChildrenBetweenDocs` is done
		DU.visitDOM(doc.body, DU.loadDataAttribs);
		var addAttrs = function(firstNode) {
			firstNode.setAttribute('typeof', 'mw:Extension/' + argDict.name);
			DU.setDataMw(firstNode, argDict);
			DU.setDataParsoid(firstNode, {
				tsr: Util.clone(dataAttribs.tsr),
				src: dataAttribs.src,
			});
		};
		var tokens = DU.buildDOMFragmentTokens(env, extToken, doc.body, addAttrs, {
			isForeignContent: true, setDSR: true,
		});
		cb({ tokens: tokens });
	})
	.catch(function(err) {
		env.log('error', 'Processing gallery extension source.', err);
		cb({ tokens: [extSrc] });
	});
};

var contentHandler = Promise.async(function *(node, state) {
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
				var elt = DU.selectMediaElt(thumb);
				var resource = null;
				if (elt) {
					// FIXME: Should we preserve the original namespace?  See T151367
					resource = elt.getAttribute('resource');
					if (resource !== null) {
						content += resource.replace(/^\.\//, '');
						var alt = elt.getAttribute('alt');
						if (alt !== null) {
							content += '|alt=' + alt;
						}
					}
				} else {
					// TODO: Previously (<=1.5.0), we rendered valid titles
					// returning mw:Error (apierror-filedoesnotexist) as
					// plaintext.  Continue to serialize this content until
					// that version is no longer supported.
					content += thumb.textContent;
				}
				// The first "a" is for the link, hopefully.
				var a = thumb.querySelector('a');
				if (a) {
					var href = a.getAttribute('href');
					if (href !== null && href !== resource) {
						content += '|link=' + href.replace(/^\.\//, '');
					}
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
});

var serialHandler = {
	handle: Promise.async(function *(node, state, wrapperUnmodified) {
		var dataMw = DU.getDataMw(node);
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
					state.serializer.wteHandlers.wikilinkHandler
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
				content = yield contentHandler(node, state);
			}
			return startTagSrc + content + '</' + dataMw.name + '>';
		}
	}),
};

/**
 * Native Parsoid implementation of the Gallery extension.
 */
var Gallery = function() {
	this.config = {
		tags: [
			{
				name: 'gallery',
				tokenHandler: tokenHandler,
				serialHandler: serialHandler,
			},
		],
		styles: ['mediawiki.page.gallery.styles'],
	};
};

if (typeof module === 'object') {
	module.exports = Gallery;
}
