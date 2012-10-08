#ifndef __HAVE_QUEUE_DISPATCHER__
#define __HAVE_QUEUE_DISPATCHER__

#include <boost/asio.hpp>

#include "LibIncludes.hpp"
#include "Token.hpp"

namespace parsoid
{
using namespace boost;
using namespace boost::asio;
/**
 * An async / concurrent queue and ASIO-integrated schedule helper class
 */
template < class ChunkType >
class QueueDispatcher {
    public:
        /**
         * Constructor and receiver setup
         */
        QueueDispatcher( io_service& io, TokenMessageReceiver receiver )
            : io( io )
            , isActive(false)
            { };

        /**
         * Set the per-item receiver
         */
        void setReceiver(TokenMessageReceiver receiver);

        // The receiver callback
        void operator()( TokenMessage ret );

        // The main loop: Dequeues items and passes them to the receiver
        void senderLoop();
    private:
        bool isActive;
        bool haveEndOfInput;
        TokenMessageReceiver receiver;
        io_service& io;
        // TODO: use concurrent_queue from TBB later!
        std::deque<ChunkType> queue;
};

} // namespace parsoid

#endif
