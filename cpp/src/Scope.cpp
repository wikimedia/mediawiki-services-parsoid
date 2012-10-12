#include "Scope.hpp"

// Include Parsoid here, since we only have a fwd declaration in the header
#include "Parsoid.hpp"

namespace parsoid {

Scope::Scope (string title, Parsoid* parsoid)
    : title(title), parsoid(parsoid)
{}

Scope::Scope (string title, const Scope* parent, AttribMap&& params)
    : depth(parent->depth + 1)
    , parent(parent)
    , title(title)
    , parsoid(parent->parsoid)
    , params(params)
{}


} // namespace parsoid
