-- Run this sql file on your database file before you do anything else

CREATE TABLE commits (
	hash TEXT NOT NULL UNIQUE PRIMARY KEY,
	timestamp TEXT NOT NULL
);

CREATE TABLE pages (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	num_fetch_errors INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL,
	latest_result INTEGER DEFAULT NULL,
	prefix char(2) NOT NULL DEFAULT 'en'
);
CREATE INDEX title_idx ON pages ( title );
CREATE INDEX latest_result_idx ON pages ( latest_result );
CREATE INDEX title_prefix ON pages ( title, prefix );

CREATE TABLE results (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	claim_id INTEGER NOT NULL,
	result TEXT NOT NULL
);
CREATE INDEX claim_id_idx ON results ( claim_id );

CREATE TABLE claims (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	page_id INTEGER NOT NULL,
	commit_hash TEXT NOT NULL,
	num_tries INTEGER NOT NULL DEFAULT 1,
        -- FIXME: rename to has_result or use a pointer to the result instead.
        -- We currently just use it to track whether it has a result, error or
        -- not.
	has_errorless_result INTEGER NOT NULL DEFAULT 0,
	timestamp INTEGER NOT NULL
);
CREATE UNIQUE INDEX page_id_has_idx ON claims ( page_id, commit_hash );

CREATE TABLE stats (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	page_id INTEGER NOT NULL,
	commit_hash TEXT NOT NULL,
	skips INTEGER NOT NULL DEFAULT 0,
	fails INTEGER NOT NULL DEFAULT 0,
	errors INTEGER NOT NULL DEFAULT 0,
	score INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX page_idx ON stats ( page_id );
