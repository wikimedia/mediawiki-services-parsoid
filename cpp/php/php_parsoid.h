
#ifndef PHP_PARSOID_H
#define PHP_PARSOID_H

extern zend_module_entry parsoid_module_entry;
#define phpext_parsoid_ptr &parsoid_module_entry

#ifdef PHP_WIN32
#	define PHP_PARSOID_API __declspec(dllexport)
#elif defined(__GNUC__) && __GNUC__ >= 4
#	define PHP_PARSOID_API __attribute__ ((visibility("default")))
#else
#	define PHP_PARSOID_API
#endif

#ifdef ZTS
#include "TSRM.h"
#endif

PHP_MINIT_FUNCTION(parsoid);
PHP_MSHUTDOWN_FUNCTION(parsoid);
PHP_RINIT_FUNCTION(parsoid);
PHP_RSHUTDOWN_FUNCTION(parsoid);
PHP_MINFO_FUNCTION(parsoid);

PHP_FUNCTION(parsoid_parse);

/* 
  	Declare any global variables you may need between the BEGIN
	and END macros here:     

ZEND_BEGIN_MODULE_GLOBALS(parsoid)
	long  global_value;
	char *global_string;
ZEND_END_MODULE_GLOBALS(parsoid)
*/

/* In every utility function you add that needs to use variables 
   in php_parsoid_globals, call TSRMLS_FETCH(); after declaring other 
   variables used by that function, or better yet, pass in TSRMLS_CC
   after the last function argument and declare your utility function
   with TSRMLS_DC after the last declared argument.  Always refer to
   the globals in your function as PARSOID_G(variable).  You are 
   encouraged to rename these macros something shorter, see
   examples in any other php module directory.
*/

#ifdef ZTS
#define PARSOID_G(v) TSRMG(parsoid_globals_id, zend_parsoid_globals *, v)
#else
#define PARSOID_G(v) (parsoid_globals.v)
#endif

#endif	/* PHP_PARSOID_H */

