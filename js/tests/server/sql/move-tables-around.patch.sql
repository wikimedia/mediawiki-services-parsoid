-- Patch for the Great Table Rearrangement of 2012-10.
ALTER TABLE pages RENAME TO oldpages;

-- new tables --
CREATE TABLE IF NOT EXISTS commits (
	hash TEXT NOT NULL UNIQUE PRIMARY KEY,
	timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	num_fetch_errors INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS title_idx ON pages( title );

CREATE TABLE IF NOT EXISTS claims (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	page_id INTEGER NOT NULL,
	commit_hash TEXT NOT NULL,
	num_tries INTEGER NOT NULL DEFAULT 1,
	has_errorless_result INTEGER NOT NULL DEFAULT 0,
	timestamp INTEGER NOT NULL
);
CREATE UNIQUE INDEX page_id_has_idx ON claims ( page_id, commit_hash );

CREATE TABLE IF NOT EXISTS results (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	claim_id INTEGER NOT NULL,
	result TEXT
);
CREATE INDEX IF NOT EXISTS claim_id_idx ON results( claim_id );

CREATE TABLE IF NOT EXISTS stats (
	id INTEGER NOT NULL UNIQUE PRIMARY KEY ASC AUTOINCREMENT,
	page_id INTEGER NOT NULL,
	commit_hash TEXT NOT NULL,
	skips INTEGER NOT NULL DEFAULT 0,
	fails INTEGER NOT NULL DEFAULT 0,
	errors NOT NULL DEFAULT 0,
	score NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS page_idx ON stats( page_id );

-- tmp-table used primarily to compute stats --
CREATE TABLE IF NOT EXISTS tmp_ids (
	id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS id_idx ON tmp_ids( id );

-- update data --
INSERT INTO pages ( title ) SELECT title FROM oldpages;

INSERT INTO commits ( hash, timestamp )
VALUES ( 'e84e5649651f17a13566b031c334b386e6fa7fa4', '2012-10-19 22:17:05.000 -0700' );

-- claims with errorless results --
INSERT INTO claims ( page_id, commit_hash, timestamp, has_errorless_result )
SELECT pages.id, 'e84e5649651f17a13566b031c334b386e6fa7fa4', oldpages.claimed, 1
FROM oldpages
JOIN pages ON pages.title=oldpages.title
WHERE oldpages.result IS NOT NULL AND (oldpages.errors = 0 OR oldpages.errors IS NULL);

-- claims with results having errors --
INSERT INTO claims ( page_id, commit_hash, timestamp, has_errorless_result )
SELECT pages.id, 'e84e5649651f17a13566b031c334b386e6fa7fa4', oldpages.claimed, 0
FROM oldpages
JOIN pages ON pages.title=oldpages.title
WHERE oldpages.result IS NOT NULL AND oldpages.errors > 0;

INSERT INTO results ( claim_id, result )
SELECT claims.id, oldpages.claimed
FROM claims
JOIN pages ON pages.id=claims.page_id
JOIN oldpages ON oldpages.title=pages.title
WHERE oldpages.result IS NOT NULL;

INSERT INTO stats ( page_id, commit_hash, skips, fails, errors, score )
SELECT pages.id, 'e84e5649651f17a13566b031c334b386e6fa7fa4', oldpages.skips, oldpages.fails, oldpages.errors,
       oldpages.errors*1000000 + oldpages.fails*1000 + oldpages.skips
FROM oldpages
JOIN pages ON pages.title = oldpages.title
WHERE oldpages.result IS NOT NULL;
CREATE INDEX IF NOT EXISTS score_idx ON stats( score );

-- drop old table --
DROP TABLE oldpages;
