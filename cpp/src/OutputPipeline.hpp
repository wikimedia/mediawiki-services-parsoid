#include "parsoid_internal.hpp"


namespace parsoid {
using std::string;

// FIXME
typedef boost::function<void(string)> DocumentReceiver;
class TreeBuilder {};
class DOMPostProcessor {};

class OutputPipeline {
    public:
        OutputPipeline()
            : syncTransformManager( SyncTokenTransformManager( false ) )
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

        void setReceiver ( DocumentReceiver receiver ) {
            receiver = receiver;
        }

    private:
        SyncTokenTransformManager syncTransformManager;
        TreeBuilder treeBuilder;
        DOMPostProcessor postProcessor;
        // The output receiver
        DocumentReceiver receiver;
};

} // namespace parsoid
