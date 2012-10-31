/**
 * PEG.js grammar for reading change test files for the
 * selective serialization testing in Parsoid.
 */

testfile =
	chunk+

eol = "\n"

whitespace = [ \t]+

ws = whitespace

rest_of_line = c:( [^\n]* ) eol {
	return c.join( '' );
}

line = (!"!!") line:rest_of_line {
	return line;
}

text = lines:line* {
	return lines.join('\n');
}

chunk =
	comment /
	test /
	empty



comment =
	"#" text:rest_of_line

empty =
	eol /
	ws

end_test =
    "!!" ws? "end" ws? eol

test =
	start_test
	title:text
	sections:section*
	end_test {
		var test = {
			type: 'test',
			title: title
		};
		for (var i = 0; i < sections.length; i++) {
			var section = sections[i];
			test[section.name] = section.text;
		}
		return test;
	}

section =
	"!!" ws? (!"end") name:(c:[a-zA-Z0-9]+ { return c.join(''); }) rest_of_line
	text:text {
		return {
			name: name,
			text: text
		};
	}

/* the : is for a stray one, not sure it should be there */

start_test =
    "!!" ws? "test" ":"? ws? eol

end_test =
    "!!" ws? "end" ws? eol

