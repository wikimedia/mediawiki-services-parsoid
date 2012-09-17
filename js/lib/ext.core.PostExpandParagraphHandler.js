/*
 * Insert paragraphs for >= 2 newlines followed by inline content
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */

// Include general utilities
var u = require('./mediawiki.Util.js').Util;


function PostExpandParagraphHandler ( dispatcher ) {
	this.tokens = [];
	this.newLineCount = 0;
	this.register( dispatcher );
}

// constants
PostExpandParagraphHandler.prototype.newlineRank = 2.5;
PostExpandParagraphHandler.prototype.anyRank = 2.501; // Just after regular quote and newline


// Register this transformer with the TokenTransformer
PostExpandParagraphHandler.prototype.register = function ( dispatcher ) {
	this.dispatcher = dispatcher;
	// Register for NEWLINE tokens
	dispatcher.addTransform( this.onNewLine.bind(this), "PostExpandParagraphHandler:onNewLine",
			this.newlineRank, 'newline' );
	// Reset internal state when we are done
	dispatcher.addTransform( this.onEnd.bind(this), "PostExpandParagraphHandler:onEnd",
			this.newlineRank, 'end' );
};

PostExpandParagraphHandler.prototype.reset = function ( token, frame, cb ) {
	//console.warn( 'PostExpandParagraphHandler.reset ' + JSON.stringify( this.tokens ) );
	if ( this.newLineCount ) {
		this.tokens.push( token );
		return this._finish();
	} else {
		return [token];
	}
};

PostExpandParagraphHandler.prototype._finish = function ( ) {
	var tokens = Array.prototype.concat.apply([], this.tokens);
	this.tokens = [];
	// remove 'any' registration
	this.dispatcher.removeTransform( this.anyRank, 'any' );
	this.newLineCount = 0;
	return tokens;
};


// Handle NEWLINE tokens
PostExpandParagraphHandler.prototype.onNewLine = function (  token, frame, cb ) {
	//console.warn( 'PostExpandParagraphHandler.onNewLine: ' + JSON.stringify( token, null , 2 ) );
	var res;
	this.tokens.push(token);

	if (! this.newLineCount ) {
		this.dispatcher.addTransform( this.onAny.bind(this), "PostExpandParagraphHandler:onAny",
				this.anyRank, 'any' );
	}

	this.newLineCount++;
	return {};
};

PostExpandParagraphHandler.prototype.onEnd = function (  token, frame, cb ) {
	return { tokens: this.reset( token ) };
}

PostExpandParagraphHandler.prototype.onAny = function ( token, frame, cb ) {
	//console.warn( 'PostExpandParagraphHandler.onAny' );
	if ( token.constructor === CommentTk ||
			// TODO: narrow this down a bit more to take typeof into account
			( token.constructor === SelfclosingTagTk && token.name === 'meta' ) ||
			( token.constructor === String && token.match( /^[\t ]*$/ ) )
	)
	{
		// Continue with collection..
		this.tokens.push( token );
		return {};
	} else {
		function popStashedTokens(tokens, pTks) {
			var t = tokens.shift();
			// Ignore newline and whitespace line tokens
			while (t.constructor !== NlTk) {
				if (t.constructor === SelfclosingTagTk) {
					pTks.push(t);
				}
				t = tokens.shift();
			}
		}

		// None of the tokens we are interested in, so abort processing..
		//console.warn( 'PostExpandParagraphHandler.onAny: ' + JSON.stringify( this.tokens, null , 2 ) );
		if ( this.newLineCount >= 2 && ! u.isBlockToken( token ) ) {
			// move newline tokens out of the paragraph
			var pTks = [],
				newLineCount = this.newLineCount;
			while ( newLineCount >= 4 ) {
				// Insert <p><br></p> sections
				popStashedTokens(this.tokens, pTks);
				popStashedTokens(this.tokens, pTks);
				// mark this as a placeholder for now until the
				// editor handles this properly
				pTks.push(new TagTk( 'p', [new KV('typeof', 'mw:Placeholder')] ));
				popStashedTokens(this.tokens, pTks);
				pTks.push(new SelfclosingTagTk('br'));
				pTks.push(new EndTagTk('p'));
				newLineCount -= 3;
			}

			// SSS FIXME: Ideally, all significant newlines should be
			// be <br/>s.  But that breaks compatibility with the php parser.
			popStashedTokens(this.tokens, pTks);
			pTks.push(new NlTk());
			if (newLineCount >= 2) {
				popStashedTokens(this.tokens, pTks);
				pTks.push(new NlTk());
				pTks.push(new TagTk('p'));
				if (newLineCount === 3) {
					popStashedTokens(this.tokens, pTks);
					pTks.push( new SelfclosingTagTk( 'br' ) );
				}
			}

			var res = { tokens: pTks.concat( this._finish(), [token] ) };
			//console.warn( 'insert p:' + JSON.stringify( res, null, 2 ) );
			return res;
		} else {
			return { tokens: this.reset(token) };
		}
	}

};

if (typeof module == "object") {
	module.exports.PostExpandParagraphHandler = PostExpandParagraphHandler;
}
