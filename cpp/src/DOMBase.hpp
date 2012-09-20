/**
 * Abstract Document Object Model wrapper
 */

#include <boost/function.hpp>

namespace parsoid {



// Forward declarations
class XMLNodeIterator;
class XMLAttributeIterator;
class XMLAttribute;
class XMLTreeWalker;
class XMLNode;
class XMLText;
class XMLDocument;

/**
 * Callback receiving a DOMBase message
 *
 * FIXME: actually use a DOM type
 */
typedef boost::function<void(XMLDocument*)> DocumentReceiver;

// At the very minimum, we have to support the equivalent to the following
// libhubbub -> DOM callbacks:
// libhubbub cb     // DOMBase equivalent
// ---------------------------------------
// create_comment,  // XMLDocument()
// create_doctype,  // node.appendChild( XMLNodeType::Doctype )
// create_element,  // node.appendChild( XMLNodeType::Element )
// create_text,     // node.appendChild( XMLNodeType::Text )
// ref_node,        // ? probably not needed
// unref_node,      // ?
// append_child,    // node.appendChild
// insert_before,   // insertChildBefore
// remove_child,    // removeChild
// clone_node,      // copy constructor
// reparent_children, // wrapper around appendChild and iterator
// get_parent,      // parent()
// has_children,    // empty()
// form_associate,  // do nothing really (not needed)
// add_attributes,  // iterate with addAttribute()
// set_quirks_mode, // n/a and not needed
// change_encoding, // not needed, always utf8


// Tree node types
enum class XMLNodeType
{
    Null,		// Empty (null) node handle
    Document,		// A document tree's absolute root
    Element,		// Element tag, i.e. '<node/>'
    Pcdata,		// Plain character data, i.e. 'text'
    Cdata,		// Character data, i.e. '<![CDATA[text]]>'
    Comment,		// Comment tag, i.e. '<!-- text -->'
    Pi,			// Processing instruction, i.e. '<?name?>'
    Declaration,	// Document declaration, i.e. '<?xml version="1.0"?>'
    Doctype		// Document type declaration, i.e. '<!DOCTYPE doc>'
};


// Range-based for loop support
template <typename It> class XMLObjectRange
{
    public:
        typedef It const_iterator;

        XMLObjectRange(It b, It e): _begin(b), _end(e)
    {
    }

        It begin() const { return _begin; }
        It end() const { return _end; }

    private:
        It _begin, _end;
};



// A light-weight handle for manipulating attributes in DOM tree
class XMLAttribute
{

    public:
        // Default constructor. Constructs an empty attribute.
        XMLAttribute();

        // Safe C++11 bool conversion operator
        explicit operator bool() const;

        // Comparison operators (compares wrapped attribute pointers)
        bool operator==(const XMLAttribute& r) const;
        bool operator!=(const XMLAttribute& r) const;
        bool operator<(const XMLAttribute& r) const;
        bool operator>(const XMLAttribute& r) const;
        bool operator<=(const XMLAttribute& r) const;
        bool operator>=(const XMLAttribute& r) const;

        // Check if attribute is empty
        bool empty() const;

        // Get attribute name/value, or "" if attribute is empty
        const string& name() const;
        const string& value() const;

        // Get attribute value, or the empty string if attribute is empty
        explicit operator string() const;

        // Get attribute value as a number, or the default value if conversion did not succeed or attribute is empty
        int asInt(int def = 0) const;
        unsigned int asUint(unsigned int def = 0) const;
        double asDouble(double def = 0) const;
        float asFloat(float def = 0) const;

        // Get attribute value as bool (returns true if first character is in '1tTyY' set), or the default value if attribute is empty
        bool asBool(bool def = false) const;

        // Set attribute name/value (returns false if attribute is empty or there is not enough memory)
        bool setName(const string& rhs);
        bool setValue(const string& rhs);

        // Set attribute value with type conversion (numbers are converted to strings, boolean is converted to "true"/"false")
        bool setValue(int rhs);
        bool setValue(unsigned int rhs);
        bool setValue(double rhs);
        bool setValue(bool rhs);

        // Set attribute value (equivalent to set_value without error checking)
        XMLAttribute& operator=(const string& rhs);
        XMLAttribute& operator=(int rhs);
        XMLAttribute& operator=(unsigned int rhs);
        XMLAttribute& operator=(double rhs);
        XMLAttribute& operator=(bool rhs);

        // Get next/previous attribute in the attribute list of the parent node
        XMLAttribute nextAttribute() const;
        XMLAttribute previousAttribute() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const;
};

class XMLNode
{
        friend class XMLAttributeIterator;
        friend class XMLNodeIterator;
        friend class xml_named_nodeIterator;

    protected:
        // The root of the document tree
        XMLNode& _root;

    public:
        // Default constructor. Constructs an empty node.
        XMLNode();

        // Safe C++11 bool conversion operator
        explicit operator bool() const;

        // String conversion
        explicit operator string() const;

        // Comparison operators (compares wrapped node pointers)
        bool operator==(const XMLNode& r) const;
        bool operator!=(const XMLNode& r) const;
        bool operator<(const XMLNode& r) const;
        bool operator>(const XMLNode& r) const;
        bool operator<=(const XMLNode& r) const;
        bool operator>=(const XMLNode& r) const;

        // Check if node is empty.
        bool empty() const;

        // Get node name/value, or "" if node is empty or it has no name/value
        const string& name() const;
        const string& value() const;

        // Get attribute list
        XMLAttribute firstAttribute() const;
        XMLAttribute lastAttribute() const;

        // Get children list
        XMLNode firstChild() const;
        XMLNode lastChild() const;

        // Get next/previous sibling in the children list of the parent node
        XMLNode nextSibling() const;
        XMLNode previousSibling() const;

        // Get parent node
        XMLNode parent() const;

        // Get root of DOM tree this node belongs to
        XMLNode root() const;

        // Get text object for the current node
        XMLText text() const;

        // Get child, attribute or next/previous sibling with the specified name
        XMLNode child(const string& name) const;
        XMLAttribute attribute(const string& name) const;
        XMLNode nextSibling(const string& name) const;
        XMLNode previousSibling(const string& name) const;

        // Get child value of current node; that is, value of the first child node of type PCDATA/CDATA
        const string& childValue() const;

        // Get child value of child with specified name. Equivalent to child(name).child_value().
        const string& childValue(const string& name) const;

        // Set node name/value (returns false if node is empty, there is not enough memory, or node can not have name/value)
        bool setName(const string& rhs);
        bool setValue(const string& rhs);

        // Add attribute with specified name. Returns added attribute, or empty attribute on errors.
        XMLAttribute appendAttribute(const string& name);
        XMLAttribute prependAttribute(const string& name);
        XMLAttribute insertAttribute_after(const string& name, const XMLAttribute& attr);
        XMLAttribute insertAttribute_before(const string& name, const XMLAttribute& attr);

        // Add a copy of the specified attribute. Returns added attribute, or empty attribute on errors.
        XMLAttribute appendCopy(const XMLAttribute& proto);
        XMLAttribute prependCopy(const XMLAttribute& proto);
        XMLAttribute insertCopyAfter(const XMLAttribute& proto, const XMLAttribute& attr);
        XMLAttribute insertCopyBefore(const XMLAttribute& proto, const XMLAttribute& attr);

        // Add child node with specified type. Returns added node, or empty node on errors.
        XMLNode appendChild(XMLNodeType type = XMLNodeType::Element);
        XMLNode prependChild(XMLNodeType type = XMLNodeType::Element);
        XMLNode insertChildAfter(XMLNodeType type, const XMLNode& node);
        XMLNode insertChildBefore(XMLNodeType type, const XMLNode& node);

        // Add child element with specified name. Returns added node, or empty node on errors.
        XMLNode appendChild(const string& name);
        XMLNode prependChild(const string& name);
        XMLNode insertChildAfter(const string& name, const XMLNode& node);
        XMLNode insertChildBefore(const string& name, const XMLNode& node);

        // Move the specified node as a child. Returns the added node, or an
        // empty node on errors.
        XMLNode appendChild(const XMLNode& node);
        XMLNode prependChild(const XMLNode& node);
        XMLNode insertChildAfter(const XMLNode& node, const XMLNode& afterNode);
        XMLNode insertChildBefore(const XMLNode& node, const XMLNode& beforeNode);

        // Add a copy of the specified node as a child. Returns added node, or empty node on errors.
        XMLNode appendCopy(const XMLNode& proto);
        XMLNode prependCopy(const XMLNode& proto);
        XMLNode insertCopyAfter(const XMLNode& proto, const XMLNode& node);
        XMLNode insertCopyBefore(const XMLNode& proto, const XMLNode& node);

        // Remove specified attribute
        bool removeAttribute(const XMLAttribute& a);
        bool removeAttribute(const string& name);

        // Remove specified child
        bool removeChild(const XMLNode& n);
        bool removeChild(const string& name);


        // Search for a node by path consisting of node names and . or .. elements.
        //XMLNode first_element_by_path(const string& path, string delimiter = '/') const;


        // Child nodes iterators
        typedef XMLNodeIterator iterator;

        iterator begin() const;
        iterator end() const;

        // Attribute iterators
        typedef XMLAttributeIterator attributeIterator;

        attributeIterator attributesBegin() const;
        attributeIterator attributesEnd() const;

        // Range-based for support
        //XMLObjectRange<XMLNodeIterator> children() const;
        //XMLObjectRange<xml_named_nodeIterator> children(const string& name) const;
        //XMLObjectRange<XMLAttributeIterator> attributes() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const;
};

// Document class (DOM tree root)
class XMLDocument: public XMLNode
{
    private:
        // Non-copyable semantics
        XMLDocument(const XMLDocument&);
        const XMLDocument& operator=(const XMLDocument&);

    public:
        // Default constructor, makes empty document
        XMLDocument();

        // Destructor, invalidates all node/attribute handles to this document
        ~XMLDocument();

        // Removes all nodes, leaving the empty document
        void reset();

        // Removes all nodes, then copies the entire contents of the specified document
        void reset(const XMLDocument& proto);

        // Get document element
        XMLNode documentElement() const;

        // loading/saving left out for now
};

} // namespace parsoid
