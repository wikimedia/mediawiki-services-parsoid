#include "parsoid_internal.hpp"

namespace parsoid {

Parsoid::Parsoid ()
    : mainInputExpansionPipeline( true )
    , syncOutputPipeline()
{
    // Create a new environment per request
    // TODO: pass environment to pipeline ctors

    // Hook up the output pipeline to the input pipeline
    mainInputExpansionPipeline.setReceiver( syncOutputPipeline );
}

DOM::XMLDocumentPtr Parsoid::parse( string input ) {
    DOM::XMLDocumentPtr doc;
    // define a callback that appends to string
    // TODO: actually handle TokenMessage in callback!
    auto setDoc = [&] ( DOM::XMLDocumentPtr value ) { doc = value; };
    parse( input, setDoc );
    return doc;
}

void Parsoid::parse( string input, DOM::DocumentReceiver receiver ) {
    // Set the syncOutputPipeline receiver
    syncOutputPipeline.setReceiver( receiver );

    // Feed the input pipeline
    mainInputExpansionPipeline.receive( input );
}


}
