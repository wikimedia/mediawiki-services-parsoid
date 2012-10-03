default_target: all
.PHONY : default_target all clean up

BUILD_DIR ?= build

all:
	mkdir -p $(BUILD_DIR)
	cd $(BUILD_DIR) && cmake ..
	$(MAKE) $(MFLAGS) -C $(BUILD_DIR) install

clean:
	rm -rf $(BUILD_DIR)


REFRESH_CONTRIB = \
	cpp/contrib/netsurf/libhubbub

up:
	cd .. ; \
	git submodule sync ; \
	for DIR in $(REFRESH_CONTRIB) ; do \
		rm -rf .git/modules/$$DIR ; \
		rm -rf $$DIR ; \
	done ; \
	git submodule update -i
