#include <string>
#include <stdint.h>
#include <boost/intrusive_ptr.hpp>
#include "intrusive_ptr_base.hpp"
#include <vector>

namespace parsoid
{
    /**
     * Base class for all Parsoid tokens
     *
     * Implements reference counting, and an ordered dict with support for
     * duplicate values
     *
     * Experimental work in progress, very early stages.
     */

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
            enum typeID {
                AbstractToken = 0,
                StartTagTk = 1,
                EndTagTk = 2,
                TextTk = 3,
                CommentTk = 4,
                NlTk = 5,
                EOFTk = 6
            };

            Token();
            // General token source range accessors
            Token& setSourceRange( unsigned int rangeStart, unsigned int rangeEnd );
            unsigned int getSourceRangeStart( );
            unsigned int getSourceRangeEnd( );

            // type tag for safe upcasting
            // Alternative solution: Use typeid RTTI info. Disadvantage:
            // cannot use switch, have to compare each to typeid(type) in
            // if..else if.. structure
            virtual typeID type() { return typeID::AbstractToken; };
            
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
            TagToken& setName ( const std::string& name );
            const std::string& getName( );

            TagToken& setAttribute ( const std::string& name, const std::string&value );
            const std::string* getAttribute( const std::string& name );
            TagToken& appendAttribute( const std::string& name, const std::string& value );
            TagToken& prependAttribute( const std::string& name, const std::string& value );
            TagToken& insertAttributeAfter( const std::string& otherName, 
                    const std::string& name, const std::string& value );
            TagToken& insertAttributeBefore( const std::string& otherName,
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
            virtual Token::typeID type() { 
                return Token::typeID::StartTagTk; 
            };
    };

    class EndTagTk: public TagToken {
        public:
            EndTagTk() = default;
            virtual Token::typeID type() { 
                return Token::typeID::EndTagTk; 
            };
    };

    class ContentToken: public Token
    {
        public:
            // Value accessors: only available for text and comment tokens
            ContentToken& setText ( const std::string& text );
            const std::string& getText ( );
            virtual ~ContentToken ();
            virtual Token::typeID type() { 
                return Token::typeID::AbstractToken; 
            };
        private:
            // no direct instances, abstract
            ContentToken(){ throw; };
    };

    // not much to do here..
    class NlTk: public Token { 
        public:
            NlTk() = default;
            virtual Token::typeID type() { 
                return Token::typeID::NlTk; 
            };
    };
    class EOFTk: public Token {
        public:
            EOFTk() = default;
            virtual Token::typeID type() { 
                return Token::typeID::EOFTk; 
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
