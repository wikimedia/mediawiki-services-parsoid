#ifndef __HAVE_INPUT_EXPANSION__
#define __HAVE_INPUT_EXPANSION__

#include "parsoid_internal.hpp"

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
            tokenizer.setReceiver( syncTransformManager );

            // Hook up to SyncTokenTransformManager
            syncTransformManager.setReceiver( asyncTransformManager );
        }

        void receive ( const string& input ) {
            tokenizer.setInput( input );
            // FIXME: in loop / looping async task?
            emit( tokenizer.tokenize() );
        }


    private:
        WikiTokenizer tokenizer;
        SyncTokenTransformManager syncTransformManager;
        AsyncTokenTransformManager asyncTransformManager;
};

} // namespace parsoid

#endif
