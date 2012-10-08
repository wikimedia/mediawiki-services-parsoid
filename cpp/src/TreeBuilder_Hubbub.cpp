#include "XMLDOM_Pugi.hpp" //FIXME
#include "TreeBuilder_Hubbub.hpp"

extern "C" {
    #include <hubbub/hubbub.h>
    #include <treebuilder/treebuilder.h>
};

namespace parsoid
{


class TreeBuilderHandler
{
public:
    typedef DOM::XMLNode node_type;
    typedef DOM::XMLAttribute attribute_type;

    //TODO define a string_type with non-copying const constructor(char*, int)
    typedef string string_type;

    TreeBuilderHandler(TreeBuilder_Hubbub* context);

    hubbub_tree_handler* getHandler() {
        return &handler;
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

    hubbub_tree_handler handler;
};


TreeBuilder_Hubbub::TreeBuilder_Hubbub()
    : hubbubTreeBuilder(nullptr)
{
    hubbub_error error;

    error = hubbub_treebuilder_create(
        &TreeBuilder_Hubbub::hubbubAllocator,
        NULL,
        &hubbubTreeBuilder
    );
    if (error != HUBBUB_OK) {
        throw "Not ok";
    }

    handler = new TreeBuilderHandler(this);
    hubbub_treebuilder_optparams params;
    params.tree_handler = handler->getHandler();
    hubbub_treebuilder_setopt(
        hubbubTreeBuilder,
        HUBBUB_TREEBUILDER_TREE_HANDLER,
        &params
    );

    reset();
}

TreeBuilder_Hubbub::~TreeBuilder_Hubbub()
{
    if (!document->root().empty()) {
        std::cerr << "ERROR: EOF not received. Final document contents:" << std::endl;
        std::cerr << *document;
    }
    reset();
    if (hubbubTreeBuilder) {
        hubbub_treebuilder_destroy(hubbubTreeBuilder);
    }
    delete handler;
}

void TreeBuilder_Hubbub::reset()
{
    document->reset();

    hubbub_treebuilder_optparams params;
    params.document_node = static_cast<void*>(document->root());
    hubbub_treebuilder_setopt(hubbubTreeBuilder, HUBBUB_TREEBUILDER_DOCUMENT_NODE, &params);
}

void TreeBuilder_Hubbub::addToken(Tk tok)
{
    //std::cerr << "h_tokening: " << tok.toString() << std::endl;

    hubbub_token h_tok;
    hubbub_from_tk(&h_tok, tok);
    hubbub_treebuilder_token_handler(&h_tok, hubbubTreeBuilder);
    if (h_tok.data.tag.attributes) {
        TreeBuilder_Hubbub::hubbubAllocator(
            h_tok.data.tag.attributes,
            0,
            nullptr
        );
    }
}


TreeBuilderHandler::TreeBuilderHandler(TreeBuilder_Hubbub* context)
{
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

    handler.ctx = static_cast<void *>(context);
}

hubbub_error TreeBuilderHandler::append_child(void* ctx, void* p_parent, void* p_child, void** p_result)
{
    node_type parent(p_parent);
    node_type child(p_child);

    node_type result = parent.appendChild(child);

    if (result.empty()) {
        return HUBBUB_UNKNOWN;
    }
    *p_result = static_cast<void*>(result);
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::insert_before(void *ctx, void *p_parent, void *p_child, void *p_ref_child, void **p_result)
{
    node_type parent(p_parent);
    node_type child(p_child);
    node_type ref_child(p_ref_child);

    node_type result = parent.insertChildBefore(child, ref_child);

    if (result.empty()) {
        return HUBBUB_UNKNOWN;
    }
    *p_result = static_cast<void*>(result);
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::append_child_new(void *ctx, void *p_parent, hubbub_token_type type, void **p_result)
{
    node_type parent(p_parent);

    node_type result = parent.appendChild(TreeBuilderHandler::type_from_hubbub(type));

    if (result.empty()) {
        return HUBBUB_UNKNOWN;
    }
    *p_result = static_cast<void*>(result);
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::insert_before_new(void *ctx, void *p_parent, hubbub_token_type type, void *p_ref_child, void **p_result)
{
    node_type parent(p_parent);
    node_type ref_child(ref_child);

    node_type result = parent.appendChild(TreeBuilderHandler::type_from_hubbub(type));

    if (result.empty()) {
        return HUBBUB_UNKNOWN;
    }
    *p_result = static_cast<void*>(result);
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::remove_child(void *ctx, void *p_parent, void *p_child)
{
    node_type parent(p_parent);
    node_type child(child);

    bool result = parent.removeChild(child);

    if (!result) {
        return HUBBUB_UNKNOWN;
    }
    return HUBBUB_OK;
}

//FIXME change hubbub api to specify new parent
hubbub_error TreeBuilderHandler::clone_node(void *ctx, void *p_node, bool deep, void **p_result)
{
    node_type node(p_node);
    node_type result;
    for (attribute_type attr : node.attributes()) {
        result.appendCopy(attr);
    }
    if (deep) {
        for (node_type child : node) {
            result.appendChild(child);
        }
    }
    *p_result = static_cast<void*>(result);
    return HUBBUB_OK;
}

//TODO true move
hubbub_error TreeBuilderHandler::reparent_children(void *ctx, void *p_node, void *p_new_parent)
{
    node_type node(p_node);
    node_type new_parent(p_new_parent);

    std::vector<node_type> old_children;
    for (node_type child : node) {
        new_parent.appendChild(child);
        old_children.push_back(child);
    }
    for (node_type child : old_children) {
        node.removeChild(child);
    }
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::get_parent(void *ctx, void *p_node, bool element_only, void **p_result)
{
    node_type node(p_node);

    node_type result = node.parent();

    if (result.empty()) {
        return HUBBUB_UNKNOWN;
    }
    *p_result = static_cast<void*>(result);
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::has_children(void *ctx, void *p_node, bool *result)
{
    node_type node(p_node);

    *result = !node.firstChild().empty();

    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::form_associate(void *ctx, void *p_form, void *p_node)
{
    //FIXME
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::set_name(void *ctx, void *p_node, const hubbub_string *name)
{
    node_type node(p_node);

    node.setName(TreeBuilderHandler::string_from_hubbub(*name));

    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::set_value(void *ctx, void *p_node, const hubbub_string *value)
{
    node_type node(p_node);

    node.setValue(TreeBuilderHandler::string_from_hubbub(*value));

    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::add_attributes(void *ctx, void *p_node, const hubbub_attribute *attributes, uint32_t n_attributes)
{
    node_type node(p_node);

    for (int i = 0; i < int(n_attributes); i++)
    {
        const hubbub_attribute h_attr = attributes[i];
        attribute_type attr = node.appendAttribute(TreeBuilderHandler::string_from_hubbub(h_attr.name));
        attr.setValue(TreeBuilderHandler::string_from_hubbub(h_attr.value));
    }

    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::set_quirks_mode(void *ctx, hubbub_quirks_mode mode)
{
    // FIXME
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::encoding_change(void *ctx, const char *encname)
{
    // FIXME
    return HUBBUB_OK;
}

hubbub_error TreeBuilderHandler::complete_script(void *ctx, void *script)
{
    // FIXME
    return HUBBUB_OK;
}

XMLNodeType TreeBuilderHandler::type_from_hubbub(hubbub_token_type type)
{
    switch (type) {
    case HUBBUB_TOKEN_DOCTYPE:
        return XMLNodeType::Doctype;

    case HUBBUB_TOKEN_START_TAG:
        return XMLNodeType::Element;

    case HUBBUB_TOKEN_END_TAG:
        // FIXME ?
        return XMLNodeType::Element;

    case HUBBUB_TOKEN_COMMENT:
        return XMLNodeType::Comment;

    case HUBBUB_TOKEN_CHARACTER:
        return XMLNodeType::Pcdata;

    case HUBBUB_TOKEN_EOF:
        //FIXME

    default:
        break;
    }

    return XMLNodeType::Null;
}

const TreeBuilderHandler::string_type
TreeBuilderHandler::string_from_hubbub(const hubbub_string& str)
{
    return string_type(reinterpret_cast< const char* >(str.ptr), str.len);
}

void TreeBuilder_Hubbub::hubbub_from_tk(hubbub_token* h_tok, Tk tok)
{
    h_tok->data.tag.n_attributes = 0;
    h_tok->data.tag.attributes = nullptr;

    switch (tok.type()) {
        case TokenType::Abstract:
            //FIXME
            std::cerr << "got abstract token!" << std::endl;
            break;
        case TokenType::StartTag:
            h_tok->type = HUBBUB_TOKEN_START_TAG;
            hubbub_from_string(&h_tok->data.tag.name, tok.getName());
            h_tok->data.tag.n_attributes = tok.attributes().size();
            h_tok->data.tag.attributes = static_cast<hubbub_attribute*>(
                TreeBuilder_Hubbub::hubbubAllocator(
                    nullptr,
                    sizeof(hubbub_attribute) * (tok.attributes().size() + 1),
                    nullptr
                )
            );
            {
                int index = 0;
                for (pair<vector<Tk>, vector<Tk>> p : tok.attributes()) {
                    hubbub_from_string(&h_tok->data.tag.attributes[index].name, p.first[0].getText());
                    hubbub_from_string(&h_tok->data.tag.attributes[index].value, p.second[0].getText());
                    index++;
                }
            }
            break;
        case TokenType::EndTag:
            h_tok->type = HUBBUB_TOKEN_END_TAG;
            hubbub_from_string(&h_tok->data.tag.name, tok.getName());
            break;
        case TokenType::Text:
            h_tok->type = HUBBUB_TOKEN_CHARACTER;
            hubbub_from_string(&h_tok->data.character, tok.getText());
            break;
        case TokenType::Comment:
            h_tok->type = HUBBUB_TOKEN_COMMENT;
            hubbub_from_string(&h_tok->data.comment, tok.getText());
            break;
        case TokenType::Nl:
            h_tok->type = HUBBUB_TOKEN_CHARACTER;
            hubbub_from_string(&h_tok->data.character, "\n");
            break;
        case TokenType::Eof:
            h_tok->type = HUBBUB_TOKEN_EOF;
            break;
    }
    //h_tok.type = HUBBUB_TOKEN_DOCTYPE; FIXME
    //FIXME HUBBUB_TOKEN_EOF
}

void TreeBuilder_Hubbub::hubbub_from_string(hubbub_string* h_str, const string& str)
{
    h_str->ptr = reinterpret_cast<const uint8_t*>(str.c_str());
    h_str->len = str.length();
}


}
