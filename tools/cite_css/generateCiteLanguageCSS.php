<?php

/* phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic */

function wfGetCSS( string $selector, array $rules ) {
	return "$selector {\n\t" . implode( "\n\t", $rules ) . "\n}\n";
}

function wfLoadJson( string $file ): array {
	return json_decode( file_get_contents( $file ), true );
}

// Generate language-specific CSS files
$counterMaps = [
	"٠١٢٣٤٥٦٧٨٩" => "arabic-indic",
	"০১২৩৪৫৬৭৮৯" => "bengali",
	"0123456789" => "decimal", /* Not a zero-start counter */
	"०१२३४५६७८९" => "devanagari",
	"೦೧೨೩೪೫೬೭೮೯" => "kannada",
	"၀၁၂၃၄၅၆၇၈၉" => "myanmar",
	"۰۱۲۳۴۵۶۷۸۹" => "persian",
];
# Language fallback chain
$langFallbacks = wfLoadJson( __DIR__ . "/language.fallbacks.json" );
$localizedDigits = wfLoadJson( __DIR__ . "/localized.digits.json" );
$localizedSeps = wfLoadJson( __DIR__ . "/localized.separators.json" );
$rtl = wfLoadJson( __DIR__ . "/rtl.langs.json" );
$rtl['en'] = false; // to ensure fallbacks work properly
$allLangs = array_merge( array_keys( $localizedDigits ), array_keys( $localizedSeps ) );

// Process fallback chains
foreach ( $allLangs as $lang ) {
	if ( $lang !== 'en' ) {
		// last fallback is 'en'
		$len = count( $langFallbacks[$lang] ?? [] );
		if ( $len === 0 || ( $langFallbacks[$lang][$len - 1] !== 'en' ) ) {
			$langFallbacks[$lang][] = 'en';
		}
		foreach ( $langFallbacks[$lang] ?? [] as $fbLang ) {
			if ( !isset( $localizedDigits[$lang] ) && isset( $localizedDigits[$fbLang] ) ) {
				$localizedDigits[$lang] = $localizedDigits[$fbLang];
			}
			if ( !isset( $localizedSeps[$lang] ) && isset( $localizedSeps[$fbLang] ) ) {
				$localizedSeps[$lang] = $localizedSeps[$fbLang];
			}
			if ( !isset( $rtl[$lang] ) && isset( $rtl[$fbLang] ) ) {
				$rtl[$lang] = $rtl[$fbLang];
			}
		}
	}
}

foreach ( $allLangs as $lang ) {
	$out = [];

	if ( $rtl[$lang] ) { // guaranteed to be set because of 'en' fallback
		$out[] = "/* @noflip */\n" . wfGetCSS(
			".mw-cite-dir-ltr",
			[ "direction: ltr;", "text-align: left;" ]
		);
		$out[] = "/* @noflip */\n" . wfGetCSS(
			".mw-cite-dir-rtl",
			[ "direction: rtl;", "text-align: right;" ]
		);
	}

	$digits = $localizedDigits[$lang] ?? null;

	if ( $digits === null ) {
		$counterType = 'decimal';
	} else {
		$str = implode( $digits );
		$counterType = $counterMaps[$str] ?? null;
		if ( $counterType ) {
			if ( $counterType !== 'decimal' ) {
				// ensure counting starts at zero
				$out[] = wfGetCSS(
					"span[ rel~='mw:referencedBy' ]",
					[ "counter-reset: mw-ref-linkback -1;" ]
				);
			}
		} else {
			$counterType = "$lang-counter";
			$cssSel = "@counter-style $counterType";
			$cssRules = [];
			$cssRules[] = "system: numeric;";
			$cssRules[] = "symbols: " . implode(
				array_map(
					static function ( $digit ) {
						return "'" . $digit . "'";
					},
					$digits ),
				' ' ) . ';';
			$out[] = wfGetCSS( $cssSel, $cssRules );
		}
		$out[] = wfGetCSS(
			".mw-ref > a:after",
			[ "content: '[' counter( mw-Ref, $counterType ) ']';" ]
		);
		$out[] = wfGetCSS(
			".mw-ref > a[ data-mw-group ]:after",
			[ "content: '[' attr( data-mw-group ) ' ' counter( mw-Ref, $counterType ) ']';" ]
		);
	}

	$separator = $localizedSeps[$lang] ?? '.';
	$out[] = wfGetCSS(
		"span[ rel='mw:referencedBy' ] > a:before",
		[ "content: counter( mw-references, $counterType )" .
			" '$separator' counter( mw-ref-linkback, $counterType );" ]
	);
	file_put_contents( "./tools/cite_css/ext.cite.style.$lang.css", implode( $out, "\n" ) );
}
