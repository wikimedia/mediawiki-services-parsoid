<?php

namespace Parsoid\Config;

/**
 * Some shared helpers across the different config implementations
 */
class ConfigUtils {
	/**
	 * This takes properties value of 'expandtemplates' output and computes
	 * magicword wikitext for those properties.
	 *
	 * This is needed for Parsoid/JS compatibility, but may go away in the future.
	 *
	 * @param array $props
	 * @return string
	 */
	public static function manglePreprocessorResponse( array $props ): string {
		// FIXME: This seems weirdly special-cased for displaytitle & displaysort
		// For now, just mimic what Parsoid/JS does, but need to revisit this
		$mws = '';
		foreach ( $props as $name => $value ) {
			if ( $name === 'displaytitle' || $name === 'defaultsort' ) {
				$mws .= "\n{{" . mb_strtoupper( $name ) . ':' . $value . '}}';
			}
		}

		return $mws;
	}
}
