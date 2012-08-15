OBJS = test.o

PREFIX ?= $(CURDIR)/../build

CXXFLAGS += \
	-g \
	-I$(PREFIX)/include

.DEFAULT_GOAL = test

LIBS = \
    -lstdc++ \
    -L$(PREFIX)/lib \
    -Wl,-Bstatic \
    -lhubbub \
    -ljson \
    -lparsoid \
    -Wl,-Bdynamic

test: $(OBJS)
	$(CXX) -o $@ $(LIBS) -lparsoid $(OBJS)

clean:
	rm -f test $(OBJS)
