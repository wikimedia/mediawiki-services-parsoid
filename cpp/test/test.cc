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

void test_tokenizer(const string& testtext) {
    WikiTokenizer t( testtext );

    TokenChunkPtr tcp;

    cout << "TOKENIZER START!\n\n";

    do {
        tcp = t.tokenize();
        cout << tcp->toString() << endl;
    } while ( tcp->size() != 0 && tcp->back().type() != TokenType::Eof );

    if ( tcp->size() != 0 ) {
        cout << "Input was not totally matched.";
    }
    cout << "TOKENIZER FINISH!\n\n";
}

class TestDocReceiver
{
public:
    TestDocReceiver()
        : done( false ) {}

    void receive( DOM::XMLDocumentPtr value ) {
        cout << "received chunk:" << endl << *value << endl;
        doc = value;
        done = true;
    }

    DOM::DocumentReceiver getReceiver() {
        return boost::bind(&TestDocReceiver::receive, boost::ref(*this), _1);
    }

    bool done;
    DOM::XMLDocumentPtr doc;
};

void test_pipeline(const string& testtext) {
    cout << "PARSER START!\n\n";

    Parsoid parser;
    TestDocReceiver doc_receiver;
    parser.parse(testtext, doc_receiver.getReceiver());

    // FIXME assuming the parse was synchronous.
    // otherwise:
    //cerr << "Waiting indefinitely for parsing to complete..." << endl;

    //while ( !doc_receiver.done ) {
    //    sleep( 1 );
    //}

    cout << "PARSER FINISH!\n\n";
}

int main()
{
    //    test_tokens();

    string testtext = "";
    char tmpChr;

    if ( isatty( fileno( stdout ) ) ) {
        int timeout = 5;
        cerr << "Waiting for wikitext input from terminal, timeout in " << timeout << " seconds." << endl;
        alarm( 5 );
    }

    while ( !cin.eof() ) {
        cin.get( tmpChr );
        testtext += tmpChr;
    }

    alarm( 0 );

    //test_tokenizer(testtext);
    test_pipeline(testtext);

    return 0;
}
