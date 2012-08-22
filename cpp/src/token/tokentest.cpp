#include <iostream>
#include <string.h>
#include "virttoken.hpp"

using namespace parsoid;
using namespace std;

int main () {
    boost::intrusive_ptr<StartTagTk> t (new StartTagTk( ));
    t->appendAttribute( "foo", "bar" );
    cout << "  Attrib foo: " << *(t->getAttribute("foo")) << endl;
    t->setAttribute( "foo", "blub" );
    cout << "  Attrib foo: " << *(t->getAttribute("foo")) << endl;
    cout << "  Default constructor " << t->refcount() << endl;
    boost::intrusive_ptr<StartTagTk> t2( t );
    cout << "  t2: " << &t2 << endl;
    return 0;
}
