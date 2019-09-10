<?php

// This file is loaded from wmf-config's CommonSettings.php

$wgReadOnly = "Scandium access is read-only for Parsoid testing. " .
	"You shouldn't need to write anything from here.";

// When Parsoid is enabled in production context, this will
// have already been configured.
if ( !isset( $wgParsoidSettings ) ) {
	// Temporarily enable all these defaults
	$wgParsoidSettings = [
		'useSelser' => true,
	];
}

// Override Parsoid-specific settings for rt-testing.
$wgParsoidSettings['rtTestMode'] = true;
$wgParsoidSettings['scrubWikitext'] = true;

// Disabled for now so porting the dev api isn't on the critical path
// These endpoints are occasionally useful while investigating rt testing
// diffs on the server.
// $wgParsoidSettings['devAPI'] = true;

// Linting during rt testing is useful to catch errors and crashers,
// but we don't want to save lints to the production db. Right now, in the
// integrated mode, it isn't possible to lint without posting results.
// Once this functionality is implemented, we will enable this on scandium.
// $wgParsoidSettings['linting'] = true;
