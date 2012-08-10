SOURCES = \
	html_parser.cc

OBJS = $(SOURCES:.cc=.o)

PREFIX ?= $(CURDIR)/../build

#.INCLUDE_DIRS += \
#    $(PREFIX)/include
CXXFLAGS += \
	-g \
	-I$(PREFIX)/include

LIBS = \
    -lstdc++ \
    -L$(PREFIX)/lib \
    -Wl,-Bstatic \
    -lhubbub \
    -ljson \
    -Wl,-Bdynamic \

LIB_STATIC = libparsoid.a

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
	cp $(LIB_STATIC) $(PREFIX)/lib

clean:
	rm -f $(LIB_STATIC) $(OBJS) test test.o

test: install test.o all
	$(CXX) -o $@ $(LIBS) -lparsoid $(OBJS) test.o
