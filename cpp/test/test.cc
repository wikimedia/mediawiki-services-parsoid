#include "libparsoid/parsoid_internal.hpp"
#include <vector>

using namespace parsoid;
using namespace std;
using boost::intrusive_ptr;

/**
 * Try the token interface
 */
void test_tokens() {
    // Create a few tokens and -vectors
    Tk keyToken = mkText(" foo");
    // c++11 generalized initialization lists are quite compact
    vector<Tk> key2{ mkStartTag("a"), mkText(" bar") };
    vector<Tk> key3{ mkText(" baz") };
    
    vector<Tk> key;
    key.push_back(keyToken);

    // Add them to a StartTag
    Tk t = mkStartTag("a");
    t.setAttribute(key, key);
    t.setAttribute(key2, key3);

    // And see if we can get at the attributes
    cout << "getAttribute <foo>: " 
        << t.getAttribute(key)[0].getText()
        << "\nshould return baz: "
        << t.getAttribute(key2).at(0).getText()
        << endl;
}

int main()
{
    test_tokens();
    return 0;
}
