#include "XMLDOM_Pugi.hpp"

namespace parsoid
{
using pugi::xml_node;
using pugi::xml_document;

/**
 * XMLDocument_Pugi implementation
 */

void
XMLDocument_Pugi::reset() {
    pugiDoc.reset();
}

void
XMLDocument_Pugi::reset( const XMLDocument_Pugi& other ) {
    pugiDoc.reset(other.pugiDoc);
}

/**
 * XMLNode_Pugi implementation
 */

XMLNode_Pugi
XMLNode_Pugi::setName(const string& rhs) {
    if ( pugiNode.set_name( rhs.c_str() ) ) {
        return *this;
    } else {
        throw std::runtime_error( "setName failed" );
    }
}

XMLNode_Pugi
XMLNode_Pugi::setValue(const string& rhs) {
    if ( pugiNode.set_value( rhs.c_str() ) ) {
        return *this;
    } else {
        throw std::runtime_error( "setValue failed" );
    }
}

XMLAttribute_Pugi
XMLNode_Pugi::insertAttribute_after(const string& name
        , const XMLAttribute_Pugi& attr)
{
    return XMLAttribute_Pugi(
            pugiNode.insert_attribute_after( name.c_str(), attr.pugiAttrib )
            );
}
XMLAttribute_Pugi
XMLNode_Pugi::insertAttribute_before(const string& name
        , const XMLAttribute_Pugi& attr)
{
    return XMLAttribute_Pugi(
            pugiNode.insert_attribute_before( name.c_str(), attr.pugiAttrib )
            );
}
XMLNode_Pugi
XMLNode_Pugi::appendChild(const XMLNode_Pugi& node) {
    // Implemented as a copy & remove for now.
    // TODO: implement move in pugi
    XMLNode_Pugi res = XMLNode_Pugi( pugiNode.append_copy( node.pugiNode ) );
    node.parent().removeChild( node );
    return res;
}


XMLNode_Pugi
XMLNode_Pugi::prependChild(const XMLNode_Pugi& node) {
    // Implemented as a copy & remove for now.
    // TODO: implement as move- will need access the internal xml_node_struct
    // for that.
    XMLNode_Pugi res = XMLNode_Pugi( pugiNode.prepend_copy( node.pugiNode ) );
    node.parent().removeChild( node );
    return res;
}

XMLNode_Pugi
XMLNode_Pugi::insertChildAfter(const XMLNode_Pugi& node
        , const XMLNode_Pugi& afterNode) {
    // Implemented as a copy & remove for now.
    // TODO: implement as move- will need access the internal xml_node_struct
    // for that.
    XMLNode_Pugi res = XMLNode_Pugi(
            pugiNode.insert_copy_after( node.pugiNode, afterNode.pugiNode )
    );
    node.parent().removeChild( node );
    return res;
}
XMLNode_Pugi
XMLNode_Pugi::insertChildBefore(const XMLNode_Pugi& node
        , const XMLNode_Pugi& beforeNode) {
    // Implemented as a copy & remove for now.
    // TODO: implement as move- will need access the internal xml_node_struct
    // for that.
    XMLNode_Pugi res = XMLNode_Pugi(
            pugiNode.insert_copy_before( node.pugiNode, beforeNode.pugiNode )
    );
    node.parent().removeChild( node );
    return res;
}


/**
 * XMLAttribute_Pugi implementation
 */

// Set attribute value with type conversion (numbers are converted to
// strings, boolean is converted to "true"/"false")
XMLAttribute_Pugi
XMLAttribute_Pugi::setValue(int rhs) {
    std::ostringstream oss;
    oss << rhs;
    setValue( oss.str() );
    return *this;
}

XMLAttribute_Pugi
XMLAttribute_Pugi::setValue(unsigned int rhs) {
    std::ostringstream oss;
    oss << rhs;
    setValue( oss.str() );
    return *this;
}
XMLAttribute_Pugi
XMLAttribute_Pugi::setValue(double rhs) {
    std::ostringstream oss;
    oss << rhs;
    setValue( oss.str() );
    return *this;
}
XMLAttribute_Pugi
XMLAttribute_Pugi::setValue(bool rhs) {
    setValue( rhs ? "true" : "false" );
    return *this;
}

XMLObjectRange<XMLNodeIterator_Pugi>
XMLNode_Pugi::children() const
{
    return XMLObjectRange<XMLNodeIterator_Pugi>(begin(), end());
}

XMLObjectRange<XMLAttributeIterator_Pugi>
XMLNode_Pugi::attributes() const
{
    return XMLObjectRange<XMLAttributeIterator_Pugi>(attributesBegin(), attributesEnd());
}


} // namespace parsoid
