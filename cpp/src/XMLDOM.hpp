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
class XMLAttribute;



// A string-like object.
// XXX: Subclass form std::string to enrich with overloaded assign and
// .as{Int,Double,..} methods?
//class XMLText;


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

        // Safe C++11 bool conversion operator
        explicit operator bool() const;

        // string conversion
        explicit operator string() const;

        // Comparison operators (compares wrapped node pointers)
        bool operator==(const typename XMLDOM_T::XMLNode& r) const;
        bool operator!=(const typename XMLDOM_T::XMLNode& r) const;
        bool operator<(const typename XMLDOM_T::XMLNode& r) const;
        bool operator>(const typename XMLDOM_T::XMLNode& r) const;
        bool operator<=(const typename XMLDOM_T::XMLNode& r) const;
        bool operator>=(const typename XMLDOM_T::XMLNode& r) const;

        // Check if node is empty.
        bool empty() const;

        // Get node name/value, or "" if node is empty or it has no name/value
        const string name() const;
        const string value() const;

        // Get first/last attribute
        typename XMLDOM_T::XMLAttribute firstAttribute() const;
        typename XMLDOM_T::XMLAttribute lastAttribute() const;

        // Get children list
        typename XMLDOM_T::XMLNode firstChild() const;
        typename XMLDOM_T::XMLNode lastChild() const;

        // Get next/previous sibling in the children list of the parent node
        typename XMLDOM_T::XMLNode nextSibling() const;
        typename XMLDOM_T::XMLNode previousSibling() const;

        // Get parent node
        typename XMLDOM_T::XMLNode parent() const;

        // Get root of DOM tree this node belongs to
        typename XMLDOM_T::XMLNode root() const;

        // Get text object for the current node
        const string text() const;

        // Get child, attribute or next/previous sibling with the specified name
        typename XMLDOM_T::XMLNode child(const string& name) const;
        typename XMLDOM_T::XMLAttribute attribute(const string& name) const;
        typename XMLDOM_T::XMLNode nextSibling(const string& name) const;
        typename XMLDOM_T::XMLNode previousSibling(const string& name) const;

        // Get child value of current node; that is, value of the first child node of type PCDATA/CDATA
        const string childValue() const;

        // Get child value of child with specified name. Equivalent to child(name).child_value().
        const string childValue(const string& name) const;

        // Set node name/value
        typename XMLDOM_T::XMLNode setName(const string& rhs);
        typename XMLDOM_T::XMLNode setValue(const string& rhs);

        // Add attribute with specified name. Returns added attribute, or empty attribute on errors.
        typename XMLDOM_T::XMLAttribute appendAttribute(const string& name);
        typename XMLDOM_T::XMLAttribute prependAttribute(const string& name);
        typename XMLDOM_T::XMLAttribute insertAttribute_after(const string& name
                , const typename XMLDOM_T::XMLAttribute& attr);
        typename XMLDOM_T::XMLAttribute insertAttribute_before(const string& name
                , const typename XMLDOM_T::XMLAttribute& attr);

        // Add a copy of the specified attribute. Returns added attribute, or empty attribute on errors.
        typename XMLDOM_T::XMLAttribute appendCopy(const typename XMLDOM_T::XMLAttribute& proto);
        typename XMLDOM_T::XMLAttribute prependCopy(const typename XMLDOM_T::XMLAttribute& proto);
        typename XMLDOM_T::XMLAttribute insertCopyAfter(const typename XMLDOM_T::XMLAttribute& proto
                                            , const typename XMLDOM_T::XMLAttribute& attr);
        typename XMLDOM_T::XMLAttribute insertCopyBefore(const typename XMLDOM_T::XMLAttribute& proto
                                            , const typename XMLDOM_T::XMLAttribute& attr);

        // Add child node with specified type. Returns added node, or empty node on errors.
        typename XMLDOM_T::XMLNode appendChild(XMLNodeType type = XMLNodeType::Element);
        typename XMLDOM_T::XMLNode prependChild(XMLNodeType type = XMLNodeType::Element);
        typename XMLDOM_T::XMLNode insertChildAfter(XMLNodeType type, const typename XMLDOM_T::XMLNode& node);
        typename XMLDOM_T::XMLNode insertChildBefore(XMLNodeType type, const typename XMLDOM_T::XMLNode& node);

        // Add child element with specified name. Returns added node, or empty node on errors.
        typename XMLDOM_T::XMLNode appendChild(const string& name);
        typename XMLDOM_T::XMLNode prependChild(const string& name);
        typename XMLDOM_T::XMLNode insertChildAfter(const string& name, const typename XMLDOM_T::XMLNode& node);
        typename XMLDOM_T::XMLNode insertChildBefore(const string& name, const typename XMLDOM_T::XMLNode& node);

        // Move the specified node as a child. Returns the added node, or an
        // empty node on errors.
        typename XMLDOM_T::XMLNode appendChild(const typename XMLDOM_T::XMLNode& node);
        typename XMLDOM_T::XMLNode prependChild(const typename XMLDOM_T::XMLNode& node);
        typename XMLDOM_T::XMLNode insertChildAfter(const typename XMLDOM_T::XMLNode& node
                , const typename XMLDOM_T::XMLNode& afterNode);
        typename XMLDOM_T::XMLNode insertChildBefore(const typename XMLDOM_T::XMLNode& node
                , const typename XMLDOM_T::XMLNode& beforeNode);

        // Add a copy of the specified node as a child. Returns added node, or empty node on errors.
        typename XMLDOM_T::XMLNode appendCopy(const typename XMLDOM_T::XMLNode& proto);
        typename XMLDOM_T::XMLNode prependCopy(const typename XMLDOM_T::XMLNode& proto);
        typename XMLDOM_T::XMLNode insertCopyAfter(const typename XMLDOM_T::XMLNode& proto
                , const typename XMLDOM_T::XMLNode& node);
        typename XMLDOM_T::XMLNode insertCopyBefore(const typename XMLDOM_T::XMLNode& proto
                , const typename XMLDOM_T::XMLNode& node);

        // Remove specified attribute
        bool removeAttribute(const typename XMLDOM_T::XMLAttribute& a);
        bool removeAttribute(const string& name);

        // Remove specified child
        bool removeChild(const typename XMLDOM_T::XMLNode& n);
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

        // Removes all nodes, leaving the empty document
        void reset();

        // Removes all nodes, then copies the entire contents of the specified document
        void reset(const typename XMLDOM_T::XMLDocument& proto);

        // Get document element
        typename XMLDOM_T::XMLNode documentElement() const;

        // loading/saving left out for now

        // Destructor, invalidates all node/attribute handles to this document
        ~XMLDocumentBase() {};

    protected:
        // Default constructor, makes empty document
        XMLDocumentBase() {};

    private:
        // Non-copyable semantics
        XMLDocumentBase(const typename XMLDOM_T::XMLDocument&);
        const XMLDocumentBase& operator=(const typename XMLDOM_T::XMLDocument&);

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
