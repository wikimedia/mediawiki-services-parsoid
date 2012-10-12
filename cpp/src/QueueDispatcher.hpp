#ifndef __HAVE_QUEUE_DISPATCHER__
#define __HAVE_QUEUE_DISPATCHER__

#include <boost/asio.hpp>

#include "LibIncludes.hpp"
#include "Token.hpp"
#include "PipelineStage.hpp"

namespace parsoid
{
using namespace boost;
using namespace boost::asio;
/**
 * An async / concurrent queue and ASIO-integrated schedule helper class
 */
template < class ChunkType >
class QueueDispatcher
    :public PipelineStage<ChunkType, ChunkType>
{
    public:
        /**
         * Constructor and receiver setup
         */
        QueueDispatcher( io_service& io )
            : io( io )
            , isActive(false)
            { };

        // The main loop: Dequeues items and passes them to the receiver
        void senderLoop();

        void receive ( ChunkType ret );

    private:
        bool isActive;
        bool haveEndOfInput;
        io_service& io;
        // TODO: use concurrent_queue from TBB later!
        std::deque<ChunkType> queue;
};

} // namespace parsoid

#endif
