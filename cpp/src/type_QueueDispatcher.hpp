#include <boost/asio.hpp>
#include <boost/bind.hpp>
#include <boost/function.hpp>
#include <queue>

#include "parsoid_internal.hpp"

namespace parsoid {
    using namespace boost;
    using namespace boost::asio;
    /**
     * An async / concurrent queue and ASIO-integrated schedule helper class
     */
    template < class ChunkType >
    class QueueDispatcher {
    public:
        /**
         * Constructor and handler setup
         */
        QueueDispatcher( io_service& io, TokenMessageReceiver handler )
            : io( io )
            , isActive(false)
        { };

        /**
         * Set the per-item handler
         */
        void setHandler(TokenMessageReceiver handler);

        // The handler callback
        void operator()( TokenMessage ret );

        // The main loop: Dequeues items and passes them to the handler
        void handlerLoop();
    private:
        bool isActive;
        bool haveEndOfInput;
        TokenMessageReceiver handler;
        io_service& io;
        // TODO: use concurrent_queue from TBB later!
        std::deque<ChunkType> queue;
    };

} // namespace parsoid
