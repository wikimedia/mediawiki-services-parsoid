SOURCES = \
	html_parser.cpp \
	type_token.cpp

OBJS = $(SOURCES:.cpp=.o)

PREFIX ?= $(CURDIR)/../build

#.INCLUDE_DIRS += \
#    $(PREFIX)/include
CXXFLAGS += \
	-std=c++11 \
	-g \
	-Wall \
	-I$(PREFIX)/include

LIB_STATIC = libparsoid.a

.DEFAULT_GOAL = all

.PHONY: \
	all \
	install \
	clean \
	test

all: $(LIB_STATIC)

$(LIB_STATIC): $(OBJS)
	echo "objs: $(OBJS)"
	rm -f $@
	$(AR) $(ARFLAGS) $@ $^

install: all
	install $(LIB_STATIC) $(PREFIX)/lib
	mkdir -p $(PREFIX)/include/libparsoid
	install *.hpp $(PREFIX)/include/libparsoid
	install *.h $(PREFIX)/include/libparsoid

clean:
	rm -f $(LIB_STATIC) $(OBJS)
