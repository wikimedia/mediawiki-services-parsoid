#ifndef __HAVE_TOKEN_TRANSFORM_MANAGER__
#define __HAVE_TOKEN_TRANSFORM_MANAGER__

#include "LibIncludes.hpp"
#include "Token.hpp"
#include "PipelineStage.hpp"
#include "TokenHandler.hpp"
#include "TokenTransformer.hpp"

namespace parsoid {


template <class TokenTransformerT>
class TokenTransformManager
    : public PipelineStage<TokenMessage, TokenMessage>
{
    public:

        /**
         * Options
         */
        enum class Options {
            none = 0,
            atTopLevel = 1
        };

        typedef typename TokenTransformerT::handler_type handler_type;


        // The constructor
        TokenTransformManager();
        TokenTransformManager (enum Options flags, float baseRank)
            : flags(flags), baseRank(baseRank)
        {}

        /**
         * Register a token transformer
         */
        void addTransformer( TokenTransformerT* transformer );

        /**
         * Register a token handler
         */
        void addHandler( handler_type& handler );
        /**
         * Remove a token handler
         */
        void removeHandler( handler_type receiver );

        // FIXME: move back to .cpp (see comment there)
        ~TokenTransformManager() {
            // delete all registered transformers
            for ( TokenTransformerT* t: transformers ) {
                delete t;
            }
        }
    protected:
        // The token transformers
        vector<TokenTransformerT*> transformers;

        /**
         * Get iterator to the transforms for the current token type & name.
         * Returns a merged iterator for both anyHandlers and the matching
         * per-token-type handlers.
         */
        typename vector<handler_type>::const_iterator
        getHandlers(float minRank, TokenType type);

        typename vector<handler_type>::const_iterator
        getHandlers(float minRank, TokenType type, string name);

        // Handler registrations
        vector<handler_type> anyHandlers; // TokenType Abstract
        map<string, vector<handler_type>> startTagHandlers;
        map<string, vector<handler_type>> endTagHandlers;
        vector<handler_type> textHandlers;
        vector<handler_type> commentHandlers;
        vector<handler_type> nlHandlers;
        vector<handler_type> eofHandlers;

        Options flags;
        float baseRank;

};

/**
 * Provide operator| for TokenTransformManager options
 *
 * TODO: makes this a bit more.... readable ;)
 */
template <class TokenTransformerT>
inline typename TokenTransformManager<TokenTransformerT>::Options operator|(
          typename TokenTransformManager<TokenTransformerT>::Options a
        , typename TokenTransformManager<TokenTransformerT>::Options b) {
    return static_cast<typename TokenTransformManager<TokenTransformerT>::Options>(
            static_cast<unsigned int>(a)
            | static_cast<unsigned int>(b));
}

} // namespace parsoid

#endif
