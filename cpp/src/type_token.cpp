#include <iostream>
#include <boost/algorithm/string.hpp>
#include "parsoid_internal.hpp"

// Experimental work in progress.

using namespace std;

namespace parsoid
{

    /**
     * Tk methods
     */
    const TokenType Tk::type() const { return mToken->type(); };
    unsigned int Tk::getSourceRangeStart() const {
        return mToken->getSourceRangeStart();
    }
    unsigned int Tk::getSourceRangeEnd() const {
        return mToken->getSourceRangeEnd();
    }
    void Tk::setSourceRange( unsigned int rangeStart, unsigned int rangeEnd ) {
        return const_cast<Token*>(mToken.get())
                ->setSourceRange( rangeStart, rangeEnd );
    }
    
    const string Tk::toString() const {
        return mToken->toString();
    }
    
    /**
     * The TagToken interface
     */
    void Tk::setName ( const std::string& name ) {
        return const_cast<Token*>(mToken.get())->setName(name);
    }
    const std::string& Tk::getName( ) const {
        return mToken->getName();
    }
    void Tk::setAttribute ( const vector<Tk>& name, const vector<Tk>&value ) {
        return const_cast<Token*>(mToken.get())->setAttribute(name, value);
    }
    const vector<Tk> Tk::getAttribute( const vector<Tk>& name ) const {
        return mToken->getAttribute(name);
    }
    //void TK::removeAttribute( const vector<Tk>& name )

    // The ContentToken interface
    void Tk::setText ( const std::string& text ) {
        return const_cast<Token*>(mToken.get())->setText( text );
    }
    const std::string& Tk::getText ( ) const {
        return mToken->getText();
    }

    bool Tk::operator==( const Tk& t ) const {
        const Token* t1 = (mToken.get());
        const Token* t2 = (mToken.get());
        if ( t1->type() != t2->type() ) {
            return false;
        } else {
            // delegate to virtual tokens
            return mToken.get()->equals( *(t.mToken.get()) );
        }
    }

    /**
     * A few Tk creation helpers
     */
    Tk mkStartTag ( const string& name, AttribMap* attribs ) {
        return Tk( new StartTagTk( name, attribs ) );
    }
    Tk mkEndTag ( const string& name, AttribMap* attribs ) {
        return Tk( new EndTagTk( name, attribs ) );
    }
    Tk mkText ( const string& text ) {
        return Tk( new TextTk( text ) );
    }
    Tk mkComment ( const string& text ) {
        return Tk ( new CommentTk( text ) );
    }
    Tk mkNl ( ) { return Tk( new NlTk() ); }
    Tk mkEof ( ) { return Tk( new EofTk() ); }

    TokenChunkPtr mkTokenChunk() {
        return TokenChunkPtr( new TokenChunk() );
    }

    /**
     * Token methods
     */
    Token::Token( ) :
    srStart(0), srEnd(0) {};
    Token::~Token() {
        std::cout << "~Token" << std::endl;
    };

    // General token source range accessors
    void Token::setSourceRange( unsigned int rangeStart, unsigned int rangeEnd ) {
        srStart = rangeStart;
        srEnd = rangeEnd;
    }

    unsigned int Token::getSourceRangeStart() const {
        return srStart;
    }
    unsigned int Token::getSourceRangeEnd() const {
        return srEnd;
    }

    bool Token::equals( const Token& t ) const {
        return true;
    }
            
            


    // TagToken methods
    TagToken::~TagToken() {
        std::cout << "~TagToken" << std::endl;
    };

    bool TagToken::equals( const Token& t ) const {
        std::cout << "TagToken==" << std::endl;
        const TagToken& t2 = dynamic_cast<const TagToken&>(t);
        return getName() == t2.getName()
            && mAttribs.size() == t2.mAttribs.size();
    }

    void TagToken::setName ( const string& name ) {
        text = name;
    }
    const string& TagToken::getName () const {
        return text;
    }

    const vector<Tk> TagToken::getAttribute( const vector<Tk>& name ) const
    {
        vector< pair<vector<Tk>, vector<Tk>> >::const_reverse_iterator p;
        for ( p = mAttribs.rbegin(); p < mAttribs.rend(); p++ ) {
            // we assume that attribute keys are ASCII, so we can use simple
            // non-unicode to_upper
            if ( p->first == name ) {
                return p->second;
            }
        }
        return vector<Tk>();
    }


    void 
    TagToken::setAttribute ( const vector<Tk>& name, const vector<Tk>& value )
    {
        // MediaWiki unfortunately uses the *last* duplicate value for a given
        // attribute, so search in reverse. XML/HTML DOM uses the first value
        // instead, so we'll have to remove all but the last duplicate before
        // feeding the DOM. The duplicates should still round-trip though..
        //
        // TODO: 
        // * always store lowercase version and intern standard attribute names
        // * remember non-canonical attribute cases in rt data
        vector< pair<vector<Tk>, vector<Tk>> >::reverse_iterator p;
        for ( p = mAttribs.rbegin(); p < mAttribs.rend(); p++ ) {
            // we assume that attribute )keys are ASCII, so we can use simple
            // non-unicode to_upper
            if ( name == p->first ) {
                p->second = value;
            }
        }
        // nothing found, append the attribute
        appendAttribute( name, value );
    }

    void
    TagToken::appendAttribute ( const vector<Tk>& name, const vector<Tk>& value )
    {
        mAttribs.push_back( make_pair( name, value ) );
    }

    void
    TagToken::prependAttribute ( const vector<Tk>& name, const vector<Tk>& value )
    {
        pair<vector<Tk>, vector<Tk>> p( name, value );
        mAttribs.insert( mAttribs.begin(), p );
    }
    

    /**
     * ContentToken methods
     */
    void ContentToken::setText ( const string& text ) {
        this->text = text;
    }

    const string& ContentToken::getText ( ) const {
        return text;
    }

    bool ContentToken::equals ( const Token& t ) const {
        return getText() == t.getText();
    }
        
    
    ContentToken::~ContentToken() {};

    /**
     * TokenAccumulator
     */
    AsyncReturnHandler
    TokenAccumulator::siblingDone() {
        isSiblingDone = true;
        if ( isChildDone ) {
            return cb;
        } else {
            return nullAsyncReturnHandler;
        }
    }

    AsyncReturnHandler
    TokenAccumulator::returnSibling( AsyncReturn ret ) {
        // append the returned chunks
        const TokenChunkChunk& retChunks = ret.getChunks();
        // Collect the chunks
        chunks.insert(chunks.end(), retChunks.begin(), retChunks.end());
        isSiblingDone = ret.isAsync();
        if ( isChildDone ) {
            // forward to parent
            // XXX: use move semantics?
            cb( AsyncReturn( chunks, ret.isAsync() ) );
            chunks.clear();
            return cb;
        } else { 
            return nullAsyncReturnHandler;
        }
    }

    void
    TokenAccumulator::returnChild( AsyncReturn ret ) {
        if ( ! ret.isAsync() ) {
            isChildDone = true;
            // Prepend the returned chunks to queue and return both
            const TokenChunkChunk& retChunks = ret.getChunks();
            chunks.insert( chunks.begin(), retChunks.begin(), retChunks.end() );
            // return the combined chunks
            cb ( AsyncReturn( chunks, isSiblingDone ) );
            // And clear the queue
            chunks.clear();
        } else {
            // just forward the ret
            cb( ret );
        }
    }
    

}

std::ostream& operator<<(std::ostream &strm, const parsoid::Tk& tk) {
    return strm << tk.toString();
}
