"use strict";
/** Thunk to upstream domino to fix some bugs not yet released upstream. */
var domino = require('domino');

// address domino gh #16 upstream
var Node = domino.impl.Node;
Node.prototype.ELEMENT_NODE                = Node.ELEMENT_NODE;
Node.prototype.ATTRIBUTE_NODE              = Node.ATTRIBUTE_NODE;
Node.prototype.TEXT_NODE                   = Node.TEXT_NODE;
Node.prototype.CDATA_SECTION_NODE          = Node.CDATA_SECTION_NODE;
Node.prototype.ENTITY_REFERENCE_NODE       = Node.ENTITY_REFERENCE_NODE;
Node.prototype.ENTITY_NODE                 = Node.ENTITY_NODE;
Node.prototype.PROCESSING_INSTRUCTION_NODE = Node.PROCESSING_INSTRUCTION_NODE;
Node.prototype.COMMENT_NODE                = Node.COMMENT_NODE;
Node.prototype.DOCUMENT_NODE               = Node.DOCUMENT_NODE;
Node.prototype.DOCUMENT_TYPE_NODE          = Node.DOCUMENT_TYPE_NODE;
Node.prototype.DOCUMENT_FRAGMENT_NODE      = Node.DOCUMENT_FRAGMENT_NODE;
Node.prototype.NOTATION_NODE               = Node.NOTATION_NODE;

// pull in outerHTML support from https://github.com/fgnass/domino/pull/18
var Document = domino.impl.Document;
if (!Object.getOwnPropertyDescriptor(Document.prototype, 'outerHTML')) {
    Object.defineProperty(Document.prototype, 'outerHTML',
                          { get: function() { return this.innerHTML; } });
}
if (!Object.getOwnPropertyDescriptor(Node.prototype, 'outerHTML')) {
    Object.defineProperty(Node.prototype, 'outerHTML', { get: function() {
        // "the attribute must return the result of running the HTML fragment
        // serialization algorithm on a fictional node whose only child is
        // the context object"
        var fictional = {
            childNodes: [ this ],
            nodeType: 0
        };
        return this.serialize.call(fictional);
    }});
}

// address domino gh #18 upstream
var hasBrokenSerialize = function() {
    var doc = domino.createDocument();
    var p = doc.createElement('p');
    p.innerHTML = '<pre>a</pre>';
    return (p.innerHTML !== '<pre>a</pre>');
};
if (hasBrokenSerialize()) {
    // Monkey-patch Node.prototype.serialize()
    var old_serialize = Node.prototype.serialize;
    var new_serialize = function() {
        var s = old_serialize.call(this);
        // remove extra newline after <pre>/<textarea>/<listing>
        s = s.replace(/(<(?:pre|textarea|listing)(?:\s+[^\s"'>\/=]+(?:\s*=\s*"[^"]*")?)*\s*>)\n([^\n])/g,
                  '$1$2');
        return s;
    };
    // unfortunately Node.prototype.serialize is non-writable, so we have to
    // do things the hard way:
    Node.prototype = Object.create(Node.prototype);
    // add 'serialize' to all subclasses of Node...
    ["Node", "Document", "DocumentFragment", "Element"].forEach(function(cls) {
        domino.impl[cls].prototype.serialize = new_serialize;
    });
    // ...including "Leaf", which isn't explicitly exported
    var Leaf_proto = Object.getPrototypeOf(domino.impl.DocumentType.prototype);
    Leaf_proto.serialize = new_serialize;
    console.assert(!hasBrokenSerialize());
}

module.exports = domino;
