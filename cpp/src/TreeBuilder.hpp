#ifndef __HAVE_TREEBUILDER__
#define __HAVE_TREEBUILDER__

#include "Token.hpp"
#include "PipelineStage.hpp"

namespace parsoid
{


class TreeBuilder
    : public PipelineStage<TokenMessage, DOM::XMLDocumentPtr>
{
protected:
    TreeBuilder()
        : document(new DOM::XMLDocument)
    {}

public:
    virtual void reset() {}

    virtual void addToken(Tk tok) {}

    void receive(TokenMessage message)
    {
        for (TokenChunkPtr chunk : message.getChunks())
        {
            for (Tk tok : chunk->getChunk())
            {
                addToken(tok);

                if (tok.type() == TokenType::Eof)
                {
                    emit(document);
                    reset();
                }
            }
        }
    }

protected:
    DOM::XMLDocumentPtr document;
};


} // namespace parsoid

#endif
