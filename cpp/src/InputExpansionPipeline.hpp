#ifndef __HAVE_INPUT_EXPANSION__
#define __HAVE_INPUT_EXPANSION__

#include "Token.hpp"
#include "PipelineStage.hpp"
#include "WikiTokenizer.hpp"
#include "SyncTokenTransformManager.hpp"
#include "AsyncTokenTransformManager.hpp"

namespace parsoid {

class InputExpansionPipeline
    : public PipelineStage<const string&, TokenMessage>
{

    public:
        // TODO: pass in environment
        InputExpansionPipeline( bool isAtToplevel )
            : syncTransformManager( SyncTokenTransformManager::Options::atTopLevel, 0.0 )
            , asyncTransformManager( AsyncTokenTransformManager::Options::atTopLevel, 1.0 )
        {
            // Hook up to tokenizer
            tokenizer.setReceiver( syncTransformManager );

            // Hook up to SyncTokenTransformManager
            syncTransformManager.setReceiver( asyncTransformManager );
        }

        void receive ( const string& input ) {
            // FIXME input is not a shareable pointer if async
            tokenizer.setInput( &input );
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
