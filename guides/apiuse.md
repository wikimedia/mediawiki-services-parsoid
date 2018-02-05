# Using Parsoid's API

If you're a developer looking to deal with MediaWiki's wikitext output, but
you would much prefer it to be an HTML DOM, then Parsoid can best help you
through its HTTP API that serves HTML (or JSON) responses.

This guide may become out of date; the latest information should be
available [on the wiki](https://www.mediawiki.org/wiki/Parsoid/API).

## /{wiki domain}/v3/page/{html|pagebundle}/{article name}[/{revision}]

### GET

If you make a GET request to the API, to a URI that represents a valid
wikimedia domain and an article name, you will get back an HTML document with
a bunch of extra information used for round-tripping. You can use this to do
basic parsing of existing wiki pages.

#### Responses

Assuming all goes well, you will receive a 200 OK response with the text of
the HTML document. But what if things go wrong?

##### 401 Unauthorized

This means that the wiki you were trying to access doesn't allow read access
to anonymous users. Parsoid will never work for this wiki, and you should
report this as a bug in the server's configuration.

##### 404 Not Found

This means what you would expect - the page was not there on the wiki. It
might also indicate that this is a redirect to a different wiki - those do
exist - and that you should use the URL in the text of the response instead.

##### 500 Internal Server Error

The least helpful of error codes. We do try to include more information in the
body of the response, but it may not always be as helpful as we intend.

## /{wiki domain}/v3/transform/{wikitext|html|pagebundle}/to/{wikitext|html|pagebundle}[/{article name}[/{revision}]]

### POST

Converts wikitext to html, or vice-versa.

## /_version/

### GET

Yields a JSON object of the daemon name and version from `package.json`.
If running from a git repository, it would add the sha of the HEAD commit
(`git rev-parse HEAD`). Example:

    $ curl http://localhost:8000/_version
    {"name":"mediawiki-parsoid","version":"0.0.1","sha":"63a778a1ffc1e9bd0dbb3a7571fe40bfb0a6d699"}
