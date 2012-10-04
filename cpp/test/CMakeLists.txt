cmake_minimum_required( VERSION 2.8 )
include_directories(
    ${CMAKE_BINARY_DIR}/include
    ${libparsoid_SOURCE_DIR}
)

add_executable( test
	test.cc
)
target_link_libraries( test ${PARSOID_LIBS} boost_system pugixml )

install (
    TARGETS test
    DESTINATION ${CMAKE_BINARY_DIR}/bin
)

#add_test( test test )
