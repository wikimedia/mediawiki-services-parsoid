<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

enum CounterType: string {
	case NODE_DATA_ID = 'mw';
	case ANNOTATION_ABOUT = 'mwa';
	case TRANSCLUSION_ABOUT = '#mwt';

	/**
	 * Convert a counter to a Base64 encoded string.
	 * Padding is stripped. /,+ are replaced with _,- respectively.
	 * Warning: Max integer is 2^31 - 1 for bitwise operations.
	 * @param int $n
	 * @return string
	 */
	private static function counterToBase64( int $n ): string {
		$str = '';
		do {
			$str = chr( $n & 0xff ) . $str;
			$n >>= 8;
		} while ( $n > 0 );
		return rtrim( strtr( base64_encode( $str ), '+/', '-_' ), '=' );
	}

	public function counterToId( int $counter ): string {
		if ( $this === self::NODE_DATA_ID ) {
			return $this->value . self::counterToBase64( $counter );
		} else {
			return $this->value . $counter;
		}
	}

	public function idToCounter( string $id ): ?string {
		return $this->matches( $id ) ? substr( $id, strlen( $this->value ) ) : null;
	}

	public function getRE(): string {
		return $this === self::NODE_DATA_ID ? "mw[\w-]{2,}" : "{$this->value}\d+";
	}

	public function matches( string $id ): bool {
		return (bool)preg_match( "/^" . $this->getRE() . "$/D", $id );
	}
}
