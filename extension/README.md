Parsoid is not an extension. This file is only meant for internal use during
development, as a lightweight way of testing integration.

To set up, just make sure the /vendor directory is up to date, then add
`wfLoadExtension( 'Parsoid', '/path/to/parsoid/extension.json' )` to
your LocalSettings. You'll have to remove it again in the future once
Parsoid is integrated with core and this mock extension is deleted.

To test, visit `{$wgScriptPath}/rest.php/parsoid/ping`.