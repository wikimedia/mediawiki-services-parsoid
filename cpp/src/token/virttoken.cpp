#include "virttoken.hpp"
#include <ostream>
#include <boost/algorithm/string.hpp>

// Experimental work in progress.

using namespace std;

namespace parsoid
{
    Token::Token( ) :
    srStart(0), srEnd(0) {};
    Token::~Token() {};

    // General token source range accessors
    void Token::setSourceRange( unsigned int rangeStart, unsigned int rangeEnd ) {
        srStart = rangeStart;
        srEnd = rangeEnd;
    }

    unsigned int Token::getSourceRangeStart() {
        return srStart;
    }
    unsigned int Token::getSourceRangeEnd() {
        return srEnd;
    }


    // TagToken methods
    TagToken::~TagToken() {};
    void TagToken::setName ( const string& name ) {
        text = name;
    }
    const string& TagToken::getName () {
        return text;
    }

    const string* TagToken::getAttribute( const string& name )
    {
        vector< pair<string, string> >::reverse_iterator p;
        for ( p = _attribs.rbegin(); p < _attribs.rend(); p++ ) {
            // we assume that attribute keys are ASCII, so we can use simple
            // non-unicode to_upper
            string lowerName = boost::to_lower_copy( name );
            if ( (boost::to_lower_copy(p->first)) == lowerName ) {
                return &(p->second);
            }
        }
        return NULL;
    }


    void 
    TagToken::setAttribute ( const string& name, const string& value )
    {
        // MediaWiki unfortunately uses the *last* duplicate value for a given
        // attribute, so search in reverse. XML/HTML DOM uses the first value
        // instead, so we'll have to remove all but the last duplicate before
        // feeding the DOM. The duplicates should still round-trip though..
        //
        // TODO: 
        // * always store lowercase version and intern standard attribute names
        // * remember non-canonical attribute cases in rt data
        vector< pair<string, string> >::reverse_iterator p;
        for ( p = _attribs.rbegin(); p < _attribs.rend(); p++ ) {
            // we assume that attribute keys are ASCII, so we can use simple
            // non-unicode to_upper
            if ( (boost::to_upper_copy(name)) == p->first ) {
                cout << p->second << endl;
                p->second = value;
            }
        }
        // nothing found, append the attribute
        appendAttribute( name, value );
    }

    void
    TagToken::appendAttribute ( const string& name, const string& value )
    {
        pair<const string, const string> p( name, value );
        _attribs.push_back( p );
    }

    void
    TagToken::prependAttribute ( const string& name, const string& value )
    {
        pair<const string&, const string&> p( name, value );
        _attribs.insert( _attribs.begin(), p );
    }

    //// XXX: actually implement
    //Token&
    //Token::insertAttributeAfter ( const string& otherName, 
    //        const string& name, const string& value )
    //{
    //    pair<const string&, const string&> p( name, value );
    //    _attribs.insert( _attribs.begin(), p );
    //    return *this;
    //}

    // text and comment token interface
    void ContentToken::setText ( const string& text ) {
        this->text = text;
    }

    /**
     * ContentToken methods
     */
    const string& ContentToken::getText ( ) {
        return text;
    }

}
