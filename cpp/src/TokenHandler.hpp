#ifndef __HAVE_TOKENHANDLER_HPP__
#define __HAVE_TOKENHANDLER_HPP__

#include "LibIncludes.hpp"
#include "Token.hpp"
#include "Scope.hpp"

namespace parsoid {

/**
 * A token handler (callback per-token)
 */
template <class HandlerT>
class TokenHandler
{
    friend class TokenTransformer;
    friend class TokenTransformManagerBase;
    public:
        // Non-tag tokens
        TokenHandler(HandlerT handle, TokenType type)
            : handle(handle), type(type)
        {};

        // Tag tokens
        TokenHandler(HandlerT handle, TokenType type, const string& name)
            : handle(handle), type(type), name(name)
        {};

    protected:
        // Don't default-construct.
        TokenHandler() = default;

        // Set by TokenTransformer::addHandler
        float rank;

        // The actual handler callable
        HandlerT handle;

        // Info needed for efficient removal
        TokenType type;
        string name;
};

} // namespace parsoid

#endif
