#include "XMLDOM.hpp"

// FIXME: Fix up cmake build files to install header before building
// libparsoid & set include paths properly
#include "../contrib/pugixml/src/pugixml.hpp"

namespace parsoid
{

// Forward declarations
class XMLDocument_Pugi;
class XMLNode_Pugi;
class XMLAttribute_Pugi;

typedef XMLDOM<XMLDocument_Pugi, XMLNode_Pugi, XMLAttribute_Pugi> DOM;

class XMLAttribute_Pugi: public XMLAttributeBase
{
    // TODO: Implement
};

class XMLNode_Pugi: public XMLNodeBase<DOM>
{
    // TODO: Implement
};

class XMLDocument_Pugi: public XMLDocumentBase<DOM>
{
    // TODO: Implement
    public:
        ~XMLDocument_Pugi();
};

}
