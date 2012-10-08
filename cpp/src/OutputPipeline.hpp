#ifndef __HAVE_OUTPUT_PIPELINE__
#define __HAVE_OUTPUT_PIPELINE__

#include "XMLDOM_Pugi.hpp"
#include "TreeBuilder_Hubbub.hpp"
#include "SyncTokenTransformManager.hpp"


namespace parsoid {

// FIXME
class DOMPostProcessor
    : public PipelineStage<DOM::XMLDocumentPtr, DOM::XMLDocumentPtr>
{
public:
    void receive(DOM::XMLDocumentPtr doc)
    {
        emit(doc);
    }
};

class OutputPipeline
    : public PipelineStage<TokenMessage, DOM::XMLDocumentPtr>
{
    public:
        OutputPipeline()
            : syncTransformManager( false )
        {
            // Create handlers and implicitly register them with this manager
            // new QuoteHandler( *this );
            // new ListHandler( *this );
            // new BehaviorSwitchHandler( *this );
            // new CiteHandler( *this );
            // new PreHandler( *this );
            // new PostExpandParagraphHandler( *this );
            // new SanitizerHandler( *this );

            // Hook up the (default constructed) treeBuilder with the
            // syncTransformManager
            syncTransformManager.setReceiver( treeBuilder );

            // Hook up the (default constructed) DOM postprocessor to the
            // treebuilder
            treeBuilder.setReceiver( postProcessor );
        }

        void receive ( TokenMessage message ) {
            // Feed the SyncTokenTransformManager
            syncTransformManager.receive( message );
        }

        void setReceiver(function<void(DOM::XMLDocumentPtr)> receiver) {
            postProcessor.setReceiver(receiver);
        }

    private:
        SyncTokenTransformManager syncTransformManager;
        TreeBuilder_Hubbub treeBuilder;
        DOMPostProcessor postProcessor;
};

} // namespace parsoid

#endif
