#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
    Index a bzip2-compressed MediaWiki dump in XML format

"""
import argparse
import marshal

from bx.misc.seekbzip2 import SeekableBzip2File


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('bz2', help='bz2 dump file')
parser.add_argument('bz2t', help='bzip-table file')
parser.add_argument('output', help='destination file')
parser.add_argument('--offsets-only', action='store_true')
args = parser.parse_args()


index = {}
dump = SeekableBzip2File(args.bz2, args.bz2t)
offset = 0
try:
    for line in dump:
        if line == '  <page>\n':
            start = offset
        elif line.startswith('    <title>'):
            title = line[11:-9]
            index[title] = start
        offset = dump.tell()
finally:
    dump.close()

if args.offsets_only:
    index = tuple(index)

with open(args.output, 'wb') as f:
    marshal.dump(index, f)
