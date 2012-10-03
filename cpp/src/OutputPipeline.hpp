#include "parsoid_internal.hpp"


namespace parsoid {

// FIXME
class DOMPostProcessor {};

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
            // syncTransformManager.setReceiver( treeBuilder );

            // Hook up the (default constructed) DOM postprocessor to the
            // treebuilder
            //treeBuilder.setReceiver( postProcessor );
        }

        void receive ( TokenMessage message ) {
            // Feed the SyncTokenTransformManager
            syncTransformManager.receive( message );
        }

    private:
        SyncTokenTransformManager syncTransformManager;
        TreeBuilder treeBuilder;
        DOMPostProcessor postProcessor;
};

} // namespace parsoid
