Please see [the Parsoid project page](https://www.mediawiki.org/wiki/Parsoid)
for some information on how to get started with these tests and the current
parser architecture.

Install dependencies and run tests:

	$ cd ..  # if you are in this README file's directory
	$ npm test

Running parserTests.js
----------------------

For parserTests, you also need MediaWiki's parser test cases
(`parserTests.txt`).  Parsoid maintains its own fork of the MediaWiki
parser test cases, and we synchronize it from time to time.  You can
also specify a test case file as an argument, or symlink
`parserTests.txt` from a `mediawiki/core` git checkout.

	$ node ./parserTests.js

Several options are available for parserTests:

	$ node ./parserTests.js --help

Enjoy!

Running the round-trip test server
----------------------------------

In `tests/server/`, to install the necessary packages, run
	$ npm install

You'll need a pre-created MySQL database. Then, copy
`server.settings.js.example` to `server.settings.js` and in that file
edit the connection parameters. You can also override the settings
with command line options, to see them and their default values run:
	$ node server --help

To populate the database with initial data, you might first want to
create a user and a database.  For this example we'll use `$USER`,
`$PASSWORD`, and `$DBNAME` to stand for the user, password, and database
you specified in `server.settings.js`:

	$ mysql -u root -p$ROOTPASSWORD mysql
	mysql> CREATE USER '$USER'@'localhost' IDENTIFIED BY '$PASSWORD';
	mysql> CREATE DATABASE $DBNAME;
	mysql> GRANT ALL PRIVILEGES ON $DBNAME.* TO '$USER'@'localhost';
	mysql> \q

Now you'll want to create the initial database:

	$ mysql -u$USER -p$PASSWORD $DBNAME < sql/create_everything.mysql
	$ node importJson --prefix=enwiki titles.example.en.json
	$ node importJson --prefix=eswiki titles.example.es.json

The script importJson.js takes the same connection parameters as server.js. To
test the handling of non-existent articles, you might want to also do:

	$ node importJson --prefix=enwiki titles.example.bogus.json
	$ node importJson --prefix=eswiki titles.example.bogus.json

Now start the server:

	$ node server

Running the round-trip test clients
-----------------------------------

In `tests/client`, copy `config.example.js` to `config.js` and edit it to your
taste. In separate windows, as many as you want:

	$ cd tests/client
	$ node client

Then take a look at [the statistics](http://localhost:8001/).

Running the dumpgrepper
-----------------------

The dumpgrepper utility is useful to search XML dumps for specific regexp
patterns. With a simple regexp, an enwiki dump can be grepped in ~20 minutes.

The grepper operates on actual wikitext (with XML encoding removed), so there is
no need to complicate regexps with entities. It supports JavaScript RegExps.

	$ npm install -g dumpgrepper

More information on [github](https://github.com/wikimedia/dumpgrepper) and the
[mediawiki wiki](https://www.mediawiki.org/wiki/Parsoid/DumpGrepper).
