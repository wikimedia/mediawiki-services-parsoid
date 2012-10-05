#ifndef __HAVE_TREEBUILDER__
#define __HAVE_TREEBUILDER__

#include "parsoid_internal.hpp"

extern "C" {
    #include <hubbub/hubbub.h>
    #include <treebuilder/treebuilder.h>
};

namespace parsoid
{

/**
 * Tree builder wrapper
 *
 * - Converts our tokens to a stack-allocated libhubbub token while reusing
 *   string buffers
 * - Calls the libhubbub treebuilder for each token
 * - Calls its receiver after receiving the EofTk
 */
class TreeBuilder
    : public PipelineStage<TokenMessage, DOM::XMLDocumentPtr>
{
public:
    TreeBuilder();
    ~TreeBuilder();

    void reset();

    void receive(TokenMessage message);

    static void* hubbubAllocator(void *ptr, size_t len, void *pw) {
       return realloc(ptr, len);
    }

    void hubbub_from_tk(hubbub_token* h_tok, Tk tok);
    void hubbub_from_string(hubbub_string* h_str, const string& str);

private:
    DOM::XMLDocumentPtr document;
    hubbub_treebuilder* hubbubTreeBuilder;
    hubbub_tree_handler callbacks;
};

class TreeBuilderHandler
{
public:
    typedef DOM::XMLNode node_type;
    typedef DOM::XMLAttribute attribute_type;

    //TODO define a string_type with non-copying const constructor(char*, int)
    typedef string string_type;

    static hubbub_tree_handler get_handler()
    {
        hubbub_tree_handler handler;

        handler.append_child = &TreeBuilderHandler::append_child;
        handler.insert_before = &TreeBuilderHandler::insert_before;
        handler.append_child_new = &TreeBuilderHandler::append_child_new;
        handler.insert_before_new = &TreeBuilderHandler::insert_before_new;
        handler.remove_child = &TreeBuilderHandler::remove_child;
        handler.clone_node = &TreeBuilderHandler::clone_node;
        handler.reparent_children = &TreeBuilderHandler::reparent_children;
        handler.get_parent = &TreeBuilderHandler::get_parent;
        handler.has_children = &TreeBuilderHandler::has_children;
        handler.form_associate = &TreeBuilderHandler::form_associate;
        handler.set_name = &TreeBuilderHandler::set_name;
        handler.set_value = &TreeBuilderHandler::set_value;
        handler.add_attributes = &TreeBuilderHandler::add_attributes;
        handler.set_quirks_mode = &TreeBuilderHandler::set_quirks_mode;
        handler.encoding_change = &TreeBuilderHandler::encoding_change;
        handler.complete_script = &TreeBuilderHandler::complete_script;
        handler.ctx = nullptr;

        return handler;
    }

    static hubbub_error append_child(void* ctx, void* parent, void* child, void** result);
    static hubbub_error insert_before(void *ctx, void *parent, void *child, void *ref_child, void **result);
    static hubbub_error append_child_new(void *ctx, void *parent, hubbub_token_type type, void **result);
    static hubbub_error insert_before_new(void *ctx, void *parent, hubbub_token_type type, void *ref_child, void **result);
    static hubbub_error remove_child(void *ctx, void *parent, void *child);
    static hubbub_error clone_node(void *ctx, void *node, bool deep, void **result);
    static hubbub_error reparent_children(void *ctx, void *node, void *new_parent);
    static hubbub_error get_parent(void *ctx, void *node, bool element_only, void **result);
    static hubbub_error has_children(void *ctx, void *node, bool *result);
    static hubbub_error form_associate(void *ctx, void *form, void *node);
    static hubbub_error set_name(void *ctx, void *node, const hubbub_string *name);
    static hubbub_error set_value(void *ctx, void *node, const hubbub_string *value);
    static hubbub_error add_attributes(void *ctx, void *node, const hubbub_attribute *attributes, uint32_t n_attributes );
    static hubbub_error set_quirks_mode(void *ctx, hubbub_quirks_mode mode);
    static hubbub_error encoding_change(void *ctx, const char *encname);
    static hubbub_error complete_script(void *ctx, void *script);

    static XMLNodeType type_from_hubbub(hubbub_token_type type);
    static const string_type string_from_hubbub(const hubbub_string& str);
};


} // namespace parsoid

#endif
