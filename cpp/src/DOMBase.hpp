/**
 * Abstract Document Object Model wrapper
 */

#include <boost/function.hpp>

namespace parsoid {

/**
 * Callback receiving a DOMBase message
 */
typedef boost::function<void(DOMBase)> DocumentReceiver;

class XMLNodeIterator;
class XMLAttributeIterator;
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
        XMLNode_struct* _root;

        typedef void (*unspecified_bool_type)(XMLNode***);

    public:
        // Default constructor. Constructs an empty node.
        XMLNode();

        // Constructs node from internal pointer
        explicit XMLNode(XMLNode_struct* p);

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

        // Get node type
        XMLNode_type type() const;

        // Get node name/value, or "" if node is empty or it has no name/value
        const char_t* name() const;
        const char_t* value() const;

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
        XMLNode child(const char_t* name) const;
        XMLAttribute attribute(const char_t* name) const;
        XMLNode next_sibling(const char_t* name) const;
        XMLNode previous_sibling(const char_t* name) const;

        // Get child value of current node; that is, value of the first child node of type PCDATA/CDATA
        const char_t* child_value() const;

        // Get child value of child with specified name. Equivalent to child(name).child_value().
        const char_t* child_value(const char_t* name) const;

        // Set node name/value (returns false if node is empty, there is not enough memory, or node can not have name/value)
        bool set_name(const char_t* rhs);
        bool set_value(const char_t* rhs);

        // Add attribute with specified name. Returns added attribute, or empty attribute on errors.
        XMLAttribute append_attribute(const char_t* name);
        XMLAttribute prepend_attribute(const char_t* name);
        XMLAttribute insert_attribute_after(const char_t* name, const XMLAttribute& attr);
        XMLAttribute insert_attribute_before(const char_t* name, const XMLAttribute& attr);

        // Add a copy of the specified attribute. Returns added attribute, or empty attribute on errors.
        XMLAttribute append_copy(const XMLAttribute& proto);
        XMLAttribute prepend_copy(const XMLAttribute& proto);
        XMLAttribute insert_copy_after(const XMLAttribute& proto, const XMLAttribute& attr);
        XMLAttribute insert_copy_before(const XMLAttribute& proto, const XMLAttribute& attr);

        // Add child node with specified type. Returns added node, or empty node on errors.
        XMLNode append_child(XMLNode_type type = node_element);
        XMLNode prepend_child(XMLNode_type type = node_element);
        XMLNode insert_child_after(XMLNode_type type, const XMLNode& node);
        XMLNode insert_child_before(XMLNode_type type, const XMLNode& node);

        // Add child element with specified name. Returns added node, or empty node on errors.
        XMLNode append_child(const char_t* name);
        XMLNode prepend_child(const char_t* name);
        XMLNode insert_child_after(const char_t* name, const XMLNode& node);
        XMLNode insert_child_before(const char_t* name, const XMLNode& node);

        // Add a copy of the specified node as a child. Returns added node, or empty node on errors.
        XMLNode append_copy(const XMLNode& proto);
        XMLNode prepend_copy(const XMLNode& proto);
        XMLNode insert_copy_after(const XMLNode& proto, const XMLNode& node);
        XMLNode insert_copy_before(const XMLNode& proto, const XMLNode& node);

        // Remove specified attribute
        bool remove_attribute(const XMLAttribute& a);
        bool remove_attribute(const char_t* name);

        // Remove specified child
        bool remove_child(const XMLNode& n);
        bool remove_child(const char_t* name);


        // Search for a node by path consisting of node names and . or .. elements.
        XMLNode first_element_by_path(const char_t* path, char_t delimiter = '/') const;

        // Recursively traverse subtree with xml_tree_walker
        bool traverse(xml_tree_walker& walker);


        // Child nodes iterators
        typedef XMLNodeIterator iterator;

        iterator begin() const;
        iterator end() const;

        // Attribute iterators
        typedef XMLAttributeIterator attributeIterator;

        attributeIterator attributes_begin() const;
        attributeIterator attributes_end() const;

        // Range-based for support
        XMLObjectRange<XMLNodeIterator> children() const;
        XMLObjectRange<xml_named_nodeIterator> children(const char_t* name) const;
        XMLObjectRange<XMLAttributeIterator> attributes() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const;
};

} // namespace parsoid
