/**
 * Implements the php parser's `renderImageGallery` natively.
 *
 * Params to support (on the extension tag):
 *   showfilename, caption, mode, widths, heights, perrow
 *
 * A proposed spec is at: https://phabricator.wikimedia.org/P2506
 */
'use strict';

var ParsoidExtApi = module.parent.require('./extapi.js').versionCheck('^0.6.1');
var Promise = ParsoidExtApi.Promise;
var Util = ParsoidExtApi.Util;
var DU = ParsoidExtApi.DOMUtils;

var modes = require('./modes.js');

var Opts = function(env, attrs) {
	Object.assign(this, env.conf.wiki.siteInfo.general.galleryoptions);

	var perrow = parseInt(attrs.perrow, 10);
	if (!Number.isNaN(perrow)) { this.imagesPerRow = perrow; }

	var width = parseInt(attrs.widths, 10);
	if (!Number.isNaN(width)) { this.imageWidth = width; }

	var height = parseInt(attrs.heights, 10);
	if (!Number.isNaN(height)) { this.imageHeight = height; }

	var mode = (attrs.mode || '').toLowerCase();
	if (modes.has(mode)) { this.mode = mode; }

	this.showfilename = (attrs.showfilename !== undefined);
	this.caption = attrs.caption;
};

// FIXME: This is too permissive.  The php implementation only calls
// `replaceInternalLinks` on the gallery caption.  We should have a new
// tokenizing rule that only tokenizes text / wikilink.
var pCaption = Promise.method(function(data) {
	var options = data.extToken.getAttribute('options');
	var caption = options.find(function(kv) {
		return kv.k === 'caption';
	});
	if (caption === undefined || !caption.v) { return null; }
	return Util.promiseToProcessContent(
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
	)
	.then(function(doc) {
		// Store before `migrateChildrenBetweenDocs` in render
		DU.visitDOM(doc.body, DU.storeDataAttribs);
		return doc.body;
	});
});

var pLine = function(data, obj) {
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

	return Util.promiseToProcessContent(env, data.manager.frame, wt, {
		pipelineType: 'text/x-mediawiki/full',
		pipelineOpts: {
			extTag: 'gallery',
			inTemplate: data.pipelineOpts.inTemplate,
			noPre: true,
			noPWrapping: true,
		},
		srcOffsets: srcOffsets,
	})
	.then(function(doc) {
		var body = doc.body;

		var thumb = body.firstChild;
		if (thumb.nodeName !== 'FIGURE') {
			return null;
		}

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

		var typeOf = thumb.getAttribute('typeof');
		if (/\bmw:Error\b/.test(typeOf)) {
			while (thumb.firstChild) { thumb.firstChild.remove(); }
			thumb.appendChild(doc.createTextNode(text));
		}

		var gallerytext = !/^\s*$/.test(figcaption.innerHTML) && figcaption;
		if (gallerytext) {
			// Store before `migrateChildrenBetweenDocs` in render
			DU.visitDOM(gallerytext, DU.storeDataAttribs);
		}
		return { thumb: thumb, gallerytext: gallerytext };
	});
};

var tokenHandler = function(manager, pipelineOpts, extToken, cb) {
	var env = manager.env;
	var argDict = Util.getArgInfo(extToken).dict;
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

	Promise.all([
		(opts.caption === undefined) ? null : pCaption(data),
		Promise.map(lines, pLine.bind(null, data)),
	])
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
		var tokens = DU.buildDOMFragmentTokens(env, extToken, doc, addAttrs, {
			isForeignContent: true, setDSR: true,
		});
		cb({ tokens: tokens });
	})
	.catch(function(err) {
		env.log('error', 'Processing gallery extension source.', err);
		cb({ tokens: [extSrc] });
	});
};

var contentHandler = Promise.method(function(node, state) {
	var content = '\n';
	return Promise.reduce(Array.from(node.childNodes), function(_, child) {
		switch (child.nodeType) {
			case child.ELEMENT_NODE:
				// Ignore if it isn't a "gallerybox"
				if (child.nodeName !== 'LI' ||
						child.getAttribute('class') !== 'gallerybox') {
					break;
				}
				var thumb = child.querySelector('.thumb');
				if (!thumb) { break; }
				var p = Promise.resolve();
				// FIXME: Is this the right img?
				var img = thumb.querySelector('img');
				var resource = null;
				if (img) {
					// FIXME: Should we preserve the original namespace?
					resource = img.getAttribute('resource');
					if (resource !== null) {
						content += resource.replace(/^\.\//, '');
						var alt = img.getAttribute('alt');
						if (alt !== null) {
							content += '|alt=' + alt;
						}
					}
				} else {
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
					p = p.then(function() {
						return state.serializeCaptionChildrenToString(gallerytext,
							state.serializer.wteHandlers.wikilinkHandler)
						.then(function(caption) {
							// Drop empty captions
							if (!/^\s*$/.test(caption)) {
								content += '|' + caption;
							}
						});
					});
				}
				return p.then(function() { content += '\n'; });
			case child.TEXT_NODE:
			case child.COMMENT_NODE:
				// Ignore it
				return;
			default:
				console.assert(true, 'Should not be here!');
		}
	}, null).then(function() {
		return content;
	});
});

var serialHandler = {
	handle: Promise.method(function(node, state, wrapperUnmodified) {
		var p = Promise.resolve();
		var dataMw = DU.getDataMw(node);
		// Handle the "gallerycaption" first
		var galcaption = node.querySelector('li.gallerycaption');
		if (galcaption &&
				// FIXME: VE should signal to use the HTML by removing the
				// `caption` from data-mw.
				typeof dataMw.attrs.caption !== 'string') {
			p = state.serializeCaptionChildrenToString(galcaption,
					state.serializer.wteHandlers.wikilinkHandler)
			.then(function(caption) {
				dataMw.attrs.caption = caption;
			});
		}
		return p.then(function() {
			return state.serializer.serializeExtensionStartTag(node, state);
		})
		.then(function(startTagSrc) {
			if (!dataMw.body) {
				return startTagSrc;  // We self-closed this already.
			} else {
				var p2;
				// FIXME: VE should signal to use the HTML by removing the
				// `extsrc` from the data-mw.
				if (typeof dataMw.body.extsrc === 'string') {
					p2 = Promise.resolve(dataMw.body.extsrc);
				} else {
					p2 = contentHandler(node, state);
				}
				return p2.then(function(content) {
					return startTagSrc + content + '</' + dataMw.name + '>';
				});
			}
		});
	}),
};

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
