#include "parsoid_internal.hpp"

// #include <treebuilder.h> // Include the libhubbub treebuilder header

namespace parsoid
{

/**
 * Tree builder wrapper
 *
 * - Converts our tokens to a stack-allocated libhubbub token while reusing
 *   string buffers
 * - Calls the libhubbub treebuilder for each token
 * - Calls its receiver after receiving the EofTk
 */
class TreeBuilder {
    public:
        void setReceiver ( DOM::DocumentReceiver receiver ) {
            this->receiver = receiver;
        }

        void receive( TokenMessage message ) {
            // Iterate through chunk, convert each token to stack-allocated
            // libhubbub token and feed each to libhubbub tree builder
            //
            // If EofTk is found, call receiver( DOM );
        }
    private:
        DOM::DocumentReceiver receiver;
};

} // namespace parsoid
