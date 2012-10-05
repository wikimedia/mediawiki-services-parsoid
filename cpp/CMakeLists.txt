cmake_minimum_required( VERSION 2.8 )

include( ExternalProject )

project( parsoid CXX )
# option( WITH_PHP "Build php bindings" ON )

# Figure out the right CXX_FLAGS for c++11 support
if(CMAKE_COMPILER_IS_GNUCXX)
    execute_process(COMMAND ${CMAKE_C_COMPILER} -dumpversion
        OUTPUT_VARIABLE GCC_VERSION)
    if (GCC_VERSION VERSION_EQUAL 4.6)
        set( CMAKE_CXX_FLAGS "-g -Wall -std=c++0x" )
    else(GCC_VERSION VERSION_GREATER 4.7 or GCC_VERSION VERSION_EQUAL 4.7)
        set( CMAKE_CXX_FLAGS "-g -Wall -std=c++11" )
    else()
        message( FATAL_ERROR "GCC version < 4.6 detected, please upgrade!" )
    endif()
else()
    # Just assume c++11 support. TODO: test with other compilers
    message( STATUS "Non-GCC compiler detected, using default flags" )
    set( CMAKE_CXX_FLAGS "-g -Wall -std=c++11" )
endif()

set(
    PARSOID_LIBS
    pthread
    pugixml
    hubbub_treebuilder
    parsoid
)
set( envs PREFIX=${CMAKE_BINARY_DIR} )
add_subdirectory( contrib/pugixml-cmake )
add_subdirectory( contrib/netsurf/libhubbub )

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

contrib_makeinstall( peg
	contrib/peg-0.1.9
)

contrib_make( double-conversion
	contrib/double-conversion
)

