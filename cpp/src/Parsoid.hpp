// Create minimal external header with interface types
#include "parsoid_internal.hpp"

namespace parsoid {

/**
 * The main Parsoid setup class
 */
class Parsoid {
    public:
        Parsoid();
        void parse( string input, DOM::DocumentReceiver receiver );
        // Overloaded sync version
        DOM::XMLDocument* parse( string input );

        void setReceiver( DOM::DocumentReceiver receiver ) {
            this->receiver = receiver;
        }
    private:
        /**
         * The main input / expansion pipeline
         */
        InputExpansionPipeline mainInputExpansionPipeline;

        /**
         * The output pipeline, created by the constructor
         */
        OutputPipeline syncOutputPipeline;

        // The document receiver
        DOM::DocumentReceiver receiver;
};


} // namespace parsoid
