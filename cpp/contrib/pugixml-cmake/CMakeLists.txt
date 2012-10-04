cmake_minimum_required( VERSION 2.8 )
project( libpugixml )

include_directories ( 
    ../pugixml/src
)


#target_link_libraries( pugixml ${PUGIXML_LIBS} )

set(
	public_headers
        ../pugixml/src/pugixml.hpp
        ../pugixml/src/pugiconfig.hpp
)

add_library(
	pugixml
	../pugixml/src/pugixml.cpp
        ${public_headers}
)

get_target_property(
    pugi_lib
    pugixml
    OUTPUT_NAME
)

#file(
#    COPY
#    ${pugi_lib}
#    DESTINATION ${CMAKE_BINARY_DIR}/lib
#)

file(
    COPY
    ${public_headers}
    DESTINATION ${CMAKE_BINARY_DIR}/include/libpugixml
)
