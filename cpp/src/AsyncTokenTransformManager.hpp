#ifndef __HAVE_ASYNC_TRANSFORM_MANAGER__
#define __HAVE_ASYNC_TRANSFORM_MANAGER__

#include "TokenTransformer.hpp"
#include "Scope.hpp"

namespace parsoid {

typedef function<void(TokenMessage)> async_handler_cb_type;
typedef function<TokenMessage( Tk token
    , const Scope* scope, async_handler_cb_type cb )> async_handler_type;

class AsyncTokenTransformManager
    : public TokenTransformManager<TokenTransformer<async_handler_type>>
{
    public:
        AsyncTokenTransformManager(Scope* scope, float baseRank)
            : TokenTransformManager(scope, baseRank)
        {}
        void receive ( TokenMessage message ) {
            // We are not doing anything useful currently..
            emit( message );

            // for ( async_handler_type handler: getHandlers ) {
            //      res = handler( token, scope, maybeSyncReturnCB );
            //      // handle result..
            // }
            // emit ( new chunk );
            //
        }
    private:
};

} // namespace parsoid

#endif
