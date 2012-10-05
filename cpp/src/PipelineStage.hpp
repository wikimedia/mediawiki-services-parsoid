#ifndef __HAVE_PIPELINE_PHASE__
#define __HAVE_PIPELINE_PHASE__

#include <boost/function.hpp>

namespace parsoid {

using boost::function;

template< class input_type >
class InputStage {
public:
    void receive( input_type msg );
};

template< typename output_type >
class OutputStage {
public:
    //typedef InputStage< output_type > receiving_object_type;
    typedef function<void( output_type )> receiving_function_type;

    template <class receiving_object_type>
    void setReceiver( receiving_object_type& receiver ) {
        emit = boost::bind( &receiving_object_type::receive, boost::ref(receiver), _1 );
    }

    void setReceiver( receiving_function_type receiver ) {
        emit = receiver;
    }

protected:
    receiving_function_type emit;
};


template< class input_type, class output_type >
/* abstract */ class PipelineStage
    : public InputStage< input_type >
    , public OutputStage< output_type >
{};


}

#endif
