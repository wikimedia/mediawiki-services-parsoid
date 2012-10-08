#include "WikiTokenizer.hpp"

#include "wikitext_tokenizer.hpp"
#include "wikitext_tokenizer.cpp"

using namespace boost;


using namespace WTTokenizer; // look for the prefix "yy"-
extern int WTTokenizer::yyparse(yycontext*);


// Include the generated tokenizer source, namespaced to parsoid::WTTokenizer
namespace parsoid
{

    WikiTokenizer::WikiTokenizer() {
        // TODO: check if the tokenizer modifies the string!
        ctx = new yycontext;
        memset(ctx, 0, sizeof(yycontext));

        // The yytext buffer
        ctx->textlen= 1024;
        ctx->text= static_cast<char*>(malloc(ctx->textlen));
        // Backtracking thunks
        ctx->thunkslen= 32;
        ctx->thunks= static_cast<yythunk*>(
            malloc( sizeof(yythunk) * ctx->thunkslen));
        // Semantic result type stack
        ctx->valslen= 32;
        ctx->vals= (YYSTYPE *) new YYSTYPE[ctx->valslen];

        // Update the ref to this
        ctx->tokenizer = this;
    }


    // TODO: split construction from input passing / state reset?
    WikiTokenizer::WikiTokenizer( const string* input )
        : WikiTokenizer()
    {
        setInput( input );
    }

    // FIXME: shares memory of "input", but peg code may realloc()
    void WikiTokenizer::setInput( const string* input ) {
        this->input = input;
        ctx->buf = const_cast<char*>(input->c_str());
        // Setting the buflen to something larger than the actual length + 512
        // prevents realloc calls
        ctx->buflen = input->size() + 513;
        // The limit sets the boundary for the tokenizer
        ctx->limit = input->size() + 1;
    }

    TokenChunkPtr WikiTokenizer::tokenize() {
        // Init the accumulator stack
        //cout << ctx->buf << endl;
        // /*yy*/accumStack = { vector<Tk>() };
        // Parse a single toplevel block per call, and remember the source
        // position
	yyparse(ctx);
        return popScope();
    }

    bool WikiTokenizer::syntaxBreak() {
        int pos = ctx->pos;
        bool ret;
        switch ( (*input)[pos] ) {
            case '=':
                ret = syntaxFlags.get( WikiTokenizer::SyntaxFlags::Flag::Equal );
                break;
            default:
                ret = false;
                break;
        }
        return ret;
    }

    WikiTokenizer::~WikiTokenizer() {
        free(ctx->thunks);
        free(ctx->text);
        delete[] ctx->vals;
        delete ctx;
    }

}
