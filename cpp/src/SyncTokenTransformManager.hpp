#include "parsoid_internal.hpp"

namespace parsoid {

class SyncTokenTransformManager
    : public TokenTransformManagerBase<TokenMessageTransformer>
{
    public:
        SyncTokenTransformManager(bool isAtToplevel)
            : TokenTransformManagerBase<TokenMessageTransformer>( isAtToplevel ) {}

        void receive( TokenMessage message ) {
            // We are not doing anything useful currently..
            receiver( message );
        }
};

} // namespace parsoid

