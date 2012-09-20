/**
 * Abstract Document Object Model wrapper
 */

#include <boost/function.hpp>

namespace parsoid {

/**
 * Callback receiving a DOMBase message
 *
 * FIXME: actually use a DOM type
 */
typedef boost::function<void(string)> DocumentReceiver;

class XMLNodeIterator;
class XMLAttributeIterator;
class XMLAttribute;
class XMLTreeWalker;
class XMLNode;
class XMLText;

// libhubbub interface:
// create_comment,
// create_doctype,
// create_element,
// create_text,
// ref_node,
// unref_node,
// append_child,
// insert_before,
// remove_child,
// clone_node,
// reparent_children,
// get_parent,
// has_children,
// form_associate,
// add_attributes,
// set_quirks_mode,
// change_encoding,


// Tree node types
enum class XMLNodeType
{
    node_null,			// Empty (null) node handle
    node_document,		// A document tree's absolute root
    node_element,		// Element tag, i.e. '<node/>'
    node_pcdata,		// Plain character data, i.e. 'text'
    node_cdata,			// Character data, i.e. '<![CDATA[text]]>'
    node_comment,		// Comment tag, i.e. '<!-- text -->'
    node_pi,			// Processing instruction, i.e. '<?name?>'
    node_declaration,	// Document declaration, i.e. '<?xml version="1.0"?>'
    node_doctype		// Document type declaration, i.e. '<!DOCTYPE doc>'
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
        XMLNode appendChild(XMLNodeType type = XMLNodeType::node_element);
        XMLNode prependChild(XMLNodeType type = XMLNodeType::node_element);
        XMLNode insertChildAfter(XMLNodeType type, const XMLNode& node);
        XMLNode insertChildBefore(XMLNodeType type, const XMLNode& node);

        // Add child element with specified name. Returns added node, or empty node on errors.
        XMLNode appendChild(const string& name);
        XMLNode prependChild(const string& name);
        XMLNode insertChildAfter(const string& name, const XMLNode& node);
        XMLNode insertChildBefore(const string& name, const XMLNode& node);

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

} // namespace parsoid
