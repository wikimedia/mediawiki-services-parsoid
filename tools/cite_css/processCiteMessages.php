<?php

/* phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic */
/* phpcs:disable Generic.Files.LineLength.TooLong */
/* phpcs:disable MediaWiki.Commenting.FunctionComment.WrongStyle */

/* ------------------------------------------------------------------------------
 * This script is meant to be used as a tool to process Cite's i18n messages used
 * for formatting Cite numbers and generate equivalent CSS rules that generate
 * almost equivalent output. These rules are meant to be tweaked before being added
 * to a wiki's MediaWiki:Common.css file.
 *
 * Run this script as: php tools/processCiteMessages.php <optional-args>
 *
 * This script assumes a checkout of the Cite extension in ../../core/extensions/Cite
 * If not, pass the cite directory path as ARGV[1]
 *
 * This script assumes the presence of a number of JSON files:
 * - JSON output of https://global-search.toolforge.org/?namespaces=8&q=.%2A&regex=1&title=Cite%20reference.%2A
 *   stored in "./cite.references.messages.json" OR passed in via ARGV[2]
 * - JSON output of https://global-search.toolforge.org/?namespaces=8&q=.%2A&regex=1&title=Cite%20link%20label.%2A
 *   stored in "/cite.link_label_groups.messages.json" OR passed in via ARGV[3]
 * - Localized separators stored in "./localized.separators.json" extracted
 *   from the separators arrays in the various language message files in
 *   mediawiki core repo.
 * - Message fallback chains in "./language.fallbacks.json"
 *
 * It dumps the CSS rules per wiki (found in the JSON files) to stdout.
 * ------------------------------------------------------------------------------ */

// Message fallback chain generated with this CLI in MW core's
// languages/messages/ directory and edited lightly.
//
// git grep '$fallback ' | sed 's/^Messages\(.*\)\..* '"'"'\(.*\).;.*/\L"\1":["\2"]/;s/_/-/;s/, /", "/g;s/$/,/g;' > /tmp/language.fallbacks.json

function wfJsonKeyToTitleSuffix( string $key ): string {
	return preg_replace( '/cite_/', '', $key );
}

function wfTitleToKey( string $title ): string {
	return strtr( preg_replace( '/^.*?:Cite /', '', $title ), ' ', '_' );
}

function wfFetchRevisionContent( string $wiki, string $title ): string {
	$out = [];
	$cache = __DIR__ . "/../cached_titles";
	$cachedFile = "$cache/$wiki." . wfTitleToKey( $title );
	if ( file_exists( $cachedFile ) ) {
		$res = file_get_contents( $cachedFile );
	} else {
		$path = __DIR__ . "/../FetchWt.php";
		$command = "php $path --domain $wiki.org --title '$title'";
		/* phpcs:disable MediaWiki.Usage.ForbiddenFunctions.exec */
		exec( $command, $out );
		$res = implode( $out );
		file_put_contents( $cachedFile, $res );
	}
	# error_log("GOT $res instead of missing for $wiki:$title");
	return $res;
}

function wfProcessRow( array $row, array &$wikiInfo ): void {
	$wiki = $row['wiki'];
# Debug
#	if ( $wiki !== "hi.wikipedia" ) {
#		return;
#	}
	$msgKey = $row['title'];
	$content = trim( $row['source_text'] );
	if ( !$content ) {
		# error_log("MISSING content for $wiki:$msgKey");
		$content = wfFetchRevisionContent( $wiki, $msgKey );
	}
	$msgKey = wfTitleToKey( $msgKey );
	// \u0026amp;#32 => &#32 => ' '
	$content = preg_replace( '/\s+/', ' ',
		html_entity_decode(
			preg_replace( "#^<span[^>]*>([\s\S]*)</span>$#", "$1", html_entity_decode( $content ) )
		)
	);
	# error_log("wiki:$wiki; msg: $msgKey; content: $content");
	$wikiInfo[$wiki][$msgKey] = $content;
}

function wfAddCSSForIBTagsAndProcessMsg( array &$cssRules, string &$msg ) {
	if ( preg_match( "/<b>/", $msg ) ) {
		$cssRules[] = "font-weight: bold;";
	}
	if ( preg_match( "/<i>/", $msg ) ) {
		$cssRules[] = "font-style: italic;";
	}
	$msg = preg_replace( "/<\/?(i|b)>/", "", $msg );
}

function wfGetCSS( string $selector, array $rules ) {
	return "$selector {\n\t" . implode( "\n\t", $rules ) . "\n}";
}

function wfEmitCSS( string $selector, array $rules ) {
	print wfGetCSS( $selector, $rules ) . "\n";
}

function wfLoadJson( string $file ): array {
	return json_decode( file_get_contents( $file ), true );
}

function wfProcessMessages( string $file, ?array &$wikiInfo ): void {
	$jsonObj = wfLoadJson( $file );
	foreach ( $jsonObj["hits"] as $row ) {
		wfProcessRow( $row, $wikiInfo );
	}
}

function wfDetectCounterType( string $msg ): ?string {
	$counterTypeMaps = [
		"0-9" => "decimal",
		"a-z" => "lower-alpha",
		"A-Z" => "upper-alpha",
		"٠١٢٣٤٥٦٧٨٩" => "arabic-indic",
		"০১২৩৪৫৬৭৮৯" => "bengali",
		"0123456789" => "decimal",
		"०१२३४५६७८९" => "devanagari",
		"೦೧೨೩೪೫೬೭೮೯" => "kannada",
		"၀၁၂၃၄၅၆၇၈၉" => "myanmar",
		"۰۱۲۳۴۵۶۷۸۹" => "persian",
	];

	/* Hacky heuristic that should work */
	if ( $msg === "first second last!" ) {
		return "error-test";
	} elseif ( preg_match( '/^([αβγδεζηθικλμνξοπρστυφχψω]*( |$))*$/u', $msg ) ) {
		return "lower-greek";
	} elseif ( preg_match( '/^([ivxlcdm]*( |$))*$/u', $msg ) ) {
		return "lower-roman";
	} elseif ( preg_match( '/^([IVXLCDM]*( |$))*$/u', $msg ) ) {
		return "upper-roman";
	} else {
		foreach ( $counterTypeMaps as $digits => $type ) {
			if ( preg_match( "/^([$digits]*( |$))*$/u", $msg ) ) {
				return $type;
			}
		}
		return null;
	}
}

// ext.cite.style.css defines data-mw-group=... CSS rules for these groups
$defaultGroupCounterTypes = [
	'decimal',
	'lower-alpha',
	'upper-alpha',
	'lower-roman',
	'upper-roman',
	'error-test',
	'lower-greek'
];

function wfBackfill( string $citeI18nDir, string $lang, array &$messages ) {
	$jsonMsgKeys = [
		"cite_reference_link",
		"cite_references_link_one",
		"cite_references_link_many_format_backlink_labels",
		"cite_references_link_many_format",
		"cite_references_link_many",
		"cite_references_link_many_and",
		"cite_references_link_many_sep",
	];
	$langJsonFile = "$citeI18nDir$lang.json";
	if ( file_exists( $langJsonFile ) ) {
		$langMsgs = wfLoadJson( $langJsonFile );
		foreach ( $jsonMsgKeys as $key ) {
			$msgTitleKey = wfJsonKeyToTitleSuffix( $key );
			if ( !isset( $messages[$msgTitleKey] ) && isset( $langMsgs[$key] ) ) {
				$messages[$msgTitleKey] = $langMsgs[$key];
			}
		}
	}
}

$wikiInfo = [];
$citeRepo = $argv[1] ?? ( __DIR__ . "/../../../core/extensions/Cite" );

// This file is the exported JSON of https://global-search.toolforge.org/?namespaces=8&q=.%2A&regex=1&title=Cite%20reference.%2A
$jsonFile = $argv[2] ?? ( __DIR__ . "/cite.reference.messages.json" );
wfProcessMessages( $jsonFile, $wikiInfo );

// This file is the exported JSON of https://global-search.toolforge.org/?namespaces=8&q=.%2A&regex=1&title=Cite%20link%20label.%2A
$jsonFile = $argv[3] ?? ( __DIR__ . "/cite.link_label_groups.messages.json" );
wfProcessMessages( $jsonFile, $wikiInfo );

// Language fallback chain
$langFallbacks = wfLoadJson( __DIR__ . "/language.fallbacks.json" );

// Localized digits & separators
$localizedDigits = wfLoadJson( __DIR__ . "/localized.digits.json" ); // Extracted from languages/messages/Message$lang.php
$localizedSeps = wfLoadJson( __DIR__ . "/localized.separators.json" ); // Extracted from languages/messages/Message$lang.php
$digitLocalizationEnabled = wfLoadJson( __DIR__ . "/digits.localization.config.json" ); // Extracted from wmf-config/$wgTranslateNumerals

// Backfill from lang-specific i18n file
$citeI18nDir = $citeRepo . "/i18n/";
foreach ( $wikiInfo as $wiki => &$messages ) {
	$lang = preg_replace( "/\..*$/", "", $wiki );
	wfBackfill( $citeI18nDir, $lang, $messages );
}

// Backfill from language fallback chains
foreach ( $wikiInfo as $wiki => &$messages ) {
	if ( $lang !== 'en' ) {
		// last fallback is 'en'
		$len = count( $langFallbacks[$lang] ?? [] );
		if ( $len === 0 || ( $langFallbacks[$lang][$len - 1] !== 'en' ) ) {
			$langFallbacks[$lang][] = 'en';
		}
		foreach ( $langFallbacks[$lang] ?? [] as $fbLang ) {
			wfBackfill( $citeI18nDir, $fbLang, $messages );
			if ( !isset( $localizedDigits[$lang] ) && isset( $localizedDigits[$fbLang] ) ) {
				$localizedDigits[$lang] = $localizedDigits[$fbLang];
			}
			if ( !isset( $localizedSeps[$lang] ) && isset( $localizedSeps[$fbLang] ) ) {
				$localizedSeps[$lang] = $localizedSeps[$fbLang];
			}
		}
	}
}

// Process messages
foreach ( $wikiInfo as $wiki => &$messages ) {
	# error_log( "$wiki has " . count($messages) . " messages ");

	// Preprocess all messages
	foreach ( $messages as $key => $msg ) {
		$msg = preg_replace( "/strong/", "b", $msg );
		$msg = preg_replace( "/'''([^']+)'''/", "<b>$1</b>", $msg );
		$msg = preg_replace( "/''([^']+)''/", "<i>$1</i>", $msg );
		$msg = html_entity_decode( $msg );

		switch ( $key ) {
			case "reference_link":
				$msg = preg_replace( "/<(span|nowiki|sup)[^>]*>|<\/(span|sup|nowiki)>/", "", $msg );
				$msg = preg_replace( "/\[\[\#\\$2\||\]\]/", "", $msg );
				break;

			case "references_link_one":
				$msg = preg_replace( "/<(li|span)[^>]*>|<\/(li|span)>/", "", $msg );
				$msg = preg_replace( "/\[\[\#\\$2\||\]\]|\\$3/", "", $msg );
				break;

			case "references_link_many":
				$msg = preg_replace( "/<(li|span|nowiki)[^>]*>|<\/(li|span|nowiki)>/", "", $msg );
				$msg = preg_replace( "/\\$2 \\$3/", "", $msg );
				break;

			case "references_link_many_format":
				$msg = preg_replace( "/\[\[\#\\$1\||<(span|sup)[^>]*>|<\/(span|sup)>|\]\]/", "", $msg );
				break;

			case "references_link_many_sep":
				$msg = preg_replace( "/|<sup[^>]*>|<\/sup>/", "", $msg );
				break;

			case "references_link_many_and":
				$msg = preg_replace( "/|<sup[^>]*>|<\/sup>/", "", $msg );
				$msg = preg_replace( "/|<sup[^>]*>|<\/sup>/", "", $msg );
				break;

			default:
				break;
		}
		$messages[$key] = $msg;
		# error_log("$key = " . json_encode($msg) );
	}

	print "--- EMITTING CSS for $wiki ---\n";

	// Generate any required custom counters first
	$lang = preg_replace( "/\..*$/", "", $wiki );
	$digits = $localizedDigits[$lang] ?? null;
	if ( $digits === null ) {
		$langCounterType = "decimal"; // default
	} else {
		$langCounterType = wfDetectCounterType( implode( ' ', $digits ) ) ?? "$lang-counter";
	}
	// check if localization is disabled!
	if ( $langCounterType !== 'decimal' && !( $digitLocalizationEnabled[$wiki] ?? true ) ) {
		$refCounterType = 'decimal';
		$linkbackCounterType = 'decimal';
		$langSep = '.';
		$resetRefCounterTypes = true;
	} else {
		$refCounterType = $langCounterType;
		$linkbackCounterType = $langCounterType;
		$langSep = $localizedSeps[$lang] ?? '.'; // default
		$resetRefCounterTypes = false;
	}

	$keys = array_keys( $messages );
	$groupLabels = [];
	foreach ( $messages as $key => $msg ) {
		if ( preg_match( '/^link_label_group-/', $key ) ) {
			$group = substr( $key, 17 /* strlen( "link_label_group-" ) */ );
			$groupCounterType = wfDetectCounterType( $msg );
			if ( !$groupCounterType ) {
				// emit custom counter definitions
				$groupCounterType = "custom-group-label-$group";
				$cssSel = "@counter-style $groupCounterType";
				$cssRules = [];
				$cssRules[] = "system: fixed;";
				$cssRules[] = "symbols: " . preg_replace( "/([^\s]+)/", "'$1'", $msg ) . ";";
				wfEmitCSS( $cssSel, $cssRules );
			}
			$groupLabels[$group] = $groupCounterType;
		} elseif ( $key === "references_link_many_format_backlink_labels" ) {
			$linkbackCounterType = wfDetectCounterType( $msg );
			if ( !$linkbackCounterType ) {
				$linkbackCounterType = "custom-backlink";
				$cssSel = "@counter-style custom-backlink";
				$cssRules = [];
				$cssRules[] = "system: fixed;";
				$cssRules[] = "symbols: " . preg_replace( "/([^\s]+)/", "'$1'", $msg ) . ";";
				wfEmitCSS( $cssSel, $cssRules );

				/* Ensure counter-reset is at zero if $langCounterType is not decimal! */
				if ( $langCounterType !== 'decimal' ) {
					$cssSel = 'span[ rel="mw:referencedBy" ]';
					$cssRules = [ 'counter-reset: mw-ref-linkback 0;' ];
					wfEmitCSS( $cssSel, $cssRules );
				}
			}
		}
	}

	// Generate other CSS rules
	foreach ( $messages as $key => $msg ) {
		switch ( $key ) {
			case "reference_link":
				// "[$3]" is the effective default Parsoid CSS output
				if ( $msg !== "[$3]" ) {
					$cssSel = '.mw-ref > a:after';
					$parts = preg_split( "/\\$3/", $msg );
					$rule = "content: ";
					if ( $parts[0] !== "" ) {
						$rule .= "'" . $parts[0] . "'";
					}
					// FIXME: the counter is language-specific
					// but editors can fix this or we can edit it manually
					$rule .= " counter( mw-Ref, $refCounterType )";
					if ( $parts[1] !== "" ) {
						$rule .= " '" . $parts[1] . "'";
					}
					$rule .= ";";
					wfEmitCSS( $cssSel, [ $rule ] );

					if ( $resetRefCounterTypes ) {
						$cssSel = ".mw-ref > a[ data-mw-group ]:after";
						// NOP since $refCountertype is known to to be 'decimal'
						// but make code clearer and more robust
						$rule = preg_replace( "/$refCounterType/", "decimal", $baseRule );
						wfEmitCSS( $cssSel, [ $rule ] );
					}

					// Add CSS rules for all groups
					$baseRule = $rule;
					foreach ( $groupLabels as $group => $groupCounterType ) {
						$cssSel = ".mw-ref > a[data-mw-group=$group]:after";
						$rule = preg_replace( "/$refCounterType/", "$groupCounterType", $baseRule );
						wfEmitCSS( $cssSel, [ $rule ] );
					}
				} else {
					if ( $resetRefCounterTypes ) {
						wfEmitCSS(
							".mw-ref > a:after",
							[ "content: '[' counter( mw-Ref, decimal ) ']';" ]
						);

						wfEmitCSS(
							".mw-ref > a[ data-mw-group ]:after",
							[ "content: '[' attr( data-mw-group ) ' ' counter( mw-Ref, decimal ) ']';" ]
						);
					}
					// Add CSS rules for those not present in ext.cite.style.css in Cite extension
					foreach ( $groupLabels as $group => $groupCounterType ) {
						if ( $groupCounterType !== $group ||
							!array_search( $group, $defaultGroupCounterTypes, true )
						) {
							$cssSel = ".mw-ref > a[data-mw-group=$group]:after";
							$rule = "content: '[' counter( mw-Ref, $groupCounterType ) ']';";
							wfEmitCSS( $cssSel, [ $rule ] );
						}
					}
				}
				break;

			case "references_link_one":
				// "↑ " is the effective default Parsoid CSS output
				$msg = rtrim( $msg );
				if ( $msg !== "↑" ) {
					$cssSel = 'a[ rel="mw:referencedBy" ]:before';
					$cssRules = [];
					wfAddCSSForIBTagsAndProcessMsg( $cssRules, $msg );
					$cssRules[] = 'content: "' . $msg . '";';
					wfEmitCSS( $cssSel, $cssRules );
				}
				break;

			case "references_link_many":
				if ( preg_match( "/<sup>/", $msg ) ) {
					$cssSel = 'span[ rel="mw:referencedBy" ] > a:after';
					$cssRules = [ 'font-size: smaller;' ];
					wfEmitCSS( $cssSel, $cssRules );

					$cssSel = 'span[ rel="mw:referencedBy" ] > a:nth-last-child(2):after';
					$cssRules = [ "vertical-align: super;" ];
					wfEmitCSS( $cssSel, $cssRules );
				}

				$msg = preg_replace( "/<\/?sup[^>]*>/", "", $msg );
				$msg = preg_replace( "/\\$2 \\$3/", "", $msg );

				if ( $msg !== "↑ " ) { // "↑ " is the default
					$cssSel = 'span[ rel="mw:referencedBy" ]:before';
					$cssRules = [];
					wfAddCSSForIBTagsAndProcessMsg( $cssRules, $msg );
					$cssRules[] = 'content: "' . $msg . '";';
					wfEmitCSS( $cssSel, $cssRules );
				}
				break;

			case "references_link_many_format":
				// "$2" is the effective default Parsoid CSS output
				// with decimal as the counter type and "." as the separator.
				if ( $msg !== "$2" || ( $langCounterType !== "decimal" && $langSep !== "." ) ) {
					$cssSel = 'span[ rel="mw:referencedBy" ] > a:before';
					$cssRules = [];
					wfAddCSSForIBTagsAndProcessMsg( $cssRules, $msg );

					$counterRef = preg_match( "/\\$2/", $msg ) ? "\\$2" : "\\$3";
					$parts = preg_split( "/$counterRef/", $msg );
					$rule = 'content:';
					if ( $parts[0] !== "" ) {
						$rule .= " '" . $parts[0] . "'";
					}

					// Default is Y where Y is mw-ref-linkback counter
					if ( $counterRef === "\\$2" ) {
						$counter = $resetRefCounterTypes ? "decimal" : $langCounterType;
						// X.Y where X is mw-references counter and Y is mw-ref-linkback counter
						$linkbackRule =
							"counter( mw-references, $counter )" . " '$langSep' " .
							"counter( mw-ref-linkback, $counter )";
					} else { // implicilty assumed to be "\\$3"
						$linkbackRule = "counter( mw-ref-linkback, $linkbackCounterType )";
					}

					$rule .= " $linkbackRule";
					if ( count( $parts ) > 1 && $parts[1] !== "" ) {
						$rule .= " '" . $parts[1] . "'";
					}
					$rule .= ";";
					$cssRules[] = $rule;
					wfEmitCSS( $cssSel, $cssRules );
				} elseif ( $resetRefCounterTypes ) {
					$cssSel = 'span[ rel="mw:referencedBy" ] > a:before';
					$linkbackRule =
						"counter( mw-references, $linkbackCounterType )" . " '$langSep' " .
						"counter( mw-ref-linkback, $linkbackCounterType )";
					$cssRules = [];
				}
				break;

			case "references_link_many_and":
				if ( $msg !== ' ' ) { // ' ' is the default
					$cssSel = 'span[ rel="mw:referencedBy" ] > a:nth-last-child(2):after';
					$cssRules = [];
					wfAddCSSForIBTagsAndProcessMsg( $cssRules, $msg );
					$cssRules[] = 'content: "' . $msg . '";';
					wfEmitCSS( $cssSel, $cssRules );
				}
				break;

			case "references_link_many_sep":
				if ( $msg !== ' ' ) { // ' ' is the default
					$cssSel = 'span[ rel="mw:referencedBy" ] > a:after';
					$cssRules = [];
					wfAddCSSForIBTagsAndProcessMsg( $cssRules, $msg );
					$cssRules[] = 'content: "' . $msg . '";';
					wfEmitCSS( $cssSel, $cssRules );
				}
				break;

			default:
				break;
		}
	}
}
