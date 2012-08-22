#include <string>
#include <stdint.h>
#include <boost/intrusive_ptr.hpp>
#include "intrusive_ptr_base.hpp"
#include <vector>

namespace parsoid
{
    using std::string;
    using std::vector;
    /**
     * Base class for all Parsoid tokens
     *
     * Implements reference counting, and an ordered dict with support for
     * duplicate values
     *
     * Experimental work in progress, very early stages.
     */

    enum class TokenType {
        Abstract,
        StartTag,
        EndTag,
        Text,
        Comment,
        Nl,
        Eof,
    };

    /**
     * TODO:
     * - rt data
     * - optimize strings, intern tag and attribute names (use fbstring?)
     */

    class Token: public intrusive_ptr_base< Token > 
    {
        public:
            // Consecutive number so that a jump table can be used
            // Alternative: bit-per-type, so that we can use bitmasks for
            // selection

            Token();
            // General token source range accessors
            void setSourceRange( unsigned int rangeStart, unsigned int rangeEnd );
            unsigned int getSourceRangeStart( );
            unsigned int getSourceRangeEnd( );

            // type tag for safe upcasting
            // Alternative solution: Use typeid RTTI info. Disadvantage:
            // cannot use switch, have to compare each to typeid(type) in
            // if..else if.. structure
            virtual TokenType type() const { return TokenType::Abstract; };
            
            virtual ~Token ();

        protected:
            std::string text;   // Name or text content

        private:
            uint32_t srStart;
            uint32_t srEnd;

    };

    class TagToken: public Token
    {
        public:
            TagToken() {};
            // Attributes and tag name: only available for tags
            void setName ( const std::string& name );
            const std::string& getName( );

            void setAttribute ( const std::string& name, const std::string&value );
            const std::string* getAttribute( const std::string& name );
            void appendAttribute( const std::string& name, const std::string& value );
            void prependAttribute( const std::string& name, const std::string& value );
            void insertAttributeAfter( const std::string& otherName, 
                    const std::string& name, const std::string& value );
            void insertAttributeBefore( const std::string& otherName,
                    const std::string& name, const std::string& value );

            virtual ~TagToken ();

        protected:
            // data members
            std::vector< std::pair<std::string, std::string> > _attribs;
    };

    // These two inherit all their functionality from TagToken
    class StartTagTk: public TagToken {
        public:
            StartTagTk() = default;
            virtual TokenType type() const {
                return TokenType::StartTag; 
            };
    };

    class EndTagTk: public TagToken {
        public:
            EndTagTk() = default;
            virtual TokenType type() const {
                return TokenType::EndTag; 
            };
    };

    class ContentToken: public Token
    {
        public:
            // Value accessors: only available for text and comment tokens
            void setText ( const std::string& text );
            const std::string& getText ( );
            virtual ~ContentToken ();
            virtual TokenType type() const {
                return TokenType::Abstract; 
            };
        private:
            // no direct instances, abstract
            ContentToken(){ throw; };
    };

    // not much to do here..
    class NlTk: public Token { 
        public:
            NlTk() = default;
            virtual TokenType type() const {
                return TokenType::Nl; 
            };
    };
    class EofTk: public Token {
        public:
            EofTk() = default;
            virtual TokenType type() const {
                return TokenType::Eof; 
            };
    };
}

            /**
             * optimized version for later:
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
