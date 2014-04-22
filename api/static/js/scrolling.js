"use strict";

/* jshint browser:true, jquery:true */
( function ( $ ) {
	$( document ).ready( function () {
		var curDiff, getDiffs = function () {
				return $( 'ins, del' ).filter( function () {
					var $this = $( this );
					return ( $this.is( 'ins' ) || !$this.prev().is( 'ins' ) );
				} );
			}, $nxtbtn = $( '<button>' )
			.addClass( 'parsoid-nextdiff' )
			.css( 'display', 'none' )
			.attr( 'accesskey', 'n' )
			.click( function () {
				var foundCur = curDiff === undefined;
				getDiffs().each( function ( i ) {
					if ( foundCur ) {
						$( 'html, body' ).animate( {
							scrollTop: $( this ).offset().top
						} );
						curDiff = i;
						return false;
					}
					foundCur = i === curDiff;
				} );
			} ), $prvbtn = $( '<button>' )
			.addClass( 'parsoid-prevdiff' )
			.css( 'display', 'none' )
			.attr( 'accesskey', 'p' )
			.click( function () {
				var foundCur = curDiff === undefined;
				var revlist = getDiffs().get().reverse();
				$( revlist ).each( function ( i ) {
					i = revlist.length - 1 - i;
					if ( foundCur ) {
						$( 'html, body' ).animate( {
							scrollTop: $( this ).offset().top
						} );
						curDiff = i;
						return false;
					}
					foundCur = i === curDiff;
				} );
			} );
		$( 'body' ).append( $nxtbtn ).append( $prvbtn );
	} );
}( jQuery ) );
