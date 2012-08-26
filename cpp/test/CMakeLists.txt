cmake_minimum_required( VERSION 2.8 )
include_directories( ${libparsoid_SOURCE_DIR} )

add_executable( test
	test.cc
)
target_link_libraries( test ${PARSOID_LIBS} )

#add_test( test test )
