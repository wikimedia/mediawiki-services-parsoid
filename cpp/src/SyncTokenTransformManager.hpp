#ifndef __HAVE_SYNC_MANAGER__
#define __HAVE_SYNC_MANAGER__

#include "TokenTransformer.hpp"

namespace parsoid {


typedef function<TokenMessage( Tk token, const Frame& frame )> sync_handler_type;


class SyncTokenTransformManager
    : public TokenTransformManager<TokenTransformer<sync_handler_type> >
{
    public:
        // async APIs
        typedef function<void(TokenMessage)> handler_cb_type;
        typedef function<TokenMessage( Tk token
            , const Frame& frame, handler_cb_type cb )> handler_type;

        SyncTokenTransformManager(enum Options flags, float baseRank)
            : TokenTransformManager(flags, baseRank) {}

        void receive( TokenMessage message ) {
            // We are not doing anything useful currently..
            emit( message );
        }
};

} // namespace parsoid


#endif
