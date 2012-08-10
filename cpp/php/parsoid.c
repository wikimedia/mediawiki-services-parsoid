
#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include "php.h"
#include "php_ini.h"
#include "ext/standard/info.h"
#include "php_parsoid.h"

//#include "html_parser.h"

/* If you declare any globals in php_parsoid.h uncomment this:
ZEND_DECLARE_MODULE_GLOBALS(parsoid)
*/

/* True global resources - no need for thread safety here */
static int le_parsoid;

/* {{{ parsoid_functions[]
 *
 * Every user visible function must have an entry in parsoid_functions[].
 */
const zend_function_entry parsoid_functions[] = {
	PHP_FE(parsoid_parse,	NULL)
	{NULL, NULL, NULL}	/* Must be the last line in parsoid_functions[] */
};
/* }}} */

/* {{{ parsoid_module_entry
 */
zend_module_entry parsoid_module_entry = {
#if ZEND_MODULE_API_NO >= 20010901
	STANDARD_MODULE_HEADER,
#endif
	"parsoid",
	parsoid_functions,
	PHP_MINIT(parsoid),
	PHP_MSHUTDOWN(parsoid),
	PHP_RINIT(parsoid),		/* Replace with NULL if there's nothing to do at request start */
	PHP_RSHUTDOWN(parsoid),	/* Replace with NULL if there's nothing to do at request end */
	PHP_MINFO(parsoid),
#if ZEND_MODULE_API_NO >= 20010901
	"0.1", /* Replace with version number for your extension */
#endif
	STANDARD_MODULE_PROPERTIES
};
/* }}} */

#ifdef COMPILE_DL_PARSOID
ZEND_GET_MODULE(parsoid)
#endif

/* {{{ PHP_INI
 */
/* Remove comments and fill if you need to have entries in php.ini
PHP_INI_BEGIN()
    STD_PHP_INI_ENTRY("parsoid.global_value",      "42", PHP_INI_ALL, OnUpdateLong, global_value, zend_parsoid_globals, parsoid_globals)
    STD_PHP_INI_ENTRY("parsoid.global_string", "foobar", PHP_INI_ALL, OnUpdateString, global_string, zend_parsoid_globals, parsoid_globals)
PHP_INI_END()
*/
/* }}} */

/* {{{ php_parsoid_init_globals
 */
/* Uncomment this function if you have INI entries
static void php_parsoid_init_globals(zend_parsoid_globals *parsoid_globals)
{
	parsoid_globals->global_value = 0;
	parsoid_globals->global_string = NULL;
}
*/
/* }}} */

/* {{{ PHP_MINIT_FUNCTION
 */
PHP_MINIT_FUNCTION(parsoid)
{
	/* If you have INI entries, uncomment these lines 
	REGISTER_INI_ENTRIES();
	*/
	return SUCCESS;
}
/* }}} */

/* {{{ PHP_MSHUTDOWN_FUNCTION
 */
PHP_MSHUTDOWN_FUNCTION(parsoid)
{
	/* uncomment this line if you have INI entries
	UNREGISTER_INI_ENTRIES();
	*/
	return SUCCESS;
}
/* }}} */

/* Remove if there's nothing to do at request start */
/* {{{ PHP_RINIT_FUNCTION
 */
PHP_RINIT_FUNCTION(parsoid)
{
	return SUCCESS;
}
/* }}} */

/* Remove if there's nothing to do at request end */
/* {{{ PHP_RSHUTDOWN_FUNCTION
 */
PHP_RSHUTDOWN_FUNCTION(parsoid)
{
	return SUCCESS;
}
/* }}} */

/* {{{ PHP_MINFO_FUNCTION
 */
PHP_MINFO_FUNCTION(parsoid)
{
	php_info_print_table_start();
	php_info_print_table_header(2, "parsoid support", "enabled");
	php_info_print_table_end();

	/* Remove comments if you have entries in php.ini
	DISPLAY_INI_ENTRIES();
	*/
}
/* }}} */


/* Remove the following function when you have succesfully modified config.m4
   so that your module can be compiled into PHP, it exists only for testing
   purposes. */

/* Every user-visible function in PHP should document itself in the source */
/* {{{ proto string parsoid_parse(string arg) */
PHP_FUNCTION(parsoid_parse)
{
	char *arg = NULL;
	int arg_len, len;
        long result;

	if (zend_parse_parameters(ZEND_NUM_ARGS() TSRMLS_CC, "s", &arg, &arg_len) == FAILURE) {
		return;
	}

        //result = parse_html(arg);
	RETURN_LONG(result);
}
/* }}} */
/* The previous line is meant for vim and emacs, so it can correctly fold and 
   unfold functions in source code. See the corresponding marks just before 
   function definition, where the functions purpose is also documented. Please 
   follow this convention for the convenience of others editing your code.
*/


/*
 * Local variables:
 * tab-width: 4
 * c-basic-offset: 4
 * End:
 * vim600: noet sw=4 ts=4 fdm=marker
 * vim<600: noet sw=4 ts=4
 */
