Parsoid
=======

[![Build Status](https://travis-ci.org/wikimedia/parsoid.svg?branch=master)](https://travis-ci.org/wikimedia/parsoid)
[![Coverage Status](https://img.shields.io/coveralls/wikimedia/parsoid.svg)](https://coveralls.io/r/wikimedia/parsoid?branch=master)

A combined Mediawiki and html parser in JavaScript running on node.js. Please
see (https://www.mediawiki.org/wiki/Parsoid) for an overview
of the project.

You might need to set the NODE_PATH environment variable:

	export NODE_PATH="node_modules"

Download the dependencies:

	npm install

Run tests:

	npm test

Configure your Parsoid web service.

	cp config.example.yaml config.yaml
	# Tweak config.yaml

Run the webservice:

	npm start

More installation details are available at
https://www.mediawiki.org/wiki/Parsoid/Setup

Developer API documentation can be found at
https://doc.wikimedia.org/Parsoid/master/

And some helpful getting-started guides are at
https://doc.wikimedia.org/Parsoid/master/

An example of a library that builds on Parsoid output to offer an API that
mimics mwparserfromhell in JavaScript can be found at,
https://github.com/wikimedia/parsoid-jsapi

License
-------

Copyright (c) 2011-2015 Wikimedia Foundation and others; see
`AUTHORS.txt`.

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
