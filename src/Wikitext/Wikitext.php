<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wikitext;

use Wikimedia\Parsoid\Config\Env;

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
	 * This takes properties value of preprocessed output and computes
	 * magicword wikitext for those properties.
	 *
	 * This is needed for Parsoid/JS compatibility, but may go away in the future.
	 *
	 * @param Env $env
	 * @param array $ret
	 * @return string
	 */
	private static function manglePreprocessorResponse( Env $env, array $ret ): string {
		$wikitext = $ret['wikitext'];

		foreach ( [ 'modules', 'modulestyles', 'jsconfigvars' ] as $prop ) {
			$env->addOutputProperty( $prop, $ret[$prop] ?? [] );
		}

		// FIXME: This seems weirdly special-cased for displaytitle & displaysort
		// For now, just mimic what Parsoid/JS does, but need to revisit this
		foreach ( ( $ret['properties'] ?? [] ) as $name => $value ) {
			if ( $name === 'displaytitle' || $name === 'defaultsort' ) {
				$wikitext .= "{{" . mb_strtoupper( $name ) . ':' . $value . '}}';
			}
		}

		return $wikitext;
	}

	/**
	 * Equivalent of 'preprocessWikitext' from Parser.php in core.
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
	 * @param string $wt
	 * @return array
	 *  - 'error' did we hit resource limits?
	 *  - 'src' expanded wikitext OR error message to print
	 *     FIXME: Maybe error message should be localizable
	 */
	public static function preprocess( Env $env, string $wt ): array {
		$start = microtime( true );
		$ret = $env->getDataAccess()->preprocessWikitext( $env->getPageConfig(), $wt );
		// FIXME: Should this bump be len($ret['wikitext']) - len($wt)?
		// I could argue both ways.
		if ( !$env->bumpWt2HtmlResourceUse( 'wikitextSize', strlen( $ret['wikitext'] ) ) ) {
			return [
				'error' => true,
				'src' => "wt2html: wikitextSize limit exceeded",
			];
		}
		$wikitext = self::manglePreprocessorResponse( $env, $ret );
		if ( $env->profiling() ) {
			$profile = $env->getCurrentProfile();
			$profile->bumpMWTime( "Template", 1000 * ( microtime( true ) - $start ), "api" );
			$profile->bumpCount( "Template" );
		}
		return [
			'error' => false,
			'src' => $wikitext
		];
	}
}
