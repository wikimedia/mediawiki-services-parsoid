#include "TokenTransformer.hpp"
#include "TokenTransformManager.hpp"

namespace parsoid {

template <class TokenTransformerT>
void
TokenTransformManager<TokenTransformerT>::addTransformer( TokenTransformerT* transformer ) {
    transformer->setBaseRank( baseRank );
    baseRank += TRANSFORMER_DELTA;
    transformers.push_back( transformer );
}

// FIXME: test does not properly links against this implementation, so I moved
// this back to the header for now.

//template <class TokenTransformerT>
//TokenTransformManager<TokenTransformerT>::~TokenTransformManager() {
//    // delete all registered transformers
//    for ( TokenTransformerT* t: transformers ) {
//        delete t;
//    }
//}


} // namespace parsoid
