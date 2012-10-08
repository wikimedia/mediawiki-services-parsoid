#ifndef __HAVE_SYNC_MANAGER__
#define __HAVE_SYNC_MANAGER__

#include "TokenTransformManagerBase.hpp"

namespace parsoid {

class SyncTokenTransformManager
    : public TokenTransformManagerBase<TokenMessageTransformer>
{
    public:
        SyncTokenTransformManager(bool isAtToplevel)
            : TokenTransformManagerBase<TokenMessageTransformer>( isAtToplevel ) {}

        void receive( TokenMessage message ) {
            // We are not doing anything useful currently..
            emit( message );
        }
};

} // namespace parsoid


#endif
