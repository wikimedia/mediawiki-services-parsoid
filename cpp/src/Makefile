SOURCES = \
	html_parser.cc

OBJS = $(SOURCES:.cc=.o)

PREFIX ?= $(CURDIR)/../build

#.INCLUDE_DIRS += \
#    $(PREFIX)/include
CXXFLAGS += \
	-g \
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
	rm -f $@
	$(AR) $(ARFLAGS) $@ $^

install: all
	install $(LIB_STATIC) $(PREFIX)/lib
	mkdir -p $(PREFIX)/include/libparsoid
	install *.h $(PREFIX)/include/libparsoid

clean:
	rm -f $(LIB_STATIC) $(OBJS)
