/**
 * Simple noinclude / onlyinclude implementation. Strips all tokens in
 * noinclude sections.
 *
 * @author Gabriel Wicke <gwicke@wikimedia.org>
 */

var TokenCollector = require( './ext.util.TokenCollector.js' ).TokenCollector;

/**
 * This helper function will build a meta token in the right way for these
 * tags.
 */
var buildMetaToken = function ( manager, tokenName, isEnd, tsr ) {
	var metaToken, tokenAttribs;

	if ( isEnd ) {
		tokenName += '/End';
	}

	tokenAttribs = [ new KV( 'typeof', tokenName ) ];
	metaToken = new SelfclosingTagTk( 'meta', tokenAttribs );

	if ( tsr ) {
		metaToken.dataAttribs.tsr = tsr;
		metaToken.dataAttribs.src = metaToken.getWTSource( manager.env );
	}

	return metaToken;
};


/**
 * OnlyInclude sadly forces synchronous template processing, as it needs to
 * hold onto all tokens in case an onlyinclude block is encountered later.
 * This can fortunately be worked around by caching the tokens after
 * onlyinclude processing (which is a good idea anyway).
 */
function OnlyInclude( manager, options ) {
	this.manager = manager;
	if ( options.isInclude ) {
		this.accum = [];
		this.inOnlyInclude = false;
		this.foundOnlyInclude = false;
		// register for 'any' token, collect those
		this.manager.addTransform( this.onAnyInclude.bind( this ), "OnlyInclude:onAnyInclude", this.rank, 'any' );
	} else {
		// just convert onlyinclude tokens into meta tags with rt info
		this.manager.addTransform( this.onOnlyInclude.bind( this ), "OnlyInclude:onOnlyInclude", this.rank,
				'tag', 'onlyinclude' );
	}
}

OnlyInclude.prototype.rank = 0.01; // Before any further processing

OnlyInclude.prototype.onOnlyInclude = function ( token, manager ) {
	var attribs = [
			new KV( 'typeof', 'mw:OnlyInclude' + ( token instanceof EndTagTk ? '/End' : '' ) )
		],
		meta = new SelfclosingTagTk( 'meta', attribs );
	return { token: meta };
};

OnlyInclude.prototype.onAnyInclude = function ( token, manager ) {
	//this.manager.env.dp( 'onAnyInclude', token, this );
	var isTag, tagName, buiMeTo, meta;

	if ( token.constructor === EOFTk ) {
		this.inOnlyInclude = false;
		if ( this.accum.length && ! this.foundOnlyInclude ) {
			var res = this.accum;
			res.push( token );
			this.accum = [];
			//this.manager.setTokensRank( res, this.rank + 0.001 );
			return { tokens: res };
		} else {
			this.foundOnlyInclude = false;
			this.accum = [];
			return { token: token };
		}
	}

	isTag = token.constructor === TagTk ||
			token.constructor === EndTagTk ||
			token.constructor === SelfclosingTagTk;

	if ( isTag ) {
		switch ( token.name ) {
			case 'onlyinclude':
				tagName = 'mw:OnlyInclude';
				break;
			case 'includeonly':
				tagName = 'mw:IncludeOnly';
				break;
			case 'noinclude':
				tagName = 'mw:NoInclude';
		}
	}

	buiMeTo = buildMetaToken.bind( null, manager, tagName );

	if ( isTag && token.name === 'onlyinclude' ) {
		if ( ! this.inOnlyInclude ) {
			this.foundOnlyInclude = true;
			this.inOnlyInclude = true;
			// wrap collected tokens into meta tag for round-tripping
			meta = buiMeTo( token.constructor === EndTagTk );
			return meta;
		} else {
			this.inOnlyInclude = false;
			meta = buiMeTo( token.constructor === EndTagTk );
		}
		//meta.rank = this.rank;
		return { token: meta };
	} else {
		if ( this.inOnlyInclude ) {
			//token.rank = this.rank;
			return { token: token };
		} else {
			this.accum.push( token );
			return { };
		}
	}
};


function NoInclude( manager, options ) {
	new TokenCollector(
			manager,
			function ( tokens ) {
				var buiMeTo = buildMetaToken.bind( null, manager, 'mw:NoInclude' );
				if ( options.isInclude ) {
					//manager.env.tp( 'noinclude stripping' );
					return {};
				} else {
					return { tokens: [
						buiMeTo( false ),
						( tokens.length > 1 && ! ( tokens[1] instanceof EOFTk) ) ? tokens[1] : '',
						buiMeTo( true )
					] };
				}
			}, // just strip it all..
			true, // match the end-of-input if </noinclude> is missing
			0.02, // very early in stage 1, to avoid any further processing.
			'tag',
			'noinclude'
			);
}

// XXX: Preserve includeonly content in meta tag (data attribute) for
// round-tripping!
function IncludeOnly( manager, options ) {
	new TokenCollector(
			manager,
			function ( tokens ) {
				var buiMeTo = buildMetaToken.bind( null, manager, 'mw:IncludeOnly', false ), ioText = '';
				if ( options.isInclude ) {
					tokens.shift();
					if ( tokens.length &&
						tokens[tokens.length - 1].constructor !== EOFTk ) {
							tokens.pop();
					}
					return { tokens: tokens };
				} else {
					manager.env.tp( 'includeonly stripping' );
					return { tokens: [
						buiMeTo( [tokens[0].dataAttribs.tsr[0], tokens[tokens.length-1].dataAttribs.tsr[1]] )
					] };
				}
			},
			true, // match the end-of-input if </noinclude> is missing
			0.03, // very early in stage 1, to avoid any further processing.
			'tag',
			'includeonly'
			);
}


if (typeof module === "object") {
	module.exports.NoInclude = NoInclude;
	module.exports.IncludeOnly = IncludeOnly;
	module.exports.OnlyInclude = OnlyInclude;
}
