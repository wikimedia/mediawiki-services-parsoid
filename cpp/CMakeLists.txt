cmake_minimum_required( VERSION 2.8 )

include( ExternalProject )

project( parsoid CXX )
# option( WITH_PHP "Build php bindings" ON )

set( CMAKE_CXX_FLAGS "-Wall -std=c++11" )
set(
	PARSOID_LIBS
	parsoid
	#boost_
)
set( envs PREFIX=${CMAKE_BINARY_DIR} )
add_subdirectory( src )
add_subdirectory( test )
include_directories( ${CMAKE_BINARY_DIR}/include )

function( contrib_make proj subdir ) # & varargs ...
	set( srcdir ${CMAKE_SOURCE_DIR}/${subdir} )
	ExternalProject_Add( ${proj}
		SOURCE_DIR ${srcdir}
		CONFIGURE_COMMAND echo ""
		BUILD_COMMAND make -C ${srcdir} ${envs}
		BUILD_IN_SOURCE 1
		INSTALL_COMMAND echo ""
		${ARGN}
	)
endfunction()

function( contrib_makeinstall proj subdir ) # & varargs...
	set( srcdir ${CMAKE_SOURCE_DIR}/${subdir} )
	ExternalProject_Add( ${proj}
		SOURCE_DIR ${srcdir}
		CONFIGURE_COMMAND echo ""
		BUILD_COMMAND make -C ${srcdir} ${envs}
		BUILD_IN_SOURCE 1
		INSTALL_COMMAND make -C ${srcdir} install ${envs}
		${ARGN}
	)
endfunction()

contrib_makeinstall( netsurf-buildsystem
	contrib/netsurf/buildsystem
)

contrib_makeinstall( netsurf-libparserutils
	contrib/netsurf/libparserutils
	DEPENDS netsurf-buildsystem
)

contrib_makeinstall( netsurf-libhubbub
	contrib/netsurf/libhubbub
	DEPENDS netsurf-buildsystem netsurf-libparserutils
)

# TODO sorry, wind0ids.
#contrib_make( netsurf-libjson
#	contrib/netsurf/json-c/json-c
#	CONFIGURE_COMMAND sh autogen.sh && ./configure --prefix=${CMAKE_BINARY_DIR}
## XXX autogen is failing for some reason
#)

contrib_makeinstall( peg
	contrib/peg-0.1.9
)

contrib_make( double-conversion
	contrib/double-conversion
)
