#include "XMLDOM.hpp"
#include <sstream>
#include <stdexcept>

// FIXME: Fix up cmake build files to install header before building
// libparsoid & set include paths properly
#include "../contrib/pugixml/src/pugixml.hpp"

namespace parsoid
{

using pugi::xml_node;
using pugi::xml_document;
using pugi::xml_attribute;

// Forward declarations
class XMLDocument_Pugi;
class XMLNode_Pugi;


class XMLAttribute_Pugi: public XMLAttributeBase
{
    friend class XMLNode_Pugi;
    // TODO: More complete implementation!
    public:
        XMLAttribute_Pugi()
            : pugiAttrib(nullptr) {}
        ~XMLAttribute_Pugi() = default;
        // Safe C++11 bool conversion operator
        explicit operator bool() const {
            return !!pugiAttrib;
        }

        // Comparison operators (compares wrapped attribute pointers)
        bool operator==(const XMLAttribute_Pugi& r) const {
            return pugiAttrib == r.pugiAttrib;
        }
        bool operator!=(const XMLAttribute_Pugi& r) const {
            return pugiAttrib != r.pugiAttrib;
        }
        bool operator<(const XMLAttribute_Pugi& r) const {
            return pugiAttrib < r.pugiAttrib;
        }
        bool operator>(const XMLAttribute_Pugi& r) const {
            return pugiAttrib > r.pugiAttrib;
        }
        bool operator<=(const XMLAttribute_Pugi& r) const {
            return pugiAttrib <= r.pugiAttrib;
        }
        bool operator>=(const XMLAttribute_Pugi& r) const {
            return pugiAttrib >= r.pugiAttrib;
        }

        // Check if attribute is empty
        bool empty() const {
            return pugiAttrib.empty();
        }

        // Get attribute name/value, or "" if attribute is empty
        const string name() const {
            return string( pugiAttrib.name() );
        }
        const string value() const {
            return string( pugiAttrib.value() );
        }

        // Get attribute value, or the empty string if attribute is empty
        explicit operator string() const {
            return string( pugiAttrib.as_string() );
        }

        // Get attribute value as a number, or the default value if conversion
        // did not succeed or attribute is empty
        int asInt(int def = 0) const {
            return pugiAttrib.as_int(def);
        }
        unsigned int asUint(unsigned int def = 0) const {
            return pugiAttrib.as_uint(def);
        }
        double asDouble(double def = 0) const {
            return pugiAttrib.as_double(def);
        }
        float asFloat(float def = 0) const {
            return pugiAttrib.as_float(def);
        }

        // Get attribute value as bool (returns true if first character is in
        // '1tTyY' set), or the default value if attribute is empty
        bool asBool(bool def = false) const {
            return pugiAttrib.as_bool(def);
        }

        // Set attribute name/value (returns false if attribute is empty or there is not enough memory)
        XMLAttribute_Pugi setName(const string& rhs) {
            pugiAttrib.set_name(rhs.c_str());
            return *this;
        }

        XMLAttribute_Pugi setValue(const string& rhs) {
            pugiAttrib.set_value(rhs.c_str());
            return *this;
        }

        // Set attribute value with type conversion (numbers are converted to
        // strings, boolean is converted to "true"/"false")
        XMLAttribute_Pugi setValue(int rhs);
        XMLAttribute_Pugi setValue(unsigned int rhs);
        XMLAttribute_Pugi setValue(double rhs);
        XMLAttribute_Pugi setValue(bool rhs);

        // Set attribute value (equivalent to set_value)
        XMLAttribute_Pugi operator=(const string& rhs) { return setValue( rhs ); }
        XMLAttribute_Pugi operator=(int rhs) { return setValue( rhs ); }
        XMLAttribute_Pugi operator=(unsigned int rhs) { return setValue( rhs ); }
        XMLAttribute_Pugi operator=(double rhs) { return setValue( rhs ); }
        XMLAttribute_Pugi operator=(bool rhs) { return setValue( rhs ); }

        // Get next/previous attribute in the attribute list of the parent node
        XMLAttribute_Pugi nextAttribute() const {
            return XMLAttribute_Pugi( pugiAttrib.next_attribute() );
        }
        XMLAttribute_Pugi previousAttribute() const {
            return XMLAttribute_Pugi( pugiAttrib.previous_attribute() );
        }

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const {
            return pugiAttrib.hash_value();
        }
    private:
        xml_attribute pugiAttrib;
        XMLAttribute_Pugi(xml_attribute attr)
            : pugiAttrib( attr ) {};

};

typedef XMLDOM<XMLDocument_Pugi, XMLNode_Pugi, XMLAttribute_Pugi> DOM;

class XMLNode_Pugi: public XMLNodeBase<DOM>
{
    friend class XMLDocument_Pugi;
    // TODO: Implement
    public:
        explicit operator bool() const {
            return !!pugiNode;
        }

        explicit operator string() const {
            std::ostringstream oss;
            pugiNode.print(oss);
            return oss.str();
        }

        // Comparison operators (compares wrapped node pointers)
        bool operator==(const XMLNode_Pugi& r) const {
            return pugiNode == r.pugiNode;
        }
        bool operator!=(const XMLNode_Pugi& r) const {
            return pugiNode != r.pugiNode;
        }
        bool operator<(const XMLNode_Pugi& r) const {
            return pugiNode < r.pugiNode;
        }
        bool operator>(const XMLNode_Pugi& r) const {
            return pugiNode > r.pugiNode;
        }
        bool operator<=(const XMLNode_Pugi& r) const {
            return pugiNode <= r.pugiNode;
        }
        bool operator>=(const XMLNode_Pugi& r) const {
            return pugiNode >= r.pugiNode;
        }
        bool empty() {
            return pugiNode.empty();
        }
        const string name() const {
            return string(pugiNode.name());
        }
        const string value() const {
            return string(pugiNode.value());
        }

        // Get first / last attribute
        XMLAttribute_Pugi firstAttribute() const {
            return XMLAttribute_Pugi( pugiNode.first_attribute() );
        }
        XMLAttribute_Pugi lastAttribute() const {
            return XMLAttribute_Pugi( pugiNode.last_attribute() );
        }
        // Get children list
        XMLNode_Pugi firstChild() const {
            return XMLNode_Pugi( pugiNode.first_child() );
        }
        XMLNode_Pugi lastChild() const {
            return XMLNode_Pugi( pugiNode.last_child() );
        }

        // Get next/previous sibling in the children list of the parent node
        XMLNode_Pugi nextSibling() const {
            return XMLNode_Pugi( pugiNode.next_sibling() );
        }
        XMLNode_Pugi previousSibling() const {
            return XMLNode_Pugi( pugiNode.previous_sibling() );
        }


        // Get parent node
        XMLNode_Pugi parent() const {
            return XMLNode_Pugi( pugiNode.parent() );
        }

        // Get root of DOM tree this node belongs to
        XMLNode_Pugi root() const {
            return XMLNode_Pugi( pugiNode.root() );
        }

        // Get text object for the current node
        const string text() const {
            return string( pugiNode.text().get() );
        }

        // Get child, attribute or next/previous sibling with the specified name
        XMLNode_Pugi child(const string& name) const {
            return XMLNode_Pugi( pugiNode.child( name.c_str() ) );
        }
        XMLAttribute_Pugi attribute(const string& name) const {
            return XMLAttribute_Pugi( pugiNode.attribute( name.c_str() ) );
        }
        XMLNode_Pugi nextSibling(const string& name) const {
            return XMLNode_Pugi( pugiNode.next_sibling( name.c_str() ) );
        }
        XMLNode_Pugi previousSibling(const string& name) const {
            return XMLNode_Pugi( pugiNode.previous_sibling( name.c_str() ) );
        }

        // Get child value of current node; that is, value of the first child node of type PCDATA/CDATA
        const string childValue() const {
            return string( pugiNode.child_value() );
        }


        // Get child value of child with specified name. Equivalent to
        // child(name).childValue().
        const string childValue(const string& name) const {
            return string( pugiNode.name() );
        }

        // Set node name/value (throws a std::runtime_exception if node is
        // empty, there is not enough memory, or node can not have name/value)
        XMLNode_Pugi setName(const string& rhs);

        XMLNode_Pugi setValue(const string& rhs);

        // Add attribute with specified name. Returns added attribute, or empty attribute on errors.
        XMLAttribute_Pugi appendAttribute(const string& name) {
            return XMLAttribute_Pugi( pugiNode.append_attribute( name.c_str() ) );
        }
        XMLAttribute_Pugi prependAttribute(const string& name) {
            return XMLAttribute_Pugi( pugiNode.prepend_attribute( name.c_str() ) );
        }
        XMLAttribute_Pugi insertAttribute_after(const string& name
                                        , const XMLAttribute_Pugi& attr);
        XMLAttribute_Pugi insertAttribute_before(const string& name
                , const XMLAttribute_Pugi& attr);

        // Add a copy of the specified attribute. Returns added attribute, or
        // empty attribute on errors.
        XMLAttribute_Pugi appendCopy(const XMLAttribute_Pugi& proto) {
            return XMLAttribute_Pugi( pugiNode.append_copy( proto.pugiAttrib ) );
        }
        XMLAttribute_Pugi prependCopy(const XMLAttribute_Pugi& proto) {
            return XMLAttribute_Pugi( pugiNode.prepend_copy( proto.pugiAttrib ) );
        }
        XMLAttribute_Pugi insertCopyAfter(const XMLAttribute_Pugi& proto
                                            , const XMLAttribute_Pugi& attr) {
            return XMLAttribute_Pugi(
                    pugiNode.insert_copy_after( proto.pugiAttrib, attr.pugiAttrib )
            );
        }
        XMLAttribute_Pugi insertCopyBefore(const XMLAttribute_Pugi& proto
                                            , const XMLAttribute_Pugi& attr) {
            return XMLAttribute_Pugi(
                    pugiNode.insert_copy_before( proto.pugiAttrib, attr.pugiAttrib )
            );
        }

        // Add child node with specified type. Returns added node, or empty node on errors.
        XMLNode_Pugi appendChild(XMLNodeType type = XMLNodeType::Element) {

            return XMLNode_Pugi(pugiNode.append_child( pugi::xml_node_type(type) ));
        }
        XMLNode_Pugi prependChild(XMLNodeType type = XMLNodeType::Element) {
            return XMLNode_Pugi(pugiNode.prepend_child( pugi::xml_node_type(type) ));
        }
        XMLNode_Pugi insertChildAfter(XMLNodeType type, const XMLNode_Pugi& node) {
            return XMLNode_Pugi(
                    pugiNode.insert_child_after( pugi::xml_node_type(type), node.pugiNode )
            );
        }
        XMLNode_Pugi insertChildBefore(XMLNodeType type, const XMLNode_Pugi& node) {
            return XMLNode_Pugi(
                    pugiNode.insert_child_before( pugi::xml_node_type(type), node.pugiNode )
            );
        }

        // Add child element with specified name. Returns added node, or empty
        // node on errors.
        XMLNode_Pugi appendChild(const string& name) {
            return XMLNode_Pugi(pugiNode.append_child( name.c_str() ));
        }
        XMLNode_Pugi prependChild(const string& name) {
            return XMLNode_Pugi(pugiNode.prepend_child( name.c_str() ));
        }
        XMLNode_Pugi insertChildAfter(const string& name, const XMLNode_Pugi& node) {
            return XMLNode_Pugi(pugiNode.insert_child_after( name.c_str(), node.pugiNode ));
        }

        XMLNode_Pugi insertChildBefore(const string& name, const XMLNode_Pugi& node) {
            return XMLNode_Pugi(pugiNode.insert_child_before( name.c_str(), node.pugiNode ));
        }

        // Move the specified node as a child. Returns the added node, or an
        // empty node on errors.
        XMLNode_Pugi appendChild(const XMLNode_Pugi& node);
        XMLNode_Pugi prependChild(const XMLNode_Pugi& node);
        XMLNode_Pugi insertChildAfter(const XMLNode_Pugi& node
                , const XMLNode_Pugi& afterNode);
        XMLNode_Pugi insertChildBefore(const XMLNode_Pugi& node
                , const XMLNode_Pugi& beforeNode);

        // Add a copy of the specified node as a child. Returns added node, or
        // empty node on errors.
        XMLNode_Pugi appendCopy(const XMLNode_Pugi& proto);
        XMLNode_Pugi prependCopy(const XMLNode_Pugi& proto);
        XMLNode_Pugi insertCopyAfter(const XMLNode_Pugi& proto
                , const XMLNode_Pugi& node);
        XMLNode_Pugi insertCopyBefore(const XMLNode_Pugi& proto
                , const XMLNode_Pugi& node);

        // Remove specified attribute
        bool removeAttribute(const XMLAttribute_Pugi& a);
        bool removeAttribute(const string& name);

        // Remove specified child
        bool removeChild(const XMLNode_Pugi& n);
        bool removeChild(const string& name);


        // Search for a node by path consisting of node names and . or .. elements.
        //XMLDOM_T::XMLNode first_element_by_path(const string& path, string delimiter = '/') const;


        // Child nodes iterators
        //typedef XMLNode_PugiIterator iterator;

        iterator begin() const;
        iterator end() const;

        // Attribute iterators
        //typedef XMLAttribute_PugiIterator attributeIterator;

        //attributeIterator attributesBegin() const;
        //attributeIterator attributesEnd() const;

        // Range-based for support
        //XMLObjectRange<XMLDOM_T::XMLNodeIterator> children() const;
        //XMLObjectRange<xml_named_nodeIterator> children(const string& name) const;
        //XMLObjectRange<XMLAttributeIterator> attributes() const;

        // Get hash value (unique for handles to the same object)
        size_t hash_value() const {
            return pugiNode.hash_value();
        }



    protected:
        XMLNode_Pugi()
            : pugiNode(nullptr) {};
        XMLNode_Pugi( xml_node pugiNode )
            : pugiNode( pugiNode ) {}
    private:
        xml_node pugiNode;

};

class XMLDocument_Pugi: public XMLDocumentBase<DOM>
{
    // TODO: Implement
    public:
        XMLDocument_Pugi() = default;
        ~XMLDocument_Pugi() = default;
        void reset();
        void reset(const XMLDocument_Pugi& other);
    private:
        xml_node pugiNode() const;
        xml_document pugiDoc;
};

}
