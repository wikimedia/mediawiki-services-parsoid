default_target: all
.PHONY : default_target all clean

BUILD_DIR ?= build

all:
	mkdir -p $(BUILD_DIR)
	cd $(BUILD_DIR) && cmake ..
	make -C $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)
