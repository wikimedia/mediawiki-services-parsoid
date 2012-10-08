#ifndef __HAVE_ASYNC_TRANSFORM_MANAGER__
#define __HAVE_ASYNC_TRANSFORM_MANAGER__

#include "TokenTransformManagerBase.hpp"

namespace parsoid {

class AsyncTokenTransformManager
    : public TokenTransformManagerBase<TokenMessageReceiver>
{
    public:
        AsyncTokenTransformManager(bool isAtToplevel)
            : TokenTransformManagerBase<TokenMessageReceiver>(isAtToplevel) {}
        void receive ( TokenMessage message ) {
            // We are not doing anything useful currently..
            emit( message );
        }
};

} // namespace parsoid

#endif
