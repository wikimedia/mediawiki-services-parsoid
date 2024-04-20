/* ----------------------------------------------------------------------------------------
 * - Run this query in quarry:
 *   select page_title,page_namespace from page where page_is_redirect=0 and mod(page_namespace,2) = 1;
 * - Download those results as a json file in $FILE
 * - Run this as node tools/gen.titles.js $WIKIPREFIX $FILE $COUNT (however many entries you want)
 *   and dump the output in a sql file.
 * - Import to the visual diff server and update the test database.
 * - Run visual diff tests and profit!
 * ---------------------------------------------------------------------------------------- */
if (process.argv.length < 5) {
	console.error("USAGE: node " + process.argv[1] + " <wikiprefix> <file> <count>");
	process.exit(1);
}

const nsMap = {
	"0":"",
	"2":"User",
	"4":"Project",
	"6":"File",
	"8":"MediaWiki",
	"10":"Template",
	"12":"Help",
	"14":"Category",
	"828":"Module",
};
const wikiPrefix = process.argv[2];
const file = process.argv[3];
const numEntries = Number(process.argv[4]);
const data =
	JSON.parse(
		require('fs').readFileSync(file, "utf8")
	)
	.rows
	.sort(function(a,b) {
		return 0.5 - Math.random();
	})
	.map(function(e) {
		const nsId = Number(e[1]);
		let ns;
		if (nsId % 2 === 0) {
			ns = nsMap[String(nsId)];
			ns = ns ? ns + ":" : "";
		} else {
			ns = nsMap[String(nsId - 1)];
			ns = ns + (ns ? "_" : "") + "Talk:";
		}
		return ns + e[0];
	})
	.slice(0,Number(numEntries))
	.map(function(e) {
		return `INSERT IGNORE INTO pages(prefix, title) VALUES("${ wikiPrefix }", "${ e.replace(/"/g, '\\"') }");`;
	});
console.log(data.join("\n"));
