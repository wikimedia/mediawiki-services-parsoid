#ifndef __HAVE_TOKENTRANSFORMER_HPP__
#define __HAVE_TOKENTRANSFORMER_HPP__

#include "LibIncludes.hpp"
#include "Token.hpp"
#include "TokenTransformManager.hpp"

namespace parsoid {

// forward declaration
//template <class TokenTransformerT> class TokenTransformManager;

/**
 * Token transformers are transform the token stream by registering one or
 * more TokenHandlers
 */
template <class HandlerT>
class TokenTransformer
{
    public:
        typedef HandlerT handler_type;
        typedef TokenTransformer<HandlerT> transformer_type;
        typedef TokenTransformManager<transformer_type> manager_type;

        TokenTransformer(manager_type& manager);
        void setBaseRank(float rank) {
            baseRank = rank;
        }
        virtual ~TokenTransformer();
    protected:
        // Basic transformation interface
        void addHandler( HandlerT& handler );

        /**
         * Basic transformations, give precedence to other transformation
         * - uses afterHandler's rank as the new base
         */
        void addHandler( HandlerT& handler, const HandlerT& afterHandler );
        void removeHandler( const HandlerT& handler );
    private:
        float baseRank;
        TokenTransformManager<transformer_type>& manager;
};

}

#endif
