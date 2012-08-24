OBJS = test.o

PREFIX ?= $(CURDIR)/../build

CXXFLAGS += \
	-std=c++11 \
	-g \
	-Wall \
	-I$(PREFIX)/include

#.DEFAULT_GOAL = test

LIBS = \
    -lstdc++ \
    -L$(PREFIX)/lib \
    -Wl,-Bstatic \
    -lhubbub \
    -ljson \
    -lparsoid \
    -Wl,-Bdynamic

test: $(OBJS)
	$(CXX) -o $@  $(OBJS) $(LIBS) -lparsoid

all: test

.PHONY: run valgrind clean
run: test
	./test
valgrind:
	valgrind ./test

clean:
	rm -f test $(OBJS)
