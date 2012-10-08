#ifndef __HAVE_TOKEN_TRANSFORM_BASE__
#define __HAVE_TOKEN_TRANSFORM_BASE__

#include "LibIncludes.hpp"
#include "Token.hpp"
#include "PipelineStage.hpp"

namespace parsoid {


template <typename HandlerType>
class TokenTransformManagerBase
    : public PipelineStage< TokenMessage, TokenMessage >
{
    public:
        typedef pair<float, HandlerType> TokenHandler;
        // The constructor
        TokenTransformManagerBase();
        TokenTransformManagerBase( bool isAtToplevel ) {}

        /**
         * Register a token transformer
         */
        void addTransform( HandlerType receiver,
                float rank, TokenType type );
        /**
         * Register a token transformer, version for tags
         */
        void addTransform( HandlerType receiver,
                float rank, TokenType type, string name );
        /**
         * Remove a token transformer
         */
        void removeTransform( float rank, TokenType type );
        void removeTransform( float rank, TokenType type, string name );

        ~TokenTransformManagerBase() {
            // TODO: delete all registered transforms
        }
    protected:
        /**
         * Get iterator to the transforms for the current token type & name.
         * Returns a merged iterator for both anyHandlers and the matching
         * per-token-type handlers.
         */
        typename vector<TokenHandler>::const_iterator
        getTransforms(float minRank, TokenType type);

        typename vector<TokenHandler>::const_iterator
        getTransforms(float minRank, TokenType type, string name);

        // Handler registrations
        vector<TokenHandler> anyHandlers; // TokenType Abstract
        map<string, vector<TokenHandler>> startTagHandlers;
        map<string, vector<TokenHandler>> endTagHandlers;
        vector<TokenHandler> textHandlers;
        vector<TokenHandler> commentHandlers;
        vector<TokenHandler> nlHandlers;
        vector<TokenHandler> eofHandlers;

};


} // namespace parsoid

#endif
