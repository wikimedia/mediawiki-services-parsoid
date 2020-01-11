/** @module */

'use strict';

var ParsoidExtApi = module.parent.parent.require('./extapi.js').versionCheck('^0.11.0');
const { DOMDataUtils, DOMUtils, JSUtils, Util } = ParsoidExtApi;

/**
 * @class
 */
class Traditional {
	constructor() {
		this.mode = 'traditional';
		this.scale = 1;
		this.padding = { thumb: 30, box: 5, border: 8 };
	}

	MODE() { return this.mode; }
	SCALE() { return this.scale; }
	PADDING() { return this.padding; }

	appendAttr(ul, k, v) {
		var val = ul.getAttribute(k) || '';
		if (val) { val += ' '; }
		ul.setAttribute(k, val + v);
	}

	ul(opts, doc) {
		var ul = doc.createElement('ul');
		var cl = 'gallery mw-gallery-' + this.MODE();
		ul.setAttribute('class', cl);
		Object.keys(opts.attrs).forEach((k) => {
			this.appendAttr(ul, k, opts.attrs[k]);
		});
		doc.body.appendChild(ul);
		this.perRow(opts, ul);
		this.setAdditionalOptions(opts, ul);
		return ul;
	}

	perRow(opts, ul) {
		if (opts.imagesPerRow > 0) {
			var padding = this.PADDING();
			var total = opts.imageWidth + padding.thumb + padding.box + padding.border;
			total *= opts.imagesPerRow;
			this.appendAttr(ul, 'style', [
				'max-width: ' + total + 'px;',
				'_width: ' + total + 'px;',
			].join(' '));
		}
	}

	setAdditionalOptions(opts, ul) {}

	caption(opts, doc, ul, caption) {
		var li = doc.createElement('li');
		li.setAttribute('class', 'gallerycaption');
		DOMUtils.migrateChildrenBetweenDocs(caption, li);
		li.setAttribute('data-parsoid', caption.getAttribute('data-parsoid'));
		// The data-mw attribute *shouldn't* exist, since this caption
		// should be a <body>.  But let's be safe and copy it anyway.
		li.setAttribute('data-mw', caption.getAttribute('data-mw'));
		ul.appendChild(doc.createTextNode('\n'));
		ul.appendChild(li);
	}

	dimensions(opts) {
		return `${opts.imageWidth}x${opts.imageHeight}px`;
	}

	scaleMedia(opts, wrapper) {
		return opts.imageWidth;
	}

	thumbWidth(width) {
		return width + this.PADDING().thumb;
	}

	thumbHeight(height) {
		return height + this.PADDING().thumb;
	}

	thumbStyle(width, height) {
		var style = [`width: ${this.thumbWidth(width)}px;`];
		if (this.MODE() === 'traditional') {
			style.push(`height: ${this.thumbHeight(height)}px;`);
		}
		return style.join(' ');
	}

	boxWidth(width) {
		return this.thumbWidth(width) + this.PADDING().box;
	}

	boxStyle(width, height) {
		return `width: ${this.boxWidth(width)}px;`;
	}

	galleryText(doc, box, gallerytext, width) {
		var div = doc.createElement('div');
		div.setAttribute('class', 'gallerytext');
		if (gallerytext) {
			DOMUtils.migrateChildrenBetweenDocs(gallerytext, div);
			div.setAttribute('data-parsoid', gallerytext.getAttribute('data-parsoid'));
			// The data-mw attribute *shouldn't* exist, since this gallerytext
			// should be a <figcaption>.  But let's be safe and copy it anyway.
			div.setAttribute('data-mw', gallerytext.getAttribute('data-mw'));
		}
		box.appendChild(div);
	}

	line(opts, doc, ul, o) {
		var width = this.scaleMedia(opts, o.thumb);
		var height = opts.imageHeight;

		var box = doc.createElement('li');
		box.setAttribute('class', 'gallerybox');
		box.setAttribute('style', this.boxStyle(width, height));

		var thumb = doc.createElement('div');
		thumb.setAttribute('class', 'thumb');
		thumb.setAttribute('style', this.thumbStyle(width, height));

		var wrapper = doc.createElement('figure-inline');
		wrapper.setAttribute('typeof', o.rdfaType);
		DOMDataUtils.setDataParsoid(wrapper, Util.clone(DOMDataUtils.getDataParsoid(o.thumb)));
		DOMDataUtils.setDataMw(wrapper, Util.clone(DOMDataUtils.getDataMw(o.thumb)));
		// Store temporarily, otherwise these get clobbered after rendering by
		// the call to `DOMDataUtils.visitAndLoadDataAttribs()` in `toDOM`.
		DOMDataUtils.storeDataAttribs(wrapper);
		DOMUtils.migrateChildrenBetweenDocs(o.thumb, wrapper);
		thumb.appendChild(wrapper);

		box.appendChild(thumb);
		this.galleryText(doc, box, o.gallerytext, width);
		ul.appendChild(doc.createTextNode('\n'));
		ul.appendChild(box);
	}

	render(env, opts, caption, lines) {
		var doc = env.createDocument();
		var ul = this.ul(opts, doc);
		if (caption) {
			this.caption(opts, doc, ul, caption);
		}
		lines.forEach(l => this.line(opts, doc, ul, l));
		ul.appendChild(doc.createTextNode('\n'));
		return doc;
	}
}

/**
 * @class
 * @extends ~Traditional
 */
class NoLines extends Traditional {
	constructor() {
		super();
		this.mode = 'nolines';
		this.padding = { thumb: 0, box: 5, border: 4 };
	}
}

/**
 * @class
 * @extends ~Traditional
 */
class Slideshow extends Traditional {
	constructor() {
		super();
		this.mode = 'slideshow';
	}
	setAdditionalOptions(opts, ul) {
		ul.setAttribute('data-showthumbnails', opts.showthumbnails ? "1" : "");
	}
	perRow() {}
}

/**
 * @class
 * @extends ~Traditional
 */
class Packed extends Traditional {
	constructor() {
		super();
		this.mode = 'packed';
		this.scale = 1.5;
		this.padding = { thumb: 0, box: 2, border: 8 };
	}

	perRow() {}

	dimensions(opts) {
		return `x${Math.ceil(opts.imageHeight * this.SCALE())}px`;
	}

	scaleMedia(opts, wrapper) {
		var elt = wrapper.firstChild.firstChild;
		var width = parseInt(elt.getAttribute('width'), 10);
		if (Number.isNaN(width)) {
			width = opts.imageWidth;
		} else {
			width /= this.SCALE();
		}
		elt.setAttribute('width', Math.ceil(width));
		elt.setAttribute('height', opts.imageHeight);
		return width;
	}

	galleryText(doc, box, gallerytext, width) {
		if (!/packed-(hover|overlay)/.test(this.MODE())) {
			Traditional.prototype.galleryText.call(this, doc, box, gallerytext, width);
			return;
		}
		if (!gallerytext) {
			return;
		}
		var div = doc.createElement('div');
		div.setAttribute('class', 'gallerytext');
		DOMUtils.migrateChildrenBetweenDocs(gallerytext, div);
		div.setAttribute('data-parsoid', gallerytext.getAttribute('data-parsoid'));
		// The data-mw attribute *shouldn't* exist, since this gallerytext
		// should be a <figcaption>.  But let's be safe and copy it anyway.
		div.setAttribute('data-mw', gallerytext.getAttribute('data-mw'));
		var wrapper = doc.createElement('div');
		wrapper.setAttribute('class', 'gallerytextwrapper');
		wrapper.setAttribute('style', `width: ${Math.ceil(width - 20)}px;`);
		wrapper.appendChild(div);
		box.appendChild(wrapper);
	}
}

/**
 * @class
 * @extends ~Packed
 */
class PackedHover extends Packed {
	constructor() {
		super();
		this.mode = 'packed-hover';
	}
}

/**
 * @class
 * @extends ~Packed
 */
class PackedOverlay extends Packed {
	constructor() {
		super();
		this.mode = 'packed-overlay';
	}
}

/** @namespace */
var modes = JSUtils.mapObject({
	traditional: new Traditional(),
	nolines: new NoLines(),
	slideshow: new Slideshow(),
	packed: new Packed(),
	'packed-hover': new PackedHover(),
	'packed-overlay': new PackedOverlay(),
});

if (typeof module === 'object') {
	module.exports = modes;
}
