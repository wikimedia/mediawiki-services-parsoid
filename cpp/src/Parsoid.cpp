#include "parsoid_internal.hpp"
#include <boost/bind.hpp>
#include <boost/function.hpp>

namespace parsoid {
using boost::function;
using boost::bind;
using std::string;
Parsoid::Parsoid ()
    : mainInputExpansionPipeline( InputExpansionPipeline( true ) )
{
    // Create a new environment per request



    // Create the main input pipeline
    // TODO: pass in environment
    //mainInputExpansionPipeline = InputExpansionPipeline( true );

    // Create the output pipeline
    // TODO: pass in environment
    syncOutputPipeline = OutputPipeline();

    // Hook up the output pipeline to the input pipeline
    //mainInputExpansionPipeline.setReceiver( syncOutputPipeline );
}

void assign( string& target, const string& value ) { target.assign( value ); }

string Parsoid::parse( string input ) {
    string out;
    // define a callback that appends to string
    // TODO: actually handle TokenMessage in callback!
    auto cb = bind( assign, boost::ref(out), _1 );
    parse( input, cb );
    return out;
}

void Parsoid::parse( string input, DocumentReceiver receiver ) {
    // Set the syncOutputPipeline receiver
    syncOutputPipeline.setReceiver( receiver );

    // Feed the input pipeline
    mainInputExpansionPipeline.receive( input );
}


}
