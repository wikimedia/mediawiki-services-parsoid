#include "parsoid_internal.hpp"

namespace parsoid {

class AsyncTokenTransformManager
    : public TokenTransformManagerBase<TokenMessageReceiver>
{
    public:
        AsyncTokenTransformManager(bool isAtToplevel)
            : TokenTransformManagerBase<TokenMessageReceiver>(isAtToplevel) {}
        void receive ( TokenMessage message ) {}
};

} // namespace parsoid

