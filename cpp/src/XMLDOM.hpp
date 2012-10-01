/**
 * Abstract Document Object Model wrapper
 *
 * The idea is to provide stack-allocated pointer wrapper classes with a
 * uniform interface. Memory management of the actual DOM implementation is
 * expected to be tied to DOM membership: A DOM node is deallocated whenever
 * it is removed from the DOM.
 *
 * The top-level XMLDocument class is refcounted with an intrusive_ptr, and
 * will deallocate the entire DOM when its refcount drops to zero.
 */

#include <boost/function.hpp>
#include "IntrusivePtrBase.hpp"
#include "LibIncludes.hpp"

namespace parsoid {


// Forward declarations
// The core DOM classes, normally typedef'ed from the template base classes
// below
class XMLDocument;
class XMLNode;

// At the very minimum, we have to support the equivalent to the following
// libhubbub -> DOM callbacks:
// libhubbub cb     // DOMBase equivalent
// ---------------------------------------
// create_comment,  // node.appendChild( XMLNodeType::Comment ) (always attach)
// create_doctype,  // node.appendChild( XMLNodeType::Doctype )
// create_element,  // node.appendChild( XMLNodeType::Element )
// create_text,     // node.appendChild( XMLNodeType::Text )
// ref_node,        // not needed: remove remove_node_from_dom calls that
//                     are not followed by unref_node (moving append/insert
//                     instead)
// unref_node,      // not needed: always attach node to DOM, use moving
//                     append_child/insert_before
// append_child,    // node.appendChild (moving!)
// insert_before,   // insertChildBefore (moving!)
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
    Null,               // Empty (null) node handle
    Document,           // A document tree's absolute root
    Element,            // Element tag, i.e. '<node/>'
    Pcdata,             // Plain character data, i.e. 'text'
    Cdata,              // Character data, i.e. '<![CDATA[text]]>'
    Comment,            // Comment tag, i.e. '<!-- text -->'
    Pi,                 // Processing instruction, i.e. '<?name?>'
    Declaration,        // Document declaration, i.e. '<?xml version="1.0"?>'
    Doctype             // Document type declaration, i.e. '<!DOCTYPE doc>'
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
class XMLAttributeBase
{
    protected:
        // protect the constructor- we are an abstract base class
        XMLAttributeBase() = default;
        ~XMLAttributeBase() = default;
        // no copying either
        XMLAttributeBase( const XMLAttributeBase& );
        const XMLAttributeBase& operator=(const XMLAttributeBase&);

    public:
        // Default constructor. Constructs an empty attribute.

        // Safe C++11 bool conversion operator
        explicit operator bool() const;

        // Comparison operators (compares wrapped attribute pointers)
        bool operator==(const XMLAttributeBase& r) const;
        bool operator!=(const XMLAttributeBase& r) const;
        bool operator<(const XMLAttributeBase& r) const;
        bool operator>(const XMLAttributeBase& r) const;
        bool operator<=(const XMLAttributeBase& r) const;
        bool operator>=(const XMLAttributeBase& r) const;

        // Check if attribute is empty
        bool empty() const;

        // Get attribute name/value, or "" if attribute is empty
        const string name() const;
        const string value() const;

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
        XMLAttributeBase setName(const string& rhs);
        XMLAttributeBase setValue(const string& rhs);

        // Set attribute value with type conversion (numbers are converted to strings, boolean is converted to "true"/"false")
        XMLAttributeBase setValue(int rhs);
        XMLAttributeBase setValue(unsigned int rhs);
        XMLAttributeBase setValue(double rhs);
        XMLAttributeBase setValue(bool rhs);

        // Set attribute value (equivalent to set_value without error checking)
        XMLAttributeBase operator=(const string& rhs);
        XMLAttributeBase operator=(int rhs);
        XMLAttributeBase operator=(unsigned int rhs);
        XMLAttributeBase operator=(double rhs);
        XMLAttributeBase operator=(bool rhs);

        // Get next/previous attribute in the attribute list of the parent node
        XMLAttributeBase nextAttribute() const;
        XMLAttributeBase previousAttribute() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const;
};

template <class XMLDOM_T>
class XMLNodeBase
{
        friend class XMLDOM_T::XMLAttributeIterator;
        friend class XMLDOM_T::XMLNodeIterator;
        //friend class XMLDOM_T::xml_named_nodeIterator;

    protected:
        // Protected, as we are an abstract base class
        // Default constructor. Constructs an empty node.
        XMLNodeBase() = default;
        ~XMLNodeBase() = default;
        // no copying either
        XMLNodeBase( const XMLNodeBase& );
        const XMLNodeBase& operator=(const XMLNodeBase&);

    public:
        typedef typename XMLDOM_T::XMLDocument document_type;
        typedef typename XMLDOM_T::XMLNode node_type;
        typedef typename XMLDOM_T::XMLAttribute attribute_type;

        // Safe C++11 bool conversion operator
        explicit operator bool() const;

        // string conversion
        explicit operator string() const;

        // Comparison operators (compares wrapped node pointers)
        bool operator==(const node_type& r) const;
        bool operator!=(const node_type& r) const;
        bool operator<(const node_type& r) const;
        bool operator>(const node_type& r) const;
        bool operator<=(const node_type& r) const;
        bool operator>=(const node_type& r) const;

        // Check if node is empty.
        bool empty() const;

        // Get node name/value, or "" if node is empty or it has no name/value
        const string name() const;
        const string value() const;

        // Get first/last attribute
        attribute_type firstAttribute() const;
        attribute_type lastAttribute() const;

        // Get children list
        node_type firstChild() const;
        node_type lastChild() const;

        // Get next/previous sibling in the children list of the parent node
        node_type nextSibling() const;
        node_type previousSibling() const;

        // Get parent node
        node_type parent() const;

        // Get root of DOM tree this node belongs to
        node_type root() const;

        // Get text object for the current node
        const string text() const;

        // Get child, attribute or next/previous sibling with the specified name
        node_type child(const string& name) const;
        attribute_type attribute(const string& name) const;
        node_type nextSibling(const string& name) const;
        node_type previousSibling(const string& name) const;

        // Get child value of current node; that is, value of the first child node of type PCDATA/CDATA
        const string childValue() const;

        // Get child value of child with specified name. Equivalent to child(name).child_value().
        const string childValue(const string& name) const;

        // Set node name/value
        node_type setName(const string& rhs);
        node_type setValue(const string& rhs);

        // Add attribute with specified name. Returns added attribute, or empty attribute on errors.
        attribute_type appendAttribute(const string& name);
        attribute_type prependAttribute(const string& name);
        attribute_type insertAttribute_after(const string& name
                , const attribute_type& attr);
        attribute_type insertAttribute_before(const string& name
                , const attribute_type& attr);

        // Add a copy of the specified attribute. Returns added attribute, or empty attribute on errors.
        attribute_type appendCopy(const attribute_type& proto);
        attribute_type prependCopy(const attribute_type& proto);
        attribute_type insertCopyAfter(const attribute_type& proto
                                            , const attribute_type& attr);
        attribute_type insertCopyBefore(const attribute_type& proto
                                            , const attribute_type& attr);

        // Add child node with specified type. Returns added node, or empty node on errors.
        node_type appendChild(XMLNodeType type = XMLNodeType::Element);
        node_type prependChild(XMLNodeType type = XMLNodeType::Element);
        node_type insertChildAfter(XMLNodeType type, const node_type& node);
        node_type insertChildBefore(XMLNodeType type, const node_type& node);

        // Add child element with specified name. Returns added node, or empty node on errors.
        node_type appendChild(const string& name);
        node_type prependChild(const string& name);
        node_type insertChildAfter(const string& name, const node_type& node);
        node_type insertChildBefore(const string& name, const node_type& node);

        // Move the specified node as a child. Returns the added node, or an
        // empty node on errors.
        node_type appendChild(const node_type& node);
        node_type prependChild(const node_type& node);
        node_type insertChildAfter(const node_type& node
                , const node_type& afterNode);
        node_type insertChildBefore(const node_type& node
                , const node_type& beforeNode);

        // Add a copy of the specified node as a child. Returns added node, or empty node on errors.
        node_type appendCopy(const node_type& proto);
        node_type prependCopy(const node_type& proto);
        node_type insertCopyAfter(const node_type& proto
                , const node_type& node);
        node_type insertCopyBefore(const node_type& proto
                , const node_type& node);

        // Remove specified attribute
        bool removeAttribute(const attribute_type& a);
        bool removeAttribute(const string& name);

        // Remove specified child
        bool removeChild(const node_type& n);
        bool removeChild(const string& name);


        // Search for a node by path consisting of node names and . or .. elements.
        //XMLDOM_T::XMLNode first_element_by_path(const string& path, string delimiter = '/') const;


        // Child nodes iterators
        typedef typename XMLDOM_T::XMLNodeIterator iterator;

        iterator begin() const;
        iterator end() const;

        // Attribute iterators
        typedef typename XMLDOM_T::XMLAttributeIterator attributeIterator;

        attributeIterator attributesBegin() const;
        attributeIterator attributesEnd() const;

        // Range-based for support
        //XMLObjectRange<XMLDOM_T::XMLNodeIterator> children() const;
        //XMLObjectRange<xml_named_nodeIterator> children(const string& name) const;
        //XMLObjectRange<XMLAttributeIterator> attributes() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const;
};

// Document class (DOM tree root)
template <class XMLDOM_T>
class XMLDocumentBase
    : public XMLDOM_T::XMLNode
    // The XMLDocumentBase is refcounted
    , public IntrusivePtrBase<XMLDocumentBase<XMLDOM_T>>
{
    public:
        typedef typename XMLDOM_T::XMLDocument document_type;
        typedef typename XMLDOM_T::XMLNode node_type;
        typedef typename XMLDOM_T::XMLAttribute attribute_type;

        // Removes all nodes, leaving the empty document
        void reset();

        // Removes all nodes, then copies the entire contents of the specified document
        void reset(const document_type& proto);

        // Get document element
        node_type documentElement() const;

        // loading/saving left out for now

        // Destructor, invalidates all node/attribute handles to this document
        ~XMLDocumentBase() {};

    protected:
        // Default constructor, makes empty document
        XMLDocumentBase() {};

    private:
        // Non-copyable semantics
        XMLDocumentBase(const document_type&);
        const XMLDocumentBase& operator=(const document_type&);

};


/**
 * Type wrapper class
 */
template <class XMLDocumentT, class XMLNodeT, class XMLAttributeT>
class XMLDOM
{
    public:
        typedef XMLDocumentT XMLDocument;
        typedef XMLNodeT XMLNode;
        typedef XMLAttributeT XMLAttribute;

        typedef intrusive_ptr<XMLDocument> XMLDocumentPtr;

        /**
         * Callback receiving a XMLDocument message
         *
         * FIXME: actually use a DOM type
         */
        typedef boost::function<void(XMLDocumentPtr)> DocumentReceiver;

        // Iterator helpers
        class XMLAttributeIterator;
        class XMLNodeIterator;
};


} // namespace parsoid
