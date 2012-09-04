#ifndef __HAVE_PARSOID_TOKENIZER_H__
#define __HAVE_PARSOID_TOKENIZER_H__

#include <vector>
#include "parsoid_internal.hpp"

// Actions are supposed to return this type as semantic value
namespace parsoid {
    using std::string;
    using std::vector;

    class WikiTokenizer {
        public:
            WikiTokenizer( const string& input );
            int tokenize();
            ~WikiTokenizer();
        private:
            void* _ctx;
    };
}
#endif
