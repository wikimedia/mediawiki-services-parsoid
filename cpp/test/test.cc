#include "libparsoid/parsoid_internal.hpp"

using namespace parsoid;
using namespace std;
int main()
{
    boost::intrusive_ptr<StartTagTk> t (new StartTagTk( ));
    t->appendAttribute( "foo", "bar" );
    cout << "  Attrib foo: " << *(t->getAttribute("foo")) << endl;
    t->setAttribute( "foo", "blub" );
    cout << "  Attrib foo: " << *(t->getAttribute("foo")) << endl;
    cout << "  Refcount: " << t->refcount() << endl;
    cout << "  Type: " << (int)t->type() << endl;
    boost::intrusive_ptr<StartTagTk> t2( t );
    cout << "  t2: " << &t2 << endl;
    return 0;
}
