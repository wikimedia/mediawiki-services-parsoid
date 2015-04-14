Parsoid
=======

[![Build Status](https://travis-ci.org/wikimedia/parsoid.svg?branch=master)](https://travis-ci.org/wikimedia/parsoid)
[![Coverage Status](https://img.shields.io/coveralls/wikimedia/parsoid.svg)](https://coveralls.io/r/wikimedia/parsoid?branch=master)

A combined Mediawiki and html parser in JavaScript running on node.js. Please
see (https://www.mediawiki.org/wiki/Future/Parser_development) for an overview
of the current implementation, and instructions on running the tests.

You might need to set the NODE_PATH environment variable,
```shell
export NODE_PATH="node_modules"
```

Download the dependencies:
```shell
npm install
```

Run tests:
```shell
npm test
```

Configure your Parsoid web service:
```shell
cd api
cp localsettings.js.example localsettings.js
// Tweak localsettings.js
```

Run the webservice:
```shell
 npm start
```

More details are available at https://www.mediawiki.org/wiki/Parsoid/Setup

== License ==
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
