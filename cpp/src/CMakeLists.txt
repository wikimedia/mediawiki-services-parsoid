cmake_minimum_required( VERSION 2.8 )
project( libparsoid )
set(
	LIBPARSOID_SRCS
	html_parser.cpp
	Token.cpp
        QueueDispatcher.cpp
        # The generated wikitext tokenizer
        wikitext_tokenizer.cpp
        WikiTokenizer.cpp
        Parsoid.cpp
)

include_directories( 
    ${CMAKE_BINARY_DIR}/include 
    # for parsoid_internal.hpp, which is transcluded from
    # wikitext_tokenizer.cpp (FIXME: enforce header install first instead?)
    ${CMAKE_CURRENT_SOURCE_DIR}
    # for the generated wikitext_tokenizer.cpp
    ${CMAKE_CURRENT_BINARY_DIR}
    )

add_library(
	parsoid
	${LIBPARSOID_SRCS}
)

target_link_libraries( parsoid ${PARSOID_LIBS} )

set(
	public_headers
	parsoid_internal.hpp
        html_parser.h
        WikiTokenizer.hpp
        ParsoidEnvironment.hpp
        TokenTransformManagerBase.hpp
        SyncTokenTransformManager.hpp
        AsyncTokenTransformManager.hpp
        InputExpansionPipeline.hpp
        OutputPipeline.hpp
        Parsoid.hpp
)

install(
	FILES ${public_headers}
	DESTINATION ${CMAKE_BINARY_DIR}/include/libparsoid
)

add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/wikitext_tokenizer.cpp
    COMMAND ${CMAKE_BINARY_DIR}/bin/leg ${CMAKE_CURRENT_SOURCE_DIR}/wikitext_tokenizer.leg > ${CMAKE_CURRENT_BINARY_DIR}/wikitext_tokenizer.cpp
    DEPENDS peg ${CMAKE_CURRENT_SOURCE_DIR}/wikitext_tokenizer.leg
    COMMENT "Generating the tokenizer using leg parser generator"
    VERBATIM)
