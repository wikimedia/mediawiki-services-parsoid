#ifndef __HAVE_FRAME_HPP__
#define __HAVE_FRAME_HPP__

#include "LibIncludes.hpp"
#include "Token.hpp"
//#include "Parsoid.hpp"

namespace parsoid {

// Forward declaration
class Parsoid;

class Frame
{
    public:
        Frame (string title, Parsoid& parsoid);
        Frame newChild( string title, Parsoid& parsoid, AttribMap params );
    private:
        Frame();
        // TODO: memory managemet?
        const Frame* parentFrame;
        int depth;
        string title;

        // Holds global config/env stuff
        // XXX: conflict with namespace?
        Parsoid& parsoid;

        // The template parameters
        AttribMap params;

};


} // namespace parsoid

#endif
