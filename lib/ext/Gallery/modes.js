'use strict';

var coreutil = require('util');
var domino = require('domino');

var ParsoidExtApi = module.parent.parent.require('./extapi.js').versionCheck('^0.6.1');
var DU = ParsoidExtApi.DOMUtils;
var JSUtils = ParsoidExtApi.JSUtils;

var Traditional = function(options) {
	Object.assign(this, options);
};

Traditional.prototype.mode = 'traditional';
Traditional.prototype.scale = 1;
Traditional.prototype.padding = { thumb: 30, box: 5, border: 8 };

Traditional.prototype.ul = function(opts, doc) {
	var ul = doc.createElement('ul');
	var cl = 'gallery mw-gallery-' + opts.mode;
	if (opts.class) { cl += ' ' + opts.class; }
	ul.setAttribute('class', cl);
	doc.body.appendChild(ul);
	this.perRow(opts, ul);
	this.setAdditionalOptions(opts, ul);
	return ul;
};

Traditional.prototype.perRow = function(opts, ul) {
	if (opts.imagesPerRow > 0) {
		var padding = this.padding;
		var total = opts.imageWidth + padding.thumb + padding.box + padding.border;
		total *= opts.imagesPerRow;
		ul.setAttribute('style', [
			'max-width: ' + total + 'px;',
			'_width: ' + total + 'px;',
		].join(' '));
	}
};

Traditional.prototype.setAdditionalOptions = function(opts, ul) {};

Traditional.prototype.caption = function(opts, doc, ul, caption) {
	var li = doc.createElement('li');
	li.setAttribute('class', 'gallerycaption');
	DU.migrateChildrenBetweenDocs(caption, li);
	ul.appendChild(doc.createTextNode('\n'));
	ul.appendChild(li);
};

Traditional.prototype.verticalAlign = function(doc, thumb, wrapper) {
	if (this.mode !== 'traditional') { return; }
	// `helper` and `wrapper` are from http://stackoverflow.com/a/7310398
	// avoid the need to calculate paddings individually
	var helper = doc.createElement('span');
	helper.setAttribute('style', [
		'display: inline-block;',
		'height: 100%;',
		'vertical-align: middle;',
	].join(' '));
	thumb.appendChild(helper);
	wrapper.setAttribute('style', [
		'vertical-align: middle;',
		'display: inline-block;',
	].join(' '));
};

Traditional.prototype.dimensions = function(opts) {
	return coreutil.format('%dx%dpx', opts.imageWidth, opts.imageHeight);
};

Traditional.prototype.scaleImage = function(opts, wrapper) {
	return opts.imageWidth;
};

Traditional.prototype.thumbWidth = function(width) {
	return width + this.padding.thumb;
};

Traditional.prototype.thumbHeight = function(height) {
	return height + this.padding.thumb;
};

Traditional.prototype.thumbStyle = function(width, height) {
	var style = [coreutil.format('width: %dpx;', this.thumbWidth(width))];
	if (this.mode === 'traditional') {
		style.push(coreutil.format('height: %dpx;', this.thumbHeight(height)));
	}
	return style.join(' ');
};

Traditional.prototype.boxWidth = function(width) {
	return this.thumbWidth(width) + this.padding.box;
};

Traditional.prototype.boxStyle = function(width, height) {
	return coreutil.format('width: %dpx;', this.boxWidth(width));
};

Traditional.prototype.galleryText = function(doc, box, gallerytext, width) {
	var div = doc.createElement('div');
	div.setAttribute('class', 'gallerytext');
	if (gallerytext) {
		DU.migrateChildrenBetweenDocs(gallerytext, div);
	}
	box.appendChild(div);
};

Traditional.prototype.line = function(opts, doc, ul, o) {
	var width = this.scaleImage(opts, o.thumb);
	var height = opts.imageHeight;

	var box = doc.createElement('li');
	box.setAttribute('class', 'gallerybox');
	box.setAttribute('style', this.boxStyle(width, height));

	var thumb = doc.createElement('div');
	thumb.setAttribute('class', 'thumb');
	thumb.setAttribute('style', this.thumbStyle(width, height));

	var wrapper = doc.createElement('span');
	// Only place the attrs if we rendered an image.
	if (o.thumb.querySelector('img')) {
		wrapper.setAttribute('typeof', 'mw:Image');
	}
	DU.migrateChildrenBetweenDocs(o.thumb, wrapper);
	this.verticalAlign(doc, thumb, wrapper);
	thumb.appendChild(wrapper);

	box.appendChild(thumb);
	this.galleryText(doc, box, o.gallerytext, width);
	ul.appendChild(doc.createTextNode('\n'));
	ul.appendChild(box);
};

Traditional.prototype.render = function(opts, caption, lines) {
	var doc = domino.createDocument();
	var ul = this.ul(opts, doc);
	if (caption) {
		this.caption(opts, doc, ul, caption);
	}
	lines.forEach(this.line.bind(this, opts, doc, ul));
	ul.appendChild(doc.createTextNode('\n'));
	return doc;
};

var Packed = function(options) {
	Traditional.call(this, options);
};
coreutil.inherits(Packed, Traditional);

Packed.prototype.mode = 'packed';
Packed.prototype.scale = 1.5;
Packed.prototype.padding = { thumb: 0, box: 2, border: 8 };

Packed.prototype.perRow = function() {};

Packed.prototype.dimensions = function(opts) {
	return coreutil.format('x%dpx', Math.trunc(opts.imageHeight * this.scale));
};

Packed.prototype.scaleImage = function(opts, wrapper) {
	var img = wrapper.querySelector('img');
	if (img) {
		var width = parseInt(img.getAttribute('width'), 10);
		if (Number.isNaN(width)) {
			width = opts.imageWidth;
		} else {
			width = Math.trunc(width / this.scale);
		}
		img.setAttribute('width', width);
		img.setAttribute('height', opts.imageHeight);
		return width;
	} else {
		return opts.imageWidth;
	}
};

Packed.prototype.galleryText = function(doc, box, gallerytext, width) {
	if (!/packed-(hover|overlay)/.test(this.mode)) {
		Traditional.prototype.galleryText.call(this, doc, box, gallerytext);
		return;
	}
	if (!gallerytext) {
		return;
	}
	var div = doc.createElement('div');
	div.setAttribute('class', 'gallerytext');
	DU.migrateChildrenBetweenDocs(gallerytext, div);
	var wrapper = doc.createElement('div');
	wrapper.setAttribute('class', 'gallerytextwrapper');
	wrapper.setAttribute('style', coreutil.format('width: %dpx;', width - 20));
	wrapper.appendChild(div);
	box.appendChild(wrapper);
};

var Slideshow = function(options) {
	Traditional.call(this, options);
};
coreutil.inherits(Slideshow, Traditional);

Slideshow.prototype.setAdditionalOptions = function(opts, ul) {
	ul.setAttribute('data-showthumbnails', opts.showthumbnails ? "1" : "");
};

Slideshow.prototype.perRow = function() {};

var modes = JSUtils.mapObject({
	traditional: new Traditional({}),
	nolines: new Traditional({
		mode: 'nolines',
		padding: { thumb: 0, box: 5, border: 4 },
	}),
	slideshow: new Slideshow({ mode: 'slideshow' }),
	packed: new Packed({}),
	'packed-hover': new Packed({ mode: 'packed-hover' }),
	'packed-overlay': new Packed({ mode: 'packed-overlay' }),
});

if (typeof module === 'object') {
	module.exports = modes;
}
