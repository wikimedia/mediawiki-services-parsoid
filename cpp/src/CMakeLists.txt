cmake_minimum_required( VERSION 2.8 )
project( libparsoid )
FILE(
	GLOB
	LIBPARSOID_SRCS
	"*.cpp"
)

# if you need to exclude any source files:
#LIST( REMOVE_ITEM LIBPARSOID_SRCS ${SKIP_SRCS} )

SET(
	GENERATED_SRCS
	wikitext_tokenizer.cpp
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
	${GENERATED_SRCS}
	${LIBPARSOID_SRCS}
)

add_dependencies( parsoid pugixml netsurf-libhubbub )

target_link_libraries( parsoid ${PARSOID_LIBS} )

set(
	public_headers
	parsoid_internal.hpp
        # FIXME: divide into internal and external headers
        WikiTokenizer.hpp
        ParsoidEnvironment.hpp
        TokenTransformManager.hpp
        TokenTransformer.hpp
        TokenHandler.hpp
        Frame.hpp
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

add_custom_command (
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/wikitext_tokenizer.cpp
    COMMAND ${CMAKE_BINARY_DIR}/bin/leg ${CMAKE_CURRENT_SOURCE_DIR}/wikitext_tokenizer.leg > ${CMAKE_CURRENT_BINARY_DIR}/wikitext_tokenizer.cpp
    DEPENDS peg ${CMAKE_CURRENT_SOURCE_DIR}/wikitext_tokenizer.leg
    COMMENT "Generating the tokenizer using leg parser generator"
    VERBATIM
)
