<?php

// Stub MobileContext class from MobileFrontend extension
class MobileContext extends ContextSource {
	public static function singleton() {
		return new self();
	}

	/**
	 * Take a URL and return a copy that conforms to the mobile URL template
	 * @param string $url URL to convert
	 * @param bool $forceHttps should force HTTPS?
	 * @return string|bool
	 */
	public function getMobileUrl( $url, $forceHttps = false ) {
		return "xyz";
	}
}
