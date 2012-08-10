PHP_ARG_ENABLE(parsoid, whether to enable parsoid support,
  [  --enable-parsoid           Enable parsoid support])

PHP_ARG_WITH(libparsoid, libparsoid install dir,
  [  --with-libparsoid[=DIR]], no, no)

if test "$PHP_PARSOID" != "no"; then

  BUILD_DIR="../build"
  dnl TODO:
  dnl PHP_CHECK_LIBRARY(parsoid, unmangled_parsoid_nothing,
  dnl [
  dnl   PHP_ADD_INCLUDE($BUILD_DIR/include)
  dnl   PHP_ADD_LIBRARY_WITH_PATH(parsoid, $BUILD_DIR, PARSOID_SHARED_LIBADD)
  dnl ], [
  dnl   AC_MSG_ERROR(parsoid module requires libparsoid)
  dnl ], [
  dnl   -lstdc++ -lhubbub -L$BUILD_DIR/lib
  dnl ])

  dnl # --with-parsoid -> check with-path
  dnl SEARCH_PATH="/usr/local /usr"     # you might want to change this
  dnl SEARCH_FOR="/include/parsoid.h"  # you most likely want to change this
  dnl if test -r $PHP_PARSOID/$SEARCH_FOR; then # path given as parameter
  dnl   PARSOID_DIR=$PHP_PARSOID
  dnl else # search default path list
  dnl   AC_MSG_CHECKING([for parsoid files in default path])
  dnl   for i in $SEARCH_PATH ; do
  dnl     if test -r $i/$SEARCH_FOR; then
  dnl       PARSOID_DIR=$i
  dnl       AC_MSG_RESULT(found in $i)
  dnl     fi
  dnl   done
  dnl fi
  dnl
  dnl if test -z "$PARSOID_DIR"; then
  dnl   AC_MSG_RESULT([not found])
  dnl   AC_MSG_ERROR([Please reinstall the parsoid distribution])
  dnl fi

  dnl # --with-parsoid -> add include path
  dnl PHP_ADD_INCLUDE($PARSOID_DIR/include)

  dnl # --with-parsoid -> check for lib and symbol presence
  dnl LIBNAME=parsoid # you may want to change this
  dnl LIBSYMBOL=parsoid # you most likely want to change this 

  dnl PHP_CHECK_LIBRARY($LIBNAME,$LIBSYMBOL,
  dnl [
  dnl   PHP_ADD_LIBRARY_WITH_PATH($LIBNAME, $PARSOID_DIR/lib, PARSOID_SHARED_LIBADD)
  dnl   AC_DEFINE(HAVE_PARSOIDLIB,1,[ ])
  dnl ],[
  dnl   AC_MSG_ERROR([wrong parsoid lib version or lib not found])
  dnl ],[
  dnl   -L$PARSOID_DIR/lib -lm
  dnl ])
  dnl
  PHP_SUBST(PARSOID_SHARED_LIBADD)

  PHP_NEW_EXTENSION(parsoid, parsoid.c, $ext_shared)
fi
