#include "parsoid_internal.hpp"

namespace parsoid
{


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


} // namespace parsoid
