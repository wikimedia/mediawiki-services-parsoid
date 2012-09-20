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

class XMLNode
{
        friend class XMLAttributeIterator;
        friend class XMLNodeIterator;
        friend class xml_named_nodeIterator;

    protected:
        XMLNode& _root;

        typedef void (*unspecified_bool_type)(XMLNode***);

    public:
        // Default constructor. Constructs an empty node.
        XMLNode();

        // Safe bool conversion operator
        operator unspecified_bool_type() const;

        // Borland C++ workaround
        bool operator!() const;

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
        XMLAttribute first_attribute() const;
        XMLAttribute last_attribute() const;

        // Get children list
        XMLNode first_child() const;
        XMLNode last_child() const;

        // Get next/previous sibling in the children list of the parent node
        XMLNode next_sibling() const;
        XMLNode previous_sibling() const;

        // Get parent node
        XMLNode parent() const;

        // Get root of DOM tree this node belongs to
        XMLNode root() const;

        // Get text object for the current node
        XMLText text() const;

        // Get child, attribute or next/previous sibling with the specified name
        XMLNode child(const string& name) const;
        XMLAttribute attribute(const string& name) const;
        XMLNode next_sibling(const string& name) const;
        XMLNode previous_sibling(const string& name) const;

        // Get child value of current node; that is, value of the first child node of type PCDATA/CDATA
        const string& child_value() const;

        // Get child value of child with specified name. Equivalent to child(name).child_value().
        const string& child_value(const string& name) const;

        // Set node name/value (returns false if node is empty, there is not enough memory, or node can not have name/value)
        bool set_name(const string& rhs);
        bool set_value(const string& rhs);

        // Add attribute with specified name. Returns added attribute, or empty attribute on errors.
        XMLAttribute append_attribute(const string& name);
        XMLAttribute prepend_attribute(const string& name);
        XMLAttribute insert_attribute_after(const string& name, const XMLAttribute& attr);
        XMLAttribute insert_attribute_before(const string& name, const XMLAttribute& attr);

        // Add a copy of the specified attribute. Returns added attribute, or empty attribute on errors.
        XMLAttribute append_copy(const XMLAttribute& proto);
        XMLAttribute prepend_copy(const XMLAttribute& proto);
        XMLAttribute insert_copy_after(const XMLAttribute& proto, const XMLAttribute& attr);
        XMLAttribute insert_copy_before(const XMLAttribute& proto, const XMLAttribute& attr);

        // Add child node with specified type. Returns added node, or empty node on errors.
        XMLNode append_child(XMLNodeType type = XMLNodeType::node_element);
        XMLNode prepend_child(XMLNodeType type = XMLNodeType::node_element);
        XMLNode insert_child_after(XMLNodeType type, const XMLNode& node);
        XMLNode insert_child_before(XMLNodeType type, const XMLNode& node);

        // Add child element with specified name. Returns added node, or empty node on errors.
        XMLNode append_child(const string& name);
        XMLNode prepend_child(const string& name);
        XMLNode insert_child_after(const string& name, const XMLNode& node);
        XMLNode insert_child_before(const string& name, const XMLNode& node);

        // Add a copy of the specified node as a child. Returns added node, or empty node on errors.
        XMLNode append_copy(const XMLNode& proto);
        XMLNode prepend_copy(const XMLNode& proto);
        XMLNode insert_copy_after(const XMLNode& proto, const XMLNode& node);
        XMLNode insert_copy_before(const XMLNode& proto, const XMLNode& node);

        // Remove specified attribute
        bool remove_attribute(const XMLAttribute& a);
        bool remove_attribute(const string& name);

        // Remove specified child
        bool remove_child(const XMLNode& n);
        bool remove_child(const string& name);


        // Search for a node by path consisting of node names and . or .. elements.
        //XMLNode first_element_by_path(const string& path, string delimiter = '/') const;


        // Child nodes iterators
        typedef XMLNodeIterator iterator;

        iterator begin() const;
        iterator end() const;

        // Attribute iterators
        typedef XMLAttributeIterator attributeIterator;

        attributeIterator attributes_begin() const;
        attributeIterator attributes_end() const;

        // Range-based for support
        //XMLObjectRange<XMLNodeIterator> children() const;
        //XMLObjectRange<xml_named_nodeIterator> children(const string& name) const;
        //XMLObjectRange<XMLAttributeIterator> attributes() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const;
};

} // namespace parsoid
