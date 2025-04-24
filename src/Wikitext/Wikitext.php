<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wikitext;

use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Fragments\StripState;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;

/**
 * This class represents core wikitext concepts that are currently represented
 * as methods of Parser.php (in core) OR Parsoid.php (here) or other classes.
 * Care should be taken to have this class represent first-class wikitext
 * concepts and operations and not so much implementation concepts, but that is
 * understandably a hard line to draw. Given that, this suggestion is more of a
 * guideline to help with code hygiene.
 */
class Wikitext {
	/**
	 * Equivalent of 'preprocess' from Parser.php in core.
	 * - expands templates
	 * - replaces magic variables
	 *
	 * Notably, this doesn't support replacing template args from a frame,
	 * i.e. the preprocessing here is of *standalone wikitext*, not in
	 * reference to something else which is where a frame would be used.
	 *
	 * This does not run any Parser hooks either, but support for which
	 * could eventually be added that is triggered by input options.
	 *
	 * This also updates resource usage and returns an error if limits
	 * are breached.
	 *
	 * @param Env $env
	 * @param PFragment $fragment input wikitext, possibly with embedded
	 *  strip markers.
	 * @param ?bool &$error Set to true if we hit resource limits
	 * @return PFragment Expanded wikitext OR error message to print
	 */
	public static function preprocessFragment( Env $env, PFragment $fragment, ?bool &$error = null ): PFragment {
		$error = false;
		$start = hrtime( true );
		# $originalSize = strlen( $fragment->asMarkedWikitext( StripState::new() ) );
		// Only pass a string to preprocessWikitext unless core is ready
		// for this new API.
		// @phan-suppress-next-line PhanDeprecatedFunction
		if ( !$env->getSiteConfig()->getMWConfigValue( 'ParsoidFragmentInput' ) ) {
			$fragment = $fragment->killMarkers();
		}
		$ret = $env->getDataAccess()->preprocessWikitext( $env->getPageConfig(), $env->getMetadata(), $fragment );
		if ( is_string( $ret ) ) {
			$ret = WikitextPFragment::newFromWt( $ret, null );
		}
		$wikitextSize = strlen( $ret->asMarkedWikitext( StripState::new() ) );
		// FIXME: Should this bump be $wikitextSize - $originalSize?
		// We should try to figure out what core does and match it.
		if ( !$env->bumpWt2HtmlResourceUse( 'wikitextSize', $wikitextSize ) ) {
			$error = true;
			return WikitextPFragment::newFromLiteral(
				"wt2html: wikitextSize limit exceeded", null
			);
		}

		if ( $env->profiling() ) {
			$profile = $env->getCurrentProfile();
			$profile->bumpMWTime( "Template", hrtime( true ) - $start, "api" );
			$profile->bumpCount( "Template" );
		}
		return $ret;
	}
}
