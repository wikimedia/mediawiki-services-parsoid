#ifndef __HAVE_WIKITEXT_TOKENIZER_HPP__
#define __HAVE_WIKITEXT_TOKENIZER_HPP__

#include "WikiTokenizer.hpp"

using namespace parsoid;
using std::stringstream;

// Wrap the tokenizer in its own sub-namespace because of the many globals declarations.
namespace parsoid {
namespace WTTokenizer {

typedef struct _yycontext yycontext;

// Actions are supposed to return this type as semantic value
#define YYSTYPE vector<Tk>

// local tokenizer context
#define YY_CTX_LOCAL

#define YY_INPUT(buf, result, max)  \
    { \
        result = 0; \
    }

// Add a reference to the driving WikiTokenizer object as an additional state
// member
#define YY_CTX_MEMBERS WikiTokenizer* tokenizer;

// If you want to see _ALL THE TEXT_, uncomment this.
//#define YY_DEBUG

// Define a few convenience macros to make things more readable
#define emit ctx->tokenizer->emit
#define pushScope ctx->tokenizer->pushScope
#define popScope ctx->tokenizer->popScope
#define getAccum ctx->tokenizer->getAccum

#define incFlag ctx->tokenizer->syntaxFlags.inc
#define decFlag ctx->tokenizer->syntaxFlags.dec
#define pushFlag ctx->tokenizer->syntaxFlags.push
#define popFlag ctx->tokenizer->syntaxFlags.pop
#define getFlag ctx->tokenizer->syntaxFlags.get


} // namespace WTTokenizer
} // namespace parsoid

#endif
