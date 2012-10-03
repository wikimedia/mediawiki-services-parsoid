#ifndef __HAVE_PIPELINE_PHASE__
#define __HAVE_PIPELINE_PHASE__

namespace parsoid {

template< input_type >
class InputStage {
public:
    void receive( input_type msg ) = 0;
}

template< output_type >
class OutputStage {
public:
    typedef typename InputStage< output_type > receiving_object_type;
    typedef typename void( output_type ) receiving_function_type;

    void setReceiver( receiving_object_type receiver ) {
        setReceiver( boost::bind( &receiving_object_type::receive, receiver, _1 ) );
    }

    void setReceiver( receiving_function_type receiver ) {
        emit = receiver;
    }

protected:
    receiving_function_type emit;
}


template< input_type, output_type >
/* abstract */ class PipelineStage
    : public InputStage< input_type >
    , public OutputStage< output_type >
{};


}

#endif
