#include "parsoid_internal.hpp"


namespace parsoid {

class InputExpansionPipeline {

    public:
        // TODO: pass in environment
        InputExpansionPipeline( bool isAtToplevel )
            : syncTransformManager( SyncTokenTransformManager( isAtToplevel ) )
            , asyncTransformManager( AsyncTokenTransformManager( isAtToplevel ) )
        {
            // Hook up to tokenizer
            tokenizer.setReceiver(
                bind( &SyncTokenTransformManager::receive, &syncTransformManager, _1 )
            );

            // Hook up to SyncTokenTransformManager
            syncTransformManager.setReceiver(
                bind( &AsyncTokenTransformManager::receive, &asyncTransformManager, _1 )
            );

        }

        void receive ( const string& input ) {
            tokenizer.setInput( input );
            // FIXME: in loop / looping async task?
            tokenizer.tokenize();
        }

        void setReceiver( TokenMessageReceiver receiver ) {
            this->receiver = receiver;
        }

    private:
        WikiTokenizer tokenizer;
        SyncTokenTransformManager syncTransformManager;
        AsyncTokenTransformManager asyncTransformManager;
        TokenMessageReceiver receiver;
};

} // namespace parsoid
