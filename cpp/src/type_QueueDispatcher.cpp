#include "parsoid_internal.hpp"

namespace parsoid {
    template <class ChunkType>
    void QueueDispatcher<ChunkType>::setHandler( TokenMessageReceiver handler ) {
        this->handler = handler;
    }

    template <class ChunkType>
    void QueueDispatcher<ChunkType>::operator() ( TokenMessage ret ) {
        queue.push_front( ret.getChunks() );
        if ( ! ret.isAsync() ) {
            haveEndOfInput = true;
        }
        if ( !isActive ) {
            // schedule self with IO service
            io.post(bind(&QueueDispatcher::handlerLoop, this));
        }
    }

    template <class ChunkType>
    void QueueDispatcher<ChunkType>::handlerLoop() {
        isActive = true;
        // Keep handling items from the queue
        while ( ! queue.empty() ) {
            handler( queue.back() );
            queue.pop_back();
        }
        isActive = false;
    }
}
