/** @module */

'use strict';

const Promise = require('../../../utils/promise.js');

const { DOMDataUtils } = require('../../../utils/DOMDataUtils.js');
const { DOMUtils } = require('../../../utils/DOMUtils.js');
const { WTSUtils } = require('../../../html2wt/WTSUtils.js');
const { Sanitizer } = require('../../tt/Sanitizer.js');
const { PegTokenizer } = require('../../tokenizer.js');

class AddMediaInfo {
	/**
	 * Extract the dimensions for media.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Object} attrs
	 * @param {Object} info
	 * @return {Object}
	 */
	static handleSize(env, attrs, info) {
		let height = info.height;
		let width = info.width;

		console.assert(typeof height === 'number' && !Number.isNaN(height));
		console.assert(typeof width === 'number' && !Number.isNaN(width));

		if (info.thumburl && info.thumbheight) {
			height = info.thumbheight;
		}

		if (info.thumburl && info.thumbwidth) {
			width = info.thumbwidth;
		}

		// Audio files don't have dimensions, so we fallback to these arbitrary
		// defaults, and the "mw-default-audio-height" class is added.
		if (info.mediatype === 'AUDIO') {
			height = /* height || */ 32;  // Arguably, audio should respect a defined height
			width = width || env.conf.wiki.widthOption;
		}

		let mustRender;
		if (info.mustRender !== undefined) {
			mustRender = info.mustRender;
		} else {
			mustRender = info.mediatype !== 'BITMAP';
		}

		// Handle client-side upscaling (including 'border')

		// Calculate the scaling ratio from the user-specified width and height
		let ratio = null;
		if (attrs.size.height && info.height) {
			ratio = attrs.size.height / info.height;
		}
		if (attrs.size.width && info.width) {
			const r = attrs.size.width / info.width;
			ratio = (ratio === null || r < ratio) ? r : ratio;
		}

		if (ratio !== null && ratio > 1) {
			// If the user requested upscaling, then this is denied in the thumbnail
			// and frameless format, except for files with mustRender.
			if (!mustRender && (attrs.format === 'Thumb' || attrs.format === 'Frameless')) {
				// Upscaling denied
				height = info.height;
				width = info.width;
			} else {
				// Upscaling allowed
				// In the batch API, these will already be correct, but the non-batch
				// API returns the source width and height whenever client-side scaling
				// is requested.
				if (!env.conf.parsoid.useBatchAPI) {
					height = Math.round(info.height * ratio);
					width = Math.round(info.width * ratio);
				}
			}
		}

		return { height, width };
	}

	/**
	 * This is a port of TMH's parseTimeString()
	 *
	 * @param {string} timeString
	 * @param {number} [length]
	 * @return {number}
	 */
	static parseTimeString(timeString, length) {
		let time = 0;
		const parts = timeString.split(':');
		if (parts.length > 3) {
			return false;
		}
		for (let i = 0; i < parts.length; i++) {
			const num = parseInt(parts[i], 10);
			if (Number.isNaN(num)) {
				return false;
			}
			time += num * Math.pow(60, parts.length - 1 - i);
		}
		if (time < 0) {
			time = 0;
		} else if (length !== undefined) {
			console.assert(typeof length === 'number');
			if (time > length) { time = length - 1; }
		}
		return time;
	}

	/**
	 * Handle media fragments
	 * https://www.w3.org/TR/media-frags/
	 *
	 * @param {Object} info
	 * @param {Object} dataMw
	 * @return {string}
	 */
	static parseFrag(info, dataMw) {
		let time;
		let frag = '';
		const starttime = WTSUtils.getAttrFromDataMw(dataMw, 'starttime', true);
		const endtime = WTSUtils.getAttrFromDataMw(dataMw, 'endtime', true);
		if (starttime || endtime) {
			frag += '#t=';
			if (starttime) {
				time = AddMediaInfo.parseTimeString(starttime[1].txt, info.duration);
				if (time !== false) {
					frag += time;
				}
			}
			if (endtime) {
				time = AddMediaInfo.parseTimeString(endtime[1].txt, info.duration);
				if (time !== false) {
					frag += ',' + time;
				}
			}
		}
		return frag;
	}

	/**
	 * @param {Node} elt
	 * @param {Object} info
	 * @param {Object} attrs
	 * @param {Object} dataMw
	 * @param {boolean} hasDimension
	 */
	static addSources(elt, info, attrs, dataMw, hasDimension) {
		const doc = elt.ownerDocument;
		const frag = AddMediaInfo.parseFrag(info, dataMw);

		let derivatives;
		let dataFromTMH = true;
		if (info.thumbdata && Array.isArray(info.thumbdata.derivatives)) {
			// BatchAPI's `getAPIData`
			derivatives = info.thumbdata.derivatives;
		} else if (Array.isArray(info.derivatives)) {
			// "videoinfo" prop
			derivatives = info.derivatives;
		} else {
			derivatives = [
				{
					src: info.url,
					type: info.mime,
					width: String(info.width),
					height: String(info.height),
				},
			];
			dataFromTMH = false;
		}

		derivatives.forEach(function(o) {
			const source = doc.createElement('source');
			source.setAttribute('src', o.src + frag);
			source.setAttribute('type', o.type);
			const fromFile = o.transcodekey !== undefined ? '' : '-file';
			if (hasDimension) {
				source.setAttribute('data' + fromFile + '-width', o.width);
				source.setAttribute('data' + fromFile + '-height', o.height);
			}
			if (dataFromTMH) {
				source.setAttribute('data-title', o.title);
				source.setAttribute('data-shorttitle', o.shorttitle);
			}
			elt.appendChild(source);
		});
	}

	/**
	 * @param {Node} elt
	 * @param {Object} info
	 */
	static addTracks(elt, info) {
		const doc = elt.ownerDocument;
		let timedtext;
		if (info.thumbdata && Array.isArray(info.thumbdata.timedtext)) {
			// BatchAPI's `getAPIData`
			timedtext = info.thumbdata.timedtext;
		} else if (Array.isArray(info.timedtext)) {
			// "videoinfo" prop
			timedtext = info.timedtext;
		} else {
			timedtext = [];
		}
		timedtext.forEach(function(o) {
			const track = doc.createElement('track');
			track.setAttribute('kind', o.kind || '');
			track.setAttribute('type', o.type || '');
			track.setAttribute('src', o.src || '');
			track.setAttribute('srclang', o.srclang || '');
			track.setAttribute('label', o.label || '');
			// FIXME: Looks like in some cases this value is undefined
			track.setAttribute('data-mwtitle', o.title || '');
			track.setAttribute('data-dir', o.dir || '');
			elt.appendChild(track);
		});
	}

	/**
	 * Abstract way to get the path for an image given an info object.
	 *
	 * @private
	 * @param {Object} info
	 * @param {string|null} info.thumburl The URL for a thumbnail.
	 * @param {string} info.url The base URL for the image.
	 * @return {string}
	 */
	static getPath(info) {
		let path = '';
		if (info.thumburl) {
			path = info.thumburl;
		} else if (info.url) {
			path = info.url;
		}
		return path;
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} info
	 * @param {Object|null} manualinfo
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	static handleAudio(env, container, attrs, info, manualinfo, dataMw) {
		const doc = container.ownerDocument;
		const audio = doc.createElement('audio');

		audio.setAttribute('controls', '');
		audio.setAttribute('preload', 'none');

		const size = AddMediaInfo.handleSize(env, attrs, info);
		DOMDataUtils.addNormalizedAttribute(audio, 'height', String(size.height), null, true);
		DOMDataUtils.addNormalizedAttribute(audio, 'width', String(size.width), null, true);

		// Hardcoded until defined heights are respected.
		// See `AddMediaInfo.handleSize`
		container.classList.add('mw-default-audio-height');

		AddMediaInfo.copyOverAttribute(audio, container, 'resource');

		if (container.firstChild.firstChild.hasAttribute('lang')) {
			AddMediaInfo.copyOverAttribute(audio, container, 'lang');
		}

		AddMediaInfo.addSources(audio, info, attrs, dataMw, false);
		AddMediaInfo.addTracks(audio, info);

		return { rdfaType: 'mw:Audio', elt: audio };
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} info
	 * @param {Object|null} manualinfo
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	static handleVideo(env, container, attrs, info, manualinfo, dataMw) {
		const doc = container.ownerDocument;
		const video = doc.createElement('video');

		if (manualinfo || info.thumburl) {
			video.setAttribute('poster', AddMediaInfo.getPath(manualinfo || info));
		}

		video.setAttribute('controls', '');
		video.setAttribute('preload', 'none');

		const size = AddMediaInfo.handleSize(env, attrs, info);
		DOMDataUtils.addNormalizedAttribute(video, 'height', String(size.height), null, true);
		DOMDataUtils.addNormalizedAttribute(video, 'width', String(size.width), null, true);

		AddMediaInfo.copyOverAttribute(video, container, 'resource');

		if (container.firstChild.firstChild.hasAttribute('lang')) {
			AddMediaInfo.copyOverAttribute(video, container, 'lang');
		}

		AddMediaInfo.addSources(video, info, attrs, dataMw, true);
		AddMediaInfo.addTracks(video, info);

		return { rdfaType: 'mw:Video', elt: video };
	}

	/**
	 * Set up the actual image structure, attributes, etc.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} info
	 * @param {Object|null} manualinfo
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	static handleImage(env, container, attrs, info, manualinfo, dataMw) {
		const doc = container.ownerDocument;
		const img = doc.createElement('img');

		AddMediaInfo.addAttributeFromDateMw(img, dataMw, 'alt');

		if (manualinfo) { info = manualinfo; }

		AddMediaInfo.copyOverAttribute(img, container, 'resource');

		img.setAttribute('src', AddMediaInfo.getPath(info));

		if (container.firstChild.firstChild.hasAttribute('lang')) {
			AddMediaInfo.copyOverAttribute(img, container, 'lang');
		}

		// Add (read-only) information about original file size (T64881)
		img.setAttribute('data-file-width', String(info.width));
		img.setAttribute('data-file-height', String(info.height));
		img.setAttribute('data-file-type', info.mediatype && info.mediatype.toLowerCase());

		const size = AddMediaInfo.handleSize(env, attrs, info);
		DOMDataUtils.addNormalizedAttribute(img, 'height', String(size.height), null, true);
		DOMDataUtils.addNormalizedAttribute(img, 'width', String(size.width), null, true);

		// Handle "responsive" images, i.e. srcset
		if (info.responsiveUrls) {
			const candidates = [];
			Object.keys(info.responsiveUrls).forEach(function(density) {
				candidates.push(
					info.responsiveUrls[density] + ' ' + density + 'x');
			});
			if (candidates.length > 0) {
				img.setAttribute('srcset', candidates.join(', '));
			}
		}

		return { rdfaType: 'mw:Image', elt: img };
	}

	/**
	 * FIXME: this is more complicated than it ought to be because
	 * we're trying to handle more than one different data format:
	 * batching returns one, videoinfo returns another, imageinfo
	 * returns a third.  We should fix this!  If we need to do
	 * conversions, they should probably live inside Batcher, since
	 * all of these results ultimately come from the Batcher.imageinfo
	 * method (no one calls ImageInfoRequest directly any more).
	 *
	 * @param {MWParserEnvironment} env
	 * @param {string} key
	 * @param {Object} data
	 * @return {Object}
	 */
	static extractInfo(env, key, data) {
		if (env.conf.parsoid.useBatchAPI) {
			return this.stripProtoFromInfo(data.batchResponse);
		} else {
			const ns = data.imgns;
			// `useVideoInfo` is for legacy requests; batching returns thumbdata.
			const prop = env.conf.wiki.useVideoInfo ? 'videoinfo' : 'imageinfo';
			// title is guaranteed to be not null here
			const image = data.pages[ns + ':' + key];
			if (!image || !image[prop] || !image[prop][0] ||
					// Fallback to adding mw:Error
					(image.missing !== undefined && image.known === undefined)) {
				return null;
			} else {
				return this.stripProtoFromInfo(image[prop][0]);
			}
		}
	}

	/** Core's API requests call wfExpandUrl to add a protocol, even to
	 *  URLs which should be protocol-relative.  Strip the protocol off
	 *  to make everything protocol-relative, so we're consistent and
	 *  don't inadvertently reflect the protocol used for the API request.
	 */
	static stripProtoFromInfo(data) {
		const stripProto = function(obj, key) {
			if (obj && obj[key]) {
				obj[key] = obj[key].replace(/^https?:/, '');
			}
		};
		stripProto(data, 'url');
		stripProto(data, 'thumburl');
		stripProto(data, 'descriptionurl');
		if (data && data.responsiveUrls) {
			Object.keys(data.responsiveUrls).forEach((density) => {
				stripProto(data.responsiveUrls, density);
			});
		}
		if (data && data.thumbdata && Array.isArray(data.thumbdata.derivatives)) {
			// Batch API
			data.thumbdata.derivatives.forEach((deriv) => {
				stripProto(deriv, 'src');
			});
		}
		if (data && Array.isArray(data.derivatives)) {
			// Regular imageinfo API
			data.derivatives.forEach((deriv) => {
				stripProto(deriv, 'src');
			});
		}
		if (data && data.thumbdata && Array.isArray(data.thumbdata.timedtext)) {
			// Batch API
			data.thumbdata.timedtext.forEach((text) => {
				stripProto(text, 'src');
			});
		}
		if (data && Array.isArray(data.timedtext)) {
			// Regular imageinfo API
			data.timedtext.forEach((text) => {
				stripProto(text, 'src');
			});
		}
		return data;
	}

	/**
	 * Use sane defaults
	 *
	 * @param {MWParserEnvironment} env
	 * @param {string} key
	 * @param {Object} dims
	 * @return {Object}
	 */
	static errorInfo(env, key, dims) {
		const widthOption = env.conf.wiki.widthOption;
		return {
			url: `./Special:FilePath/${Sanitizer.sanitizeTitleURI(key, false)}`,
			// Preserve width and height from the wikitext options
			// even if the image is non-existent.
			width: dims.width || widthOption,
			height: dims.height || dims.width || widthOption,
		};
	}

	/**
	 * @param {string} key
	 * @param {string} message
	 * @param {Object} [params]
	 * @return {Object}
	 */
	static makeErr(key, message, params) {
		const e = { key: key, message: message };
		// Additional error info for clients that could fix the error.
		if (params !== undefined) { e.params = params; }
		return e;
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {string} key
	 * @param {Object} dims
	 * @return {Object}
	 */
	static *requestInfo(env, key, dims) {
		let err = null;
		let info = null;
		try {
			const data = yield env.batcher.imageinfo(key, dims);
			info = AddMediaInfo.extractInfo(env, key, data);
			if (!info) {
				info = AddMediaInfo.errorInfo(env, key, dims);
				err = AddMediaInfo.makeErr('apierror-filedoesnotexist', 'This image does not exist.');
			} else if (info.hasOwnProperty('thumberror')) {
				err = AddMediaInfo.makeErr('apierror-unknownerror', info.thumberror);
			}
		} catch (e) {
			info = AddMediaInfo.errorInfo(env, key, dims);
			err = AddMediaInfo.makeErr('apierror-unknownerror', e);
		}
		return { err, info };
	}

	/**
	 * @param {Node} container
	 * @param {Array} errs
	 * @param {Object} dataMw
	 */
	static addErrors(container, errs, dataMw) {
		if (!DOMUtils.hasTypeOf(container, 'mw:Error')) {
			let typeOf = container.getAttribute('typeof') || '';
			typeOf = `mw:Error${typeOf.length ? ' ' : ''}${typeOf}`;
			container.setAttribute('typeof', typeOf);
		}
		if (Array.isArray(dataMw.errors)) {
			errs = dataMw.errors.concat(errs);
		}
		dataMw.errors = errs;
	}

	/**
	 * @param {Node} elt
	 * @param {Node} container
	 * @param {string} attribute
	 */
	static copyOverAttribute(elt, container, attribute) {
		const span = container.firstChild.firstChild;
		DOMDataUtils.addNormalizedAttribute(
			elt, attribute, span.getAttribute(attribute),
			WTSUtils.getAttributeShadowInfo(span, attribute).value
		);
	}

	/**
	 * If this is a manual thumbnail, fetch the info for that as well
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Object} attrs
	 * @param {Object} dims
	 * @param {Object} dataMw
	 * @return {Object}
	 */
	static *manualInfo(env, attrs, dims, dataMw) {
		const attr = WTSUtils.getAttrFromDataMw(dataMw, 'manualthumb', true);
		if (attr === null) { return { err: null, info: null }; }

		const val = attr[1].txt;
		const title = env.makeTitleFromText(val, attrs.title.getNamespace(), true);
		if (title === null) {
			return {
				info: AddMediaInfo.errorInfo(env, /* That right? */ attrs.title.getKey(), dims),
				err: AddMediaInfo.makeErr('apierror-invalidtitle', 'Invalid thumbnail title.', { name: val }),
			};
		}

		return yield AddMediaInfo.requestInfo(env, title.getKey(), dims);
	}

	/**
	 * @param {Node} elt
	 * @param {Object} dataMw
	 * @param {string} key
	 */
	static addAttributeFromDateMw(elt, dataMw, key) {
		const attr = WTSUtils.getAttrFromDataMw(dataMw, key, false);
		if (attr === null) { return; }

		elt.setAttribute(key, attr[1].txt);
	}

	/**
	 * @param {MWParserEnvironment} env
	 * @param {Object} urlParser
	 * @param {Node} container
	 * @param {Object} attrs
	 * @param {Object} dataMw
	 * @param {boolean} isImage
	 */
	static handleLink(env, urlParser, container, attrs, dataMw, isImage) {
		const doc = container.ownerDocument;
		const attr = WTSUtils.getAttrFromDataMw(dataMw, 'link', true);

		let anchor = doc.createElement('a');
		if (isImage) {
			if (attr !== null) {
				let discard = true;
				const val = attr[1].txt;
				if (val === '') {
					// No href if link= was specified
					anchor = doc.createElement('span');
				} else if (urlParser.tokenizesAsURL(val)) {
					// an external link!
					anchor.setAttribute('href', val);
				} else {
					const link = env.makeTitleFromText(val, undefined, true);
					if (link !== null) {
						anchor.setAttribute('href', env.makeLink(link));
					} else {
						// Treat same as if link weren't present
						anchor.setAttribute('href', env.makeLink(attrs.title));
						// but preserve for roundtripping
						discard = false;
					}
				}
				if (discard) {
					WTSUtils.getAttrFromDataMw(dataMw, 'link', /* keep */ false);
				}
			} else {
				anchor.setAttribute('href', env.makeLink(attrs.title));
			}
		} else {
			anchor = doc.createElement('span');
		}

		if (anchor.nodeName === 'A') {
			const href = Sanitizer.cleanUrl(env, anchor.getAttribute('href'), 'external');
			anchor.setAttribute('href', href);
		}

		container.replaceChild(anchor, container.firstChild);
	}

	/**
	 * @param {Node} rootNode
	 * @param {MWParserEnvironment} env
	 * @param {Object} options
	 */
	static *addMediaInfo(rootNode, env, options) {
		const urlParser = new PegTokenizer(env);
		const doc = rootNode.ownerDocument;
		let containers = Array.from(doc.querySelectorAll('figure,figure-inline'));

		// Try to ensure `addMediaInfo` is idempotent based on finding the
		// structure unaltered from the emitted tokens.  Note that we may hit
		// false positivies in link-in-link scenarios but, in those cases, link
		// content would already have been processed to dom in a subpipeline
		// and would necessitate filtering here anyways.
		containers = containers.filter((c) => {
			return c.firstChild && c.firstChild.nodeName === 'A' &&
				c.firstChild.firstChild && c.firstChild.firstChild.nodeName === 'SPAN' &&
				// The media element may remain a <span> if we hit an error
				// below so use the annotation as another indicator of having
				// already been processed.
				!DOMUtils.hasTypeOf(c, 'mw:Error');
		});

		yield Promise.map(containers, Promise.async(function *(container) {
			const dataMw = DOMDataUtils.getDataMw(container);
			const span = container.firstChild.firstChild;
			const attrs = {
				size: {
					width: span.hasAttribute('data-width') ? Number(span.getAttribute('data-width')) : null,
					height: span.hasAttribute('data-height') ? Number(span.getAttribute('data-height')) : null,
				},
				format: WTSUtils.getMediaType(container).format,
				title: env.makeTitleFromText(span.textContent),
			};

			const ret = { container, dataMw, attrs, i: null, m: null };

			if (!env.conf.parsoid.fetchImageInfo) {
				ret.i = { err: AddMediaInfo.makeErr('apierror-unknownerror', 'Fetch of image info disabled.') };
				return ret;
			}

			const dims = Object.assign({}, attrs.size);

			const page = WTSUtils.getAttrFromDataMw(dataMw, 'page', true);
			if (page && dims.width !== null) {
				dims.page = page[1].txt;
			}

			// "starttime" should be used if "thumbtime" isn't present,
			// but only for rendering.
			const thumbtime = WTSUtils.getAttrFromDataMw(dataMw, 'thumbtime', true);
			const starttime = WTSUtils.getAttrFromDataMw(dataMw, 'starttime', true);
			if (thumbtime || starttime) {
				let seek = thumbtime ? thumbtime[1].txt : starttime[1].txt;
				seek = AddMediaInfo.parseTimeString(seek);
				if (seek !== false) {
					dims.seek = seek;
				}
			}

			ret.i = yield AddMediaInfo.requestInfo(env, attrs.title.getKey(), dims);
			ret.m = yield AddMediaInfo.manualInfo(env, attrs, dims, dataMw);
			return ret;
		}))
		.reduce((_, ret) => {
			const { container, dataMw, attrs, i, m } = ret;
			const errs = [];

			if (i.err !== null) { errs.push(i.err); }
			if (m.err !== null) { errs.push(m.err); }

			// Add mw:Error to the RDFa type.
			if (errs.length > 0) {
				AddMediaInfo.addErrors(container, errs, dataMw);
				return _;
			}

			const { info } = i;
			const { info: manualinfo } = m;

			// T110692: The batching API seems to return these as strings.
			// Till that is fixed, let us make sure these are numbers.
			// (This was fixed in Sep 2015, FWIW.)
			info.height = Number(info.height);
			info.width = Number(info.width);

			let o;
			let isImage = false;
			switch (info.mediatype) {
				case 'AUDIO':
					o = AddMediaInfo.handleAudio(env, container, attrs, info, manualinfo, dataMw);
					break;
				case 'VIDEO':
					o = AddMediaInfo.handleVideo(env, container, attrs, info, manualinfo, dataMw);
					break;
				default:
					isImage = true;
					o = AddMediaInfo.handleImage(env, container, attrs, info, manualinfo, dataMw);
			}
			const { rdfaType, elt } = o;

			AddMediaInfo.handleLink(env, urlParser, container, attrs, dataMw, isImage);

			const anchor = container.firstChild;
			anchor.appendChild(elt);

			let typeOf = container.getAttribute('typeof') || '';
			typeOf = typeOf.replace(/\bmw:(Image)(\/\w*)?\b/, `${rdfaType}$2`);
			container.setAttribute('typeof', typeOf);

			if (Array.isArray(dataMw.attribs) && dataMw.attribs.length === 0) {
				delete dataMw.attribs;
			}

			return _;
		}, null);
	}

	run(...args) {
		return AddMediaInfo.addMediaInfo(...args);
	}
}

// This pattern is used elsewhere
['addMediaInfo', 'requestInfo', 'manualInfo'].forEach((f) => {
	AddMediaInfo[f] = Promise.async(AddMediaInfo[f]);
});

module.exports.AddMediaInfo = AddMediaInfo;
