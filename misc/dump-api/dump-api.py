#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
    dump-api.py

    Fake MediaWiki API that handles requests from titles by reading from
    a bzip2-compressed database dump. Outputs JSON. For optimal performance,
    place this service behind an HTTP reverse proxy such as Varnish, and copy
    the dump file to a tmpfs filesystem.

    Dependencies:
     - bx-python   https://bitbucket.org/james_taylor/bx-python/
     - bottle      http://bottlepy.org/
     - ujson       http://pypi.python.org/pypi/ujson/
     - seek-bzip   https://bitbucket.org/james_taylor/seek-bzip2/

    If you have pip installed, simply run:

      pip install bjoern bottle bx-python

    To serve articles from a dump, you will need to generate two auxiliary
    indices: a bzip2 table, using bzip-table, and an article index, using
    gen-index.py. bzip-table is included in James Taylor's seek-bzip2 library
    (see above).

    :author: Ori Livneh <ori@wikimedia.org>

"""
import atexit
import marshal
import ujson

from bottle import request, response, route, run
from bx.misc.seekbzip2 import SeekableBzip2File
from xml.sax.saxutils import unescape


config = {
    'filename'       : '/run/data/en-2012-09-10.xml.bz2',
    'table_filename' : '/run/data/en-2012-09-10.xml.bz2t',
    'index'          : '/run/data/en-2012-09-10.xml.marshal'
}

dump = SeekableBzip2File(**config)
atexit.register(dump.close)

with open(config['index'], 'rb') as f:
    index = marshal.load(f)

http_headers = {
    'Cache-Control' : 'public, max-age=31536000',
    'Content-Type'  : 'application/json; charset=utf-8'
}


def get_page(title):
    offset = index.get(title)
    if offset is None:
        return {'-1': {'ns': 0, 'title': title, 'missing': ''}}
    dump.seek(offset)
    capturing = False
    lines = []
    for line in dump:
        if line.startswith('    <ns>'):
            ns = int(line[8:-6])
            continue
        elif line.startswith('    <id>'):
            pageid = int(line[8:-6])
            continue
        elif line.startswith('      <text xml:space="preserve">'):
            capturing = True
            line = line[33:]
        if line.endswith('</text>\n'):
            lines.append(line[:-8])
            break
        if capturing:
            lines.append(line)
    content = unescape(''.join(lines))
    return {str(id): {
        'ns'        : ns,
        'pageid'    : pageid,
        'revisions' : [{'*'  : content}],
        'title'     : title
    }}


@route('/w/api.php')
def fake_api():
    title = request.query.titles.replace('_', ' ')
    response.headers.update(http_headers)
    return ujson.dumps({'query': {'pages': get_page(title)}})


if __name__ == '__main__':
    run(port=8080, server='bjoern', debug=True)
