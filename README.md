Parsoid
=======

[![Build Status](https://travis-ci.org/wikimedia/parsoid.svg?branch=master)](https://travis-ci.org/wikimedia/parsoid)

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
