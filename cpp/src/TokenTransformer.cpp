#include "TokenTransformer.hpp"

namespace parsoid {

template <class HandlerT>
TokenTransformer<HandlerT>::TokenTransformer (manager_type& manager)
    : manager(manager)
{
    manager.addTransformer( this );
}

template <class HandlerT>
void
TokenTransformer<HandlerT>::addHandler(HandlerT& handler) {
    handler.rank = baseRank;
    manager.addHandler( handler );
}

template <class HandlerT>
void
TokenTransformer<HandlerT>::addHandler(
        HandlerT& handler
        , const HandlerT& afterHandler )
{
    handler.rank = afterHandler.rank + HANDLER_DELTA;
    manager.addHandler( handler );
}

} // namespace parsoid
