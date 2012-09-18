( function ( $ ) {
	$( document ).ready( function () {
		var curDiff, $nxtbtn = $( '<button>' )
			.addClass( 'parsoid-nextdiff' )
			.css( 'display', 'none' )
			.attr( 'accesskey', 'n' )
			.click( function () {
				var foundCur = curDiff === undefined;
				$( 'ins' ).each( function ( i ) {
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
				var revlist = $( 'ins' ).get().reverse();
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
