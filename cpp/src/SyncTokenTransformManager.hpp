#include "parsoid_internal.hpp"

namespace parsoid {

class SyncTokenTransformManager
    : public TokenTransformManagerBase<TokenMessageTransformer>
{
    public:
        SyncTokenTransformManager(bool isAtToplevel)
            : TokenTransformManagerBase<TokenMessageTransformer>( isAtToplevel ) {}

        void receive( TokenMessage message ) {}
};

} // namespace parsoid

