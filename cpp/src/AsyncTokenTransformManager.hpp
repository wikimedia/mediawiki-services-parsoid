#ifndef __HAVE_ASYNC_TRANSFORM_MANAGER__
#define __HAVE_ASYNC_TRANSFORM_MANAGER__

#include "TokenTransformer.hpp"

namespace parsoid {

typedef function<void(TokenMessage)> async_handler_cb_type;
typedef function<TokenMessage( Tk token
    , const Frame& frame, async_handler_cb_type cb )> async_handler_type;

class AsyncTokenTransformManager
    : public TokenTransformManager<TokenTransformer<async_handler_type>>
{
    public:
        AsyncTokenTransformManager(enum Options flags, float baseRank)
            : TokenTransformManager(flags, baseRank) {}
        void receive ( TokenMessage message ) {
            // We are not doing anything useful currently..
            emit( message );
        }
};

} // namespace parsoid

#endif
