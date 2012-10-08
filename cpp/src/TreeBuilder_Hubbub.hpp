#ifndef __HAVE_TREEBUILDER_HUBBUB__
#define __HAVE_TREEBUILDER_HUBBUB__

#include "TreeBuilder.hpp"

struct hubbub_token;
struct hubbub_string;
struct hubbub_treebuilder;

namespace parsoid
{


class TreeBuilderHandler;

class TreeBuilder_Hubbub
    : public TreeBuilder
{
public:
    TreeBuilder_Hubbub();
    ~TreeBuilder_Hubbub();

    virtual void reset();
    virtual void addToken(Tk tok);

private:
    static void* hubbubAllocator(void *ptr, size_t len, void *pw) {
       return realloc(ptr, len);
    }

    void hubbub_from_tk(hubbub_token* h_tok, Tk tok);
    void hubbub_from_string(hubbub_string* h_str, const string& str);

    hubbub_treebuilder* hubbubTreeBuilder;
    TreeBuilderHandler* handler;
};


}

#endif
