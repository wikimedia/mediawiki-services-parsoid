#ifndef __HAVE_SCOPE_HPP__
#define __HAVE_SCOPE_HPP__

#include "LibIncludes.hpp"
#include "Token.hpp"
//#include "Parsoid.hpp"

namespace parsoid {

// Forward declaration
class Parsoid;

class Scope
{
    public:
        /**
         * Root scope constructor
         *
         * We assume the parameters to be empty
         */
        Scope (string title, Parsoid* parsoid);

        /**
         * Child Scope constructor
         */
        Scope (string title, const Scope* parent, AttribMap&& params );

        /**
         * Expand a token chunk in this scope to phase 2
         *
         * It creates a new pipeline with a reference to this scope and sets its
         * callback to the passed-in receiver. The receiver is normally owned
         * by a token stream transformer (Attribute or Template transformers
         * mainly) and will thus outlive the async expansion processing.
         */
        void expand(TokenChunkPtr chunk, const TokenMessageReceiver* receiver);

    private:
        Scope();
        // TODO: memory management?
        const Scope* parentScope;

        /**
         * The nesting depth
         *
         * FIXME: Headsup!
         *
         * Expansions using the root scope (depth == 0) should be encapsulated
         * / wrapped on expansion.  But, there is a small caveat here that pertains
         * to use of templates in args passed to other templates.
         *
         * Ex: {{ echo | {{ echo | bar }} }}
         *
         * In the above example, the inner template is also expanded in the root
         * scope context which will also end up getting wrapped with meta-tags.
         *
         * Existing RT and template encapsulation code gets thrown off when
         * nested template uses are wrapped.  To prevent this, the JS version has
         * an additional flag that tracks these kind of template uses and does not
         * rely on scope depth alone and this flag is passed around pipeline and
         * transformer constructors.  In this C++ version, since we are not going to
         * doing all that extra flag/options passing and will solely rely on
         * scope depth to decide whether to wrap template content with meta-tags,
         * template encapsulation and rt-support code has to deal with inner
         * templates being wrapped or alternatively, we have to strip them away
         * by recognizing nesting.
         *
         * This is a FIXME while porting the TemplateTransformer.
         */
        int depth;

        // The parent Scope. Used for loop detection.
        const Scope* parent;

        /**
         * The normalized title string / dbkey
         */
        string title;

        // Holds global config/env stuff
        // XXX: conflict with namespace?
        Parsoid* parsoid;

        // The template parameters
        AttribMap params;
};


} // namespace parsoid

#endif
