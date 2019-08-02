Parsoid is not an extension. This file is only meant for internal use during
development, as a lightweight way of testing integration.

To set up, just make sure the /vendor directory is up to date, then add
`wfLoadExtension( 'Parsoid', '/path/to/parsoid/extension.json' )` to
your LocalSettings. You'll have to remove it again in the future once
Parsoid is integrated with core and this mock extension is deleted.

You'll also need to enable the Rest API with, `$wgEnableRestAPI = true;`.

If you're serving MediaWiki with Nginx, add this to your server conf,

```
location /rest.php/ {
	try_files $uri $uri/ /rest.php;
}
```

To test, visit `{$wgScriptPath}/rest.php/{domain}/v3/page/html/Main%20Page`,
where `domain` is the domain in the `$wgScriptPath`.
