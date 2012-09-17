#include "parsoid_internal.hpp"
#include <boost/bind.hpp>


namespace parsoid {
using std::string;

class InputExpansionPipeline {

    public:
        // TODO: pass in environment
        InputExpansionPipeline( bool isAtToplevel )
            : syncTransformManager( SyncTokenTransformManager( isAtToplevel ) )
            , asyncTransformManager( AsyncTokenTransformManager( isAtToplevel ) )
        {
            // Hook up to tokenizer
            //tokenizer.setReceiver(
            //        boost::bind( &SyncTokenTransformManager::receive, syncTransformManager )
            //);

            //// Hook up to SyncTokenTransformManager
            //syncTransformManager.setReceiver(
            //        boost::bind( &AsyncTokenTransformManager::receive, asyncTransformManager )
            //);

        }

        void receive ( const string& input ) {
            tokenizer.setInput( input );
            // FIXME: in loop / looping async task?
            tokenizer.tokenize();
        }

        void setReceiver( TokenMessageReceiver receiver ) {
            receiver = receiver;
        }

    private:
        WikiTokenizer tokenizer;
        SyncTokenTransformManager syncTransformManager;
        AsyncTokenTransformManager asyncTransformManager;
        TokenMessageReceiver receiver;
};

} // namespace parsoid
