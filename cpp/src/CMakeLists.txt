cmake_minimum_required( VERSION 2.8 )
project( libparsoid )
set(
	LIBPARSOID_SRCS
	html_parser.cpp
	type_token.cpp
)
include_directories( ${CMAKE_BINARY_DIR}/include )
add_library(
	parsoid
	${LIBPARSOID_SRCS}
)
target_link_libraries( parsoid ${PARSOID_LIBS} )

set(
	public_headers
	parsoid_internal.hpp
)
install(
	FILES ${public_headers}
	DESTINATION ${CMAKE_BINARY_DIR}/include/libparsoid
)
