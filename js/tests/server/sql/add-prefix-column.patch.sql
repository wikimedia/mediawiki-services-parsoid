-- add column to store which wiki this page came from
-- if your single wiki testing has not previously been on en edit update to suit

alter table pages add column prefix char(2);
update pages set prefix = 'en';
create index title_prefix on pages ( title, prefix );
