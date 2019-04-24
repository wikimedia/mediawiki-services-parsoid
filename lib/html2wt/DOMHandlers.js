'use strict';

require('../../core-upgrade.js');

const { JSUtils } = require('../utils/jsutils.js');

const AHandler = require('./DOMHandlers/AHandler.js');
const BodyHandler = require('./DOMHandlers/BodyHandler.js');
const BRHandler = require('./DOMHandlers/BRHandler.js');
const CaptionHandler = require('./DOMHandlers/CaptionHandler.js');
const DDHandler = require('./DOMHandlers/DDHandler.js');
const DTHandler = require('./DOMHandlers/DTHandler.js');
const FigureHandler = require('./DOMHandlers/FigureHandler.js');
const HeadingHandler = require('./DOMHandlers/HeadingHandler.js');
const HRHandler = require('./DOMHandlers/HRHandler.js');
const HTMLPreHandler = require('./DOMHandlers/HTMLPreHandler.js');
const ImgHandler = require('./DOMHandlers/ImgHandler.js');
const JustChildrenHandler = require('./DOMHandlers/JustChildrenHandler.js');
const LIHandler = require('./DOMHandlers/LIHandler.js');
const LinkHandler = require('./DOMHandlers/LinkHandler.js');
const ListHandler = require('./DOMHandlers/ListHandler.js');
const MediaHandler = require('./DOMHandlers/MediaHandler.js');
const MetaHandler = require('./DOMHandlers/MetaHandler.js');
const PHandler = require('./DOMHandlers/PHandler.js');
const PreHandler = require('./DOMHandlers/PreHandler.js');
const SpanHandler = require('./DOMHandlers/SpanHandler.js');
const TableHandler = require('./DOMHandlers/TableHandler.js');
const TDHandler = require('./DOMHandlers/TDHandler.js');
const THHandler = require('./DOMHandlers/THHandler.js');
const TRHandler = require('./DOMHandlers/TRHandler.js');
const QuoteHandler = require('./DOMHandlers/QuoteHandler.js');

/**
 * A map of `domHandler`s keyed on nodeNames.
 *
 * Includes specialized keys of the form: `nodeName + '_' + dp.stx`
 * @namespace
 */
const tagHandlers = JSUtils.mapObject({
	// '#text': new Text(),  // Insert the text handler here too?
	a:  new AHandler(),
	audio: new MediaHandler(),
	b: new QuoteHandler("'''"),
	body: new BodyHandler(),
	br: new BRHandler(),
	caption: new CaptionHandler(),
	dd: new DDHandler(),  // multi-line dt/dd
	dd_row: new DDHandler('row'),  // single-line dt/dd
	dl: new ListHandler({ DT: 1, DD: 1 }),
	dt: new DTHandler(),
	figure: new FigureHandler(),
	'figure-inline': new MediaHandler(),
	hr: new HRHandler(),
	h1: new HeadingHandler("="),
	h2: new HeadingHandler("=="),
	h3: new HeadingHandler("==="),
	h4: new HeadingHandler("===="),
	h5: new HeadingHandler("====="),
	h6: new HeadingHandler("======"),
	i: new QuoteHandler("''"),
	img: new ImgHandler(),
	li: new LIHandler(),
	link:  new LinkHandler(),
	meta: new MetaHandler(),
	ol: new ListHandler({ LI: 1 }),
	p: new PHandler(),
	pre: new PreHandler(),  // Wikitext indent pre generated with leading space
	pre_html: new HTMLPreHandler(),  // HTML pre
	span: new SpanHandler(),
	table: new TableHandler(),
	tbody: new JustChildrenHandler(),
	td: new TDHandler(),
	tfoot: new JustChildrenHandler(),
	th: new THHandler(),
	thead: new JustChildrenHandler(),
	tr: new TRHandler(),
	ul: new ListHandler({ LI: 1 }),
	video: new MediaHandler(),
});

if (typeof module === "object") {
	module.exports.tagHandlers = tagHandlers;
}
