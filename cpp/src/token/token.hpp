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
            enum type {
                tagTk = 0,
                endTagTk = 1,
                commentTk = 2,
                textTk = 3,
                nlTk = 4,
                eofTk = 5
            };
            // Simple constructor
            Token( Token::type t );

            // General token source range accessors
            Token& setSourceRange( unsigned int rangeStart, unsigned int rangeEnd );
            unsigned int getSourceRangeStart( );
            unsigned int getSourceRangeEnd( );

            // Attributes and tag name: only available for tags
            Token& setName ( const std::string& name );
            const std::string& getName( );

            Token& setAttribute ( const std::string& name, const std::string&value );
            const std::string* getAttribute( const std::string& name );
            Token& appendAttribute( const std::string& name, const std::string& value );
            Token& prependAttribute( const std::string& name, const std::string& value );
            Token& insertAttributeAfter( const std::string& otherName, 
                    const std::string& name, const std::string& value );
            Token& insertAttributeBefore( const std::string& otherName,
                    const std::string& name, const std::string& value );
            
            // Value accessors: only available for text and comment tokens
            Token& setText ( const std::string& text );
            const std::string& getText ( );
        private:
            uint32_t srStart;
            uint32_t srEnd;   // TODO: store length and use high byte for flags
            uint32_t flags;   // wasteful, will eat up a full word

            std::string text;   // Name or text content
            std::vector< std::pair<std::string, std::string> > _attribs;

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
    };
}

