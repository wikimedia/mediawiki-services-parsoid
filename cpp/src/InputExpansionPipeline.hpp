#include "parsoid_internal.hpp"
#include "PipelineStage.hpp"

namespace parsoid {

class InputExpansionPipeline
    : public PipelineStage<const string&, TokenMessage>
{

    public:
        // TODO: pass in environment
        InputExpansionPipeline( bool isAtToplevel )
            : syncTransformManager( isAtToplevel )
            , asyncTransformManager( isAtToplevel )
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


    private:
        WikiTokenizer tokenizer;
        SyncTokenTransformManager syncTransformManager;
        AsyncTokenTransformManager asyncTransformManager;
};

} // namespace parsoid
