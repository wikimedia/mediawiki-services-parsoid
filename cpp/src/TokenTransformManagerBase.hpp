#include "parsoid_internal.hpp"
#include <vector>
#include <map>

namespace parsoid {

using std::string;
using std::vector;
using std::map;


template <typename HandlerType>
class TokenTransformManagerBase {
    public:
        typedef pair<float, HandlerType> TokenHandler;
        // The constructor
        TokenTransformManagerBase();
        TokenTransformManagerBase( bool isAtToplevel );

        void setReceiver( TokenMessageReceiver receiver ) {
            this->receiver = receiver;
        }

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

        TokenMessageReceiver receiver;

};


} // namespace parsoid
