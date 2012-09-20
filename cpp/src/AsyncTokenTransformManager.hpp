#include "parsoid_internal.hpp"

namespace parsoid {

class AsyncTokenTransformManager
    : public TokenTransformManagerBase<TokenMessageReceiver>
{
    public:
        AsyncTokenTransformManager(bool isAtToplevel)
            : TokenTransformManagerBase<TokenMessageReceiver>(isAtToplevel) {}
        void receive ( TokenMessage message ) {
            // We are not doing anything useful currently..
            receiver( message );
        }
};

} // namespace parsoid

