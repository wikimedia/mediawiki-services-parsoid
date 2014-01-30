/**
 * Stand-alone XMLSerializer for DOM3 documents
 */
"use strict";

var htmlns = 'http://www.w3.org/1999/xhtml',
	// nodeType constants
	ELEMENT_NODE = 1,
	ATTRIBUTE_NODE = 2,
	TEXT_NODE = 3,
	CDATA_SECTION_NODE = 4,
	ENTITY_REFERENCE_NODE = 5,
	ENTITY_NODE = 6,
	PROCESSING_INSTRUCTION_NODE = 7,
	COMMENT_NODE = 8,
	DOCUMENT_NODE = 9,
	DOCUMENT_TYPE_NODE = 10,
	DOCUMENT_FRAGMENT_NODE = 11,
	NOTATION_NODE = 12;

/**
 * HTML5 void elements
 */
var emptyElements = {
  area: true,
  base: true,
  basefont: true,
  bgsound: true,
  br: true,
  col: true,
  command: true,
  embed: true,
  frame: true,
  hr: true,
  img: true,
  input: true,
  keygen: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true
};

/**
 * HTML5 elements with raw (unescaped) content
 */
var hasRawContent = {
  style: true,
  script: true,
  xmp: true,
  iframe: true,
  noembed: true,
  noframes: true,
  plaintext: true,
  noscript: true
};

/**
 * Use only very few entities, encode everything else as numeric entity
 */
function _xmlEncoder(c){
	switch(c) {
		case '<': return '&lt;';
		case '>': return '&gt;';
		case '&': return '&amp;';
		case '"': return '&quot;';
		default: return '&#' + c.charCodeAt() + ';';
	}
}

function serializeToString(node, options, cb){
	var child;
	switch(node.nodeType){
	case ELEMENT_NODE:
		child = node.firstChild;
		var attrs = node.attributes;
		var len = attrs.length;
		var nodeName = node.tagName.toLowerCase(),
			localName = node.localName;
		cb('<' + localName);
		for(var i=0;i<len;i++){
			var attr = attrs.item(i),
				singleQuotes, doubleQuotes,
				useSingleQuotes = false;
			if (options.smartQuote &&
					// More double quotes than single quotes in value?
					(attr.value.match(/"/g) || []).length >
					(attr.value.match(/'/g) || []).length)
			{
				// use single quotes
				cb(' ' + attr.name + "='"
						+ attr.value.replace(/[<&']/g, _xmlEncoder) + "'");
			} else {
				// use double quotes
				cb(' ' + attr.name + '="'
						+ attr.value.replace(/[<&"]/g, _xmlEncoder) + '"');
			}
		}
		if(child || !emptyElements[nodeName]) {
			cb('>');
			// if is cdata child node
			if(hasRawContent[nodeName]) {
				// TODO: perform context-sensitive escaping?
				// Currently this content is not normally part of our DOM, so
				// no problem. If it was, we'd probably have to do some
				// tag-specific escaping. Examples:
				// * < to \u003c in <script>
				// * < to \3c in <style>
				// ...
				if(child){
					cb(child.data);
				}
			} else {
				while(child) {
					serializeToString(child, options, cb);
					child = child.nextSibling;
				}
			}
			cb('</' + localName + '>');
		}else{
			cb('/>');
		}
		return;
	case DOCUMENT_NODE:
	case DOCUMENT_FRAGMENT_NODE:
		child = node.firstChild;
		while(child){
			serializeToString(child, options, cb);
			child = child.nextSibling;
		}
		return;
	case TEXT_NODE:
		return cb(node.data.replace(/[<&]/g, _xmlEncoder));
	case COMMENT_NODE:
		return cb( "<!--" + node.data.replace(/-->/g, '--&gt;') + "-->");
	default:
		cb('??' + node.nodeName);
	}
}

function XMLSerializer(){}
XMLSerializer.prototype.serializeToString = function(node, options){
	var buf = '',
		cb = function(bit) {
			buf += bit;
		};
	if (options.innerXML) {
		var children = node.childNodes;
		for (var i = 0; i < children.length; i++) {
			serializeToString(children[i], options, cb);
		}
	} else {
		serializeToString(node, options, cb);
	}
	return buf;
};


module.exports = XMLSerializer;
