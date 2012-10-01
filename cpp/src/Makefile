# Simple utility makefile so that we can use vim :make from the src dir too.
default_target: all
.PHONY: default_target all clean test

all clean test:
	$(MAKE) -C .. $(MFLAGS) $@
