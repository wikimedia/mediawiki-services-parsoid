#include "parsoid_internal.hpp"

namespace parsoid
{

TreeBuilder::TreeBuilder()
    : document(new DOM::XMLDocument)
    , hubbubTreeBuilder(nullptr)
{
    hubbub_error error;

    error = hubbub_treebuilder_create(
        &TreeBuilder::hubbubAllocator,
        NULL,
        &hubbubTreeBuilder
    );
    if (error != HUBBUB_OK) {
        throw "Not ok";
    }

    callbacks = TreeBuilderHandler::get_handler();
    callbacks.ctx = static_cast<void *>(this);
    hubbub_treebuilder_optparams params;
    params.tree_handler = &callbacks;
    hubbub_treebuilder_setopt(
        hubbubTreeBuilder,
        HUBBUB_TREEBUILDER_TREE_HANDLER,
        &params
    );

    reset();
}

TreeBuilder::~TreeBuilder()
{
    if (document->root().firstChild()) {
        std::cerr << "ERROR: EOF not received. Final document contents:" << std::endl;
        std::cerr << *document;
    }
    reset();
    if (hubbubTreeBuilder) {
        hubbub_treebuilder_destroy(hubbubTreeBuilder);
    }
}

void TreeBuilder::reset()
{
    document->reset();

    if (hubbubTreeBuilder) {
        hubbub_treebuilder_optparams params;
        params.document_node = static_cast<void*>(document->root());
        hubbub_treebuilder_setopt(hubbubTreeBuilder, HUBBUB_TREEBUILDER_DOCUMENT_NODE, &params);
    }
}

void TreeBuilder::receive(TokenMessage message)
{
    // Iterate through chunk, convert each token to stack-allocated
    // libhubbub token and feed each to libhubbub tree builder
    //
    // If EofTk is found, call receiver( DOM );

    for (TokenChunkPtr chunk : message.getChunks())
    {
        for (Tk tok : chunk->getChunk())
        {
            //std::cerr << "h_tokening: " << tok.toString() << std::endl;

            hubbub_token h_tok;
            hubbub_from_tk(&h_tok, tok);
            hubbub_treebuilder_token_handler(&h_tok, hubbubTreeBuilder);
            if (h_tok.data.tag.attributes) {
                TreeBuilder::hubbubAllocator(
                    h_tok.data.tag.attributes,
                    0,
                    nullptr
                );
            }

            if (tok.type() == TokenType::Eof)
            {
                emit(document);
                reset();
            }
        }
    }
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

void TreeBuilder::hubbub_from_tk(hubbub_token* h_tok, Tk tok)
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
                TreeBuilder::hubbubAllocator(
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

void TreeBuilder::hubbub_from_string(hubbub_string* h_str, const string& str)
{
    h_str->ptr = reinterpret_cast<const uint8_t*>(str.c_str());
    h_str->len = str.length();
}

} // namespace parsoid
