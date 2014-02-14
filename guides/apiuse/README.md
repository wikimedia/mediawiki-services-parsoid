# Using Parsoid's API

If you're a developer looking to deal with MediaWiki's wikitext output, but
you would much prefer it to be an HTML DOM, then Parsoid can best help you
through its HTTP API that serves HTML (or JSON) responses.

## /{wiki prefix}/{article name}

### GET

If you make a GET request to the API, to a URI that represents a valid
interwiki prefix and an article name, you will get back an HTML document with
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

### POST

If you POST to the API with the same URI scheme, in a form-encoded format
with a data member named "content", the API will round-trip the HTML in the
content member to wikitext, and return that. You can use this to do basic
round-tripping of existing, potentially modified versions of existing
wiki pages.

## /_version/

### GET

Yield JSON object of the daemon name and version from package.json. If running
from a git repository, it would add the sha of the HEAD commit (git rev-parse
HEAD). Example:

    $ curl http://localhost:8000/_version
    {"name":"mediawiki-parsoid","version":"0.0.1","sha":"63a778a1ffc1e9bd0dbb3a7571fe40bfb0a6d699"}
