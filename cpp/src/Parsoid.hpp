// Create minimal external header with interface types
#include "parsoid_internal.hpp"

namespace parsoid {

using std::string;

/**
 * The main Parsoid setup class
 */
class Parsoid {
    public:
        Parsoid();
        void parse( string input, DocumentReceiver receiver );
        // Overloaded sync version
        string parse( string input );

        void setReceiver( DocumentReceiver receiver ) {
            receiver = receiver;
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
        DocumentReceiver receiver;
};


} // namespace parsoid
