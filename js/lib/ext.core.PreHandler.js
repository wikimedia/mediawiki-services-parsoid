/*
 * FIXME: As per Gabriel's suggestion, a better solution would be
 * to replace the pre_indent production in the tokenizer and
 * handle it completely in the token stream transformer when more
 * complete info is available.  This gets rid of incorrect handling
 * in the tokenizer and fixup later on.
 *
 * So, PreHandler would register for the newline tokens instead of
 * pre tokens, and go from there.
 */

var Util = require('./mediawiki.Util.js').Util;

function PreHandler( manager, options ) {
	this.manager = manager;
	this.manager.addTransform(this.onPre.bind( this ), "PreHandler:onPre", this.rank, 'tag', 'pre');
	this.collecting = false;
}

PreHandler.prototype.rank = 3.00;
PreHandler.prototype.anyRank = 3.01;

PreHandler.prototype.onPre = function ( token, manager, cb ) {
	if (token.constructor === TagTk) {
		if (!token.isHTMLTag()) {
			this.tokens = [token];
			this.collecting = true;
			this.manager.addTransform(this.onAny.bind( this ), "PreHandler:onAny", this.anyRank, 'any');
			return { tokens: null };
		} else {
			return { tokens: [token] };
		}
	} else if (this.collecting) {
		this.collecting = false;
		this.manager.removeTransform( this.anyRank, 'any' );

		var strip = true;

		// Check if we need to strip out the <pre> tags
		// Skip the leading <pre> tag
		for (var i = 1, l = this.tokens.length; i < l; i++) {
			var t = this.tokens[i];
			var tc = t.constructor;
			if (tc === NlTk) {
				break;
			} else if (tc === String) {
				// If we encounter a new line without text chars, we are done
				if (t.match(/^\s?\n/)) {
					break;
				}
				// If we have non-space chars, no stripping!
				if (t.match(/[^\s]/)) {
					strip = false;
					break;
				}
			} else if (t.isHTMLTag() && Util.isBlockTag(t.name)) {
				// Done -- a block tag starts a new line
				break;
			} else if (tc !== CommentTk && (tc !== SelfclosingTagTk || t.name !== 'meta')) {
				// Non-meta tag.  No stripping
				strip = false;
				break;
			}
		}

		if (strip) {
			this.tokens.shift();
			// SSS FIXME: Worth creating a white-space token so that
			// the token can be discarded from certain contexts like
			// tables (right now, these get fostered out of the table
			// and become significant ws instead of non-significant ws.)
			//
			// <table>
			//   <tr>
			//     <td> foo </td>
			//   </td>
			// </table>
			//
			// This is probably the reason for ton of white-space in the
			// beginning of parsed output of pages like :en:Barack_Obama
			//
			// Insert a placeholder span with a single space
			// so we dont lose the leading space in RT-ing
			this.tokens.unshift(new EndTagTk('span'));
			this.tokens.unshift(' ');
			this.tokens.unshift(new TagTk('span', [{k: 'typeof', v: 'mw:Placeholder'}], { src: ' '}));
			return { tokens: this.tokens };
		} else {
			this.tokens.push(token);
			return { tokens: this.tokens };
		}
	} else {
		return { tokens: [token] };
	}
};

PreHandler.prototype.onAny = function ( token, manager, cb ) {
	if (this.collecting) {
		this.tokens.push(token);
		return { tokens: null };
	} else {
		return { tokens: [token] };
	}
};

if (typeof module == "object") {
	module.exports.PreHandler = PreHandler;
}
