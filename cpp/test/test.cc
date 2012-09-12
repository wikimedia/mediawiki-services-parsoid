#include "parsoid_internal.hpp"

using namespace parsoid;
using namespace std;

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
    //    test_tokens();

    string testtext = "";
    char tmpChr;

    while ( !cin.eof() ) {
        cin.get( tmpChr );
	testtext += tmpChr;
    }

    WikiTokenizer t( testtext );

    TokenChunkPtr tcp;

    cout << "TOKENIZER START!\n\n";

    do {
        tcp = t.tokenize();
	cout << tcp->toString() << endl;
    } while ( tcp->size() != 0 && tcp->back().type() != TokenType::Eof );

    if ( tcp->size() != 0 ) {
        cout << "Input was not totally matched.";
    } else {
        cout << "TOKENIZER FINISH!\n\n";
    }

    return 0;
}
