#include <hubbub/hubbub.h>
#include <hubbub/parser.h>
#include <string.h>
#include <iostream>

#include "html_parser.h"

using namespace std;

long parse_html(const char* input)
{
    if (0 == strcmp(input, "html"))
        cout << "Is html!" << endl;

    hubbub_parser* parser;
    hubbub_parser_create("UTF-8", false, NULL, NULL, &parser);

    return 1;
}

long foo () {
    cout << "foo" << endl;
    return 0;
}

extern "C" {
    void unmangled_parsoid_nothing() {};
}
