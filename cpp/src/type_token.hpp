#include <string>
#include <stdint.h>
#include <boost/intrusive_ptr.hpp>
#include <vector>
#include <deque>
#include <map>
#include <memory> // for std::shared_ptr
#include <stdexcept>
#include <boost/function.hpp>
#include "type_intrusive_ptr_base.hpp"

namespace parsoid
{
    using std::string;
    using std::vector;
    using std::deque;
    using std::pair;
    /**
     * Reference counted Parsoid tokens
     *
     * All of Parsoid deals with tokens, so this is really important.
     */

    // Token type identifiers for dynamic type checking and upcasting
    enum class TokenType {
        Abstract,
        StartTag,
        EndTag,
        Text,
        Comment,
        Nl,
        Eof,
    };

    // Forward declarations
    class Token;
    class TagToken;
    class ContentToken;

    /**
     * Wrapper class around an intrusive pointer to a Token.
     * Adds a general dynamically-typed interface on top of specialized token
     * implementations and frees users from dealing with reference counting
     * directly.
     */
    class Tk {
        public:
            // Provide the full interface for all tokens, and check types
            // dynamically (or perhaps later only when debugging)

            Tk()
                : mToken(boost::intrusive_ptr<Token>(NULL))
            {};

            Tk( Token* tokenPtr )
                : mToken( boost::intrusive_ptr<Token>(tokenPtr) )
            {};

            Tk( Token& token )
                : mToken( boost::intrusive_ptr<Token>(&token) )
            {};

            // General token source range accessors
            void setSourceRange( unsigned int rangeStart, unsigned int rangeEnd );
            unsigned int getSourceRangeStart( ) const;
            unsigned int getSourceRangeEnd( ) const;

            // type tag for safe upcasting
            // Alternative solution: Use typeid RTTI info. Disadvantage:
            // cannot use switch, have to compare each to typeid(type) in
            // if..else if.. structure
            const TokenType type() const;

            // The TagToken interface: StartTagTk and EndTagTk
            void setName ( const std::string& name );
            const std::string& getName( ) const;
            void setAttribute ( const vector<Tk>& name, const vector<Tk>&value );
            const vector<Tk> getAttribute( const vector<Tk>& name ) const;

            // The ContentToken interface: TextTk and CommentTk
            void setText ( const std::string& text );
            const std::string& getText ( ) const;

            bool operator==( const Tk& t ) const;

            // Print helper
            const string toString () const;

        private:
            // The wrapped intrusive_ptr to Token
            boost::intrusive_ptr<const Token> mToken;
    };



    /**
     * Provide simple typedefs for a token chunk and -vector
     * (for now, to get started)
     */

    typedef vector< pair< vector<Tk>, vector<Tk> > > AttribMap;

    /**
     * A few Tk creation helpers
     */
    Tk mkStartTag ( const string& name, AttribMap* attribs = nullptr );
    Tk mkEndTag ( const string& name, AttribMap* attribs = nullptr );
    Tk mkText ( const string& text );
    Tk mkComment ( const string& text );
    Tk mkNl ( );
    Tk mkEof ( );

    /**
     * Base class for all token implementations
     */
    class Token: public intrusive_ptr_base< Token >
    {
        public:
            // Consecutive number so that a jump table can be used
            // Alternative: bit-per-type, so that we can use bitmasks for
            // selection

            Token();

            virtual string toString() const {
                return "Token()";
            }

            // General token source range accessors
            void setSourceRange( unsigned int rangeStart, unsigned int rangeEnd );
            unsigned int getSourceRangeStart( ) const;
            unsigned int getSourceRangeEnd( ) const;

            // type tag for safe upcasting
            // Alternative solution: Use typeid RTTI info. Disadvantage:
            // cannot use switch, have to compare each to typeid(type) in
            // if..else if.. structure
            virtual TokenType type() const { return TokenType::Abstract; };

            // The TagToken interface
            virtual void setName ( const std::string& name ) {
                throw std::runtime_error("setName only supported by Tag and EndTag tokens");
            };
            virtual const std::string& getName( ) const {
                throw std::runtime_error("getName only supported by Tag and EndTag tokens");
            };

            virtual void setAttribute ( const vector<Tk>& name, const vector<Tk>&value ){
                throw std::runtime_error("setAttribute only supported by Tag and EndTag tokens" );
            };
            virtual const vector<Tk> getAttribute( const vector<Tk>& name ) const{
                throw std::runtime_error( "getAttribute only supported by Tag and EndTag tokens" );
            };
            virtual bool removeAttribute ( const vector<Tk>& name ) {
                throw std::runtime_error( "removeAttribute only supported by Tag and EndTag tokens" );
            };

            // The ContentToken interface
            virtual void setText ( const std::string& text ) {
                throw std::runtime_error( "setText only supported by text and comment tokens" );
            };
            virtual const std::string& getText ( ) const {
                throw ( "getText only supported by text and comment tokens" );
            }
            virtual bool equals ( const Token& t ) const;

            virtual ~Token ();

        protected:
            std::string text;   // Name or text content

        private:
            uint32_t srStart;
            uint32_t srEnd;
    };

    // Base class for start/end tags
    class TagToken: public Token
    {
        public:
            TagToken() {};
            virtual string toString() const {
                return string("TagToken()");
            }
            virtual ~TagToken();
            // Attributes and tag name: only available for tags
            // Inherited form Token
            virtual void setName ( const std::string& name );
            virtual const std::string& getName( ) const;

            virtual void setAttribute ( const vector<Tk>& name, const vector<Tk>&value );
            virtual const vector<Tk> getAttribute( const vector<Tk>& name ) const;

            void appendAttribute( const vector<Tk>& name, const vector<Tk>& value );
            void prependAttribute( const vector<Tk>& name, const vector<Tk>& value );
            void insertAttributeAfter( const vector<Tk>& otherName,
                    const vector<Tk>& name, const vector<Tk>& value );
            void insertAttributeBefore( const vector<Tk>& otherName,
                    const vector<Tk>& name, const vector<Tk>& value );

            bool operator==( const TagToken& t ) const;
            virtual bool equals ( const Token& t ) const;

            // data-parsoid rt info
            std::map<string, string> rtInfo;

        protected:
            // data members
            std::vector< pair<vector<Tk>, vector<Tk>> > mAttribs;
    };

    // These two inherit all their functionality from TagToken
    class StartTagTk: public TagToken {
        public:
            StartTagTk() = default;
            virtual string toString() const {
                return string("StartTagTk(" + getName() + ")");
            }
            StartTagTk(const string& name, AttribMap* attribs = nullptr)
            {
                this->setName( name );
                if ( attribs ) {
                    this->mAttribs = *attribs;
                }
            }
            virtual TokenType type() const {
                return TokenType::StartTag;
            };
            virtual ~StartTagTk() {
                std::cout << "~StartTagTk" << std::endl;
            }
    };

    class EndTagTk: public TagToken {
        public:
            EndTagTk() = default;
            virtual string toString() const {
                return string("EndTagTk(" + getName() + ")");
            }
            EndTagTk(const string& name, AttribMap* attribs = nullptr)
            {
                this->setName( name );
                if ( attribs ) {
                    this->mAttribs = *attribs;
                }
            }
            virtual TokenType type() const {
                return TokenType::EndTag;
            };
    };

    // Superclass for text and comment tokens
    class ContentToken: public Token
    {
        public:
            ContentToken() = default;
            virtual string toString() const {
                return string("ContentToken()");
            }
            virtual bool equals ( const Token& t ) const;

            // Value accessors: only available for text and comment tokens
            // Inherited from Token
            virtual void setText ( const std::string& text );
            virtual const std::string& getText ( ) const;
            virtual ~ContentToken ();
            virtual TokenType type() const {
                return TokenType::Abstract;
            };
    };

    // Text content
    class TextTk: public ContentToken
    {
        public:
            TextTk() = default;
            TextTk( const string& txt ) {
                text = txt;
            }
            virtual string toString() const {
                return string("TextTk(" + getText() + ")");
            }
            virtual TokenType type() const {
                return TokenType::Text;
            }
    };

    // Comments are just special texts
    class CommentTk: public ContentToken
    {
        public:
            CommentTk() = default;
            virtual string toString() const {
                return string("CommentTk(" + getText() + ")");
            }
            CommentTk( const string& txt ) {
                text = txt;
            }
            virtual TokenType type() const {
                return TokenType::Comment;
            }
    };

    // The newline token
    class NlTk: public Token {
        public:
            NlTk() = default;
            virtual string toString() const {
                return string("NlTk()");
            }
            virtual TokenType type() const {
                return TokenType::Nl;
            };
    };

    // The end of file / input
    class EofTk: public Token {
        public:
            EofTk() = default;
            virtual string toString() const {
                return string("EofTk()");
            }
            virtual TokenType type() const {
                return TokenType::Eof;
            };
    };

    // constant-time modification on both ends
    //typedef deque<Tk> TokenChunk;

    class TokenChunk:  public intrusive_ptr_base< TokenChunk >
    {
        public:
            TokenChunk() {};

            TokenChunk(deque<Tk>& chunk)
                : chunk(chunk)
                , rank(0)
            {};

            TokenChunk(deque<Tk>& chunk, float rank)
                : chunk(chunk)
                , rank(rank)
            {};

            // Rank interface
            void setRank ( float rank ) {
                this->rank = rank;
            }
            float getRank( ) {
                return rank;
            }

            // Overload append to handle both refcounted and stack-allocated
            // chunks.
            void append( const boost::intrusive_ptr<TokenChunk> chunkPtr ) {
                chunk.insert(chunk.end(), chunkPtr->chunk.begin(), chunkPtr->chunk.end());
            }
            void append( const vector<Tk>& newChunk ) {
                chunk.insert(chunk.end(), newChunk.begin(), newChunk.end());
            }

            // The only two vector-like interfaces we need so far ;)
            void push_back( Tk tk ) {
                chunk.push_back( tk );
            }
            Tk back() {
                return chunk.back();
            }

            // Expose the (const) embedded chunk for now, so that token
            // transform managers can get at it
            const deque<Tk>& getChunk() {
                return chunk;
            }

        private:
            deque<Tk> chunk;
            float rank;
    };

    // No intrusive refcounting of refs to TokenChunk, but we can use
    // shared_ptr for now
    typedef boost::intrusive_ptr<TokenChunk> TokenChunkPtr;

    /**
     * A chunk of TokenChunkPtrs ;) Cheap concatenation of immutable and
     * refcounted chunks.
     */
    // TODO: use concurrent_vector from TBB later, or protect
    // TokenAccumulator / QueueDispatcher with Mutex!
    typedef std::deque<TokenChunkPtr> TokenChunkChunk;


    TokenChunkPtr mkTokenChunk();

    // fwd declaration
    class TokenAccumulator;

    /**
     * A (potentially) asynchronous return value wrapper around a token chunk
     * chunk.
     *
     * TODO:
     * - Add support for error reporting
     * - convert into general Message template
     */
    class TokenMessage {
        public:
            TokenMessage() {};

            // TODO: make sure this uses move semantics, especially for the
            // chunk
            TokenMessage( const TokenChunkChunk& chunks )
                : chunks(chunks)
                , accumTailPtr((TokenAccumulator*)1)
            {};

            TokenMessage(
                    const TokenChunkChunk& chunks,
                    TokenAccumulator* accumPtr )
                : chunks(chunks)
                // default to 'async' mode
                , accumTailPtr(accumPtr)
            {};

            // Constructor with async boolean
            TokenMessage(
                    const TokenChunkChunk& chunks,
                    bool isAsync
                )
                : chunks(chunks)
            {
                if (isAsync) {
                    accumTailPtr = (TokenAccumulator*)1;
                } else {
                    accumTailPtr = nullptr;
                }

            }

            bool isAsync() {
                return accumTailPtr != nullptr;
            }

            bool hasAccum() {
                return accumTailPtr != nullptr && accumTailPtr != (TokenAccumulator*)1;
            }

            const TokenChunkChunk& getChunks () {
                return chunks;
            }

        private:
            TokenChunkChunk chunks;
            // The pointee is supposed to be alive just after a return, but
            // cannot be used at any other time. The only application is to
            // call siblingDone() at the end of a pipeline.
            TokenAccumulator* accumTailPtr;
    };


    /**
     * General receiver type
     */
    typedef boost::function<void(TokenMessage)> TokenMessageReceiver;

    /**
     * The nullReceiver, which is returned if no receiver is set
     */
    static const TokenMessageReceiver nullTokenMessageReceiver;

    /**
     * Order-preserving but minimal buffering between asynchronous expansion
     * points. The accumulator collects all fully-processed tokens which are
     * waiting for an async expansion (the child) to complete. Once the child
     * is done, the accumulated chunks are forwarded to the callback.
     *
     * TODO: Support parallel callbacks.
     * - Protect entire accumulator with mutex
     * - (Possibly) Schedule callback with ASIO event loop rather than calling
     *   it directly
     */
    class TokenAccumulator {
        public:
            TokenAccumulator( TokenMessageReceiver cb )
                : cb(cb)
            {};
            TokenMessageReceiver siblingDone();
            TokenMessageReceiver returnSibling( TokenMessage ret );
            void returnChild( TokenMessage ret );
        private:
            TokenMessageReceiver cb;
            TokenChunkChunk chunks;
            bool isSiblingDone;
            bool isChildDone;
    };
}

/**
 * Print helper
 */
std::ostream& operator<<(std::ostream &strm, const parsoid::Tk& tk);

/**
 * optimization sketch
union {
    struct {
        char* name;   // Pointer to name, or name enum
        //std::vector<Attribute> attributes; // large number of
        //attributes or large values
    } c_element;
    struct {
        char name[sizeof (void*)];   // Pointer to name, or name enum
        //std::vector<Attribute> attributes; // large number of
        //attributes or large values
    } c_element_inline_name;
    struct {
        char* name;   // Pointer to name, or name enum
        char buf[sizeof (void*) * 3];
    } c_element_inline_attributes;
    struct { // both name and attributes inline, or inline content
        char buf[sizeof (void*) * 4];
    } c_buffer;
    struct {
        char* value;  // Pointer to value, or value data
        // the remaining three words are wasted..
    } c_buffer_ptr;
};
// flags:
//      tokenType:
//          3 bits: startTag | endTag | comment | text | newline | eof
//      mem layout:
//          2 bits: name: ptr | interned | inline
//          1 bit: attribute/value: inline | pointer
//
// XXX: Consider using fbstring instead!
*/
