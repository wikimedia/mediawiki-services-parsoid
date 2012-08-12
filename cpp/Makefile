PREFIX = $(CURDIR)/build
export PREFIX

CONTRIB_SUB = \
	contrib/netsurf/json-c/json-c \
	contrib/netsurf/buildsystem \
	contrib/netsurf/libparserutils \
	contrib/netsurf/libhubbub \
	contrib/peg-0.1.9

AUTOGEN_SUB = \
	contrib/netsurf/json-c/json-c

AUTOGEN_TARGETS = $(foreach dir, $(AUTOGEN_SUB), $(dir)/Makefile)

.DEFAULT_GOAL = all

.PHONY: \
	all \
	clean \
	compile \
	contrib \
	configure \
	$(CONTRIB_SUB)

configure: $(AUTOGEN_TARGETS) php/Makefile

$(AUTOGEN_TARGETS):
	cd $(dir $@) && sh autogen.sh && ./configure --prefix=$(PREFIX)

php/Makefile: php/config.m4
	cd php && phpize && ./configure --prefix=$(PREFIX)


contrib: $(CONTRIB_SUB)

$(CONTRIB_SUB): configure
	$(MAKE) -C $@ all
	$(MAKE) -C $@ install

clean:
	##rm $(AUTOGEN_TARGETS)
	rm -rf build/*
	for dir in $(CONTRIB_SUB); do \
		$(MAKE) -C $$dir clean; \
	done
	cd php && phpize --clean

compile:
	$(MAKE) -C src install
	$(MAKE) -C php

all: configure contrib compile php

test:
	$(MAKE) -C test $@
